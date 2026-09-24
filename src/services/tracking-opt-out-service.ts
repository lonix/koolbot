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
 * ## No write outlives an opt-out
 *
 * A check alone is a snapshot: a write that passed it a moment before the
 * opt-out would still land afterwards — and, if the member resets straight
 * after, recreate the rows the reset just deleted. So the trackers run their
 * writes through `trackWrite`, which checks and registers the write in one
 * synchronous step, and `optOut` does not return until every write it could
 * not stop has settled (bounded by `DRAIN_TIMEOUT_MS`). Voice sessions live
 * in the voice tracker's memory rather than in a write, so it registers an
 * opt-out hook (`onOptOut`) that evicts the member's session and drains its
 * persists. Once `optOut` returns, nothing more is written about the member.
 *
 * Opt-outs and opt-ins for the same member are serialised, so two
 * overlapping requests cannot leave the cache disagreeing with Mongo.
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

  /** Upper bound on how long `optOut` waits for in-flight writes. */
  static readonly DRAIN_TIMEOUT_MS = 10_000;

  /** `guildId:userId` for every opted-out member; null until loaded. */
  private optedOut: Set<string> | null = null;
  private loading: Promise<void> | null = null;
  private lastFailedLoadAt = 0;
  /** In-flight tracker writes per `guildId:userId` (see `trackWrite`). */
  private inFlight = new Map<string, Set<Promise<unknown>>>();
  /** Tail of the per-member mutation chain (see `serialise`). */
  private mutations = new Map<string, Promise<unknown>>();
  private optOutHooks: Array<
    (userId: string, guildId: string) => Promise<unknown>
  > = [];

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
   * Run a tracker write for a member unless they are opted out. The check
   * and the registration happen together, synchronously, so `optOut` either
   * stops the write or waits for it — there is no gap between the two.
   * Resolves `false` when the member is opted out and nothing ran.
   */
  public async trackWrite(
    userId: string,
    guildId: string,
    write: () => Promise<void>,
  ): Promise<boolean> {
    if (this.isOptedOut(userId, guildId)) return false;
    const key = TrackingOptOutService.key(userId, guildId);
    const pending = this.inFlight.get(key) ?? new Set<Promise<unknown>>();
    this.inFlight.set(key, pending);
    const running = write();
    pending.add(running);
    try {
      await running;
    } finally {
      pending.delete(running);
      if (pending.size === 0) this.inFlight.delete(key);
    }
    return true;
  }

  /**
   * Register work to run whenever a member opts out, after the cache knows —
   * the voice tracker uses it to evict a live session. `optOut` awaits it; a
   * hook that throws is logged and does not fail the opt-out.
   */
  public onOptOut(
    hook: (userId: string, guildId: string) => Promise<unknown>,
  ): void {
    this.optOutHooks.push(hook);
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

  /**
   * Opt a member out. Idempotent; keeps the original timestamp. Returns once
   * no tracker write about the member is still in flight (or the drain timed
   * out, which is logged).
   */
  public async optOut(userId: string, guildId: string): Promise<void> {
    const key = TrackingOptOutService.key(userId, guildId);
    await this.serialise(key, async () => {
      await TrackingOptOut.updateOne(
        { userId, guildId },
        { $setOnInsert: { userId, guildId, optedOutAt: new Date() } },
        { upsert: true },
      );
      await this.settleLoad();
      this.optedOut?.add(key);
    });
    logger.info(
      `Member ${sanitizeForLog(userId)} opted out of tracking in guild ${sanitizeForLog(guildId)}`,
    );

    // From here no new write can start; wait out the ones that already had.
    if (!(await this.drainWrites(key))) {
      logger.warn(
        `Timed out waiting for in-flight tracking writes for ${sanitizeForLog(userId)} after opt-out`,
      );
    }
    for (const hook of this.optOutHooks) {
      try {
        await hook(userId, guildId);
      } catch (error) {
        logger.warn(
          `Tracking opt-out hook failed for ${sanitizeForLog(userId)}`,
          error,
        );
      }
    }
  }

  /**
   * Opt a member back in by deleting their row. Idempotent. Returns whether
   * a row was removed.
   */
  public async optIn(userId: string, guildId: string): Promise<boolean> {
    const key = TrackingOptOutService.key(userId, guildId);
    const result = await this.serialise(key, async () => {
      const deleted = await TrackingOptOut.deleteOne({ userId, guildId });
      await this.settleLoad();
      this.optedOut?.delete(key);
      return deleted;
    });
    const removed = (result?.deletedCount ?? 0) > 0;
    if (removed) {
      logger.info(
        `Member ${sanitizeForLog(userId)} opted back in to tracking in guild ${sanitizeForLog(guildId)}`,
      );
    }
    return removed;
  }

  /**
   * Run `fn` after every earlier mutation for the same member has settled,
   * so the Mongo write and the cache update of one request can never
   * interleave with another's.
   */
  private async serialise<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.mutations.set(key, run);
    try {
      return await run;
    } finally {
      if (this.mutations.get(key) === run) this.mutations.delete(key);
    }
  }

  /**
   * Wait for the member's in-flight tracker writes. Loops because a write
   * registered while waiting would otherwise slip through (none can once the
   * cache holds the member, but the loop is cheap). False on timeout.
   */
  private async drainWrites(key: string): Promise<boolean> {
    const deadline = Date.now() + TrackingOptOutService.DRAIN_TIMEOUT_MS;
    for (;;) {
      const pending = this.inFlight.get(key);
      if (!pending || pending.size === 0) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        Promise.allSettled([...pending]).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) return false;
    }
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
