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
import { firstLengthError, parseIntInRange } from "./routes/write/helpers.js";

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
      error: string;
      /**
       * The same refusal by form field (`title`, `description`, `date`, `time`,
       * `duration`), worded to read under the field, for a page that marks it
       * (#1523). Empty when it is about no one field (the timezone). All
       * missing fields are named here; `error` is the first, as before.
       */
      fields?: Record<string, string>;
    };

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
  if (opts.startOverride ? !title : !title || !date || !time) {
    const fields: Record<string, string> = {};
    if (!title) fields.title = "Enter a title.";
    if (!opts.startOverride && !date) fields.date = "Pick a date.";
    if (!opts.startOverride && !time) {
      fields.time = "Enter a time, for example 19:30.";
    }
    return {
      ok: false,
      error: opts.startOverride
        ? "A title is required."
        : "Title, date and time are all required.",
      fields,
    };
  }
  const lengthError = firstLengthError([
    { label: "Title", value: title, max: EVENT_TITLE_MAX },
    { label: "Description", value: description, max: EVENT_DESCRIPTION_MAX },
  ]);
  if (lengthError) {
    const fields: Record<string, string> = {};
    if (title.length > EVENT_TITLE_MAX) {
      fields.title = `At most ${EVENT_TITLE_MAX} characters.`;
    }
    if (description.length > EVENT_DESCRIPTION_MAX) {
      fields.description = `At most ${EVENT_DESCRIPTION_MAX} characters.`;
    }
    return { ok: false, error: lengthError, fields };
  }
  if (tzInput && !isValidTimezone(tzInput)) {
    return { ok: false, error: `Invalid timezone: ${tzInput}`, fields: {} };
  }

  const config = ConfigService.getInstance();
  const configuredTz = await config.getString("events.timezone", "");
  const timezone = tzInput || configuredTz;

  const startTime =
    opts.startOverride ?? parseEventDateTime(date, time, timezone);
  if (!startTime) {
    // The date alone parses (at noon) or it does not: say which of the two.
    const dateOk = parseEventDateTime(date, "12:00", timezone) !== null;
    return {
      ok: false,
      error: "Invalid date/time. Use YYYY-MM-DD and 24-hour HH:MM.",
      fields: dateOk
        ? { time: "Use 24-hour time, for example 19:30." }
        : { date: "Use a date like 2026-05-01." },
    };
  }
  if (opts.requireFuture && startTime.getTime() <= Date.now()) {
    return {
      ok: false,
      error: "The event start time must be in the future.",
      fields: opts.startOverride
        ? {}
        : { date: "The start time must be in the future." },
    };
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
      return {
        ok: false,
        error: `Duration must be between ${EVENT_DURATION_MIN} and ${EVENT_DURATION_MAX} minutes.`,
        fields: {
          duration: `Use ${EVENT_DURATION_MIN} to ${EVENT_DURATION_MAX} minutes.`,
        },
      };
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
