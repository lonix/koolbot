/**
 * Body of the "New event" page (#1305), rendered inside `renderUserPage` at
 * `/me/events/new`: an event host creates an event of their own. Same fields and
 * names as the admin form (`renderEventsPage`), so one pipeline
 * (`event-create.ts`) reads both. Built from the shared `kb-` components
 * (docs/design/pages.md, NewEventPage); the Groups block is the shared one
 * (`renderGroupsSection`), which #1299 reworks in one place for every form.
 *
 * Nothing here decides who may create: the route's host scope does. The page
 * has no Repeat field, because a host's events do not repeat.
 */

import { escapeHtml, scriptTag } from "./html.js";
import { renderSegmented } from "./setting-controls.js";
import {
  TIMEZONE_SELECT_SCRIPT,
  renderTimezoneSelect,
} from "./setting-pickers.js";
import { groupRowsScript } from "./event-group-form.js";
import { EVENT_GROUPS_SCRIPT, renderGroupsSection } from "./admin-views.js";
import {
  splitEventFormNotice,
  type PermissionNotice,
} from "./permission-notice.js";
import {
  EVENT_WHEN_CHOICES,
  EVENT_WHEN_LABELS,
  EVENT_WHEN_SCRIPT,
  type EventWhen,
} from "./event-when.js";
import {
  EVENT_DESCRIPTION_MAX,
  EVENT_TITLE_MAX,
} from "../services/event-edit.js";
import {
  FOCUS_FIRST_INVALID_SCRIPT,
  markField,
  renderRefusalCallout,
  type EventFormRefusal,
} from "./event-field-errors.js";
import type { EventGroupPreset } from "../content/event-group-presets.js";
import type { GroupFormPrefill } from "../services/event-last-setup-service.js";

export interface NewEventViewProps {
  csrfToken: string;
  /** Resolved server zone, offered first in the timezone select. */
  timezone: string;
  /** `events.default_duration_minutes`, selected by default. */
  defaultDurationMinutes: number;
  groupLimits: { defaultCount: number; maxCount: number };
  groupPresets: readonly EventGroupPreset[];
  groupPresetsNotice: string | null;
  /** The host's last group setup, to prefill the form (#1406); absent = defaults. */
  groupRemembered?: {
    prefill: GroupFormPrefill;
    /** Null for a refused form's own rows: there is no "defaults" link to offer. */
    resetHref: string | null;
    /** The Groups switch's own state when it is not "on because there is a prefill". */
    enabled?: boolean;
  } | null;
  /** The channel category or the announcement channel is not set. */
  setupNotice?: string | null;
  /** What the bot lacks for the event features (#1478), from the registry's check. */
  permissionNotice?: PermissionNotice | null;
  /** The Bot permissions page is admin-only; a host gets a sentence instead of the link. */
  canLinkToPermissions?: boolean;
  /** The When choice that starts selected (Start now on Your events passes `now`). */
  initialWhen?: EventWhen;
  /** The server refused the last post (#1531): what to change, and in which field. */
  refusal?: EventFormRefusal | null;
  /** What was posted, put back in the fields of a refused form. */
  values?: NewEventValues;
}

/** The posted text fields of a refused form, as the host typed them. */
export interface NewEventValues {
  date: string;
  time: string;
  title: string;
  description: string;
  /** Minutes; an option of its own when it is not one of the presets. */
  durationMinutes: number;
  /** The zone posted (the select keeps it, even one the runtime does not list). */
  timezone: string;
}

/** Preset lengths, in minutes (docs/design NumberField: durations are chosen). */
const DURATION_PRESETS = [30, 45, 60, 90, 120, 180, 240] as const;

function durationOptions(selected: number): string {
  const values = [...new Set<number>([...DURATION_PRESETS, selected])].sort(
    (a, b) => a - b,
  );
  return values
    .map(
      (m) =>
        `<option value="${m}"${m === selected ? " selected" : ""}>${m} minutes</option>`,
    )
    .join("");
}

