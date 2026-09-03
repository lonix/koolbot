import { formatDistanceToNow, format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import logger from "./logger.js";

/**
 * Formats a duration in milliseconds to a human-readable string
 * @param durationMs Duration in milliseconds
 * @returns Formatted duration string (e.g., "2 hours, 30 minutes")
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const remainingHours = hours % 24;
  const remainingMinutes = minutes % 60;
  const remainingSeconds = seconds % 60;

  const parts: string[] = [];

  if (days > 0) parts.push(`${days} day${days > 1 ? "s" : ""}`);
  if (remainingHours > 0)
    parts.push(`${remainingHours} hour${remainingHours > 1 ? "s" : ""}`);
  if (remainingMinutes > 0)
    parts.push(`${remainingMinutes} minute${remainingMinutes > 1 ? "s" : ""}`);
  if (remainingSeconds > 0 && parts.length === 0)
    parts.push(`${remainingSeconds} second${remainingSeconds > 1 ? "s" : ""}`);

  return parts.join(", ");
}

/**
 * Formats a date to show how long ago it was
 * @param date The date to format
 * @returns Formatted time ago string (e.g., "2 hours ago")
 */
export function formatTimeAgo(date: Date): string {
  try {
    return formatDistanceToNow(date, { addSuffix: true });
  } catch (error) {
    logger.error("Error formatting time:", error);
    return "unknown time";
  }
}

/**
 * Build the ISO-8601 week key for a date (e.g. "2026-W05").
 *
 * The year component is the ISO *week-year*, not the calendar year — near
 * year boundaries the two differ (Dec 30, 2024 is "2025-W01"), and using the
 * calendar year would collide with an unrelated week. Buckets by the UTC
 * calendar date so a key stays stable regardless of the host timezone, and
 * the two-digit zero-padded week number makes the keys sort
 * lexicographically in chronological order — which is what lets retention
 * passes prune "everything before week X" with a plain string compare.
 *
 * @param date The date to bucket
 * @returns The ISO week key, e.g. "2026-W05"
 */
export function getIsoWeekKey(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

/**
 * Formats a date to a specific timezone
 * @param date The date to format
 * @param timezone The timezone to use (e.g., "UTC", "America/New_York")
 * @returns Formatted date string in the specified timezone
 */
export function formatDateInTimezone(date: Date, timezone: string): string {
  try {
    // For UTC, we don't need to do any timezone conversion
    if (timezone === "UTC") {
      return format(date, "yyyy-MM-dd HH:mm:ss");
    }

    // For other timezones, convert from UTC to the specified timezone
    const zonedDate = toZonedTime(date, timezone);
    return format(zonedDate, "yyyy-MM-dd HH:mm:ss");
  } catch (err) {
    // Fallback to UTC if timezone is invalid
    logger.error(`Invalid timezone ${timezone}:`, err);
    return format(date, "yyyy-MM-dd HH:mm:ss");
  }
}

/**
 * Compact relative-duration units accepted by {@link parseDuration},
 * expressed in milliseconds.
 */
const DURATION_UNIT_MS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Parse a compact relative duration such as `30m`, `2h`, `3d`, `1w` or a
 * compound `1h30m` into milliseconds (#866).
 *
 * Written for the `/remind in:` option, which needs to turn a short,
 * hand-typed string into a future instant. Deliberately *not* a
 * natural-language parser: only whole numbers followed by one of
 * `m`/`h`/`d`/`w`, optionally repeated, in any order. Whitespace between
 * segments is ignored and the unit letter is case-insensitive, so
 * `1H 30M` parses the same as `1h30m`.
 *
 * Seconds are not a unit: reminders are delivered by a once-a-minute scan,
 * so a sub-minute duration would promise a precision the scheduler cannot
 * keep.
 *
 * @param input The raw user-supplied duration string
 * @returns The duration in milliseconds, or `null` when the string is not a
 *   valid duration (empty, malformed, a zero total, or numerically absurd)
 */
export function parseDuration(input: string): number | null {
  if (typeof input !== "string") return null;
  const compact = input.replace(/\s+/g, "").toLowerCase();
  if (compact.length === 0) return null;

  // Anchored so trailing junk ("2hx") and bare numbers ("90") are rejected
  // rather than silently parsed as their leading valid segment.
  if (!/^(\d+[mhdw])+$/.test(compact)) return null;

  let total = 0;
  for (const [, amount, unit] of compact.matchAll(/(\d+)([mhdw])/g)) {
    const value = Number(amount);
    // A duration long enough to overflow this check is nonsense input, and
    // letting it through would produce an invalid Date downstream.
    if (!Number.isSafeInteger(value)) return null;
    total += value * DURATION_UNIT_MS[unit];
    if (!Number.isSafeInteger(total)) return null;
  }

  return total > 0 ? total : null;
}
