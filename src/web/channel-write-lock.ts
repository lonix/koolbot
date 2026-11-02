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
 *  - A caller that gives up waiting never runs its work afterwards: when its
 *    turn comes the slot is passed on at once.
 *  - It is released when the work returns or throws, and the keyed lock drops
 *    an idle key, so nothing is left behind after a failure.
 */

import { createKeyedLock } from "../utils/keyed-lock.js";

/** How long a caller waits for another write to the same server (owner decision, #1714). */
export const CHANNEL_LOCK_WAIT_MS = 60_000;

/** What an admin reads when the wait ran out. */
export const CHANNEL_LOCK_BUSY_MESSAGE =
  "Another change to this server's channels is still running, so nothing was changed. Try again in a moment.";

export const channelWriteLock = createKeyedLock();

export type ChannelLockResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Run `work` once every earlier channel write for `guildId` has finished.
 * Resolves `{ ok: false }` (and never runs `work`) when the wait exceeds
 * `CHANNEL_LOCK_WAIT_MS`; rejects with whatever `work` throws.
 */
export function withChannelLock<T>(
  guildId: string,
  work: () => Promise<T>,
): Promise<ChannelLockResult<T>> {
  let state: "waiting" | "running" | "abandoned" = "waiting";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queued = channelWriteLock.run(guildId, async () => {
    if (state === "abandoned") return null;
    state = "running";
    clearTimeout(timer);
    return { value: await work() };
  });
  const gaveUp = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      if (state !== "waiting") return;
      state = "abandoned";
      resolve(null);
    }, CHANNEL_LOCK_WAIT_MS);
  });
  return Promise.race([queued, gaveUp]).then((got) =>
    got ? { ok: true, value: got.value } : { ok: false },
  );
}
