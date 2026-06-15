import { Client, EmbedBuilder, type ColorResolvable } from "discord.js";
import { CronJob, CronTime } from "cron";
import { ConfigService } from "./config-service.js";
import { UserNotificationPrefsService } from "./user-notification-prefs-service.js";
import { DiscordLogger } from "./discord-logger.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { RewindNudgeState } from "../models/rewind-nudge-state.js";
import { RewindService } from "./rewind-service.js";
import logger from "../utils/logger.js";

/**
 * End-of-year DM nudge for the Rewind WebUI page (#484).
 *
 * Scheduled job. For each user above `rewind.min_minutes` in the
 * current year, send a single DM with a link to `/me/rewind`. Gated by
 * the per-user `prefs.rewind` opt-out. DM-closed users (Discord error
 * 50007) are silently skipped, matching the digest/achievement pattern.
 *
 * The page itself works year-round; this service exists only to nudge
 * users to open it once the year is wrapped up.
 */

const DEFAULT_CRON = "0 10 30 12 *";
const SECONDS_PER_MINUTE = 60;
const EMBED_COLOR: ColorResolvable = "#a855f7";

export interface RewindNudgeRunSummary {
  ranAt: Date;
  year: number;
  qualifying: number;
  sent: number;
  skippedOptOut: number;
  skippedDmsClosed: number;
  /** Already nudged for this year — duplicate-delivery guard. */
  skippedAlreadySent: number;
  failed: number;
  /** Immutable completed-year snapshots written this run (#574). */
  snapshotsCreated: number;
  /** Snapshots that already existed — idempotent re-run, left untouched. */
  snapshotsExisting: number;
  /** Qualifying users with no data worth freezing. */
  snapshotsSkipped: number;
  /** Snapshots that failed to write. */
  snapshotsFailed: number;
}

