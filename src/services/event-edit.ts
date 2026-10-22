/**
 * Editing an upcoming event (#1298): the rules, as pure functions.
 *
 * The write itself is `EventService.editEvent`; this module decides what may be
 * edited, builds the version token a form carries, and describes a change for
 * the audit log. Nothing here reads Mongo or Discord.
 *
 * What an edit may touch depends on how far the event has got:
 *
 * - **full**: still `scheduled`, no channel yet, start in the future. Title,
 *   description, start (date, time, timezone) and duration.
 * - **limited**: already started (`active`, a channel has been created at the
 *   lead time, or the start has passed) but still open. Description and
 *   duration only: moving the start would leave a channel up early or late,
 *   and the voice channel's name does not follow a new title.
 * - **refused**: finished, adopted, or being ended right now.
 *
 * A recurring event is edited with a scope, `occurrence` or `following`: the
 * next occurrence is built from this one's title, description, duration and
 * timezone, so the edit must say whether those carry on. See
 * `EventService.editEvent` and the series template (`models/event.ts`).
 */

import { createHash } from "node:crypto";

/** The form limits, shared by the create and edit forms (`web/event-form.ts`). */
export const EVENT_TITLE_MAX = 100;
export const EVENT_DESCRIPTION_MAX = 1000;
export const EVENT_DURATION_MIN = 1;
export const EVENT_DURATION_MAX = 1440;

/** The editable fields, as stored. */
export interface EventEditFields {
  title: string;
  description: string;
  startTime: Date;
  timezone: string;
  durationMinutes: number;
}

/** The part of an event row the rules read. */
export interface EditableEventRef extends EventEditFields {
  state: string;
  channelId: string | null;
  recurrence?: string | null;
  seriesId?: string | null;
  nativeAdopted?: boolean | null;
  /** Series fields; they are part of the version token (#1298). */
  seriesStart?: Date | null;
  nextSpawned?: boolean | null;
  seriesTemplate?: SeriesTemplate | null;
}

/** What the next occurrence takes from the series (the model's `ISeriesTemplate`). */
export interface SeriesTemplate {
  title: string;
  description: string;
  durationMinutes: number;
  timezone: string;
}

export type EditRefusalReason = "finished" | "adopted" | "ending";

/**
 * How far an edit of a recurring event reaches: only this occurrence (the next
 * one keeps the series' values) or this one and every later one.
 */
export type EditScope = "occurrence" | "following";

/** A posted scope, or null when it is neither (missing, empty or forged). Never defaulted. */
export function parseEditScope(value: string): EditScope | null {
  return value === "occurrence" || value === "following" ? value : null;
}

/** Whether the row belongs to a recurring series (the edit then needs a scope). */
export function isSeriesRow(event: {
  recurrence?: string | null;
  seriesId?: string | null;
}): boolean {
  return (
    (!!event.recurrence && event.recurrence !== "none") ||
    (typeof event.seriesId === "string" && event.seriesId.length > 0)
  );
}

/** The four fields a series template holds, read from a row's own values. */
export function templateFromRow(row: EventEditFields): SeriesTemplate {
  return {
    title: row.title,
    description: row.description ?? "",
    durationMinutes: row.durationMinutes,
    timezone: row.timezone ?? "",
  };
}

/**
 * The template a scoped edit writes. `base` is the stored template, or the row
 * as it was before the edit when none is stored, so an earlier one-off change
 * never leaks into the series. `following` overlays only the fields this edit
 * changed; `occurrence` keeps `base` as it is.
 */
export function nextSeriesTemplate(
  scope: EditScope,
  row: EventEditFields & { seriesTemplate?: SeriesTemplate | null },
  want: EventEditFields,
): SeriesTemplate {
  // The four fields are copied one by one: the stored template of a row read
  // through Mongoose is a subdocument, and spreading or returning it would
  // carry its internals instead of the values.
  const stored = row.seriesTemplate;
  const base: SeriesTemplate = stored
    ? {
        title: stored.title,
        description: stored.description,
        durationMinutes: stored.durationMinutes,
        timezone: stored.timezone,
      }
    : templateFromRow(row);
  if (scope === "occurrence") return base;
  const out = { ...base };
  if (want.title !== row.title) out.title = want.title;
  if ((want.description ?? "") !== (row.description ?? "")) {
    out.description = want.description ?? "";
  }
  if (want.durationMinutes !== row.durationMinutes) {
    out.durationMinutes = want.durationMinutes;
  }
  if ((want.timezone ?? "") !== (row.timezone ?? "")) {
    out.timezone = want.timezone ?? "";
  }
  return out;
}

export type EditMode =
  | { mode: "full" }
  | { mode: "limited" }
  | { mode: "refused"; reason: EditRefusalReason; message: string };

