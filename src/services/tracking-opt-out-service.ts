import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { TrackingOptOut } from "../models/tracking-opt-out.js";

/**
 * The member tracking opt-out (#918).
 *
 * The message, reaction, voice and poll-participation trackers all consult
 * this before writing anything about a member. Their write paths are the
 * hottest in the bot — every message, reaction, vote and voice state change
 * in the guild — so the check must never cost a round trip:
 *
 * - The whole collection is loaded into an in-memory `Set` once, at startup
 *   (`initialize`). It only ever holds members who are currently opted out,
 *   so it stays small.
 * - `isOptedOut` is **synchronous** and is a single `Set.has`.
 * - `optOut` / `optIn` write Mongo first and update the set only once the
 *   write has landed, so the cache never claims a state the database does
 *   not hold. The bot runs as one process (the web UI included), so this set
 *   is the only cache there is.
 *
 * ## Fail closed
 *
 * Until the set has loaded, `isOptedOut` answers `true` for everyone: a
 * member who opted out must never be tracked just because Mongo was slow at
 * boot. Tracking for everyone else pauses until the load succeeds, which is
 * the cheaper failure — and a Mongo outage stops the trackers' own writes
 * anyway. A failed load is retried in the background, at most once per
 * `RETRY_INTERVAL_MS`, from the next check that finds the set unloaded.
 *
 * ## Read side
 *
 * An opt-out stops *accumulation*; it does not hide what is already stored.
 * Leaderboards, digests, `/voicestats` and Rewind keep showing existing data
 * until the member resets it from `/me/privacy` — opt-out plus reset is the
 * deletion. Opting back in re-enables tracking from that moment on and
 * restores nothing: whatever happened while opted out was never recorded.
 */
export class TrackingOptOutService {
  private static instance: TrackingOptOutService | null = null;

  /** How long to wait after a failed load before trying again. */
  static readonly RETRY_INTERVAL_MS = 30_000;

  /** `guildId:userId` for every opted-out member; null until loaded. */
  private optedOut: Set<string> | null = null;
  private loading: Promise<void> | null = null;
  private lastFailedLoadAt = 0;

  private constructor() {}

  public static getInstance(): TrackingOptOutService {
    if (!TrackingOptOutService.instance) {
      TrackingOptOutService.instance = new TrackingOptOutService();
    }
    return TrackingOptOutService.instance;
  }

  /** Drop the singleton. Tests only. */
  public static reset(): void {
    TrackingOptOutService.instance = null;
  }

  private static key(userId: string, guildId: string): string {
    return `${guildId}:${userId}`;
  }

  /** Load the opt-out set. Throws when the load fails. */
  public async initialize(): Promise<void> {
    await this.load();
    logger.info(
      `TrackingOptOutService initialized (${this.optedOut?.size ?? 0} opted-out member(s))`,
    );
  }

  /** Whether the set has loaded; false means `isOptedOut` is failing closed. */
  public isLoaded(): boolean {
    return this.optedOut !== null;
  }

  /**
   * Whether the trackers must skip this member. Synchronous and O(1): safe
   * on every message, reaction and voice state change.
   */
  public isOptedOut(userId: string, guildId: string): boolean {
    if (this.optedOut === null) {
      this.retryLoadInBackground();
      return true;
    }
    return this.optedOut.has(TrackingOptOutService.key(userId, guildId));
  }

  /**
   * The member's opt-out timestamp read straight from Mongo, or null when
   * they are not opted out. For the `/me/privacy` page, which must show the
   * real state rather than a fail-closed guess.
   */
  public async getOptedOutAt(
    userId: string,
    guildId: string,
  ): Promise<Date | null> {
    const row = await TrackingOptOut.findOne({ userId, guildId }).lean();
    return row?.optedOutAt ?? null;
  }

  /** Opt a member out. Idempotent; keeps the original timestamp. */
  public async optOut(userId: string, guildId: string): Promise<void> {
    await TrackingOptOut.updateOne(
      { userId, guildId },
      { $setOnInsert: { userId, guildId, optedOutAt: new Date() } },
      { upsert: true },
    );
    await this.settleLoad();
    this.optedOut?.add(TrackingOptOutService.key(userId, guildId));
    logger.info(
      `Member ${sanitizeForLog(userId)} opted out of tracking in guild ${sanitizeForLog(guildId)}`,
    );
  }

  /**
   * Opt a member back in by deleting their row. Idempotent. Returns whether
   * a row was removed.
   */
  public async optIn(userId: string, guildId: string): Promise<boolean> {
    const result = await TrackingOptOut.deleteOne({ userId, guildId });
    await this.settleLoad();
    this.optedOut?.delete(TrackingOptOutService.key(userId, guildId));
    const removed = (result?.deletedCount ?? 0) > 0;
    if (removed) {
      logger.info(
        `Member ${sanitizeForLog(userId)} opted back in to tracking in guild ${sanitizeForLog(guildId)}`,
      );
    }
    return removed;
  }

  /**
   * Wait out a load already in flight before touching the set. A load that
   * read the collection before this write landed would otherwise replace the
   * set afterwards and silently undo it.
   */
  private async settleLoad(): Promise<void> {
    if (this.loading) await this.loading.catch(() => undefined);
  }

  private load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async (): Promise<void> => {
        try {
          const rows = await TrackingOptOut.find(
            {},
            { userId: 1, guildId: 1, _id: 0 },
          ).lean();
          this.optedOut = new Set(
            (rows ?? []).map((row) =>
              TrackingOptOutService.key(row.userId, row.guildId),
            ),
          );
        } catch (error) {
          this.lastFailedLoadAt = Date.now();
          throw error;
        } finally {
          this.loading = null;
        }
      })();
    }
    return this.loading;
  }

  private retryLoadInBackground(): void {
    if (this.loading) return;
    if (
      Date.now() - this.lastFailedLoadAt <
      TrackingOptOutService.RETRY_INTERVAL_MS
    ) {
      return;
    }
    this.load().catch((error: unknown) => {
      logger.warn(
        "Could not load tracking opt-outs; tracking stays paused until it succeeds",
        error,
      );
    });
  }
}
