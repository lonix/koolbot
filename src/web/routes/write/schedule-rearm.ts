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
import { BirthdayService } from "../../../services/birthday-service.js";
import { DigestService } from "../../../services/digest-service.js";
import { EventService } from "../../../services/event-service.js";
import { LeaderboardRoleService } from "../../../services/leaderboard-role-service.js";
import { LfgService } from "../../../services/lfg-service.js";
import { MessageActivityCleanupService } from "../../../services/message-activity-cleanup.js";
import { ModerationCaseReviewService } from "../../../services/moderation-case-review-service.js";
import { NameHistoryCleanupService } from "../../../services/name-history-cleanup.js";
import { ReminderService } from "../../../services/reminder-service.js";
import { RewindNudgeService } from "../../../services/rewind-nudge-service.js";
import { RoleGroupSyncService } from "../../../services/role-group-sync-service.js";
import { VoiceChannelTruncationService } from "../../../services/voice-channel-truncation.js";
import { defaultConfig } from "../../../services/config-schema.js";

interface ScheduleRearm {
  /** Name used in the flash note when the re-arm fails. */
  label: string;
  /**
   * Keys that decide whether and when the job runs — whatever the service's
   * `isEnabled()` / `resolveSchedule()` read. Services on a fixed tick list
   * only their enable flag: a service that started disabled has no job until
   * a reload arms it (#1013).
   */
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
    label: "leaderboard roles",
    keys: ["leaderboard_roles.enabled", "leaderboard_roles.update_cron"],
    reload: (client) => LeaderboardRoleService.getInstance(client).reload(),
  },
  {
    label: "birthdays",
    keys: ["birthdays.enabled", "birthdays.cron"],
    reload: (client) => BirthdayService.getInstance(client).reload(),
  },
  {
    label: "rewind nudge",
    // `rewind.enabled` is the legacy fallback for `rewind.nudge.enabled`.
    keys: ["rewind.enabled", "rewind.nudge.enabled", "rewind.cron"],
    reload: (client) => RewindNudgeService.getInstance(client).reload(),
  },
  {
    label: "events",
    keys: ["events.enabled"],
    reload: (client) => EventService.getInstance(client).reload(),
  },
  {
    label: "reminders",
    keys: ["reminders.enabled"],
    reload: (client) => ReminderService.getInstance(client).reload(),
  },
  {
    label: "LFG",
    keys: ["lfg.enabled"],
    reload: (client) => LfgService.getInstance(client).reload(),
  },
  // Retention and housekeeping jobs (#1775). Recording reads its flag live, so
  // a feature switched on from Settings stores data at once; without a re-arm
  // the job that enforces the chosen retention stays unarmed until a restart.
  {
    label: "name history cleanup",
    // Fixed daily tick: only the enable flag matters.
    keys: ["namehistory.enabled"],
    reload: (client) => NameHistoryCleanupService.getInstance(client).reload(),
  },
  {
    label: "message activity cleanup",
    keys: [
      "messagetracking.cleanup.enabled",
      "messagetracking.cleanup.schedule",
    ],
    reload: (client) =>
      MessageActivityCleanupService.getInstance(client).reload(),
  },
  {
    label: "voice channel cleanup",
    keys: ["voicetracking.cleanup.enabled", "voicetracking.cleanup.schedule"],
    reload: (client) =>
      VoiceChannelTruncationService.getInstance(client).reload(),
  },
  {
    label: "moderation case reviews",
    // `ModerationCaseService.isEnabled()` needs both flags.
    keys: [
      "moderation.enabled",
      "moderation.cases.enabled",
      "moderation.cases.review_cron",
    ],
    reload: (client) =>
      ModerationCaseReviewService.getInstance(client).reload(),
  },
  {
    label: "role group sync",
    keys: [
      "adoption.role_groups.reconcile_enabled",
      "adoption.role_groups.reconcile_cron",
    ],
    reload: (client) => RoleGroupSyncService.getInstance(client).reload(),
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
