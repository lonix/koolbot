import { Client, Guild, TextChannel } from "discord.js";
import { formatInTimeZone } from "date-fns-tz";
import { ScheduledService } from "./scheduled-service.js";
import { UserNotificationPrefsService } from "./user-notification-prefs-service.js";
import { DiscordLogger } from "./discord-logger.js";
import { UserBirthday, type IUserBirthday } from "../models/user-birthday.js";
import { resolveTimezone } from "../utils/timezone.js";
import { getErrorMessage } from "../utils/error-guards.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import {
  isUnknownChannelError,
  isUnknownMessageError,
} from "../utils/discord.js";
import { fetchMemberOrNull } from "../utils/moderation-guards.js";

/**
 * Birthday celebrations service (#657).
 *
 * The cron lifecycle — arming the job, coalescing runs, reloading on
 * `/config reload` — comes from `ScheduledService`.
 *
 * The job runs on a sub-daily cadence (hourly by default) and, for each
 * member with a birthday on file, decides whether "today" matches in
 * **that member's** timezone (`UserNotificationPrefs.timezone`, #524).
 * `lastAnnouncedYear` — keyed to the member's local year — makes the
 * post idempotent regardless of how often the cron fires or whether the
 * process restarted mid-day.
 */

const DEFAULT_CRON = "0 * * * *"; // top of every hour
const DEFAULT_MESSAGE = "🎂 Happy birthday, {user}! 🎉";
const DEFAULT_ROLE_DURATION_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

export interface BirthdayInput {
  month: number;
  day: number;
  year?: number | null;
}

export interface StoredBirthday {
  month: number;
  day: number;
  year: number | null;
}

/** What a per-user birthday purge did (#916). */
export interface BirthdayPurgeResult {
  /** Birthday rows the member had in this guild. */
  matched: number;
  /** Of those, the ones deleted. */
  removed: number;
  /** Whether a live birthday-role grant was taken back on Discord. */
  roleRevoked: boolean;
  /** Recorded birthday posts about the member that the purge tried to delete. */
  announcementsAttempted: number;
  /** Of those, the ones confirmed gone from Discord. */
  announcementsDeleted: number;
  /**
   * Of those, the ones that may still be public. The row is kept when this
   * is non-zero — it holds the only ids by which those posts can ever be
   * found — so a retry can finish the job.
   */
  announcementsFailed: number;
  /** Why the purge is incomplete, when it is. */
  error?: string;
}

/**
 * How many read/revoke/delete passes a purge will make before giving up. A
 * pass only repeats when the scheduled run wrote a new role marker between
 * the read and the delete, which cannot keep happening.
 */
const MAX_PURGE_ATTEMPTS = 3;

export interface BirthdayRunSummary {
  ranAt: Date;
  candidates: number;
  announced: number;
  rolesGranted: number;
  rolesRemoved: number;
  failed: number;
}

/** Days in each (1-based) month, treating February as 29 so leap-day
 * birthdays are storable; the announcer handles the non-leap-year case. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Gregorian leap-year test. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Validate a calendar month/day pair. Accepts Feb 29 unconditionally
 * (it's a real birth date); the announcer decides when to celebrate it
 * in non-leap years.
 */
export function isValidMonthDay(month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= DAYS_IN_MONTH[month - 1];
}

/**
 * The local calendar Y/M/D for `date` in an IANA `timezone`. Used to ask
 * "is it the member's birthday today in their own zone?" so the post
 * fires on their local day, not the host's (#524).
 */
export function localYmdInZone(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const iso = formatInTimeZone(date, timezone, "yyyy-MM-dd");
  const [year, month, day] = iso.split("-").map((n) => Number.parseInt(n, 10));
  return { year, month, day };
}

/**
 * Whether `birthday` falls on the given local calendar date. A Feb 29
 * birthday celebrates on Mar 1 in non-leap years so leap-day members
 * aren't skipped three years out of four.
 */
