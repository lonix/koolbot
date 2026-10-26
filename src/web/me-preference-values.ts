/**
 * The one-line value each preference card on `/me/` shows ("Europe/Oslo ·
 * 10:59 now", "2 of 3 on"), so a member sees how a preference is set without
 * opening it (DESIGN.md Principles 3, docs/design/pages.md MemberOverviewPage).
 *
 * Pure functions: the route reads the stored values and passes them in, the
 * layout escapes the text. Every function returns plain text.
 */

import { formatInZone, isValidTimezone } from "../utils/timezone.js";
import { MONTH_NAMES } from "./user-layout.js";

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "2 of 3 on", or "None of 3 on" when no DM is switched on. */
export function notificationsValue(on: number, offered: number): string {
  if (offered <= 0) return "";
  return on === 0 ? `None of ${offered} on` : `${on} of ${offered} on`;
}

/**
 * "Europe/Oslo · 10:59 now", or "Server default (Europe/Oslo) · 10:59 now"
 * while the member has not chosen a zone. The clock is the time in that zone
 * at `now`.
 */
export function timezoneValue(
  stored: string | null,
  serverTimezone: string,
  now: Date,
): string {
  const own = stored && isValidTimezone(stored) ? stored : null;
  const zone = own ?? serverTimezone;
  const clock = formatInZone(now, zone, "HH:mm");
  return own
    ? `${own} · ${clock} now`
    : `Server default (${serverTimezone}) · ${clock} now`;
}

/**
 * The name pattern, or "Server default naming" while none is set, then the
 * number of saved presets ("2 presets", "No presets").
 */
export function voiceValue(
  namePattern: string | null,
  presetCount: number,
): string {
  const name = namePattern ? namePattern : "Server default naming";
  const presets =
    presetCount > 0
      ? `${presetCount} ${plural(presetCount, "preset", "presets")}`
      : "No presets";
  return `${name} · ${presets}`;
}

/** "14 March", or "Not set". The birth year is not repeated on the overview. */
export function birthdayValue(
  birthday: { month: number; day: number } | null,
): string {
  if (!birthday) return "Not set";
  const month = MONTH_NAMES[birthday.month - 1];
  return month ? `${birthday.day} ${month}` : "Not set";
}

/** "Opted out" or "Tracking on" for the member's activity tracking. */
export function privacyValue(optedOut: boolean): string {
  return optedOut ? "Opted out of tracking" : "Tracking on";
}
