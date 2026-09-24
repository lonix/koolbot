/**
 * Re-arm scheduled services after a settings write (#976).
 *
 * `ConfigService.set` deliberately never reloads anything, and the
 * `ScheduledService` reload callback only fires on `/config reload`. So a
 * schedule saved from the Web UI used to sit in the database until the next
 * restart. The settings write routes call {@link rearmScheduledServices} with
 * the keys they changed; a service whose enable flag or cron key is among them
 * is reloaded, which stops its job and arms it again from the new values.
 */

import type { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { DigestService } from "../../../services/digest-service.js";
import { BirthdayService } from "../../../services/birthday-service.js";
import { LeaderboardRoleService } from "../../../services/leaderboard-role-service.js";
import { defaultConfig } from "../../../services/config-schema.js";

interface ScheduleRearm {
  /** Name used in the flash note when the re-arm fails. */
  label: string;
  /** Keys that decide whether and when the job runs. */
  keys: readonly string[];
  reload: (client: Client) => Promise<void>;
}

const SCHEDULE_REARMS: readonly ScheduleRearm[] = [
  {
    label: "weekly digest",
    keys: ["digest.enabled", "digest.cron"],
    reload: (client) => DigestService.getInstance(client).reload(),
  },
  {
    label: "birthday check",
    keys: ["birthdays.enabled", "birthdays.cron"],
    reload: (client) => BirthdayService.getInstance(client).reload(),
  },
  {
    label: "leaderboard roles",
    keys: ["leaderboard_roles.enabled", "leaderboard_roles.update_cron"],
    reload: (client) => LeaderboardRoleService.getInstance(client).reload(),
  },
];

/**
 * Reload every scheduled service whose schedule keys are among `changedKeys`.
 * Never throws: a failed reload is logged and its label returned, so the
 * caller can tell the operator the new schedule is saved but not yet armed.
 */
export async function rearmScheduledServices(
  client: Client,
  changedKeys: readonly string[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const rearm of SCHEDULE_REARMS) {
    if (!rearm.keys.some((k) => changedKeys.includes(k))) continue;
    try {
      await rearm.reload(client);
    } catch (err) {
      logger.error(`Failed to re-arm ${rearm.label} after settings save`, err);
      failed.push(rearm.label);
    }
  }
  return failed;
}

/**
 * Whether a write actually changed a key's effective value. Feature cards
 * submit every row on each save, so a threshold-only edit still re-posts the
 * unchanged enable flag and cron; comparing lets those saves leave the live
 * schedule alone instead of stopping and re-arming it. `before` is the stored
 * value, or null when nothing was stored (the schema default then applies).
 * Compared as strings because a stored value may predate type coercion.
 */
export function effectiveValueChanged(
  key: string,
  before: unknown,
  after: unknown,
): boolean {
  const fallback = defaultConfig[key as keyof typeof defaultConfig];
  return String(before ?? fallback) !== String(after ?? fallback);
}

/** Flash suffix for {@link rearmScheduledServices} failures ("" when none). */
export function rearmFailureNote(failed: readonly string[]): string {
  if (failed.length === 0) return "";
  return ` The ${failed.join(", ")} schedule could not be re-armed — it takes effect after /config reload or a restart.`;
}