export function isBirthdayToday(
  birthday: { month: number; day: number },
  local: { year: number; month: number; day: number },
): boolean {
  if (birthday.month === local.month && birthday.day === local.day) {
    return true;
  }
  if (
    birthday.month === 2 &&
    birthday.day === 29 &&
    !isLeapYear(local.year) &&
    local.month === 3 &&
    local.day === 1
  ) {
    return true;
  }
  return false;
}

/**
 * Whether the bot should announce `birthday` given the current local
 * date. Combines the "is it today (in the member's zone)" test with the
 * once-per-local-year idempotency guard, so a restart or a sub-daily
 * cron cadence can't double-post. Kept pure for direct unit testing.
 */
export function shouldAnnounceBirthday(
  birthday: {
    month: number;
    day: number;
    lastAnnouncedYear?: number | null;
  },
  local: { year: number; month: number; day: number },
): boolean {
  if (!isBirthdayToday(birthday, local)) return false;
  return birthday.lastAnnouncedYear !== local.year;
}

function rowToStored(row: IUserBirthday): StoredBirthday {
  return {
    month: row.month,
    day: row.day,
    year: typeof row.year === "number" ? row.year : null,
  };
}

/**
 * Fill the `{user}` / `{username}` / `{age}` placeholders in a birthday
 * message template. `{user}` is a real mention (`<@id>`); whether it
 * pings is decided by the caller's `allowedMentions`. `{age}` resolves
 * to the empty string (and is tidied up) when no birth year is on file.
 */
export function renderBirthdayMessage(
  template: string,
  args: { userId: string; displayName: string; age: number | null },
): string {
  const ageText = args.age !== null ? String(args.age) : "";
  let result = template
    .split("{user}")
    .join(`<@${args.userId}>`)
    .split("{username}")
    .join(args.displayName)
    .split("{age}")
    .join(ageText);
  // If the template referenced {age} but we have no year, collapse the
  // now-empty spots (e.g. "turns  today" → "turns today").
  if (args.age === null) {
    result = result.replace(/\s{2,}/g, " ").trim();
  }
  return result;
}

export class BirthdayService extends ScheduledService<BirthdayRunSummary | null> {
  private static instance: BirthdayService;

  private constructor(client: Client) {
    super(client, {
      label: "Birthday service",
      disabledMessage: "Birthdays are disabled",
      cronContext: "birthdays",
      runLabel: "Birthday run",
    });
  }

  protected async isEnabled(): Promise<boolean> {
    return this.configService.getBoolean("birthdays.enabled", false);
  }

  protected async resolveSchedule(): Promise<string> {
    return this.configService.getString("birthdays.cron", DEFAULT_CRON);
  }

  public static getInstance(client: Client): BirthdayService {
    if (!BirthdayService.instance) {
      BirthdayService.instance = new BirthdayService(client);
    } else if (BirthdayService.instance.client !== client) {
      throw new Error(
        "BirthdayService already initialised with a different client",
      );
    }
    return BirthdayService.instance;
  }

  public static reset(): void {
    if (BirthdayService.instance) {
      BirthdayService.instance.destroy();
    }
    BirthdayService.instance = undefined as unknown as BirthdayService;
  }

  // ---------------------------------------------------------------
  // Storage (used by the /me/birthday WebUI surface)
  // ---------------------------------------------------------------

  /**
   * Read the stored birthday for a member, or `null` when none is set
   * (or on a read error — birthdays are non-critical, so we degrade to
   * "not set" rather than surfacing the error to the page).
   */
  public async getBirthday(
    userId: string,
    guildId: string,
  ): Promise<StoredBirthday | null> {
    if (!userId || !guildId) return null;
    try {
      const row = await UserBirthday.findOne({ userId, guildId });
      return row ? rowToStored(row) : null;
    } catch (err) {
      logger.error("Failed to load birthday", err);
      return null;
    }
  }

