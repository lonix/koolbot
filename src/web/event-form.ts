/**
 * The one validator of the event form's core fields (title, description, date,
 * time, duration, timezone), shared by "create event" (`routes/write/events.ts`)
 * and "edit event" (`routes/host-events.ts`, #1298) so the two can never drift:
 * same limits, same wording.
 */

import {
  EVENT_DESCRIPTION_MAX,
  EVENT_DURATION_MAX,
  EVENT_DURATION_MIN,
  EVENT_TITLE_MAX,
} from "../services/event-edit.js";
import { parseEventDateTime } from "../services/event-service.js";
import { ConfigService } from "../services/config-service.js";
import { isValidTimezone, resolveTimezone } from "../utils/timezone.js";
import { parseIntInRange } from "./routes/write/helpers.js";
import type { EventFormField } from "./event-field-errors.js";

/** The posted fields, already trimmed (as `getString` returns them). */
export interface EventFormFields {
  title: string;
  description: string;
  date: string;
  time: string;
  duration: string;
  timezone: string;
}

export type EventFormResult =
  | {
      ok: true;
      value: {
        title: string;
        description: string;
        startTime: Date;
        /** The zone as stored on the event (resolved, never empty). */
        timezone: string;
        durationMinutes: number;
      };
    }
  | {
      ok: false;
      /** What to change, in the host's terms. */
      error: string;
      /** The field the refusal is about; absent when it is not about one. */
      field?: EventFormField;
    };

const refuse = (
  field: EventFormField,
  error: string,
): { ok: false; error: string; field: EventFormField } => ({
  ok: false,
  error,
  field,
});

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^\d{2}:\d{2}$/;
const TIME_IN_RANGE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_RANGE_MESSAGE = "Pick a time between 00:00 and 23:59.";

/**
 * Validate the core fields. `requireFuture` is true for a new event and for an
 * edit that moves the start; an edit that leaves the start alone passes false,
 * so a title fix on an event that starts soon is not refused.
 * `fallbackDuration` is used when the duration field is empty (create only).
 */
export async function validateEventForm(
  fields: EventFormFields,
  opts: {
    requireFuture: boolean;
    fallbackDuration?: number;
    /**
     * A start decided by the "When" choice (#1305): the date and time fields
     * are then neither required nor read. Still checked to be in the future.
     */
    startOverride?: Date;
  },
): Promise<EventFormResult> {
  const {
    title,
    description,
    date,
    time,
    duration,
    timezone: tzInput,
  } = fields;
  if (!title) return refuse("title", "Enter a title.");
  if (!opts.startOverride) {
    if (!date) return refuse("date", "Pick a date.");
    if (!time) return refuse("time", "Enter a time, for example 19:30.");
  }
  if (title.length > EVENT_TITLE_MAX) {
    return refuse(
      "title",
      `Use at most ${EVENT_TITLE_MAX} characters for the title.`,
    );
  }
  if (description.length > EVENT_DESCRIPTION_MAX) {
    return refuse(
      "description",
      `Use at most ${EVENT_DESCRIPTION_MAX} characters for the description.`,
    );
  }
  if (tzInput && !isValidTimezone(tzInput)) {
    return refuse("timezone", "Pick a timezone from the list.");
  }

  const config = ConfigService.getInstance();
  const configuredTz = await config.getString("events.timezone", "");
  const timezone = tzInput || configuredTz;

  // A clock value out of range names the time field, whatever the parser makes of it.
  if (
    !opts.startOverride &&
    DATE_SHAPE.test(date) &&
    TIME_SHAPE.test(time) &&
    !TIME_IN_RANGE.test(time)
  ) {
    return refuse("time", TIME_RANGE_MESSAGE);
  }
  const startTime =
    opts.startOverride ?? parseEventDateTime(date, time, timezone);
  if (!startTime) {
    return !DATE_SHAPE.test(date)
      ? refuse("date", "Use the date format YYYY-MM-DD.")
      : !TIME_SHAPE.test(time)
        ? refuse("time", "Use 24-hour time as HH:MM, for example 19:30.")
        : !TIME_IN_RANGE.test(time)
          ? refuse("time", TIME_RANGE_MESSAGE)
          : refuse("date", "That date and time do not exist. Pick another.");
  }
  if (opts.requireFuture && startTime.getTime() <= Date.now()) {
    // A start decided by the When choice has no date field to mark.
    return refuse(
      opts.startOverride ? "when" : "date",
      "Pick a time in the future.",
    );
  }

  let durationMinutes =
    opts.fallbackDuration ??
    (await config.getNumber("events.default_duration_minutes", 120));
  if (duration) {
    const parsed = parseIntInRange(
      duration,
      EVENT_DURATION_MIN,
      EVENT_DURATION_MAX,
    );
    if (parsed === null) {
      return refuse(
        "duration",
        /^\d+$/.test(duration) && Number(duration) > EVENT_DURATION_MAX
          ? `At most ${EVENT_DURATION_MAX} minutes.`
          : `Enter a whole number of minutes, from ${EVENT_DURATION_MIN} to ${EVENT_DURATION_MAX}.`,
      );
    }
    durationMinutes = parsed;
  }

  return {
    ok: true,
    value: {
      title,
      description,
      startTime,
      timezone: resolveTimezone(timezone),
      durationMinutes,
    },
  };
}
