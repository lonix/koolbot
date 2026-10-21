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
  | { ok: false; error: string };

/**
 * Validate the core fields. `requireFuture` is true for a new event and for an
 * edit that moves the start; an edit that leaves the start alone passes false,
 * so a title fix on an event that starts soon is not refused.
 * `fallbackDuration` is used when the duration field is empty (create only).
 */
export async function validateEventForm(
  fields: EventFormFields,
  opts: { requireFuture: boolean; fallbackDuration?: number },
): Promise<EventFormResult> {
  const {
    title,
    description,
    date,
    time,
    duration,
    timezone: tzInput,
  } = fields;
  if (!title || !date || !time) {
    return { ok: false, error: "Title, date and time are all required." };
  }
  const lengthError = firstLengthError([
    { label: "Title", value: title, max: EVENT_TITLE_MAX },
    { label: "Description", value: description, max: EVENT_DESCRIPTION_MAX },
  ]);
  if (lengthError) return { ok: false, error: lengthError };
  if (tzInput && !isValidTimezone(tzInput)) {
    return { ok: false, error: `Invalid timezone: ${tzInput}` };
  }

  const config = ConfigService.getInstance();
  const configuredTz = await config.getString("events.timezone", "");
  const timezone = tzInput || configuredTz;

  const startTime = parseEventDateTime(date, time, timezone);
  if (!startTime) {
    return {
      ok: false,
      error: "Invalid date/time. Use YYYY-MM-DD and 24-hour HH:MM.",
    };
  }
  if (opts.requireFuture && startTime.getTime() <= Date.now()) {
    return { ok: false, error: "The event start time must be in the future." };
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
