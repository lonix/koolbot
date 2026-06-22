/**
 * Timezone helpers for the per-user display-timezone preference (#524).
 *
 * Validation leans on the runtime's own IANA database via
 * `Intl.supportedValuesOf("timeZone")` (Node 22+) so we never bundle a
 * timezone list. Formatting goes through `date-fns-tz` — already a
 * production dependency — so call-sites can render a `Date` in an
 * arbitrary zone without mutating global state.
 *
 * "Unset" always falls back to the host/server timezone, so users who
 * never configure a zone see no change in behaviour.
 */

import { formatInTimeZone } from "date-fns-tz";
import logger from "./logger.js";

let cachedZones: Set<string> | null = null;

/** All IANA zone identifiers known to this runtime, cached. */
function supportedZones(): Set<string> {
  if (cachedZones) return cachedZones;
  try {
    const values = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    cachedZones = new Set(values ?? []);
  } catch (err) {
    logger.warn("Intl.supportedValuesOf('timeZone') unavailable", err);
    cachedZones = new Set();
  }
  return cachedZones;
}

/** Sorted list of every IANA zone, for populating a `<select>`. */
export function listSupportedTimezones(): string[] {
  return [...supportedZones()].sort();
}

/**
 * True when `tz` is a recognized IANA timezone identifier. Prefers the
 * enumerated set; if that API is unavailable, falls back to probing the
 * `Intl.DateTimeFormat` constructor (which throws on unknown zones).
 */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false;
  // Fast path: zones enumerated by the runtime. This set drives the
  // dropdown but is not exhaustive — it omits a few valid aliases such
  // as "UTC" / "GMT" — so fall through to the authoritative constructor
  // probe, which throws a RangeError on an unknown zone.
  if (supportedZones().has(tz)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The host/server timezone — the fallback for users with no preference. */
export function getServerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Resolve a possibly-unset/invalid user timezone to a usable IANA zone,
 * falling back to the server timezone.
 */
export function resolveTimezone(tz?: string | null): string {
  return tz && isValidTimezone(tz) ? tz : getServerTimezone();
}

/** Format `date` in the resolved zone with a `date-fns` format string. */
export function formatInZone(
  date: Date,
  tz: string | null | undefined,
  fmt: string,
): string {
  return formatInTimeZone(date, resolveTimezone(tz), fmt);
}

/**
 * `YYYY-MM-DD` for `date` in an explicit zone. Used by the Rewind
 * day-grouping helpers, which only call this when a zone is actually
 * set — unset users keep the existing UTC grouping.
 */
export function isoDateInZone(date: Date, tz: string): string {
  return formatInTimeZone(date, tz, "yyyy-MM-dd");
}

/**
 * Wall-clock hour (0–23) for `date` in an explicit IANA zone. Used by the
 * time-of-day accolades (Night Owl / Early Bird) so their hour windows are
 * evaluated in the user's local time rather than UTC (#658). Callers pass
 * `"UTC"` for users with no timezone preference.
 */
export function hourInZone(date: Date, tz: string): number {
  return Number(formatInTimeZone(date, tz, "H"));
}

/**
 * Day of week for `date` in an explicit IANA zone, using JS
 * `Date.getDay()` numbering (0 = Sunday … 6 = Saturday) so it drops in for
 * the previous `getUTCDay()` calls in the day-of-week accolades (#658).
 */
export function dayOfWeekInZone(date: Date, tz: string): number {
  // date-fns "i" is ISO day-of-week (1 = Mon … 7 = Sun); map Sunday → 0.
  return Number(formatInTimeZone(date, tz, "i")) % 7;
}

/**
 * Seconds elapsed since the start of the current wall-clock hour in `tz`.
 * Lets the hour-window accolade walk align its segments to local-hour
 * boundaries even in zones with sub-hour offsets (#658).
 */
export function secondsIntoHourInZone(date: Date, tz: string): number {
  const [minute, second] = formatInTimeZone(date, tz, "m:s")
    .split(":")
    .map(Number);
  return minute * 60 + second;
}

/**
 * Render a date+time plus the resolved zone name, e.g.
 * `2026-06-12 14:30 (Europe/London)`. Used where a bare timestamp would
 * otherwise be ambiguous (e.g. `/voicestats user`).
 */
export function formatDateTimeInZone(date: Date, tz?: string | null): string {
  const zone = resolveTimezone(tz);
  return `${formatInTimeZone(date, zone, "yyyy-MM-dd HH:mm")} (${zone})`;
}
