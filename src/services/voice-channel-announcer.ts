import { Client, TextChannel } from "discord.js";
import { CronJob } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import { waitForClientReady } from "../utils/discord.js";
import {
  sanitizeCronExpression,
  validateCronExpression,
} from "../utils/cron.js";
import { VoiceChannelTracker } from "./voice-channel-tracker.js";
import { AchievementsService } from "./achievements-service.js";
import { quoteService } from "./quote-service.js";
import { PollParticipationTracker } from "./poll-participation-tracker.js";

/** Fallback schedule when the configured one is missing or unparseable. */
const DEFAULT_ANNOUNCEMENT_SCHEDULE = "0 16 * * 5";

/** One week, in milliseconds — the window every recap section covers. */
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve a quote's stored author id to a bare Discord snowflake, but only when
 * the whole string is exactly one of the supported formats (`<@id>`, `<@!id>`,
 * `@id`, or a plain numeric id). Anything else returns null so the recap emits
 * no mention. This is deliberately strict rather than "strip non-digits":
 * the returned id is allowlisted in `allowedMentions`, so assembling a
 * snowflake out of malformed or imported author data could otherwise ping an
 * unrelated member.
 */
function resolveAuthorMentionId(authorId: string): string | null {
  const match = authorId.match(/^(?:<@!?(\d+)>|@?(\d+))$/);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/** Longest poll question the recap will quote before eliding it. */
const MAX_RECAP_QUESTION_LENGTH = 120;

/**
 * Flatten a poll question for a single recap line. A question can come from a
 * member-created poll, so it is collapsed to one line, capped in length, and
 * stripped of the characters that would break out of the quoted text —
 * backticks and the smart quotes used as delimiters. Mentions are neutralised
 * separately by `allowedMentions`.
 */
function sanitizeRecapText(text: string): string {
  const flattened = text
    .replace(/[\r\n]+/g, " ")
    .replace(/[`“”]/g, "'")
    .trim();
  return flattened.length > MAX_RECAP_QUESTION_LENGTH
    ? `${flattened.slice(0, MAX_RECAP_QUESTION_LENGTH - 1)}…`
    : flattened;
}

export class VoiceChannelAnnouncer {
  private static instance: VoiceChannelAnnouncer;
  private client: Client;
  private configService: ConfigService;
  private announcementJob: CronJob | null = null;
  private isInitialized: boolean = false;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): VoiceChannelAnnouncer {
    if (!VoiceChannelAnnouncer.instance) {
      VoiceChannelAnnouncer.instance = new VoiceChannelAnnouncer(client);
    } else if (VoiceChannelAnnouncer.instance.client !== client) {
      throw new Error(
        "VoiceChannelAnnouncer already initialised with a different client",
      );
    }
    return VoiceChannelAnnouncer.instance;
  }

  public static reset(): void {
    if (VoiceChannelAnnouncer.instance) {
      VoiceChannelAnnouncer.instance.destroy();
    }
    VoiceChannelAnnouncer.instance =
      undefined as unknown as VoiceChannelAnnouncer;
  }

  public async start(): Promise<void> {
    // Guard against multiple initializations
    if (this.isInitialized) {
      logger.warn(
        "Voice channel announcer is already initialized, skipping...",
      );
      return;
    }

    logger.info("Starting voice channel announcer...");

    try {
      // Wait for client to be ready
      await waitForClientReady(this.client, "VoiceChannelAnnouncer");

      // Ensure guild channels are cached
      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("GUILD_ID not configured");
        return;
      }

      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        logger.error(`Guild not found with ID: ${guildId}`);
        return;
      }

      // Cache guild channels
      await guild.channels.fetch();

      const enabled = await this.configService.getBoolean(
        "voicetracking.announcements.enabled",
        false,
      );
      const trackingEnabled = await this.configService.getBoolean(
        "voicetracking.enabled",
        false,
      );
      if (!enabled || !trackingEnabled) {
        logger.info(
          "Weekly voice channel announcements are disabled or voice tracking is not enabled",
        );
        return;
      }

      let schedule = sanitizeCronExpression(
        await this.configService.getString(
          "voicetracking.announcements.schedule",
          DEFAULT_ANNOUNCEMENT_SCHEDULE,
        ),
      );

      // The shared validator has already logged the offending expression, so
      // this line only records the fallback being applied.
      if (!validateCronExpression(schedule, "voice channel announcements")) {
        logger.error(
          `Using the default announcement schedule instead: ${DEFAULT_ANNOUNCEMENT_SCHEDULE}`,
        );
        schedule = DEFAULT_ANNOUNCEMENT_SCHEDULE;
      }

      this.announcementJob = new CronJob(schedule, () => {
        this.makeAnnouncement();
      });

      this.announcementJob.start();
      logger.info(
        `Voice channel announcements scheduled with cron: ${schedule}`,
      );

      // Log the next scheduled run time
      const nextRun = this.announcementJob.nextDate();
      logger.info(
        `Next announcement scheduled for: ${nextRun.toLocaleString()}`,
      );

      this.isInitialized = true;
    } catch (error) {
      logger.error("Error scheduling voice channel announcements:", error);
      throw error; // Re-throw the error to be handled by the caller
    }
  }

  public async makeAnnouncement(): Promise<void> {
    try {
      // Wait for client to be ready
      await waitForClientReady(this.client, "VoiceChannelAnnouncer");

      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("GUILD_ID not configured");
        return;
      }

      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        logger.error(`Guild not found with ID: ${guildId}`);
        return;
      }

      const channelId = await this.configService.getString(
        "voicetracking.announcements.channel_id",
        "",
      );

      if (!channelId) {
        logger.error(
          "voicetracking.announcements.channel_id is not configured",
        );
        return;
      }

      // Ensure guild channels are cached
      await guild.channels.fetch();

      const channel = guild.channels.cache.get(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.error(
          `Announcement channel ID ${channelId} not found (or not a text channel) in guild ${guild.name}`,
        );
        return;
      }

      const weekAgo = new Date(Date.now() - ONE_WEEK_MS);

      // Each section is independently toggleable (#777) and self-contained:
      // a section stays hidden unless both its recap toggle and the feature
      // that produces its data are enabled, and a failure in one never breaks
      // the others.
      await this.announceVoiceStats(channel);
      await this.announceAccolades(channel);
      await this.announceQuoteOfWeek(channel, weekAgo);
      await this.announcePollTurnout(channel, guildId, weekAgo);

      logger.info("Weekly voice channel announcement sent successfully");
    } catch (error) {
      logger.error("Error making voice channel announcement:", error);
    }
  }

  /** Recap section: the weekly top voice-time leaderboard. */
  private async announceVoiceStats(channel: TextChannel): Promise<void> {
    try {
      const include = await this.configService.getBoolean(
        "voicetracking.announcements.include_voice_stats",
        true,
      );
      if (!include) return;

      const tracker = VoiceChannelTracker.getInstance(this.client);
      const topUsers = await tracker.getTopUsers(10, "week");

      if (topUsers.length === 0) {
        await channel.send("No voice channel activity recorded this week.");
        return;
      }

      const formatTime = (seconds: number): string => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
      };

      const message = [
        "🎙️ **Weekly Voice Channel Activity Report** 🎙️",
        "",
        "**Top 10 Most Active Members This Week:**",
        ...topUsers.map((user, index) => {
          const rank = index + 1;
          const medal =
            rank === 1
              ? "🥇"
              : rank === 2
                ? "🥈"
                : rank === 3
                  ? "🥉"
                  : `${rank}.`;
          const mention = rank <= 3 ? `<@${user.userId}>` : user.username;
          return `${medal} ${mention}: ${formatTime(user.totalTime)}`;
        }),
        "",
        "Keep up the great conversations! 🎮",
      ].join("\n");

      await channel.send(message);
    } catch (error) {
      logger.error("Error announcing voice stats:", error);
      // Isolated like every other section: never break the rest of the recap.
    }
  }

  /** Recap section: accolades earned in the last week. */
  private async announceAccolades(channel: TextChannel): Promise<void> {
    try {
      const include = await this.configService.getBoolean(
        "voicetracking.announcements.include_accolades",
        true,
      );
      if (!include) return;

      const achievementsEnabled = await this.configService.getBoolean(
        "achievements.enabled",
        false,
      );
      const announcementsEnabled = await this.configService.getBoolean(
        "achievements.announcements.enabled",
        true,
      );
      if (!achievementsEnabled || !announcementsEnabled) return;

      const achievementsService = AchievementsService.getInstance(this.client);
      const newAccolades =
        await achievementsService.getNewAccoladesSinceLastWeek();
      if (newAccolades.length === 0) return;

      const accoladeMessages = newAccolades
        .flatMap((userAccolades) =>
          userAccolades.accolades
            .map((accolade) => {
              const definition = achievementsService.getAccoladeDefinition(
                accolade.type,
              );
              if (!definition) return null;
              return `${definition.emoji} <@${userAccolades.userId}> earned **${definition.name}**!`;
            })
            .filter(Boolean),
        )
        .slice(0, 10); // Limit to 10 announcements

      if (accoladeMessages.length > 0) {
        await channel.send(
          [
            "",
            "🏆 **New Accolades This Week** 🏆",
            "",
            ...accoladeMessages,
          ].join("\n"),
        );
      }
    } catch (error) {
      logger.error("Error announcing accolades:", error);
      // Don't let accolade errors break the main announcement
    }
  }

  /**
   * Recap section: the quote that gained the most 👍 in the last week (#777,
   * #817). Ranking is by votes cast inside the window, so a quote added long
   * ago can win on a surge of likes; when no vote timing has been captured
   * yet the section falls back to the original "most-liked quote added this
   * week" approximation.
   */
  private async announceQuoteOfWeek(
    channel: TextChannel,
    since: Date,
  ): Promise<void> {
    try {
      const include = await this.configService.getBoolean(
        "voicetracking.announcements.include_quote_of_week",
        true,
      );
      if (!include) return;

      const quotesEnabled = await this.configService.getBoolean(
        "quotes.enabled",
        false,
      );
      if (!quotesEnabled) return;

      // A failure of the vote-window lookup must not take the whole section
      // down: the legacy "added this week" query is independent and may still
      // answer, so a throw here degrades to the fallback rather than skipping
      // Quote of the Week entirely.
      let byVotes: Awaited<
        ReturnType<typeof quoteService.getTopQuoteByVotesSince>
      > = null;
      try {
        byVotes = await quoteService.getTopQuoteByVotesSince(since);
      } catch (error) {
        logger.warn(
          "Vote-window quote lookup failed, falling back to quotes added this week:",
          error,
        );
      }

      const topQuote =
        byVotes?.quote ?? (await quoteService.getTopQuoteSince(since));
      if (!topQuote) return;

      // Author IDs may be stored in legacy formats (<@123>, <@!123>, @123,
      // 123). Only resolve a mention when the whole value is exactly one of
      // those, so malformed data can't assemble an unrelated snowflake — and
      // restrict allowed mentions so untrusted quote text can never ping
      // @everyone/@here or arbitrary roles.
      const authorId = resolveAuthorMentionId(topQuote.authorId);
      const author = authorId ? `<@${authorId}>` : "someone";
      // When the pick came from vote timing, report the likes gained this
      // week — the lifetime tally would overstate what the window measured.
      const likeCount = byVotes ? byVotes.likes : (topQuote.likes ?? 0);
      const likeLabel = likeCount === 1 ? "like" : "likes";
      const likeSuffix = byVotes ? " this week" : "";

      await channel.send({
        content: [
          "",
          "💬 **Quote of the Week** 💬",
          "",
          `> ${topQuote.content}`,
          `— ${author} · 👍 ${likeCount} ${likeLabel}${likeSuffix}`,
        ].join("\n"),
        allowedMentions: authorId
          ? { parse: [], users: [authorId] }
          : { parse: [] },
      });
    } catch (error) {
      logger.error("Error announcing quote of the week:", error);
    }
  }

  /**
   * Recap section: how many members voted, across how many polls, this week
   * (#777, #816). The poll count comes from the per-poll turnout rows, which
   * only exist for polls voted on after #816 shipped — when there are none
   * (an install that has been capturing votes for longer than it has been
   * recording turnout) the line falls back to the original member-only
   * wording rather than claiming "across 0 polls".
   */
  private async announcePollTurnout(
    channel: TextChannel,
    guildId: string,
    since: Date,
  ): Promise<void> {
    try {
      const include = await this.configService.getBoolean(
        "voicetracking.announcements.include_poll_turnout",
        true,
      );
      if (!include) return;

      const participationEnabled = await this.configService.getBoolean(
        "polls.participation.enabled",
        false,
      );
      if (!participationEnabled) return;

      const tracker = PollParticipationTracker.getInstance(this.client);
      const voters = await tracker.getRecentVoterCount(guildId, since);
      if (voters <= 0) return;

      const polls = await tracker.getRecentPollCount(guildId, since);

      const memberLabel = voters === 1 ? "member" : "members";
      const lines = [
        "",
        "🗳️ **Poll Participation** 🗳️",
        "",
        polls > 0
          ? `${voters} ${memberLabel} voted across ${polls} ${polls === 1 ? "poll" : "polls"} this week. Thanks for weighing in!`
          : `${voters} ${memberLabel} voted in polls this week. Thanks for weighing in!`,
      ];

      // Highlight the best-attended poll when there was more than one to
      // choose between — the aggregate turnout is what makes "M polls" more
      // than a bare number.
      if (polls > 1) {
        const top = await this.findTopPoll(tracker, guildId, since);
        if (top) {
          lines.push(
            `🏆 Best turnout: “${top.question}” — ${top.voterCount} ${top.voterCount === 1 ? "member" : "members"}.`,
          );
        }
      }

      await channel.send({
        content: lines.join("\n"),
        // Poll questions can come from a member-created poll, so never let
        // one resolve a mention.
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      logger.error("Error announcing poll participation:", error);
    }
  }

  /**
   * The window's best-attended poll, ready to render, or null when there is
   * nothing honest to show. The winner is picked by the tracker across every
   * poll in the window; if that poll has no question text (turnout captured
   * from a vote event only knows the question when the poll was cached) the
   * highlight is dropped rather than handed to a runner-up — "Best turnout"
   * naming the second-best poll would be wrong, not merely incomplete.
   */
  private async findTopPoll(
    tracker: PollParticipationTracker,
    guildId: string,
    since: Date,
  ): Promise<{ question: string; voterCount: number } | null> {
    const top = await tracker.getTopPollTurnout(guildId, since);
    if (!top?.question || top.voterCount <= 0) return null;

    const question = sanitizeRecapText(top.question);
    if (!question) return null;

    return { question, voterCount: top.voterCount };
  }

  public destroy(): void {
    if (this.announcementJob) {
      this.announcementJob.stop();
      this.announcementJob = null;
    }
    this.isInitialized = false;
  }
}
