import { Client, EmbedBuilder, type ColorResolvable } from "discord.js";
import { CronJob, CronTime } from "cron";
import { ConfigService } from "./config-service.js";
import { VoiceChannelTracker } from "./voice-channel-tracker.js";
import { UserNotificationPrefsService } from "./user-notification-prefs-service.js";
import { AchievementsService } from "./achievements-service.js";
import { DiscordLogger } from "./discord-logger.js";
import { DigestState } from "../models/digest-state.js";
import { UserAchievements } from "../models/user-achievements.js";
import { ACCOLADE_METADATA, type AccoladeType } from "../content/accolades.js";
import { ACHIEVEMENT_METADATA } from "../content/achievements.js";
import logger from "../utils/logger.js";

interface QualifyingUser {
  userId: string;
  username: string;
  totalTime: number;
  rank: number;
}

export interface DigestRunSummary {
  ranAt: Date;
  qualifying: number;
  sent: number;
  skippedOptOut: number;
  skippedDmsClosed: number;
  failed: number;
}

const DEFAULT_CRON = "0 9 * * 1";
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;
const EMBED_COLOR: ColorResolvable = "#5865f2";

function sanitizeCronExpression(expression: string): string {
  return expression.trim().replace(/^["']|["']$/g, "");
}

function formatDuration(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  const totalMinutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatDelta(currentSeconds: number, previousSeconds: number): string {
  const diff = currentSeconds - previousSeconds;
  if (Math.abs(diff) < SECONDS_PER_MINUTE) {
    return previousSeconds === 0 ? "first tracked week" : "no change";
  }
  const arrow = diff > 0 ? "▲" : "▼";
  return `${arrow} ${formatDuration(Math.abs(diff))} vs last week`;
}

function formatRank(rank: number | null): string {
  return rank === null ? "unranked" : `#${rank}`;
}

function formatRankDelta(
  current: number | null,
  previous: number | null,
): string | null {
  if (current === null || previous === null) return null;
  if (current === previous) return "no change";
  const diff = previous - current; // positive = moved up the leaderboard
  return diff > 0 ? `▲ ${diff}` : `▼ ${Math.abs(diff)}`;
}

/**
 * Pick a motivational footer line. We reuse the accolade descriptions
 * from `src/content/accolades.ts` as a small but consistent flavour
 * library — every line ties back to a real badge the user could earn.
 */
function pickMotivationalFooter(seed: number): string {
  const descriptions = Object.values(ACCOLADE_METADATA).map(
    (m) => m.description,
  );
  if (descriptions.length === 0) return "Keep it up!";
  const index =
    ((seed % descriptions.length) + descriptions.length) % descriptions.length;
  return descriptions[index];
}

export class DigestService {
  private static instance: DigestService;
  private client: Client;
  private configService: ConfigService;
  private job: CronJob | null = null;
  private isInitialized = false;
  private isRunning = false;
  private inFlight: Promise<DigestRunSummary | null> | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    this.configService.registerReloadCallback(async () => {
      try {
        logger.info("Weekly digest configuration changed, reloading...");

        const enabled = await this.configService.getBoolean(
          "digest.enabled",
          false,
        );

        if (!enabled && this.isInitialized) {
          logger.info("Weekly digest disabled, stopping cron job...");
          this.destroy();
        } else if (enabled) {
          await this.reload();
        }
      } catch (error) {
        logger.error(
          "Error reloading weekly digest service after configuration change:",
          error,
        );
      }
    });
  }

  public static getInstance(client: Client): DigestService {
    if (!DigestService.instance) {
      DigestService.instance = new DigestService(client);
    } else if (DigestService.instance.client !== client) {
      throw new Error(
        "DigestService already initialised with a different client",
      );
    }
    return DigestService.instance;
  }

  public static reset(): void {
    if (DigestService.instance) {
      DigestService.instance.destroy();
    }
    DigestService.instance = undefined as unknown as DigestService;
  }

  private validateCronExpression(expression: string): boolean {
    try {
      new CronTime(expression);
      return true;
    } catch (error) {
      logger.error(`Invalid cron expression for digest: ${expression}`, error);
      return false;
    }
  }

  public async start(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Digest service is already initialized, skipping...");
      return;
    }

    try {
      const enabled = await this.configService.getBoolean(
        "digest.enabled",
        false,
      );

      if (!enabled) {
        logger.info("Weekly digest is disabled");
        this.isInitialized = true;
        return;
      }

      const rawCron = await this.configService.getString(
        "digest.cron",
        DEFAULT_CRON,
      );
      const cronExpression = sanitizeCronExpression(rawCron);

      if (!this.validateCronExpression(cronExpression)) {
        logger.error(`Digest service not started: invalid cron "${rawCron}"`);
        this.isInitialized = true;
        return;
      }

      this.job = new CronJob(cronExpression, async () => {
        try {
          await this.runNow();
        } catch (error) {
          logger.error("Error running weekly digest job:", error);
        }
      });
      this.job.start();

      const nextRun = this.job.nextDate();
      logger.info(
        `Digest service started (cron: "${cronExpression}", next run: ${nextRun.toLocaleString()})`,
      );

      this.isInitialized = true;
    } catch (error) {
      logger.error("Error starting digest service:", error);
      throw error;
    }
  }

  /**
   * Run the digest job immediately. Used by the cron handler and by
   * future admin "send now" triggers. Concurrent invocations coalesce
   * onto the first one so a slow run + the next cron tick can't
   * double-deliver.
   */
  public async runNow(): Promise<DigestRunSummary | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runOnce(): Promise<DigestRunSummary | null> {
    if (this.isRunning) {
      logger.warn("Digest run already in progress, skipping");
      return null;
    }
    this.isRunning = true;
    try {
      const enabled = await this.configService.getBoolean(
        "digest.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Digest run aborted: feature disabled");
        return null;
      }

      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("Digest run aborted: GUILD_ID not configured");
        return null;
      }

      const minActiveMinutes = await this.configService.getNumber(
        "digest.min_active_minutes",
        30,
      );
      const streakMinMinutes = await this.configService.getNumber(
        "digest.streak_min_minutes",
        30,
      );
      const includeAchievements = await this.configService.getBoolean(
        "digest.include_achievements",
        true,
      );

      const minActiveSeconds =
        Math.max(0, minActiveMinutes) * SECONDS_PER_MINUTE;
      const streakMinSeconds =
        Math.max(0, streakMinMinutes) * SECONDS_PER_MINUTE;

      const tracker = VoiceChannelTracker.getInstance(this.client);
      const prefsService = UserNotificationPrefsService.getInstance();
      // Ensure the singleton is alive so a guild that flips this on
      // without ever having earned an accolade still has the service
      // ready when we look up weekly rows below.
      AchievementsService.getInstance(this.client);

      const ranked = await tracker.getTopUsers(0, "week");
      const qualifying: QualifyingUser[] = ranked
        .map((user, index) => ({
          userId: user.userId,
          username: user.username,
          totalTime: user.totalTime,
          rank: index + 1,
        }))
        .filter((user) => user.totalTime >= minActiveSeconds);

      const summary: DigestRunSummary = {
        ranAt: new Date(),
        qualifying: qualifying.length,
        sent: 0,
        skippedOptOut: 0,
        skippedDmsClosed: 0,
        failed: 0,
      };

      for (const user of qualifying) {
        try {
          const prefs = await prefsService.getPrefs(user.userId, guildId);
          if (!prefs.digest) {
            summary.skippedOptOut += 1;
            continue;
          }

          const previousState = await DigestState.findOne({
            userId: user.userId,
            guildId,
          });

          const streakWeeks = this.computeStreak(
            user.totalTime,
            streakMinSeconds,
            previousState?.lastSentAt ?? null,
            previousState?.streakWeeks ?? 0,
            summary.ranAt,
          );

          let weeklyAchievements: Array<{
            emoji: string;
            name: string;
            description: string;
          }> = [];
          if (includeAchievements) {
            weeklyAchievements = await this.collectWeeklyAchievements(
              user.userId,
              summary.ranAt,
            );
          }

          const embed = this.buildEmbed({
            user,
            previousState,
            streakWeeks,
            includeAchievements,
            weeklyAchievements,
          });

          const delivered = await this.sendDigestDM(user.userId, embed);
          if (!delivered) {
            summary.skippedDmsClosed += 1;
            continue;
          }

          summary.sent += 1;

          await DigestState.findOneAndUpdate(
            { userId: user.userId, guildId },
            {
              $set: {
                userId: user.userId,
                guildId,
                lastSentAt: summary.ranAt,
                lastWeekTotalTime: user.totalTime,
                lastWeekRank: user.rank,
                streakWeeks,
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
        } catch (error) {
          summary.failed += 1;
          logger.error(
            `Error processing digest for user ${user.userId}:`,
            error,
          );
        }
      }

      logger.info(
        `Weekly digest complete: qualifying=${summary.qualifying} sent=${summary.sent} ` +
          `opted_out=${summary.skippedOptOut} dms_closed=${summary.skippedDmsClosed} failed=${summary.failed}`,
      );

      await this.logSummary(summary);
      return summary;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * If the previous digest landed inside the last ~10 days the user is
   * "still on the streak" — increment if they qualify this week, reset
   * to 1 if not. A longer gap means the streak was already broken, so
   * we start fresh at 1 when they qualify again.
   */
  private computeStreak(
    currentSeconds: number,
    streakMinSeconds: number,
    lastSentAt: Date | null,
    previousStreak: number,
    now: Date,
  ): number {
    const qualifiesThisWeek = currentSeconds >= streakMinSeconds;
    if (!qualifiesThisWeek) return 0;
    if (!lastSentAt) return 1;
    const elapsedMs = now.getTime() - lastSentAt.getTime();
    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    if (elapsedMs > tenDaysMs) return 1;
    return previousStreak > 0 ? previousStreak + 1 : 1;
  }

  /**
   * Look up the user's achievement / accolade rows in the last 7 days.
   * Both records live on `UserAchievements` so a single query covers
   * everything; the service formats them for the embed.
   */
  private async collectWeeklyAchievements(
    userId: string,
    now: Date,
  ): Promise<Array<{ emoji: string; name: string; description: string }>> {
    const oneWeekAgo = new Date(now.getTime() - SECONDS_PER_WEEK * 1000);
    const row = await UserAchievements.findOne({ userId });
    if (!row) return [];

    const lines: Array<{ emoji: string; name: string; description: string }> =
      [];

    for (const accolade of row.accolades ?? []) {
      if (!accolade.earnedAt || accolade.earnedAt < oneWeekAgo) continue;
      const meta = ACCOLADE_METADATA[accolade.type as AccoladeType];
      if (!meta) continue;
      lines.push({
        emoji: meta.emoji,
        name: meta.name,
        description: meta.description,
      });
    }

    for (const achievement of row.achievements ?? []) {
      if (!achievement.earnedAt || achievement.earnedAt < oneWeekAgo) continue;
      const meta = (
        ACHIEVEMENT_METADATA as Record<
          string,
          { emoji: string; name: string; description: string }
        >
      )[achievement.type];
      if (!meta) continue;
      lines.push({
        emoji: meta.emoji,
        name: meta.name,
        description: meta.description,
      });
    }

    return lines;
  }

  private buildEmbed(args: {
    user: QualifyingUser;
    previousState: {
      lastWeekTotalTime: number;
      lastWeekRank: number | null;
    } | null;
    streakWeeks: number;
    includeAchievements: boolean;
    weeklyAchievements: Array<{
      emoji: string;
      name: string;
      description: string;
    }>;
  }): EmbedBuilder {
    const {
      user,
      previousState,
      streakWeeks,
      includeAchievements,
      weeklyAchievements,
    } = args;
    const previousTime = previousState?.lastWeekTotalTime ?? 0;
    const previousRank = previousState?.lastWeekRank ?? null;

    const fields: Array<{ name: string; value: string; inline: boolean }> = [
      {
        name: "This week",
        value: `${formatDuration(user.totalTime)}\n${formatDelta(
          user.totalTime,
          previousTime,
        )}`,
        inline: true,
      },
    ];

    const rankDelta = formatRankDelta(user.rank, previousRank);
    fields.push({
      name: "Rank",
      value: rankDelta
        ? `${formatRank(user.rank)}\n${rankDelta}`
        : formatRank(user.rank),
      inline: true,
    });

    fields.push({
      name: "Streak",
      value:
        streakWeeks === 0
          ? "—"
          : `${streakWeeks} week${streakWeeks === 1 ? "" : "s"}`,
      inline: true,
    });

    if (includeAchievements) {
      const achievementsValue =
        weeklyAchievements.length === 0
          ? "_None this week — there's always next week!_"
          : weeklyAchievements
              .slice(0, 10)
              .map((a) => `${a.emoji} **${a.name}** — ${a.description}`)
              .join("\n");
      fields.push({
        name: "Achievements earned this week",
        value: achievementsValue,
        inline: false,
      });
    }

    const footer = pickMotivationalFooter(user.userId.length + user.totalTime);

    return new EmbedBuilder()
      .setTitle("📊 Your weekly voice digest")
      .setColor(EMBED_COLOR)
      .setDescription(
        `Here's a snapshot of your last 7 days in voice, ${user.username}.`,
      )
      .addFields(fields)
      .setFooter({
        text: `${footer}\nDon't want these? Run /config to manage your notifications.`,
      })
      .setTimestamp(new Date());
  }

  /**
   * Send the digest DM. Returns true on delivery, false if the user has
   * DMs closed (silent skip, matches `AchievementsService` behaviour).
   * Fetch failures and other errors rethrow so the caller records `failed`.
   */
  private async sendDigestDM(
    userId: string,
    embed: EmbedBuilder,
  ): Promise<boolean> {
    const user = await this.client.users.fetch(userId);
    try {
      await user.send({ embeds: [embed] });
      return true;
    } catch (error) {
      const code = (error as { code?: number }).code;
      // 50007 = "Cannot send messages to this user" (DMs closed / blocked)
      if (code === 50007) {
        logger.debug(`Digest: DMs closed for ${userId}, skipping`);
        return false;
      }
      throw error;
    }
  }

  private async logSummary(summary: DigestRunSummary): Promise<void> {
    try {
      const discordLogger = DiscordLogger.getInstance(this.client);
      if (!discordLogger.isReady()) {
        return;
      }
      const message =
        `Qualifying: ${summary.qualifying} · sent: ${summary.sent} · ` +
        `opted out: ${summary.skippedOptOut} · DMs closed: ${summary.skippedDmsClosed} · ` +
        `failed: ${summary.failed}`;
      await discordLogger.logCronSuccess("Weekly Digest", message);
    } catch (error) {
      logger.error("Digest: failed to post run summary to Discord:", error);
    }
  }

  public async reload(): Promise<void> {
    logger.info("Reloading digest service...");
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
    logger.info("Digest service destroyed");
  }
}
