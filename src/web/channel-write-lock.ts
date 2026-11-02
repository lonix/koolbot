/**
 * The one per-server lock for writes that create channels (#1714).
 *
 * The Channel Manager's write path (`routes/write/channel-manager.ts`) and
 * `applyChannelPlan` (`channel-create.ts`) both run inside `withChannelLock`,
 * keyed by server id, so two of them cannot read the channels, both pass their
 * checks and both create the same name. Whoever holds the lock reads the live
 * channels fresh, inside it.
 *
 * In this process only: each community runs one instance. It is a promise chain
 * per key (`utils/keyed-lock.ts`), not a distributed lock.
 *
 * Rules:
 *  - The lock is not re-entrant. Never call `withChannelLock` (or
 *    `applyChannelPlan`) from inside work that already holds it for the same
 *    server: it would wait for itself until the bounded wait ran out.
 *  - Only the wait is bounded (`CHANNEL_LOCK_WAIT_MS`). A holder is bounded by
 *    its own Discord calls, which have a timeout (`WRITE_TIMEOUT_MS`).
 *  - A caller that gives up waiting, or is cancelled while waiting (`signal`,
 *    for example a closed request), never runs its work afterwards: when its
 *    turn comes the slot is passed on at once. Work that has started is never
 *    cut off by a signal; it keeps the lock until it, and any rollback it
 *    does, has finished.
 *  - It is released when the work returns or throws, and the keyed lock drops
 *    an idle key, so nothing is left behind after a failure.
 */

import { createKeyedLock } from "../utils/keyed-lock.js";

/**
 * How long a caller waits for another write to the same server (owner
 * decision, #1714). Kept under the 60 s default `proxy_read_timeout` of the
 * nginx setup in WEBUI.md: the session checks run before the wait and the
 * audit write after it, so a longer wait could end in a 504 before the busy
 * page arrives.
 */
export const CHANNEL_LOCK_WAIT_MS = 25_000;

/** What an admin reads when the wait ran out. */
export const CHANNEL_LOCK_BUSY_MESSAGE =
  "Another change to this server's channels is still running, so nothing was changed. Try again in a moment.";

/**
 * How long one read made while holding the lock may take (20 s). Discord reads
 * are also bounded by the REST client's own timeout and retries; the Mongo
 * queries behind `loadProtection` are not, so the bound is visible here, at
 * the call sites (`readWithin`). It applies to reads only: a read that times
 * out stops the write before anything is changed, and the lock is released
 * with nothing left running that can still mutate channels.
 */
export const CHANNEL_READ_TIMEOUT_MS = 20_000;

/** What an admin reads when a read inside the lock timed out. */
export const CHANNEL_READ_TIMEOUT_MESSAGE =
  "Discord didn't answer in time, so nothing was changed. Try again in a moment.";

export class ChannelReadTimeoutError extends Error {
  constructor() {
    super(CHANNEL_READ_TIMEOUT_MESSAGE);
    this.name = "ChannelReadTimeoutError";
  }
}

/**
 * Run one READ made inside the lock with its own timeout. Rejects with
 * `ChannelReadTimeoutError`, which the caller turns into a refusal before any
 * write. Never wrap a write in this: the timeout cannot stop the write, and the
 * lock would be released while it can still change channels. The abandoned read
 * keeps running but changes nothing.
 */
export function readWithin<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = read();
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ChannelReadTimeoutError()),
      CHANNEL_READ_TIMEOUT_MS,
    );
  });
  // A read that fails after the timeout already won must not be unhandled.
  pending.catch(() => undefined);
  return Promise.race([pending, timedOut]).finally(() => clearTimeout(timer));
}

export const channelWriteLock = createKeyedLock();

export type ChannelLockResult<T> =
  { ok: true; value: T } | { ok: false; reason: "busy" | "cancelled" };

/**
 * Run `work` once every earlier channel write for `guildId` has finished.
 * Resolves `{ ok: false }` (and never runs `work`) when the wait exceeds
 * `CHANNEL_LOCK_WAIT_MS` (`busy`) or `signal` aborts first (`cancelled`);
 * rejects with whatever `work` throws.
 */
export function withChannelLock<T>(
  guildId: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<ChannelLockResult<T>> {
  let state: "waiting" | "running" | "abandoned" = "waiting";
  let reason: "busy" | "cancelled" = "busy";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const queued = channelWriteLock.run(guildId, async () => {
    if (state === "abandoned") return null;
    state = "running";
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    return { value: await work() };
  });
  const gaveUp = new Promise<null>((resolve) => {
    const abandon = (why: "busy" | "cancelled"): void => {
      if (state !== "waiting") return;
      state = "abandoned";
      reason = why;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve(null);
    };
    timer = setTimeout(() => abandon("busy"), CHANNEL_LOCK_WAIT_MS);
    if (signal) {
      onAbort = () => abandon("cancelled");
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([queued, gaveUp]).then((got) =>
    got ? { ok: true, value: got.value } : { ok: false, reason },
  );
}
