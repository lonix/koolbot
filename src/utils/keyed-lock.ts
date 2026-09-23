/**
 * Serialise async work by key, in this process.
 *
 * Several places need "only one of these at a time, per thing": clicks on one
 * LFG post must not have their Discord edits land in the opposite order from
 * their database writes, and two `/lfg` runs by the same member must not both
 * decide that member owns no voice channel and each create one.
 *
 * Both are ordering problems within a single process — the bot runs as one
 * (the voice manager's in-memory ownership maps already assume it) — so a
 * promise chain per key is the whole mechanism. It is deliberately not a
 * distributed lock: the underlying writes stay atomic on their own, and this
 * only decides who goes first.
 */

export interface KeyedLock {
  /**
   * Run `work` once every earlier call for `key` has settled. Returns what
   * `work` returns, and rejects with whatever it throws — a failure never
   * blocks the next caller in line.
   */
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  /** How many keys are currently queued. For tests. */
  readonly size: number;
}

export function createKeyedLock(): KeyedLock {
  const chains = new Map<string, Promise<unknown>>();

  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = chains.get(key) ?? Promise.resolve();
      // `catch` first: one caller's failure must not poison the next's turn.
      const next = previous.catch(() => undefined).then(work);
      chains.set(key, next);
      void next
        .catch(() => undefined)
        .finally(() => {
          // Only the tail clears the entry, so the map cannot grow without
          // bound and a chain still running is never dropped.
          if (chains.get(key) === next) chains.delete(key);
        });
      return next;
    },
    get size(): number {
      return chains.size;
    },
  };
}