function sanitizeCronExpression(expression: string): string {
  return expression.trim().replace(/^["']|["']$/g, "");
}

export class RewindNudgeService {
  private static instance: RewindNudgeService;
  private client: Client;
  private configService: ConfigService;
  private job: CronJob | null = null;
  private isInitialized = false;
  private isRunning = false;
  private inFlight: Promise<RewindNudgeRunSummary | null> | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    this.configService.registerReloadCallback(async () => {
      try {
        const enabled = await this.isNudgeEnabled();
        if (!enabled && this.isInitialized) {
          logger.info("Rewind nudge disabled, stopping cron job...");
          this.destroy();
        } else if (enabled) {
          await this.reload();
        }
      } catch (error) {
        logger.error(
          "Error reloading rewind nudge service after configuration change:",
          error,
        );
      }
    });
  }

  public static getInstance(client: Client): RewindNudgeService {
    if (!RewindNudgeService.instance) {
      RewindNudgeService.instance = new RewindNudgeService(client);
    } else if (RewindNudgeService.instance.client !== client) {
      throw new Error(
        "RewindNudgeService already initialised with a different client",
      );
    }
    return RewindNudgeService.instance;
  }

  public static reset(): void {
    if (RewindNudgeService.instance) {
      RewindNudgeService.instance.destroy();
    }
    RewindNudgeService.instance = undefined as unknown as RewindNudgeService;
  }

  /**
   * Whether the end-of-year nudge should run. Keys off the dedicated
   * `rewind.nudge.enabled` toggle (#608), falling back to the legacy
   * `rewind.enabled` value for installs that opted into the nudge before
   * the key was split into feature (page) vs nudge. Passing the legacy
   * value as the default means an explicitly-stored `rewind.nudge.enabled`
   * always wins, while installs that never set it inherit their old
   * `rewind.enabled` behaviour — no manual migration required.
   *
   * This is deliberately independent of the `rewind.enabled` feature
   * gate: an admin can keep the page on with no DMs (today's behaviour),
   * or run the nudge without other coupling.
   */
  private async isNudgeEnabled(): Promise<boolean> {
    const legacy = await this.configService.getBoolean("rewind.enabled", false);
    return this.configService.getBoolean("rewind.nudge.enabled", legacy);
  }

  private validateCronExpression(expression: string): boolean {
    try {
      new CronTime(expression);
      return true;
    } catch (error) {
      logger.error(
        `Invalid cron expression for rewind nudge: ${expression}`,
        error,
      );
      return false;
    }
  }

  public async start(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Rewind nudge service is already initialized, skipping...");
      return;
    }

    try {
      const enabled = await this.isNudgeEnabled();
      if (!enabled) {
        logger.info("Rewind nudge is disabled");
        this.isInitialized = true;
        return;
      }

      const rawCron = await this.configService.getString(
        "rewind.cron",
        DEFAULT_CRON,
      );
      const cronExpression = sanitizeCronExpression(rawCron);

      if (!this.validateCronExpression(cronExpression)) {
        logger.error(
          `Rewind nudge service not started: invalid cron "${rawCron}"`,
        );
        this.isInitialized = true;
        return;
      }

      this.job = new CronJob(cronExpression, async () => {
        try {
          await this.runNow();
        } catch (error) {
          logger.error("Error running rewind nudge job:", error);
        }
      });
      this.job.start();

      const nextRun = this.job.nextDate();
      logger.info(
        `Rewind nudge service started (cron: "${cronExpression}", next run: ${nextRun.toLocaleString()})`,
      );

      this.isInitialized = true;
    } catch (error) {
      logger.error("Error starting rewind nudge service:", error);
      throw error;
    }
  }

  /**
   * Run the nudge immediately. Coalesces concurrent invocations so a
   * slow run + the next cron tick can't double-deliver.
   */
  public async runNow(): Promise<RewindNudgeRunSummary | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runOnce(): Promise<RewindNudgeRunSummary | null> {
    if (this.isRunning) {
      logger.warn("Rewind nudge run already in progress, skipping");
      return null;
    }
    this.isRunning = true;
    try {
      const enabled = await this.isNudgeEnabled();
      if (!enabled) {
        logger.info("Rewind nudge aborted: nudge disabled");
        return null;
      }

      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("Rewind nudge aborted: GUILD_ID not configured");
        return null;
      }

      const minMinutes = await this.configService.getNumber(
        "rewind.min_minutes",
        60,
      );
      const minSeconds = Math.max(0, minMinutes) * SECONDS_PER_MINUTE;

      const year = new Date().getUTCFullYear();
      const summary: RewindNudgeRunSummary = {
        ranAt: new Date(),
        year,
        qualifying: 0,
        sent: 0,
        skippedOptOut: 0,
        skippedDmsClosed: 0,
        skippedAlreadySent: 0,
        failed: 0,
        snapshotsCreated: 0,
        snapshotsExisting: 0,
        snapshotsSkipped: 0,
        snapshotsFailed: 0,
      };

      const prefsService = UserNotificationPrefsService.getInstance();

      const yearStart = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
      const yearEnd = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0));
      // Aggregate seconds per user for the current year and filter by
      // the configured minimum. No `$limit` — every qualifying user
      // should be considered, not just the top N.
      const annualUsers = await VoiceChannelTracking.aggregate<{
        _id: string;
        username: string;
        totalTime: number;
      }>([
        { $unwind: "$sessions" },
        {
          $match: {
            "sessions.startTime": { $gte: yearStart, $lt: yearEnd },
          },
        },
        {
          $group: {
            _id: "$userId",
            username: { $first: "$username" },
            totalTime: { $sum: "$sessions.duration" },
          },
        },
        { $match: { totalTime: { $gte: minSeconds } } },
        { $sort: { totalTime: -1 } },
      ]);
      const qualifying = annualUsers.map((u) => ({
        userId: u._id,
        username: u.username ?? u._id,
        totalTime: u.totalTime,
      }));
      summary.qualifying = qualifying.length;

      for (const user of qualifying) {
        try {
          // One-shot per (userId, guildId, year). A re-run of the cron
          // — or a manual `runNow()` for validation — must not produce
          // a duplicate DM. We check before any other work so an
          // already-nudged user costs only this lookup.
          const existing = await RewindNudgeState.findOne({
            userId: user.userId,
            guildId,
            year,
          });
          if (existing) {
            summary.skippedAlreadySent += 1;
            continue;
          }

          const prefs = await prefsService.getPrefs(user.userId, guildId);
          if (!prefs.rewind) {
            summary.skippedOptOut += 1;
            continue;
          }
          const embed = this.buildEmbed(user.username, year);
          const delivered = await this.sendNudgeDM(user.userId, embed);
          if (!delivered) {
            summary.skippedDmsClosed += 1;
            continue;
          }
          summary.sent += 1;

          // Record the delivery marker only after a successful send so
          // DM-closed / failed deliveries can be retried on the next run.
          await RewindNudgeState.findOneAndUpdate(
            { userId: user.userId, guildId, year },
            {
              $set: {
                userId: user.userId,
                guildId,
                year,
                sentAt: summary.ranAt,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
        } catch (error) {
          summary.failed += 1;
          logger.error(
            `Error sending rewind nudge for user ${user.userId}:`,
            error,
          );
        }
      }

      // Freeze each qualifying user's recap for the wrapping-up year into
      // an immutable snapshot (#574). The end-of-year cron runs in late
      // December, so `year` is the current UTC year that's essentially
      // done; once it rolls over, `getSummary` serves this frozen copy.
      // This runs independently of DM delivery — opted-out / DM-closed
      // users still get their year preserved — and is idempotent, so a
      // re-run leaves existing snapshots untouched.
      await this.snapshotQualifyingUsers(qualifying, guildId, year, summary);

      logger.info(
        `Rewind nudge complete: year=${summary.year} qualifying=${summary.qualifying} ` +
          `sent=${summary.sent} opted_out=${summary.skippedOptOut} ` +
          `already_sent=${summary.skippedAlreadySent} ` +
          `dms_closed=${summary.skippedDmsClosed} failed=${summary.failed} ` +
          `snapshots_created=${summary.snapshotsCreated} ` +
          `snapshots_existing=${summary.snapshotsExisting} ` +
          `snapshots_skipped=${summary.snapshotsSkipped} ` +
          `snapshots_failed=${summary.snapshotsFailed}`,
      );

      await this.logSummary(summary);
      return summary;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Persist a frozen `RewindSnapshot` for each qualifying user for `year`
   * (#574). This runs inside the end-of-year cron (default Dec 30), so
   * `year` is the current UTC year that is wrapping up — `getSummary`
   * recomputes it live rather than serving an earlier snapshot. Errors are
   * isolated per user — one bad snapshot must not abort the rest or crash
   * the cron. Each user's timezone is applied so the frozen recap matches
   * what they'd see live.
   */
  private async snapshotQualifyingUsers(
    qualifying: Array<{ userId: string; username: string; totalTime: number }>,
    guildId: string,
    year: number,
    summary: RewindNudgeRunSummary,
  ): Promise<void> {
    const rewindService = RewindService.getInstance(this.client);
    const prefsService = UserNotificationPrefsService.getInstance();

    for (const user of qualifying) {
      try {
        const timezone = await prefsService.getTimezone(user.userId, guildId);
        const outcome = await rewindService.snapshotYear(
          user.userId,
          guildId,
          year,
          timezone,
        );
        switch (outcome) {
          case "created":
            summary.snapshotsCreated += 1;
            break;
          case "exists":
            summary.snapshotsExisting += 1;
            break;
          case "skipped":
            summary.snapshotsSkipped += 1;
            break;
          default:
            summary.snapshotsFailed += 1;
        }
      } catch (error) {
        summary.snapshotsFailed += 1;
        logger.error(
          `Error snapshotting rewind for user ${user.userId}:`,
          error,
        );
      }
    }
  }

  private buildEmbed(username: string, year: number): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(`✨ Your Koolbot Rewind for ${year} is ready`)
      .setColor(EMBED_COLOR)
      .setDescription(
        `Hey ${username}, your year-in-review is waiting for you.\n\n` +
          `Open the user portal with **\`/config\`** and follow the magic link to **/me/rewind** to see your top voice and text channels, peak day, longest streak, and the badges you earned this year.\n\n` +
          `_Don't want these? Run \`/config\` → Notifications to manage your preferences._`,
      )
      .setTimestamp(new Date());
  }

  /**
   * Send the nudge DM. Returns true on delivery, false if the user has
   * DMs closed (silent skip). Other errors propagate so they count as
   * `failed`.
   */
  private async sendNudgeDM(
    userId: string,
    embed: EmbedBuilder,
  ): Promise<boolean> {
    const user = await this.client.users.fetch(userId);
    try {
      await user.send({ embeds: [embed] });
      return true;
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 50007) {
        logger.debug(`Rewind nudge: DMs closed for ${userId}, skipping`);
        return false;
      }
      throw error;
    }
  }

  private async logSummary(summary: RewindNudgeRunSummary): Promise<void> {
    try {
      const discordLogger = DiscordLogger.getInstance(this.client);
      if (!discordLogger.isReady()) return;
      const message =
        `Year ${summary.year} · qualifying: ${summary.qualifying} · ` +
        `sent: ${summary.sent} · opted out: ${summary.skippedOptOut} · ` +
        `already sent: ${summary.skippedAlreadySent} · ` +
        `DMs closed: ${summary.skippedDmsClosed} · failed: ${summary.failed} · ` +
        `snapshots: ${summary.snapshotsCreated} new / ` +
        `${summary.snapshotsExisting} kept / ${summary.snapshotsFailed} failed`;
      await discordLogger.logCronSuccess("Rewind Nudge", message);
    } catch (error) {
      logger.error(
        "Rewind nudge: failed to post run summary to Discord:",
        error,
      );
    }
  }

  public async reload(): Promise<void> {
    logger.info("Reloading rewind nudge service...");
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
    logger.info("Rewind nudge service destroyed");
  }
}