  /**
   * Set a member's birthday. The month/day are validated against the
   * calendar (Feb 29 allowed); the year, when present, must be a plausible
   * four-digit value not in the future. Resets `lastAnnouncedYear` so a
   * corrected date can still fire this year. Returns the stored value.
   *
   * There is deliberately no "clear" mode: removing a birthday must go
   * through `purgeForUser`, which takes back a live birthday role and the
   * bot's posts before deleting the row that records them (#916, #1033).
   */
  public async setBirthday(
    userId: string,
    guildId: string,
    input: BirthdayInput,
  ): Promise<StoredBirthday> {
    if (!userId) throw new Error("userId required");
    if (!guildId) throw new Error("guildId required");

    const { month, day } = input;
    if (!isValidMonthDay(month, day)) {
      throw new Error(`"${month}/${day}" is not a valid month/day`);
    }

    let year: number | undefined;
    if (input.year !== null && input.year !== undefined) {
      const currentYear = new Date().getUTCFullYear();
      if (
        !Number.isInteger(input.year) ||
        input.year < 1900 ||
        input.year > currentYear
      ) {
        throw new Error(`"${input.year}" is not a valid birth year`);
      }
      year = input.year;
    }

    const update: Record<string, unknown> = {
      $set: { month, day, updatedAt: new Date() },
      // A changed date should be eligible again this year.
      $unset: { lastAnnouncedYear: "" } as Record<string, unknown>,
    };
    if (year !== undefined) {
      (update.$set as Record<string, unknown>).year = year;
    } else {
      (update.$unset as Record<string, unknown>).year = "";
    }

    const row = await UserBirthday.findOneAndUpdate(
      { userId, guildId },
      update,
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );
    return row ? rowToStored(row) : { month, day, year: year ?? null };
  }

  // ---------------------------------------------------------------
  // Cron lifecycle
  // ---------------------------------------------------------------

