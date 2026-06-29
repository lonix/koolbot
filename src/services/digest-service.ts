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
import { formatInZone } from "../utils/timezone.js";
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

/** One rendered digest entry in a preview (no DM sent). */
export interface DigestPreviewEntry {
  userId: string;
  username: string;
  rank: number;
  totalTime: number; // seconds
  streakWeeks: number;
  /** Embed title, e.g. "📊 Your weekly voice digest". */
  title: string;
  /** Embed description (week range + greeting), rendered in the user's zone. */
  description: string;
  /** The embed fields exactly as they would appear in the DM'd embed. */
  fields: Array<{ name: string; value: string; inline: boolean }>;
  /** Embed footer text (motivational line + manage-notifications hint). */
  footer: string;
}

/**
 * Result of a dry-run digest preview (#539). Reuses the same qualifying-users
 * query and embed builder as the real cron run but sends no DMs and writes
 * nothing to `DigestState`.
 */
export interface DigestPreview {
  enabled: boolean;
  generatedAt: Date;
  /** Week window label in the server timezone, e.g. "Jun 15 – Jun 22". */
  weekRange: string;
  /** Total users clearing the min-active threshold this week. */
  qualifying: number;
  /** Of the qualifying users, how many have opted in to the digest DM. */
  optedIn: number;
  /** Of the qualifying users, how many opted out (would be skipped). */
  skippedOptOut: number;
  /**
   * Whether the digest has already gone out this week, and when. Derived
   * from the most recent `DigestState.lastSentAt` inside the current 7-day
   * window — null when no delivery has landed this week yet.
   */
  alreadySentAt: Date | null;
  includeAchievements: boolean;
  /** Max entries rendered (the rest are counted but not built). */
  limit: number;
  /** Rendered embeds for the opted-in qualifying users, up to `limit`. */
  entries: DigestPreviewEntry[];
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

