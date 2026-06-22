import { Client, Guild, TextChannel } from "discord.js";
import { CronJob, CronTime } from "cron";
import { formatInTimeZone } from "date-fns-tz";
import { ConfigService } from "./config-service.js";
import { UserNotificationPrefsService } from "./user-notification-prefs-service.js";
import { DiscordLogger } from "./discord-logger.js";
import { UserBirthday, type IUserBirthday } from "../models/user-birthday.js";
import { resolveTimezone } from "../utils/timezone.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * Birthday celebrations service (#657).
 *
 * Mirrors the cron lifecycle of `DigestService` /
 * `ScheduledAnnouncementService`: the interval handle is stored, every
 * tick is wrapped so a failure is logged and never crashes the process,
 * and a reload callback re-reads the gate on `/config reload`.
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

export interface BirthdayRunSummary {
  ranAt: Date;
  candidates: number;
  announced: number;
  rolesGranted: number;
  rolesRemoved: number;
  failed: number;
}

function sanitizeCronExpression(expression: string): string {
  return expression.trim().replace(/^["']|["']$/g, "");
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

export class BirthdayService {
  private static instance: BirthdayService;
  private client: Client;
  private configService: ConfigService;
  private job: CronJob | null = null;
  private isInitialized = false;
  private isRunning = false;
  private inFlight: Promise<BirthdayRunSummary | null> | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    this.configService.registerReloadCallback(async () => {
      try {
        logger.info("Birthday configuration changed, reloading...");
        const enabled = await this.configService.getBoolean(
          "birthdays.enabled",
          false,
        );
        if (!enabled && this.isInitialized) {
          logger.info("Birthdays disabled, stopping cron job...");
          this.destroy();
        } else if (enabled) {
          await this.reload();
        }
      } catch (error) {
        logger.error(
          "Error reloading birthday service after configuration change:",
          error,
        );
      }
    });
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

  private validateCronExpression(expression: string): boolean {
    try {
      new CronTime(expression);
      return true;
    } catch (error) {
      logger.error(
        `Invalid cron expression for birthdays: ${expression}`,
        error,
      );
      return false;
    }
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
   * Set or clear a member's birthday. Passing `null` removes the row.
   * The month/day are validated against the calendar (Feb 29 allowed);
   * the year, when present, must be a plausible four-digit value not in
   * the future. Resets `lastAnnouncedYear` so a corrected date can still
   * fire this year. Returns the stored value (or `null` when cleared).
   */
  public async setBirthday(
    userId: string,
    guildId: string,
    input: BirthdayInput | null,
  ): Promise<StoredBirthday | null> {
    if (!userId) throw new Error("userId required");
    if (!guildId) throw new Error("guildId required");

    if (input === null) {
      await UserBirthday.deleteOne({ userId, guildId });
      return null;
    }

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

  public async start(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Birthday service is already initialized, skipping...");
      return;
    }
    try {
      const enabled = await this.configService.getBoolean(
        "birthdays.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Birthdays are disabled");
        this.isInitialized = true;
        return;
      }

      const rawCron = await this.configService.getString(
        "birthdays.cron",
        DEFAULT_CRON,
      );
      const cronExpression = sanitizeCronExpression(rawCron);
      if (!this.validateCronExpression(cronExpression)) {
        logger.error(`Birthday service not started: invalid cron "${rawCron}"`);
        this.isInitialized = true;
        return;
      }

      this.job = new CronJob(cronExpression, async () => {
        try {
          await this.runNow();
        } catch (error) {
          logger.error("Error running birthday job:", error);
        }
      });
      this.job.start();

      const nextRun = this.job.nextDate();
      logger.info(
        `Birthday service started (cron: "${cronExpression}", next run: ${nextRun.toLocaleString()})`,
      );
      this.isInitialized = true;
    } catch (error) {
      logger.error("Error starting birthday service:", error);
      throw error;
    }
  }

  /**
   * Run the birthday job immediately. Concurrent invocations coalesce
   * onto the first one so a slow run and the next cron tick can't
   * double-post (in addition to the per-row `lastAnnouncedYear` guard).
   */
  public async runNow(): Promise<BirthdayRunSummary | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runOnce(): Promise<BirthdayRunSummary | null> {
    if (this.isRunning) {
      logger.warn("Birthday run already in progress, skipping");
      return null;
    }
    this.isRunning = true;
    try {
      const enabled = await this.configService.getBoolean(
        "birthdays.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Birthday run aborted: feature disabled");
        return null;
      }

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
        logger.warn(
          "Birthday run aborted: birthdays.channel_id not configured",
        );
        return null;
      }

      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        logger.error(`Birthday run aborted: guild ${guildId} not found`);
        return null;
      }

      const channel = await guild.channels.fetch(channelId);
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
      const roleId = await this.configService.getString(
        "birthdays.role_id",
        "",
      );
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
      if (roleId) {
        summary.rolesRemoved += await this.sweepExpiredRoles(
          guild,
          guildId,
          roleId,
          Math.max(0, roleDurationHours) * MS_PER_HOUR,
          summary.ranAt,
        );
      }

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

          const member = await guild.members
            .fetch(row.userId)
            .catch(() => null);
          if (!member) {
            // Member left the guild — mark as announced so we don't
            // retry every tick, and skip.
            row.lastAnnouncedYear = local.year;
            await row.save();
            continue;
          }

          const age =
            typeof row.year === "number" ? local.year - row.year : null;
          const content = renderBirthdayMessage(messageTemplate, {
            userId: row.userId,
            displayName: member.displayName,
            age,
          });

          await channel.send({
            content,
            allowedMentions: mention ? { users: [row.userId] } : { parse: [] },
          });
          summary.announced += 1;

          if (roleId) {
            const granted = await this.grantBirthdayRole(member, roleId);
            if (granted) {
              row.roleAssignedAt = summary.ranAt;
              summary.rolesGranted += 1;
            }
          }

          row.lastAnnouncedYear = local.year;
          await row.save();
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
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Remove the temporary birthday role from every member whose grant has
   * aged past `durationMs`. Durable across restarts because the grant
   * time lives on the row, not in memory. Returns the count removed.
   */
  private async sweepExpiredRoles(
    guild: Guild,
    guildId: string,
    roleId: string,
    durationMs: number,
    now: Date,
  ): Promise<number> {
    let removed = 0;
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
      try {
        const member = await guild.members.fetch(row.userId).catch(() => null);
        if (member && member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, "Birthday role expired");
          removed += 1;
        }
      } catch (error) {
        logger.warn(
          `Failed to remove expired birthday role from ${sanitizeForLog(row.userId)}:`,
          error,
        );
      } finally {
        // Clear the marker regardless: if the role is already gone or the
        // member left, there's nothing more to sweep.
        row.roleAssignedAt = undefined;
        await row.save().catch(() => undefined);
      }
    }
    return removed;
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

  public async reload(): Promise<void> {
    logger.info("Reloading birthday service...");
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.isInitialized = false;
    await this.start();
  }

  public destroy(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.isInitialized = false;
    logger.info("Birthday service destroyed");
  }
}