  protected async runOnce(): Promise<BirthdayRunSummary | null> {
    const guildId = await this.configService.getString("GUILD_ID", "");
    if (!guildId) {
      logger.error("Birthday run aborted: GUILD_ID not configured");
      return null;
    }

    const channelId = await this.configService.getString(
      "birthdays.channel_id",
      "",
    );
    if (!channelId) {
      logger.warn("Birthday run aborted: birthdays.channel_id not configured");
      return null;
    }

    // Both fetches reject rather than resolving null when the id is stale or
    // the bot lacks access, so the guards below only ever run if the rejection
    // is converted first. Mirrors `EventService`'s scan.
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      logger.error(`Birthday run aborted: guild ${guildId} not found`);
      return null;
    }

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !(channel instanceof TextChannel)) {
      logger.error(
        `Birthday run aborted: channel ${sanitizeForLog(channelId)} not found or not a text channel`,
      );
      return null;
    }

    const messageTemplate = await this.configService.getString(
      "birthdays.message",
      DEFAULT_MESSAGE,
    );
    const mention = await this.configService.getBoolean(
      "birthdays.mention",
      true,
    );
    const roleId = await this.configService.getString("birthdays.role_id", "");
    const roleDurationHours = await this.configService.getNumber(
      "birthdays.role_duration_hours",
      DEFAULT_ROLE_DURATION_HOURS,
    );

    const summary: BirthdayRunSummary = {
      ranAt: new Date(),
      candidates: 0,
      announced: 0,
      rolesGranted: 0,
      rolesRemoved: 0,
      failed: 0,
    };

    // 1. Revoke expired birthday roles first so a member whose window
    //    closed loses the role even if no one has a birthday today.
    //    Unconditionally: each row records the role it was granted
    //    (`roleAssignedId`), so clearing `birthdays.role_id` must not strand
    //    the grants already out there — the sweep is the only thing that
    //    ever takes them back (#916). The configured id stays as the
    //    fallback for rows written before that field existed.
    summary.rolesRemoved += await this.sweepExpiredRoles(
      guild,
      guildId,
      roleId,
      Math.max(0, roleDurationHours) * MS_PER_HOUR,
      summary.ranAt,
    );

    // 2. Announce today's birthdays (in each member's own timezone).
    const prefsService = UserNotificationPrefsService.getInstance();
    const rows = await UserBirthday.find({ guildId });
    summary.candidates = rows.length;

    for (const row of rows) {
      try {
        const tz = resolveTimezone(
          await prefsService.getTimezone(row.userId, guildId),
        );
        const local = localYmdInZone(summary.ranAt, tz);
        if (!shouldAnnounceBirthday(row, local)) continue;

        const member = await guild.members.fetch(row.userId).catch(() => null);
        if (!member) {
          // Member left the guild — mark as announced so we don't
          // retry every tick, and skip.
          row.lastAnnouncedYear = local.year;
          await row.save();
          continue;
        }

        const age = typeof row.year === "number" ? local.year - row.year : null;
        const content = renderBirthdayMessage(messageTemplate, {
          userId: row.userId,
          displayName: member.displayName,
          age,
        });

        const announcement = await channel.send({
          content,
          allowedMentions: mention ? { users: [row.userId] } : { parse: [] },
        });
        summary.announced += 1;

        if (roleId) {
          const granted = await this.grantBirthdayRole(member, roleId);
          if (granted) {
            row.roleAssignedAt = summary.ranAt;
            // Which role, not just when: the configured id can change while
            // this grant is live (#916).
            row.roleAssignedId = roleId;
            summary.rolesGranted += 1;
          }
        }

        row.lastAnnouncedYear = local.year;
        // Record the post so a later per-user purge can take it down. It
        // names the member and often their age, and nothing else on the
        // server knows the bot wrote it (#916).
        row.announcements = [
          ...(row.announcements ?? []),
          {
            channelId: channel.id,
            messageId: announcement.id,
            year: local.year,
          },
        ];
        // If the row was purged while this run was working (#916) — or the
        // write simply failed — nothing persisted records what this
        // iteration just did: the grant above would have no marker, so the
        // expiry sweep could never find it and the role would sit on the
        // member for good.
        const persisted = await this.saveRunRow(row);
        if (!persisted) {
          // Everything this iteration produced is now the member's data with
          // no row behind it: the announcement names them (and often their
          // age) in a public channel, and the role has no marker for the
          // sweep to find. Both come back.
          logger.warn(
            `Birthday bookkeeping for ${sanitizeForLog(row.userId)} did not persist; withdrawing the announcement and any role just granted`,
          );
          const withdrawn = await announcement
            .delete()
            .then(() => true)
            .catch((error) => {
              logger.error(
                `Failed to withdraw the birthday announcement for ${sanitizeForLog(row.userId)}; it is still public:`,
                error,
              );
              return false;
            });
          if (withdrawn) {
            summary.announced -= 1;
          } else {
            // The message is still up, naming a member who just erased their
            // data. Counting it as withdrawn would let the summary read
            // "0 announced, 0 failed" over a live privacy failure.
            summary.failed += 1;
          }
          if (roleId && row.roleAssignedAt) {
            if (
              await this.revokeBirthdayRole(row.guildId, row.userId, roleId)
            ) {
              summary.rolesGranted -= 1;
            } else {
              // The grant stands and its row is gone, so nothing will ever
              // sweep it. There is no row left to record a retry against —
              // re-creating one would restore data the member just erased —
              // so the loudest available signal is the honest one.
              summary.failed += 1;
              logger.error(
                `Birthday role for ${sanitizeForLog(row.userId)} could not be taken back after their data was reset mid-run; it is stranded on the member and no sweep can find it`,
              );
            }
          }
        }
      } catch (error) {
        summary.failed += 1;
        logger.error(
          `Error processing birthday for user ${sanitizeForLog(row.userId)}:`,
          error,
        );
      }
    }

    logger.info(
      `Birthday run complete: candidates=${summary.candidates} announced=${summary.announced} ` +
        `roles_granted=${summary.rolesGranted} roles_removed=${summary.rolesRemoved} failed=${summary.failed}`,
    );
    await this.logSummary(summary);
    return summary;
  }

  /**
   * Remove the temporary birthday role from every member whose grant has
   * aged past `durationMs`. Durable across restarts because the grant
   * time lives on the row, not in memory. Returns the count removed.
   */
  /**
   * Erase a member's birthday and take back any live birthday role (#916).
   *
   * **The role has to go first, and this cannot be a raw `deleteMany`.**
   * `sweepExpiredRoles` finds grants to revoke by querying
   * `UserBirthday.roleAssignedAt` — that row *is* the only record that the
   * role was ever handed out. Delete it while a grant is live and the sweep
   * can never find it again: the member keeps the birthday role permanently
   * and nothing will ever take it off. Same trap as the leaderboard reward
   * roles (#914), same order of operations.
   *
   * A failed revoke leaves the row in place so the sweep still expires it
   * later, and is reported as an incomplete purge rather than swallowed.
   *
   * Nothing here throws: a revoke that succeeded before a later step failed
   * is exactly the state the caller must be told about, and a rejection
   * would collapse it into a bare 0/0 in the purge report.
   */
  public async purgeForUser(
    guildId: string,
    userId: string,
  ): Promise<BirthdayPurgeResult> {
    let roleRevoked = false;
    let lastPass: BirthdayPurgeResult | null = null;

    for (let attempt = 0; attempt < MAX_PURGE_ATTEMPTS; attempt++) {
      const { retry, ...pass } = await this.purgeAttempt(guildId, userId);
      roleRevoked = roleRevoked || pass.roleRevoked;
      // The posts are *not* summed across passes. Each pass re-reads the
      // same `announcements` list — it stays on the row until the delete
      // lands — so a post taken down on the first pass comes back as an
      // Unknown Message on the next and would be counted again. The latest
      // pass already covers every recorded post, so its counts are the
      // whole picture (#916).
      lastPass = { ...pass, roleRevoked };
      if (!retry) return lastPass;

      // The row changed under us — the scheduled run granted a role and
      // wrote its marker between our read and our delete. Go round again
      // against the new state so that grant is revoked rather than orphaned.
      logger.warn(
        `Birthday purge for ${sanitizeForLog(userId)}: the row changed mid-purge; retrying`,
      );
    }

    return {
      matched: 1,
      removed: 0,
      roleRevoked,
      announcementsAttempted: lastPass?.announcementsAttempted ?? 0,
      announcementsDeleted: lastPass?.announcementsDeleted ?? 0,
      announcementsFailed: lastPass?.announcementsFailed ?? 0,
      error: `the birthday row kept changing mid-purge; gave up after ${MAX_PURGE_ATTEMPTS} attempts, so the expiry sweep still owns any live grant`,
    };
  }

  /**
   * One read/revoke/delete pass. `retry` means the conditional delete found
   * the row had changed since the read, so nothing was removed and the
   * caller should try again against the new state.
   */
  private async purgeAttempt(
    guildId: string,
    userId: string,
  ): Promise<BirthdayPurgeResult & { retry: boolean }> {
    const none = {
      announcementsAttempted: 0,
      announcementsDeleted: 0,
      announcementsFailed: 0,
    };

    let rows: IUserBirthday[];
    try {
      rows = await UserBirthday.find({ userId, guildId });
    } catch (error) {
      return {
        matched: 0,
        removed: 0,
        roleRevoked: false,
        retry: false,
        ...none,
        error: getErrorMessage(error),
      };
    }
    if (rows.length === 0) {
      return {
        matched: 0,
        removed: 0,
        roleRevoked: false,
        retry: false,
        ...none,
      };
    }

    // Before anything else: the posts. They are the loudest copy of this
    // member's data — their name and often their age, in a channel the
    // whole guild reads — and the row about to be deleted holds the only
    // ids by which they can ever be found again (#916).
    const posts = await this.withdrawAnnouncements(rows);

    const held = rows.find((row) => row.roleAssignedAt);
    let roleRevoked = false;

    if (held) {
      // The role recorded on the grant, not whatever is configured now: the
      // two differ whenever `birthdays.role_id` changed while this grant was
      // live, and revoking the configured one would leave the real grant in
      // place while deleting its only marker (#916). Rows written before
      // that field existed fall back to the configured id.
      let roleId = held.roleAssignedId ?? "";
      try {
        if (!roleId) {
          roleId = await this.configService.getString("birthdays.role_id", "");
        }
      } catch (error) {
        // Without the id there is no safe way to revoke, and the row has to
        // stay so the sweep can still find the grant.
        return {
          matched: rows.length,
          removed: 0,
          roleRevoked: false,
          retry: false,
          ...posts,
          error: getErrorMessage(error),
        };
      }
      if (roleId) {
        const revoked = await this.revokeBirthdayRole(guildId, userId, roleId);
        if (!revoked) {
          // Keep the row: it is the sweep's only handle on the grant, so
          // dropping it now would strand the role for good.
          return {
            matched: rows.length,
            removed: 0,
            roleRevoked: false,
            retry: false,
            ...posts,
            error: `could not take back the birthday role; the row is kept so the expiry sweep can still revoke it`,
          };
        }
        roleRevoked = true;
      }
      // No role configured any more: nothing to revoke, so the marker is
      // just stale bookkeeping and the row can go.
    }

    if (posts.announcementsFailed > 0) {
      // Keep the row: its `announcements` list is the only handle anything
      // has on those posts, so deleting it now would leave them up for good.
      // The purge is reported incomplete, and a retry finishes the job.
      return {
        matched: rows.length,
        removed: 0,
        roleRevoked,
        retry: false,
        ...posts,
        error: `${posts.announcementsFailed} birthday announcement(s) could not be deleted and may still be public; the row is kept so a retry can find them`,
      };
    }

    try {
      // Conditional on the marker we just read. The scheduled run can grant
      // a role and write `roleAssignedAt` between that read and this delete;
      // an unconditional delete would remove the brand-new marker and strand
      // the role for good. A row that changed under us matches nothing, and
      // we go round again rather than delete blind.
      const removal = await UserBirthday.deleteMany({
        $or: rows.map((row) => ({
          _id: row._id,
          roleAssignedAt: row.roleAssignedAt ?? null,
          // And on the announcement bookkeeping: a run that posted between
          // the read and here appended to `announcements` and stamped
          // `lastAnnouncedYear`, and with no role configured the marker
          // above would not have moved. Deleting then would drop the only
          // record of a message that names the member (#916).
          lastAnnouncedYear: row.lastAnnouncedYear ?? null,
        })),
      });
      const removed = removal?.deletedCount ?? 0;
      return {
        matched: rows.length,
        removed,
        roleRevoked,
        retry: removed < rows.length,
        ...posts,
      };
    } catch (error) {
      // The revoke above may already have taken the role off Discord.
      // Throwing would lose that: the coordinator would record a bare 0/0
      // and an operator retrying would not know the role was already gone.
      logger.error(
        `Failed to delete the birthday row for ${sanitizeForLog(userId)}:`,
        error,
      );
      return {
        matched: rows.length,
        removed: 0,
        roleRevoked,
        retry: false,
        ...posts,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Delete every birthday post recorded on these rows.
   *
   * A post that is already gone — `10008 Unknown Message`, or a channel
   * deleted out from under it — counts as deleted: there is nothing left
   * naming the member, which is the whole point. Anything else (an
   * unreachable channel, a refused delete) counts as failed, because the
   * message may well still be up, and the caller keeps the row so its ids
   * survive for a retry.
   *
   * Never throws: a post taken down before a later one failed is exactly
   * the state the purge report has to carry.
   */
  private async withdrawAnnouncements(rows: IUserBirthday[]): Promise<{
    announcementsAttempted: number;
    announcementsDeleted: number;
    announcementsFailed: number;
  }> {
    const posts = rows.flatMap((row) => row.announcements ?? []);
    let deleted = 0;
    let failed = 0;

    for (const post of posts) {
      try {
        const channel = await this.client.channels.fetch(post.channelId);
        if (!channel || !channel.isTextBased()) {
          // Not a channel we can read messages from any more; the post may
          // still be there, so this is not a success.
          failed += 1;
          logger.warn(
            `Could not delete birthday announcement ${post.messageId}: channel ${post.channelId} is unavailable`,
          );
          continue;
        }
        await channel.messages.delete(post.messageId);
        deleted += 1;
      } catch (error) {
        if (isUnknownMessageError(error) || isUnknownChannelError(error)) {
          // Already gone, or the channel that held it is — either way the
          // member is not named there any more.
          deleted += 1;
          continue;
        }
        failed += 1;
        logger.error(
          `Failed to delete birthday announcement ${post.messageId}; it may still be public:`,
          error,
        );
      }
    }

    return {
      announcementsAttempted: posts.length,
      announcementsDeleted: deleted,
      announcementsFailed: failed,
    };
  }

  /**
   * Take the birthday role off a member. True when it is safe to drop their
   * row — the guild, member or role being gone all count, since there is no
   * grant left for the sweep to chase. A lookup that merely *failed* does
   * not count: the row has to survive it, or the sweep loses the grant.
   */
  private async revokeBirthdayRole(
    guildId: string,
    userId: string,
    roleId: string,
  ): Promise<boolean> {
    try {
      const guild = await this.client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        logger.warn(
          `Birthday role revoke for ${sanitizeForLog(userId)}: guild unreachable`,
        );
        return false;
      }
      // `fetchMemberOrNull` returns null only on Discord's definitive
      // "not in the guild" codes and rethrows everything else. A blanket
      // catch here would read a rate limit as "they left", delete the only
      // marker, and strand a role that is still on a present member.
      const member = await fetchMemberOrNull(guild, userId);
      if (!member) return true;
      if (!member.roles.cache.has(roleId)) return true;
      await member.roles.remove(roleId, "Birthday data reset");
      return true;
    } catch (error) {
      logger.error(
        `Failed to take back the birthday role from ${sanitizeForLog(userId)}:`,
        error,
      );
      return false;
    }
  }

  private async sweepExpiredRoles(
    guild: Guild,
    guildId: string,
    roleId: string,
    durationMs: number,
    now: Date,
  ): Promise<number> {
    let removed = 0;
    // Grants whose role cannot be named this run (see below). Counted rather
    // than logged per row, so an unset `birthdays.role_id` does not print a
    // line per member on every run.
    let unidentified = 0;
    // Only rows with a stored grant timestamp can have a role to revoke.
    // (`$ne: null` already excludes missing fields in MongoDB; `$exists`
    // makes that intent explicit.)
    const expiredRows = await UserBirthday.find({
      guildId,
      roleAssignedAt: { $exists: true, $ne: null },
    });
    for (const row of expiredRows) {
      if (!row.roleAssignedAt) continue;
      if (now.getTime() - row.roleAssignedAt.getTime() < durationMs) continue;

      // The role this row actually recorded, falling back to the configured
      // one for rows written before the id was stored. Using the configured
      // id blindly would miss a grant made under a previous
      // `birthdays.role_id` and then clear its marker (#916).
      const grantedRoleId = row.roleAssignedId ?? roleId;
      if (!grantedRoleId) {
        // A pre-`roleAssignedId` row while `birthdays.role_id` is unset:
        // nothing identifies what to revoke *right now*. The marker is kept
        // rather than cleared — the old role may still be on the member, and
        // clearing it would lose the only record that a grant ever happened,
        // so configuring a role again could never take it back (#916). Being
        // re-examined every run is the cheaper half of that trade.
        unidentified += 1;
        continue;
      }

      // Only clear the marker once the grant is definitively dealt with.
      // Clearing it after a failed removal throws away the sweep's *only*
      // handle on a role that is still on the member (#916): a permissions
      // error or a rate limit would strand it for good. Leaving the marker
      // means the next run tries again.
      let settled = false;
      try {
        const member = await fetchMemberOrNull(guild, row.userId);
        if (!member) {
          // Definitively not in the guild: nothing to take back.
          settled = true;
        } else if (!member.roles.cache.has(grantedRoleId)) {
          // They do not hold it — already removed by hand or by an earlier
          // run — so the marker has done its job.
          settled = true;
        } else {
          await member.roles.remove(grantedRoleId, "Birthday role expired");
          removed += 1;
          settled = true;
        }
      } catch (error) {
        logger.warn(
          `Failed to remove expired birthday role from ${sanitizeForLog(row.userId)}; keeping the marker so the next run retries:`,
          error,
        );
      }

      if (settled) await this.clearRoleMarker(row);
    }

    if (unidentified > 0) {
      logger.warn(
        `Birthday sweep: ${unidentified} expired grant(s) name no role and none is configured; keeping their markers so they can still be revoked if birthdays.role_id is set again`,
      );
    }

    return removed;
  }

  /**
   * Persist a row touched by the run. False when the document is no longer
   * there — a per-user purge deleted it mid-run (#916) — as opposed to the
   * save failing for some other reason, which propagates to the per-row
   * catch as before.
   */
  private async saveRunRow(row: IUserBirthday): Promise<boolean> {
    try {
      return await this.writeRunRow(row);
    } catch (error) {
      // A rejected write is the same problem as a row that vanished: the
      // announcement is up and the role may be granted, with nothing
      // persisted that could ever find either again. Reporting it as "not
      // persisted" runs the compensation instead of dropping into the outer
      // catch and leaving both orphaned (#916).
      //
      // A write that actually landed but failed to acknowledge is withdrawn
      // needlessly — the member misses this year's announcement. That is the
      // recoverable side: the row then names a deleted message and a revoked
      // role, and both the purge and the expiry sweep already treat an
      // already-absent target as settled.
      logger.error(
        `Failed to persist the birthday run row for ${sanitizeForLog(row.userId)}; withdrawing what this iteration produced:`,
        error,
      );
      return false;
    }
  }

  private async writeRunRow(row: IUserBirthday): Promise<boolean> {
    const result = await UserBirthday.updateOne(
      { _id: row._id },
      {
        $set: {
          lastAnnouncedYear: row.lastAnnouncedYear,
          // The post this run just made, so a later purge can take it down.
          // Leaving it off would record the announcement in memory only and
          // the message would outlive every erasure (#916).
          ...(row.announcements ? { announcements: row.announcements } : {}),
          ...(row.roleAssignedAt
            ? {
                roleAssignedAt: row.roleAssignedAt,
                roleAssignedId: row.roleAssignedId,
              }
            : {}),
        },
      },
    );
    return (result?.matchedCount ?? 0) > 0;
  }

  /**
   * Drop a row's role markers once its grant is definitively dealt with.
   * Never call this after a failure: the markers are the only record that
   * the role is still out there (#916).
   */
  private async clearRoleMarker(row: IUserBirthday): Promise<void> {
    row.roleAssignedAt = undefined;
    row.roleAssignedId = undefined;
    await row
      .save()
      .catch((error) =>
        logger.warn(
          `Failed to clear roleAssignedAt for ${sanitizeForLog(row.userId)}:`,
          error,
        ),
      );
  }

  private async grantBirthdayRole(
    member: {
      roles: { add: (roleId: string, reason?: string) => Promise<unknown> };
    },
    roleId: string,
  ): Promise<boolean> {
    try {
      await member.roles.add(roleId, "Birthday role");
      return true;
    } catch (error) {
      logger.warn(`Failed to grant birthday role ${roleId}:`, error);
      return false;
    }
  }

  private async logSummary(summary: BirthdayRunSummary): Promise<void> {
    // Nothing to report on an empty tick — birthdays are sparse and an
    // hourly "0 announced" line would bury the cron channel.
    if (summary.announced === 0 && summary.rolesRemoved === 0) return;
    try {
      const discordLogger = DiscordLogger.getInstance(this.client);
      if (!discordLogger.isReady()) return;
      const message =
        `Announced: ${summary.announced} · roles granted: ${summary.rolesGranted} · ` +
        `roles removed: ${summary.rolesRemoved} · failed: ${summary.failed}`;
      await discordLogger.logCronSuccess("Birthdays", message);
    } catch (error) {
      logger.error("Birthdays: failed to post run summary to Discord:", error);
    }
  }
}
