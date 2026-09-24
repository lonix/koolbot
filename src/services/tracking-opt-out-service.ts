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
 * Opt-outs, opt-ins and data resets for the same member all run under one
 * per-member barrier (`serialise`), so none can interleave with another.
 * A reset runs inside `withTrackingPaused`, which blocks every tracker write
 * about the member for its whole duration — a handler that passed an early
 * check cannot slip a write in after the reset's deletes — and an opt-in
 * refuses to resume tracking until work left over from the opt-out has
 * settled.
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
  /** Timer for the next background reload after a failed one. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** In-flight tracker writes per `guildId:userId` (see `trackWrite`). */
  private inFlight = new Map<string, Set<Promise<unknown>>>();
  /** Tail of the per-member mutation chain (see `serialise`). */
  private mutations = new Map<string, Promise<unknown>>();
  private optOutHooks: Array<
    (userId: string, guildId: string) => Promise<unknown>
  > = [];
  /** Members whose tracking is paused while their data is reset. */
  private paused = new Set<string>();

  private constructor() {}

  public static getInstance(): TrackingOptOutService {
    if (!TrackingOptOutService.instance) {
      TrackingOptOutService.instance = new TrackingOptOutService();
    }
    return TrackingOptOutService.instance;
  }

  /** Drop the singleton. Tests only. */
  public static reset(): void {
    TrackingOptOutService.instance?.cancelRetry();
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
   * Whether the trackers must skip this member: they opted out, or their
   * data is being reset right now (`withTrackingPaused`). Synchronous and
   * O(1): safe on every message, reaction and voice state change.
   */
  public isOptedOut(userId: string, guildId: string): boolean {
    const key = TrackingOptOutService.key(userId, guildId);
    if (this.paused.has(key)) return true;
    if (this.optedOut === null) {
      this.retryLoadInBackground();
      return true;
    }
    return this.optedOut.has(key);
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
   * Register work that brings a member's tracking to rest: evict what is
   * live and wait out what is in flight. The voice tracker uses it for its
   * in-memory session and persists. It runs after the cache already blocks
   * the member — on opt-out, before an opt-in resumes tracking, and at the
   * start of a reset. Resolve `false` to report a drain that timed out; a
   * hook that throws is logged and counts as unsettled.
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
   * Opt a member out. Idempotent; keeps the original timestamp. Resolves once
   * no tracker write about the member is still in flight, with `settled:
   * false` when that could not be confirmed — the drain or a hook timed out
   * or failed. The opt-out itself is stored either way; `settled: false`
   * only means a write already under way might still land, which the caller
   * must not paper over (a reset straight after quiesces again and reports
   * it; an opt-in refuses until it has settled).
   */
  public async optOut(
    userId: string,
    guildId: string,
  ): Promise<{ settled: boolean }> {
    const key = TrackingOptOutService.key(userId, guildId);
    // The whole opt-out — write, cache, drain and hooks — holds the member's
    // barrier, so neither an opt-in nor a reset can overtake it.
    return this.serialise(key, async () => {
      await TrackingOptOut.updateOne(
        { userId, guildId },
        { $setOnInsert: { userId, guildId, optedOutAt: new Date() } },
        { upsert: true },
      );
      await this.settleLoad();
      this.optedOut?.add(key);
      logger.info(
        `Member ${sanitizeForLog(userId)} opted out of tracking in guild ${sanitizeForLog(guildId)}`,
      );
      // From here no new write can start; wait out the ones that already had.
      const { settled } = await this.quiesce(userId, guildId, key);
      return { settled };
    });
  }

  /**
   * Opt a member back in by deleting their row. Before tracking resumes, the
   * work an opt-out could not confirm finished is waited out again; if it
   * still has not settled, nothing changes and `settled: false` is returned,
   * so a late write from the opted-out period cannot land as fresh tracking.
   * Idempotent. `removed` says whether a row was deleted.
   */
  public async optIn(
    userId: string,
    guildId: string,
  ): Promise<{ removed: boolean; settled: boolean }> {
    const key = TrackingOptOutService.key(userId, guildId);
    return this.serialise(key, async () => {
      // Still opted out here, so nothing new can start while this waits.
      const { settled } = await this.quiesce(userId, guildId, key);
      if (!settled) {
        logger.warn(
          `Not opting ${sanitizeForLog(userId)} back in yet: work from their opt-out has not settled`,
        );
        return { removed: false, settled: false };
      }
      const deleted = await TrackingOptOut.deleteOne({ userId, guildId });
      await this.settleLoad();
      this.optedOut?.delete(key);
      const removed = (deleted?.deletedCount ?? 0) > 0;
      if (removed) {
        logger.info(
          `Member ${sanitizeForLog(userId)} opted back in to tracking in guild ${sanitizeForLog(guildId)}`,
        );
      }
      return { removed, settled: true };
    });
  }

  /**
   * Run `fn` — a data reset — with every tracker write about the member
   * blocked for its whole duration, under the member's barrier so no opt-in
   * or opt-out can interleave. Before `fn` starts, in-flight writes and the
   * hooks are waited out; `fn` receives how many writes were pending and
   * whether everything settled, so the reset can report it rather than claim
   * a clean deletion.
   */
  public async withTrackingPaused<T>(
    userId: string,
    guildId: string,
    fn: (quiesced: { pending: number; settled: boolean }) => Promise<T>,
  ): Promise<T> {
    const key = TrackingOptOutService.key(userId, guildId);
    return this.serialise(key, async () => {
      this.paused.add(key);
      try {
        return await fn(await this.quiesce(userId, guildId, key));
      } finally {
        this.paused.delete(key);
      }
    });
  }

  /**
   * Wait out the member's in-flight tracker writes and run every hook. Only
   * called once the member is already blocked (opted out or paused), so
   * nothing new can start meanwhile.
   */
  private async quiesce(
    userId: string,
    guildId: string,
    key: string,
  ): Promise<{ pending: number; settled: boolean }> {
    const pending = this.inFlight.get(key)?.size ?? 0;
    let settled = true;
    if (!(await this.drainWrites(key))) {
      settled = false;
      logger.warn(
        `Timed out waiting for in-flight tracking writes for ${sanitizeForLog(userId)}`,
      );
    }
    for (const hook of this.optOutHooks) {
      try {
        if ((await hook(userId, guildId)) === false) settled = false;
      } catch (error) {
        settled = false;
        logger.warn(
          `Tracking quiesce hook failed for ${sanitizeForLog(userId)}`,
          error,
        );
      }
    }
    return { pending, settled };
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
          this.cancelRetry();
        } catch (error) {
          this.lastFailedLoadAt = Date.now();
          // Retry on a timer, not only from the next tracker event: an idle
          // guild (or one with tracking switched off) would otherwise stay
          // unloaded, and the first event after recovery would be dropped.
          this.scheduleRetry();
          throw error;
        } finally {
          this.loading = null;
        }
      })();
    }
    return this.loading;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.optedOut !== null) return;
      // A failure here schedules the next attempt from `load` itself.
      this.load().catch((error: unknown) => {
        logger.warn(
          "Could not load tracking opt-outs; tracking stays paused until it succeeds",
          error,
        );
      });
    }, TrackingOptOutService.RETRY_INTERVAL_MS);
    // Never hold the process open just to retry.
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
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