export function renderNewEventBody(props: NewEventViewProps): string {
  const refusal = props.refusal ?? null;
  const v = props.values;
  const mark = (
    field: Parameters<typeof markField>[1],
    id: string,
  ): ReturnType<typeof markField> => markField(refusal, field, id);
  const mWhen = mark("when", "new-event-when");
  const mDate = mark("date", "new-event-date");
  const mTime = mark("time", "new-event-time");
  const mZone = mark("timezone", "new-event-timezone");
  const mTitle = mark("title", "new-event-title");
  const mDesc = mark("description", "new-event-description");
  const mDuration = mark("duration", "new-event-duration");
  const mGroups = mark("groups", "new-event-groups");
  const when = renderSegmented(
    "when",
    EVENT_WHEN_CHOICES.map((value) => ({
      value,
      label: EVENT_WHEN_LABELS[value],
    })),
    props.initialWhen ?? "pick",
    {
      id: "new-event-when",
      labelledBy: "new-event-when-label",
      ...(mWhen.invalid && mWhen.errorId
        ? { invalid: true, describedBy: mWhen.errorId }
        : {}),
    },
  );
  const refusedCallout = refusal
    ? `${renderRefusalCallout(refusal, "The event was not created")}\n`
    : "";
  const notice = props.setupNotice
    ? `<div class="kb-callout kb-callout--warn" role="status"><div class="kb-callout__body"><p class="kb-callout__title">${escapeHtml(props.setupNotice)}</p><p class="kb-callout__text">Ask an admin to finish setting up Events.</p></div></div>`
    : "";
  // Findings that belong to a field sit next to it in the Groups section; the
  // rest is one block under the setup notice. Nothing is added to a page that
  // has nothing to say.
  const { block: permissionBlock, inline: permissionInline } =
    splitEventFormNotice(props.permissionNotice ?? null, {
      canLinkToPage: props.canLinkToPermissions === true,
    });
  const permissionLine = permissionBlock ? `${permissionBlock}\n` : "";
  return `<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">New event</h1>
    <p class="kb-pagehead__sub">You will be the host. Plan it for later, or start it right now and the voice channels are ready at once.</p>
  </div>
</header>
${refusedCallout}${notice}
${permissionLine}<form method="POST" action="/me/events/new" class="kb-stack" data-event-form>
  <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
  <section class="kb-panel" aria-labelledby="new-event-when-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="new-event-when-h">When</h2></header>
    <div class="kb-panel__body kb-stack">
      <div class="kb-field">
        <span class="kb-label" id="new-event-when-label">Start</span>
        ${when}${mWhen.after(8)}
        <p class="kb-help">Now starts the event at once: the channels are created straight away, the announcement says it is happening now and no reminder is sent.</p>
      </div>
      <div class="kb-fields" data-when-pick>
        <div class="kb-field">
          <label class="kb-label" for="new-event-date">Date</label>
          <input class="kb-input" id="new-event-date" type="date" name="date"${v ? ` value="${escapeHtml(v.date)}"` : ""}${mDate.attrs}>${mDate.after(10)}
        </div>
        <div class="kb-field">
          <label class="kb-label" for="new-event-time">Time (24 hours)</label>
          <input class="kb-input" id="new-event-time" type="time" name="time"${v ? ` value="${escapeHtml(v.time)}"` : ""}${mTime.attrs}>${mTime.after(10)}
        </div>
        <div class="kb-field">
          <label class="kb-label" for="new-event-timezone">Timezone</label>
          ${renderTimezoneSelect("timezone", v?.timezone ?? props.timezone, { id: "new-event-timezone", defaultZone: props.timezone, ...(mZone.errorId ? { invalid: true, describedBy: mZone.errorId } : {}) })}${mZone.after(10)}
        </div>
      </div>
    </div>
  </section>
  <section class="kb-panel" aria-labelledby="new-event-details-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="new-event-details-h">Details</h2></header>
    <div class="kb-panel__body kb-stack">
      <div class="kb-field">
        <label class="kb-label" for="new-event-title">Title</label>
        <input class="kb-input" id="new-event-title" type="text" name="title" required maxlength="${EVENT_TITLE_MAX}" placeholder="Game night"${v ? ` value="${escapeHtml(v.title)}"` : ""}${mTitle.attrs}>${mTitle.after(8)}
      </div>
      <div class="kb-field">
        <label class="kb-label" for="new-event-description">Description (optional)</label>
        <textarea class="kb-textarea" id="new-event-description" name="description" rows="3" maxlength="${EVENT_DESCRIPTION_MAX}" placeholder="What is happening?"${mDesc.attrs}>${v ? escapeHtml(v.description) : ""}</textarea>${mDesc.after(8)}
      </div>
      <div class="kb-field">
        <label class="kb-label" for="new-event-duration">Duration</label>
        <select class="kb-select" id="new-event-duration" name="duration"${mDuration.attrs}>${durationOptions(v?.durationMinutes ?? props.defaultDurationMinutes)}</select>${mDuration.after(8)}
      </div>
    </div>
  </section>
  <section class="kb-panel" aria-labelledby="new-event-groups-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="new-event-groups-h">Groups</h2></header>
    <div class="kb-panel__body">
      ${mGroups.line ? `${mGroups.line}\n      ` : ""}${renderGroupsSection(props.groupLimits, props.groupPresets, props.groupPresetsNotice, "/me/events/presets", props.groupRemembered ?? null, permissionInline)}
    </div>
  </section>
  <div class="kb-row"><button type="submit" class="kb-btn kb-btn--primary">Create event</button></div>
</form>
${scriptTag(groupRowsScript())}
${scriptTag(TIMEZONE_SELECT_SCRIPT)}
${scriptTag(EVENT_GROUPS_SCRIPT)}
${EVENT_WHEN_SCRIPT}${refusal ? `\n${scriptTag(FOCUS_FIRST_INVALID_SCRIPT)}` : ""}`;
}