      // Voice tracking is a hard dependency (#659): the digest ranks members
      // by tracked voice time, so without it every DM would report empty/stale
      // rankings. Mirror voice-channel-announcer.ts and short-circuit.
      const trackingEnabled = await this.configService.getBoolean(
        "voicetracking.enabled",
        false,
      );
      if (!trackingEnabled) {
        logger.warn(
          "Digest run aborted: voice tracking is disabled (voicetracking.enabled=false).",
        );
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

      const prefsService = UserNotificationPrefsService.getInstance();
      // Ensure the singleton is alive so a guild that flips this on
      // without ever having earned an accolade still has the service
      // ready when we look up weekly rows below.
      AchievementsService.getInstance(this.client);

      const qualifying = await this.getQualifyingUsers(minActiveSeconds);

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
          // One read for both the opt-in flag and the display timezone
          // (used for the week range), so the cron loop stays at a single
          // prefs query per user even for large guilds (#524).
          const { prefs, timezone } = await prefsService.getPrefsWithTimezone(
            user.userId,
            guildId,
          );
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
            ranAt: summary.ranAt,
            timezone,
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
   * Rank this week's voice activity and keep everyone who clears the
   * minimum-active threshold. Shared by the cron run and the dry-run
   * preview (#539) so both see an identical qualifying set.
   */
  private async getQualifyingUsers(
    minActiveSeconds: number,
  ): Promise<QualifyingUser[]> {
    const tracker = VoiceChannelTracker.getInstance(this.client);
    const ranked = await tracker.getTopUsers(0, "week");
    return ranked
      .map((user, index) => ({
        userId: user.userId,
        username: user.username,
        totalTime: user.totalTime,
        rank: index + 1,
      }))
      .filter((user) => user.totalTime >= minActiveSeconds);
  }

  /**
   * Dry-run the weekly digest (#539). Reuses the exact qualifying-users
   * query and embed builder the cron run uses, but **sends no DMs and
   * writes nothing to `DigestState`** — safe to call repeatedly from the
   * admin Web UI to preview the output for the current week's window.
   *
   * Only opted-in qualifying users get a rendered embed (capped at
   * `limit`); opt-outs are counted but not built. DMs-closed skips are
   * *not* determined here — that can only be known by actually sending —
   * so the preview reports qualifying/opted-in/opted-out and leaves
   * delivery failures to the real run.
   */
  public async previewDigest(limit = 25): Promise<DigestPreview> {
    // Clamp to a sane window so a hand-crafted call can't materialise an
    // unbounded set of embeds; the Web UI always uses the default.
    const cappedLimit = Math.min(Math.max(1, Math.floor(limit)), 25);
    const generatedAt = new Date();
    const enabled = await this.configService.getBoolean(
      "digest.enabled",
      false,
    );
    const guildId = await this.configService.getString("GUILD_ID", "");
    // Read up-front so the early-return (unconfigured) preview reports the
    // real achievements setting rather than a hard-coded false.
    const includeAchievements = await this.configService.getBoolean(
      "digest.include_achievements",
      true,
    );

    const weekStart = new Date(generatedAt.getTime() - SECONDS_PER_WEEK * 1000);
    const weekRange = `${formatInZone(weekStart, null, "MMM d")} – ${formatInZone(generatedAt, null, "MMM d")}`;

    const empty: DigestPreview = {
      enabled,
      generatedAt,
      weekRange,
      qualifying: 0,
      optedIn: 0,
      skippedOptOut: 0,
      alreadySentAt: null,
      includeAchievements,
      limit: cappedLimit,
      entries: [],
    };

    if (!enabled || !guildId) {
      return empty;
    }

    const minActiveMinutes = await this.configService.getNumber(
      "digest.min_active_minutes",
      30,
    );
    const streakMinMinutes = await this.configService.getNumber(
      "digest.streak_min_minutes",
      30,
    );
    const minActiveSeconds = Math.max(0, minActiveMinutes) * SECONDS_PER_MINUTE;
    const streakMinSeconds = Math.max(0, streakMinMinutes) * SECONDS_PER_MINUTE;

    const prefsService = UserNotificationPrefsService.getInstance();
    const qualifying = await this.getQualifyingUsers(minActiveSeconds);

    // "Already sent this week?" — the most recent delivery anywhere in the
    // guild that landed inside the current 7-day window.
    const recent = await DigestState.findOne({
      guildId,
      lastSentAt: { $gte: weekStart },
    }).sort({ lastSentAt: -1 });
    const alreadySentAt = recent?.lastSentAt ?? null;

    let skippedOptOut = 0;
    const entries: DigestPreviewEntry[] = [];

    for (const user of qualifying) {
      const { prefs, timezone } = await prefsService.getPrefsWithTimezone(
        user.userId,
        guildId,
      );
      if (!prefs.digest) {
        skippedOptOut += 1;
        continue;
      }
      // Cap rendered embeds but keep counting opt-outs beyond the cap so
      // the summary line stays accurate for large guilds.
      if (entries.length >= cappedLimit) continue;

      const previousState = await DigestState.findOne({
        userId: user.userId,
        guildId,
      });

      const streakWeeks = this.computeStreak(
        user.totalTime,
        streakMinSeconds,
        previousState?.lastSentAt ?? null,
        previousState?.streakWeeks ?? 0,
        generatedAt,
      );

      let weeklyAchievements: Array<{
        emoji: string;
        name: string;
        description: string;
      }> = [];
      if (includeAchievements) {
        weeklyAchievements = await this.collectWeeklyAchievements(
          user.userId,
          generatedAt,
        );
      }

      const embed = this.buildEmbed({
        user,
        previousState,
        streakWeeks,
        includeAchievements,
        weeklyAchievements,
        ranAt: generatedAt,
        timezone,
      });
      const data = embed.data;

      entries.push({
        userId: user.userId,
        username: user.username,
        rank: user.rank,
        totalTime: user.totalTime,
        streakWeeks,
        title: data.title ?? "",
        description: data.description ?? "",
        fields: (data.fields ?? []).map((f) => ({
          name: f.name,
          value: f.value,
          inline: f.inline ?? false,
        })),
        footer: data.footer?.text ?? "",
      });
    }

    return {
      enabled,
      generatedAt,
      weekRange,
      qualifying: qualifying.length,
      optedIn: qualifying.length - skippedOptOut,
      skippedOptOut,
      alreadySentAt,
      includeAchievements,
      limit: cappedLimit,
      entries,
    };
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
    ranAt: Date;
    timezone: string | null;
  }): EmbedBuilder {
    const {
      user,
      previousState,
      streakWeeks,
      includeAchievements,
      weeklyAchievements,
      ranAt,
      timezone,
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

    // "Week of <start> – <end>" in the user's timezone (server tz when
    // unset) so the 7-day window reads in their local time (#524).
    const weekStart = new Date(ranAt.getTime() - SECONDS_PER_WEEK * 1000);
    const weekRange = `${formatInZone(weekStart, timezone, "MMM d")} – ${formatInZone(ranAt, timezone, "MMM d")}`;

    return new EmbedBuilder()
      .setTitle("📊 Your weekly voice digest")
      .setColor(EMBED_COLOR)
      .setDescription(
        `Here's a snapshot of your last 7 days in voice (${weekRange}), ${user.username}.`,
      )
      .addFields(fields)
      .setFooter({
        text: `${footer}\nYou opted in to these. Run /config → Notifications to manage your preferences.`,
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