export const EDIT_MESSAGES = {
  finished:
    "This event has finished or was cancelled, so it can no longer be edited.",
  scope:
    "Choose whether the change is for this occurrence only or for this and the following occurrences.",
  seriesAdvanced:
    "The next occurrence of this series has already been created, so this one can no longer be edited. Edit the next occurrence instead.",
  pastNextSlot:
    "With this start and duration the event would still be running when the next occurrence is due, and that occurrence would then be skipped. Move it earlier or shorten it.",
  anchor:
    "That start cannot be applied to the whole series (a monthly date that some months do not have, or a time that does not exist on some days). Pick another day or time, or change this occurrence only.",
  adopted:
    "This event was adopted from a Discord scheduled event. Edit it in Discord: the bot follows it there.",
  ending: "This event is being ended right now. Reload the page.",
  started:
    "This event has started since you opened the form. Reload to edit what is still open.",
  conflict:
    "This event changed since you opened the form (it started, ended, was cancelled or was edited). Reload the page and try again.",
  locked:
    "This event has already started, so only its description and duration can change.",
  badEnd:
    "The new duration would end the event in the past. Use a longer duration, or end the event from the host panel.",
  nativePending:
    "The Discord event is still being created. Try again in a minute to change the title or the start; the description and duration can change now.",
  disabled:
    "Events are turned off (or the setting could not be read), so the event cannot be edited. Turn on events.enabled first.",
  nativeActive:
    "The Discord event is already running (or its state could not be read), so the start time cannot move. The title, description and duration can still change.",
  past: "The event start time must be in the future.",
  unchanged: "Nothing was changed.",
} as const;

/**
 * Which edit an event allows right now. `ending` is true while an end or
 * cancel holds the event (`EventService.isEventBeingEnded`).
 */
export function editModeOf(
  event: EditableEventRef,
  now: Date,
  ending = false,
): EditMode {
  if (event.state !== "scheduled" && event.state !== "active") {
    return {
      mode: "refused",
      reason: "finished",
      message: EDIT_MESSAGES.finished,
    };
  }
  if (ending) {
    return { mode: "refused", reason: "ending", message: EDIT_MESSAGES.ending };
  }
  if (event.nativeAdopted === true) {
    return {
      mode: "refused",
      reason: "adopted",
      message: EDIT_MESSAGES.adopted,
    };
  }
  const started =
    event.state === "active" ||
    (event.channelId ?? null) !== null ||
    event.startTime.getTime() <= now.getTime();
  return { mode: started ? "limited" : "full" };
}

/** Which fields a form offered: all of them, or description and duration only. */
export type RenderedMode = "full" | "limited";

/** A posted mode, or null when it is neither (a form from before it existed, or a forged value). */
export function parseRenderedMode(value: string): RenderedMode | null {
  return value === "full" || value === "limited" ? value : null;
}

/**
 * The token a form carries: a hash of the editable fields, the state they
 * were shown in and the mode the form was rendered in. A save made on an older
 * page (the event started, was cancelled or edited meanwhile) no longer matches
 * and is answered with "reload". The mode is part of it because the clock moves
 * an event from full to limited without any stored field changing (the scan
 * moves the state later), and because a posted mode that is not the rendered
 * one must not pass: it would decide which posted fields are read and which are
 * dropped. Not `updatedAt`: the scan and RSVP writes move that and would cause
 * false conflicts.
 */
export function eventEditVersion(
  event: EditableEventRef,
  renderedMode: RenderedMode,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        renderedMode,
        event.state,
        event.channelId ?? null,
        event.title,
        event.description ?? "",
        event.startTime.getTime(),
        event.timezone ?? "",
        event.durationMinutes,
        event.seriesStart?.getTime() ?? null,
        event.nextSpawned === true,
        event.seriesTemplate
          ? [
              event.seriesTemplate.title,
              event.seriesTemplate.description,
              event.seriesTemplate.durationMinutes,
              event.seriesTemplate.timezone,
            ]
          : null,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}

/**
 * The series part of the conditional write of an edit (#1298): everything of a
 * recurring row that `eventEditVersion` covers and the row's own five fields do
 * not (the anchor, the successor marker and the template). It sits next to the
 * token on purpose, and a test walks the same cases through both, so a field
 * added to one cannot be forgotten in the other.
 *
 * The template is matched field by field: a stored template one edit has
 * written, then restored in its row fields by another, still differs here, so
 * the stale save is a conflict and cannot overwrite it. An absent template
 * matches `null`, which Mongo reads as missing too.
 */
export function seriesWriteFilter(
  event: EditableEventRef,
): Record<string, unknown> {
  // A missing and an empty string read the same, as in the version token.
  const text = (value: string | null | undefined): unknown =>
    value === "" || value == null ? { $in: ["", null] } : value;
  const t = event.seriesTemplate;
  return {
    seriesStart: event.seriesStart ?? null,
    nextSpawned: { $ne: true },
    ...(t
      ? {
          "seriesTemplate.title": t.title,
          "seriesTemplate.description": text(t.description),
          "seriesTemplate.durationMinutes": t.durationMinutes,
          "seriesTemplate.timezone": text(t.timezone),
        }
      : { seriesTemplate: null }),
  };
}

/** The fields that differ, before and after, ready for the audit log. */
export interface EventEditDiff {
  before: Record<string, string | number>;
  after: Record<string, string | number>;
}

export function diffEventEdit(
  before: EventEditFields,
  after: EventEditFields,
): EventEditDiff {
  const out: EventEditDiff = { before: {}, after: {} };
  const put = (key: string, a: string | number, b: string | number): void => {
    if (a !== b) {
      out.before[key] = a;
      out.after[key] = b;
    }
  };
  put("title", before.title, after.title);
  put("description", before.description ?? "", after.description ?? "");
  put(
    "startTime",
    before.startTime.toISOString(),
    after.startTime.toISOString(),
  );
  put("timezone", before.timezone ?? "", after.timezone ?? "");
  put("durationMinutes", before.durationMinutes, after.durationMinutes);
  return out;
}

export function hasEdit(diff: EventEditDiff): boolean {
  return Object.keys(diff.after).length > 0;
}
