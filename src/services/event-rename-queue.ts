/**
 * The rename budget of Discord channels (#1196), shared by everything that
 * renames an event's group channel (a leader's rename now, the host's rename of
 * a running event in #1197).
 *
 * Discord allows about 2 renames of one channel per 10 minutes, and answers a
 * third with a rate limit that can last minutes. A request that waits for that
 * is useless to a person who pressed a button, and an interaction dies after 3
 * seconds without a deferral and after 15 minutes with one.
 *
 * ## Invariants
 *
 * 1. **Never sleeps.** `run` answers `limited` with the time left; the caller
 *    tells the person (`describeRetryIn`) and nothing is waited for or queued
 *    behind a timer. "Queue" here means: renames of one channel run one at a
 *    time, in order, and a rename that does not fit the budget is refused at
 *    once. What was asked for is not lost: the stored name stays pending
 *    (`nameSyncPending`) and the group channel pass finishes it.
 * 2. **Keyed by channel id only.** There is no per-person state here (no
 *    cooldown per user), so a member data reset has nothing to clear.
 * 3. **The slot is taken at dispatch.** `reserve` and the start of the job are
 *    one synchronous step: nothing is awaited between the budget check and the
 *    request being sent. A request whose outcome is unknown (a timeout) keeps
 *    its slot (it may have counted at Discord); one that was rejected as rate
 *    limited, never having been sent, gives it back.
 * 4. **A 429 is believed.** When the job fails with a rate-limit rejection the
 *    channel is blocked until Discord's own reset time, even if the local
 *    count said there was room (a restart forgets the count; the host or
 *    another bot may have used the budget).
 * 5. **Memory is bounded.** Entries older than the window are dropped on every
 *    call, and `forget(channelId)` drops a deleted channel's.
 * 6. **In memory.** The bot is one process; after a restart the count starts
 *    empty and Discord's own limit (invariant 4) covers the gap.
 */

import { DiscordAPIError, RateLimitError } from "discord.js";
import { createKeyedLock } from "../utils/keyed-lock.js";
import { rateLimitWaitMs } from "../web/channel-write-rest.js";

/** Renames of one channel Discord allows per window (it says "about 2"). */
export const CHANNEL_RENAME_LIMIT = 2;
/** The window of that limit. */
export const CHANNEL_RENAME_WINDOW_MS = 10 * 60 * 1000;

export type RenameSlot = { ok: true } | { ok: false; retryAfterMs: number };

export type RenameRun<T> =
  | { status: "done"; value: T }
  | { status: "limited"; retryAfterMs: number }
  | {
      status: "failed";
      error: unknown;
      /** Discord rejected it as rate limited (nothing was sent). */
      rateLimited: boolean;
      /** When it rate limited, how long Discord says to wait. */
      retryAfterMs: number | null;
    };

export interface RenameQueueOptions {
  now?: () => number;
  limit?: number;
  windowMs?: number;
}

/** A rate-limit rejection of the fail-fast write client, possibly wrapped. */
export function rateLimitWait(err: unknown): number | null {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    if (e instanceof RateLimitError) {
      return Math.max(rateLimitWaitMs(e), 1000);
    }
    if (e instanceof DiscordAPIError && e.status === 429) return 5000;
    const o = e as { name?: unknown; status?: unknown; cause?: unknown };
    if (o.name === "RateLimitError" || o.status === 429) {
      return Math.max(
        rateLimitWaitMs(e as Parameters<typeof rateLimitWaitMs>[0]),
        1000,
      );
    }
    e = o.cause;
  }
  return null;
}

/** "about 7 minutes", "about 40 seconds": the wait shown to a person. */
export function describeRetryIn(ms: number): string {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.ceil(ms / 1000));
    return `about ${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.ceil(ms / 60_000);
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export class ChannelRenameQueue {
  private readonly now: () => number;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly lock = createKeyedLock();
  /** Channel id to the times of its renames inside the window. */
  private readonly sent = new Map<string, number[]>();
  /** Channel id to the time before which Discord said to wait. */
  private readonly blocked = new Map<string, number>();

  constructor(options: RenameQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.limit = options.limit ?? CHANNEL_RENAME_LIMIT;
    this.windowMs = options.windowMs ?? CHANNEL_RENAME_WINDOW_MS;
  }

  private prune(channelId: string, now: number): number[] {
    const times = (this.sent.get(channelId) ?? []).filter(
      (t) => now - t < this.windowMs,
    );
    if (times.length === 0) this.sent.delete(channelId);
    else this.sent.set(channelId, times);
    const until = this.blocked.get(channelId);
    if (until !== undefined && until <= now) this.blocked.delete(channelId);
    return times;
  }

  /** Whether a rename of this channel fits the budget now. Takes nothing. */
  public check(channelId: string): RenameSlot {
    const now = this.now();
    const times = this.prune(channelId, now);
    const until = this.blocked.get(channelId) ?? 0;
    let retry = Math.max(0, until - now);
    if (times.length >= this.limit) {
      // The oldest rename inside the window frees a slot when it ages out.
      const frees = times[times.length - this.limit] + this.windowMs - now;
      retry = Math.max(retry, frees);
    }
    return retry > 0 ? { ok: false, retryAfterMs: retry } : { ok: true };
  }

  /** Take a slot, in the same synchronous step as the check. */
  public reserve(channelId: string): RenameSlot {
    const slot = this.check(channelId);
    if (!slot.ok) return slot;
    const times = this.sent.get(channelId) ?? [];
    times.push(this.now());
    this.sent.set(channelId, times);
    return slot;
  }

  /** Give back the slot of a request that was never sent (a rejected 429). */
  private release(channelId: string): void {
    const times = this.sent.get(channelId);
    if (!times) return;
    times.pop();
    if (times.length === 0) this.sent.delete(channelId);
  }

  /** Discord said to wait (a 429): believe it whatever the count says. */
  public noteRateLimited(channelId: string, waitMs: number): void {
    const until = this.now() + Math.max(0, waitMs);
    this.blocked.set(
      channelId,
      Math.max(until, this.blocked.get(channelId) ?? 0),
    );
  }

  /** Forget a channel (it was deleted or replaced). */
  public forget(channelId: string): void {
    this.sent.delete(channelId);
    this.blocked.delete(channelId);
  }

  /**
   * Run one rename of `channelId` if the budget allows, one at a time per
   * channel. The job sends the request; it must not wait for a rate limit (use
   * the fail-fast write client). Never throws.
   */
  public run<T>(
    channelId: string,
    job: () => Promise<T>,
  ): Promise<RenameRun<T>> {
    return this.lock.run(channelId, async (): Promise<RenameRun<T>> => {
      const slot = this.reserve(channelId);
      if (!slot.ok) {
        return { status: "limited", retryAfterMs: slot.retryAfterMs };
      }
      try {
        return { status: "done", value: await job() };
      } catch (error) {
        const wait = rateLimitWait(error);
        if (wait !== null) {
          this.release(channelId);
          this.noteRateLimited(channelId, wait);
        }
        return {
          status: "failed",
          error,
          rateLimited: wait !== null,
          retryAfterMs: wait,
        };
      }
    });
  }
}

const shared = new ChannelRenameQueue();

/** The process-wide queue every channel rename goes through. */
export function getRenameQueue(): ChannelRenameQueue {
  return shared;
}
