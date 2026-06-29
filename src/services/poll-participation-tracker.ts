import { Client, PollAnswer, PartialPollAnswer, Snowflake } from "discord.js";
import logger, { isDebugMode } from "../utils/logger.js";
import { PollParticipationTracking } from "../models/poll-participation-tracking.js";
import mongoose from "mongoose";
import { ConfigService } from "./config-service.js";

/**
 * Tracks poll participation: a `messagePollVoteAdd` listener bumps a
 * per-user "votes cast" counter (plus per-year buckets) in the
 * `PollParticipationTracking` collection. Discord does not let us query a
 * poll's per-user votes after the fact, so this capture is the only chance to
 * record participation for a future Rewind.
 *
 * Writes are gated on `polls.participation.enabled`. A vote on any guild poll
 * counts — the tracking is independent of whether the bot's own poll feature
 * created the poll. The captured counts are surfaced (#655) via
 * `getParticipationSummary` (the `/me/` overview card), the Rewind
 * `pollVotesCast` stat, and the poll-participation accolades.
 */
export class PollParticipationTracker {
  private static instance: PollParticipationTracker;
  private client: Client;
  private isConnected: boolean = false;
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.setupMongoConnectionHandlers();
  }

  private setupMongoConnectionHandlers(): void {
    mongoose.connection.on("connected", () => {
      this.isConnected = true;
      logger.info(
        "MongoDB connection established for poll participation tracker",
      );
    });

    mongoose.connection.on("disconnected", () => {
      this.isConnected = false;
      logger.warn("MongoDB connection lost for poll participation tracker");
    });

    mongoose.connection.on("error", (error: Error) => {
      this.isConnected = false;
      logger.error(
        "MongoDB connection error in poll participation tracker:",
        error,
      );
    });
  }

  private async ensureConnection(): Promise<void> {
    if (!this.isConnected) {
      try {
        await mongoose.connect(
          await this.configService.getString(
            "MONGODB_URI",
            "mongodb://mongodb:27017/koolbot",
          ),
        );
        logger.info("Reconnected to MongoDB for poll participation tracker");
      } catch (error: unknown) {
        logger.error("Error reconnecting to MongoDB:", error);
        throw error;
      }
    }
  }

  public static getInstance(client: Client): PollParticipationTracker {
    if (!PollParticipationTracker.instance) {
      PollParticipationTracker.instance = new PollParticipationTracker(client);
    }
    return PollParticipationTracker.instance;
  }

  /**
   * Handle a `messagePollVoteAdd` event. Writes are gated on
   * `polls.participation.enabled = true`; DM polls and bot voters are
   * skipped. Each selected answer fires its own event, so a multi-select
   * vote counts once per chosen answer (i.e. "votes cast").
   */
  public async handlePollVoteAdd(
    pollAnswer: PollAnswer | PartialPollAnswer,
    userId: Snowflake,
  ): Promise<void> {
    try {
      const isEnabled = await this.configService.getBoolean(
        "polls.participation.enabled",
        false,
      );
      if (!isEnabled) {
        return;
      }

      const message = pollAnswer.poll.message;

      // Guild-scoped only — ignore DM polls.
      const guildId = message.guild?.id ?? message.guildId;
      if (!guildId) {
        return;
      }

      // Resolve the voter so we can store a friendly username and skip bots.
      // Prefer the in-memory cache to avoid an API round-trip on every vote;
      // only hit the REST API when the user isn't cached.
      const user =
        this.client.users.cache.get(userId) ??
        (await this.client.users.fetch(userId));
      if (user.bot) {
        return;
      }

      const year = String(new Date().getFullYear());
      await this.recordVote(userId, guildId, user.username, year);

      if (isDebugMode()) {
        logger.info(
          `[DEBUG] Recorded poll vote by ${user.username} (${userId}) in guild ${guildId}`,
        );
      }
    } catch (error: unknown) {
      logger.error("Error handling messagePollVoteAdd in tracker:", error);
    }
  }

  /**
   * Atomically upsert one user's vote counters. A Mongo `Map` field lets us
   * `$inc` the per-year bucket on a dotted path, so a new user, a new year,
   * and the steady state are all a single write.
   */
  private async recordVote(
    userId: string,
    guildId: string,
    username: string,
    year: string,
  ): Promise<void> {
    await this.ensureConnection();

    await PollParticipationTracking.updateOne(
      { userId, guildId },
      {
        $setOnInsert: { userId, guildId },
        $set: { username, lastVoteAt: new Date() },
        $inc: { totalVotes: 1, [`yearlyVotes.${year}`]: 1 },
      },
      { upsert: true },
    );
  }

  /**
   * Read a member's poll-participation summary for the `/me/` self-service
   * surface (#655): lifetime votes, this-year votes, and when they last
   * voted. One indexed `(userId, guildId)` lookup. Returns `null` when the
   * member has no tracking row (never voted, or capture was off when they
   * did) so the caller can hide the card.
   *
   * The current-year bucket comes from `yearlyVotes`, keyed by
   * host-timezone year at capture time (matching how votes are recorded in
   * `recordVote`). A `.lean()` read returns the Map field as a plain object,
   * which is handled here. Does not itself gate on
   * `polls.participation.enabled`: the caller intentionally hides the card
   * when the gate is off, regardless of any rows left over from a period when
   * capture was previously enabled.
   */
  public async getParticipationSummary(
    userId: string,
    guildId: string,
  ): Promise<{
    totalVotes: number;
    thisYearVotes: number;
    lastVoteAt: Date | null;
  } | null> {
    try {
      await this.ensureConnection();

      const doc = await PollParticipationTracking.findOne(
        { userId, guildId },
        { totalVotes: 1, yearlyVotes: 1, lastVoteAt: 1 },
      ).lean<{
        totalVotes?: number;
        yearlyVotes?: Map<string, number> | Record<string, number>;
        lastVoteAt?: Date | null;
      }>();
      if (!doc) return null;

      const year = String(new Date().getFullYear());
      const bucket = doc.yearlyVotes;
      const rawThisYear =
        bucket instanceof Map
          ? bucket.get(year)
          : (bucket as Record<string, number> | undefined)?.[year];
      const thisYearVotes =
        typeof rawThisYear === "number" && Number.isFinite(rawThisYear)
          ? rawThisYear
          : 0;

      return {
        totalVotes: typeof doc.totalVotes === "number" ? doc.totalVotes : 0,
        thisYearVotes,
        lastVoteAt: doc.lastVoteAt ?? null,
      };
    } catch (error) {
      logger.error("Error reading poll participation summary:", error);
      return null;
    }
  }

  public async initialize(): Promise<void> {
    try {
      await this.ensureConnection();
      logger.info("PollParticipationTracker initialized");
    } catch (error) {
      logger.error("Error initializing PollParticipationTracker:", error);
      throw error;
    }
  }
}
