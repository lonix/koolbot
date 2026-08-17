import { Client, PollAnswer, PartialPollAnswer, Snowflake } from "discord.js";
import logger, { isDebugMode } from "../utils/logger.js";
import { PollParticipationTracking } from "../models/poll-participation-tracking.js";
import { PollTurnout } from "../models/poll-turnout.js";
import mongoose from "mongoose";
import { ConfigService } from "./config-service.js";
import { getIsoWeekKey } from "../utils/time.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * Read one counter out of a `Map` field. A `.lean()` read hands back the Map
 * as a plain object while a hydrated document keeps a real `Map`, so both
 * shapes are handled; anything missing or non-numeric reads as 0.
 */
function readBucket(
  bucket: Map<string, number> | Record<string, number> | undefined,
  key: string,
): number {
  const raw =
    bucket instanceof Map
      ? bucket.get(key)
      : (bucket as Record<string, number> | undefined)?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

// How often the retention pass runs. Both windows are measured in weeks/days,
// so a daily sweep is ample; the first one runs at startup.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Cap on how many bulk `$unset` operations are sent to Mongo at once while
// pruning week buckets.
const PRUNE_BATCH_SIZE = 500;

/**
 * Tracks poll participation: a `messagePollVoteAdd` listener bumps a
 * per-user "votes cast" counter (lifetime, per-year and per-ISO-week buckets)
 * in the `PollParticipationTracking` collection, and upserts a per-poll
 * turnout row in `PollTurnout`. Discord does not let us query a poll's
 * per-user votes after the fact, so this capture is the only chance to record
 * participation.
 *
 * Writes are gated on `polls.participation.enabled`. A vote on any guild poll
 * counts — the tracking is independent of whether the bot's own poll feature
 * created the poll. The captured counts are surfaced (#655) via
 * `getParticipationSummary` (the `/me/` overview card), the Rewind
 * `pollVotesCast` stat, the poll-participation accolades, and the weekly
 * recap's "N members voted across M polls this week" line (#777, #816).
 *
 * Both time-scoped stores are bounded by a daily retention pass
 * (`pruneExpiredData`): week buckets older than
 * `polls.participation.weekly_retention_weeks` are unset, and turnout rows
 * older than `polls.turnout.retention_days` are deleted.
 */
export class PollParticipationTracker {
  private static instance: PollParticipationTracker;
  private client: Client;
  private isConnected: boolean = false;
  private configService: ConfigService;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;

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

      const now = new Date();
      const year = String(now.getFullYear());
      await this.recordVote(userId, guildId, user.username, year, now);
      await this.recordTurnout(guildId, message, userId, now);

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
   * `$inc` the per-year and per-ISO-week buckets on dotted paths, so a new
   * user, a new year, a new week, and the steady state are all a single
   * write. The week key is UTC-anchored (`getIsoWeekKey`) while the year key
   * stays host-timezone for backwards compatibility with rows written before
   * #816 — they are read independently and never compared to each other.
   */
  private async recordVote(
    userId: string,
    guildId: string,
    username: string,
    year: string,
    now: Date,
  ): Promise<void> {
    await this.ensureConnection();

    const week = getIsoWeekKey(now);
    await PollParticipationTracking.updateOne(
      { userId, guildId },
      {
        $setOnInsert: { userId, guildId },
        $set: { username, lastVoteAt: now },
        $inc: {
          totalVotes: 1,
          [`yearlyVotes.${year}`]: 1,
          [`weeklyVotes.${week}`]: 1,
        },
      },
      { upsert: true },
    );
  }

  /**
   * Upsert the per-poll turnout row for the poll this vote belongs to (#816).
   * Keyed by the poll's message id, so repeat votes (and multiselect votes,
   * which fire one event per chosen answer) fold into one row: `votesCast`
   * counts events while `voterIds` accumulates distinct members.
   *
   * Written as an update *pipeline* rather than plain operators because two
   * fields must be filled in on first sight rather than on insert:
   * `recordPollPosted` may already have created the row for a scheduled poll
   * (with no votes yet), so `$setOnInsert` would never fire and `firstVoteAt`
   * would stay null forever. `question` behaves the same way in reverse — a
   * member-created poll observed first through a partial message has no
   * question text, and only a later cached vote can supply one. `$ifNull`
   * gives both "keep what's there, otherwise take what we just learned"
   * semantics in a single atomic write.
   *
   * `postedAt` falls back to the message's creation time, which discord.js
   * derives from the snowflake and is therefore available even when the
   * message is partial.
   */
  private async recordTurnout(
    guildId: string,
    message: {
      id?: string | null;
      channelId?: string | null;
      createdAt?: Date | null;
      poll?: unknown;
    },
    userId: string,
    now: Date,
  ): Promise<void> {
    const messageId = message.id;
    if (!messageId) return;

    await this.ensureConnection();

    const question = (
      message.poll as { question?: { text?: string } } | null | undefined
    )?.question?.text;

    await PollTurnout.updateOne(
      { guildId, messageId },
      [
        {
          $set: {
            guildId,
            messageId,
            channelId: { $ifNull: ["$channelId", message.channelId ?? null] },
            question: { $ifNull: ["$question", question ?? null] },
            postedAt: { $ifNull: ["$postedAt", message.createdAt ?? now] },
            firstVoteAt: { $ifNull: ["$firstVoteAt", now] },
            lastVoteAt: now,
            votesCast: { $add: [{ $ifNull: ["$votesCast", 0] }, 1] },
            // The pipeline equivalent of `$addToSet` for a whole array.
            voterIds: {
              $setUnion: [{ $ifNull: ["$voterIds", []] }, [userId]],
            },
          },
        },
      ],
      { upsert: true },
    );
  }

  /**
   * Record a poll the bot just posted (#816). This is the only moment the
   * question text and an exact `postedAt` are known, so `PollService` calls
   * it right after sending; a poll nobody votes on still gets a row this way.
   * Gated on `polls.participation.enabled` here rather than at the call site
   * so the poll feature stays oblivious to the capture toggle, and
   * best-effort: a failure is logged, never propagated into poll posting.
   */
  public async recordPollPosted(params: {
    guildId: string;
    messageId: string;
    channelId: string | null;
    question: string | null;
    postedAt: Date;
  }): Promise<void> {
    try {
      const isEnabled = await this.configService.getBoolean(
        "polls.participation.enabled",
        false,
      );
      if (!isEnabled) return;

      await this.ensureConnection();

      await PollTurnout.updateOne(
        { guildId: params.guildId, messageId: params.messageId },
        {
          $setOnInsert: {
            guildId: params.guildId,
            messageId: params.messageId,
            firstVoteAt: null,
            lastVoteAt: null,
            votesCast: 0,
            voterIds: [],
          },
          // Posting is the authoritative source for these three, so they
          // overwrite anything a racing vote capture guessed.
          $set: {
            channelId: params.channelId,
            question: params.question,
            postedAt: params.postedAt,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      logger.error(
        `Error recording posted poll ${sanitizeForLog(params.messageId)}:`,
        error,
      );
    }
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
    thisWeekVotes: number;
    lastVoteAt: Date | null;
  } | null> {
    try {
      await this.ensureConnection();

      const doc = await PollParticipationTracking.findOne(
        { userId, guildId },
        { totalVotes: 1, yearlyVotes: 1, weeklyVotes: 1, lastVoteAt: 1 },
      ).lean<{
        totalVotes?: number;
        yearlyVotes?: Map<string, number> | Record<string, number>;
        weeklyVotes?: Map<string, number> | Record<string, number>;
        lastVoteAt?: Date | null;
      }>();
      if (!doc) return null;

      const now = new Date();
      const thisYearVotes = readBucket(
        doc.yearlyVotes,
        String(now.getFullYear()),
      );
      // Zero for rows that predate #816 (no week buckets were written then).
      const thisWeekVotes = readBucket(doc.weeklyVotes, getIsoWeekKey(now));

      return {
        totalVotes: typeof doc.totalVotes === "number" ? doc.totalVotes : 0,
        thisYearVotes,
        thisWeekVotes,
        lastVoteAt: doc.lastVoteAt ?? null,
      };
    } catch (error) {
      logger.error("Error reading poll participation summary:", error);
      return null;
    }
  }

  /**
   * Count distinct members who cast at least one poll vote since `since`, for
   * the public weekly recap (#777). `lastVoteAt` is each member's most recent
   * vote, so `lastVoteAt >= since` is true for exactly the members who voted at
   * least once inside the window — this is an *exact* distinct-member count for
   * captured votes, not an approximation. The companion half of the recap
   * sentence ("across M polls") comes from `getRecentPollCount`. Best-effort —
   * returns 0 on any DB error so the recap never fails on this section.
   */
  public async getRecentVoterCount(
    guildId: string,
    since: Date,
  ): Promise<number> {
    try {
      await this.ensureConnection();
      return await PollParticipationTracking.countDocuments({
        guildId,
        lastVoteAt: { $gte: since },
      });
    } catch (error) {
      logger.error("Error counting recent poll voters:", error);
      return 0;
    }
  }

  /**
   * Count polls that received at least one captured vote since `since` — the
   * "M polls" in the recap's "N members voted across M polls this week"
   * (#816). Counts turnout rows rather than poll *posts* so the figure lines
   * up with `getRecentVoterCount`: both cover every guild poll people
   * actually voted on, including ones the bot did not post, and a poll that
   * drew no votes is not something members "voted across". Best-effort —
   * returns 0 on any DB error so the recap never fails on this section.
   */
  public async getRecentPollCount(
    guildId: string,
    since: Date,
  ): Promise<number> {
    try {
      await this.ensureConnection();
      return await PollTurnout.countDocuments({
        guildId,
        lastVoteAt: { $gte: since },
      });
    } catch (error) {
      logger.error("Error counting recent polls:", error);
      return 0;
    }
  }

  /**
   * The best-attended poll of a window, or null when none drew a vote — the
   * "Best turnout" highlight on the recap. Distinct voters are computed from
   * `voterIds` (`$size`) rather than stored, so the count can never drift
   * from the set it summarises.
   *
   * Ranking happens in Mongo over *every* matching row, not over a page of
   * them: reading "the most recent N polls" and picking the maximum client
   * side would silently crown a runner-up in any week busier than N. Ties go
   * to the most recently posted poll. Best-effort: returns null on a DB
   * error, and the caller drops the highlight.
   */
  public async getTopPollTurnout(
    guildId: string,
    since: Date,
  ): Promise<{
    messageId: string;
    question: string | null;
    postedAt: Date;
    voterCount: number;
    votesCast: number;
  } | null> {
    try {
      await this.ensureConnection();

      const rows = await PollTurnout.aggregate<{
        messageId: string;
        question?: string | null;
        postedAt: Date;
        voterCount?: number;
        votesCast?: number;
      }>([
        { $match: { guildId, lastVoteAt: { $gte: since } } },
        {
          $addFields: {
            voterCount: { $size: { $ifNull: ["$voterIds", []] } },
          },
        },
        { $sort: { voterCount: -1, postedAt: -1 } },
        { $limit: 1 },
        {
          $project: {
            _id: 0,
            messageId: 1,
            question: 1,
            postedAt: 1,
            voterCount: 1,
            votesCast: 1,
          },
        },
      ]);

      const top = rows?.[0];
      if (!top) return null;

      return {
        messageId: top.messageId,
        question: top.question ?? null,
        postedAt: top.postedAt,
        voterCount: top.voterCount ?? 0,
        votesCast: top.votesCast ?? 0,
      };
    } catch (error) {
      logger.error("Error reading top poll turnout:", error);
      return null;
    }
  }

  /**
   * Retention pass for the two time-scoped stores (#816). The lifetime and
   * per-year counters are deliberately untouched — they are a fixed handful
   * of numbers per member and feed all-time surfaces — but the week buckets
   * and the per-poll rows (which carry voter ids) grow without bound, so both
   * are trimmed here:
   *
   * - week buckets older than `polls.participation.weekly_retention_weeks`
   *   are `$unset`. Because ISO week keys ("YYYY-Www") sort lexicographically
   *   in chronological order, "older than the cutoff week" is a plain string
   *   compare.
   * - `PollTurnout` rows whose `postedAt` predates
   *   `polls.turnout.retention_days` are deleted.
   *
   * Either window set to 0 means "keep forever", matching the other
   * `*.retention_*` keys. Best-effort: errors are logged, never thrown, so a
   * failed sweep can't take down the interval that drives it.
   */
  public async pruneExpiredData(): Promise<{
    weekBucketsPruned: number;
    turnoutRowsDeleted: number;
  }> {
    const result = { weekBucketsPruned: 0, turnoutRowsDeleted: 0 };

    try {
      await this.ensureConnection();

      const retentionWeeks = await this.configService.getNumber(
        "polls.participation.weekly_retention_weeks",
        12,
      );
      if (retentionWeeks > 0) {
        result.weekBucketsPruned = await this.pruneWeekBuckets(retentionWeeks);
      }

      const retentionDays = await this.configService.getNumber(
        "polls.turnout.retention_days",
        90,
      );
      if (retentionDays > 0) {
        const cutoff = new Date(
          Date.now() - retentionDays * 24 * 60 * 60 * 1000,
        );
        const deleted = await PollTurnout.deleteMany({
          postedAt: { $lt: cutoff },
        });
        result.turnoutRowsDeleted = deleted?.deletedCount ?? 0;
      }

      if (result.weekBucketsPruned > 0 || result.turnoutRowsDeleted > 0) {
        logger.info(
          `Poll participation retention: pruned ${result.weekBucketsPruned} week bucket(s), deleted ${result.turnoutRowsDeleted} poll turnout row(s)`,
        );
      }
    } catch (error) {
      logger.error("Error pruning poll participation data:", error);
    }

    return result;
  }

  /**
   * Unset week buckets older than the retention window.
   *
   * The stale-key filtering runs inside Mongo — `$objectToArray` turns the
   * bucket map into entries, and only documents that still hold a key below
   * the cutoff come back, carrying just those keys. Combined with a cursor
   * that means neither the read side nor the write side scales with the size
   * of the participation collection: a steady-state sweep transfers nothing
   * at all, rather than every member's full bucket map. Keys are compared as
   * strings, which is valid because ISO week keys sort chronologically.
   */
  private async pruneWeekBuckets(retentionWeeks: number): Promise<number> {
    const cutoffKey = getIsoWeekKey(
      new Date(Date.now() - retentionWeeks * 7 * 24 * 60 * 60 * 1000),
    );

    const cursor = PollParticipationTracking.aggregate<{
      _id: mongoose.Types.ObjectId;
      staleKeys: string[];
    }>([
      {
        $project: {
          staleKeys: {
            $map: {
              input: {
                $filter: {
                  input: {
                    $objectToArray: { $ifNull: ["$weeklyVotes", {}] },
                  },
                  cond: { $lt: ["$$this.k", cutoffKey] },
                },
              },
              in: "$$this.k",
            },
          },
        },
      },
      { $match: { "staleKeys.0": { $exists: true } } },
    ]).cursor();

    // The `$unset` paths are dotted Map keys, which the typed UpdateFilter
    // can't express, so the ops are assembled as the bulkWrite element type.
    type PruneOp = Parameters<
      typeof PollParticipationTracking.bulkWrite
    >[0][number];

    let pruned = 0;
    let batch: PruneOp[] = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await PollParticipationTracking.bulkWrite(batch);
      batch = [];
    };

    for await (const doc of cursor) {
      const stale: string[] = doc.staleKeys ?? [];
      if (stale.length === 0) continue;

      pruned += stale.length;
      batch.push({
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $unset: Object.fromEntries(
              stale.map((key) => [`weeklyVotes.${key}`, ""]),
            ),
          },
        },
      } as PruneOp);

      if (batch.length >= PRUNE_BATCH_SIZE) {
        await flush();
      }
    }

    await flush();
    return pruned;
  }

  public async initialize(): Promise<void> {
    try {
      await this.ensureConnection();

      // Run the retention pass once at startup, then daily. The interval is
      // unref'd so it never keeps the process alive on shutdown, and the
      // pass swallows its own errors so a bad sweep can't kill the timer.
      await this.pruneExpiredData();
      if (!this.pruneInterval) {
        this.pruneInterval = setInterval(() => {
          void this.pruneExpiredData();
        }, PRUNE_INTERVAL_MS);
        this.pruneInterval.unref?.();
      }

      logger.info("PollParticipationTracker initialized");
    } catch (error) {
      logger.error("Error initializing PollParticipationTracker:", error);
      throw error;
    }
  }

  public destroy(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
  }
}
