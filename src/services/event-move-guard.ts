/**
 * Shared state of host moves (#1192): the per-event "busy" lock and the marks
 * that keep a host move from being mistaken for a member's own join.
 *
 * Kept in a module of its own (no model, no Discord import) so the move helper
 * (`event-member-moves.ts`) and the self-join handler
 * (`event-group-assignment.ts`) can both use it without importing each other.
 *
 * ## The busy lock
 *
 * One bulk move (or live edit, #1197) per event at a time. It is NOT a queue:
 * a second caller is told "already in progress" at once (`busy: true`), which
 * is what the host sees on a double click. `withEventMoveLock` takes the lock
 * synchronously (no await between the check and the take), so two requests can
 * never both pass. It is separate from the channel lock in
 * `EventGroupChannels` (create / delete) and from the membership lock
 * (`withGroupLock`): a paced batch must not block assignment or self-joins for
 * its whole run. Never call `withEventMoveLock` from inside its own `work`
 * (it would answer busy to itself).
 *
 * ## Host-move marks
 *
 * Moving someone in Discord produces a voice join, which `handleGroupSelfJoin`
 * would treat like the member picking that channel and record (or, when the
 * move targets another group's channel, rewrite) their group. A host move must
 * never change who is in which group: changing a group is the Assign section's
 * job. So the mover marks `(guild, member, target channel)` BEFORE it asks
 * Discord to move (the gateway event can arrive before the REST answer), and
 * `handleGroupSelfJoin` consumes the mark synchronously, before it queues
 * anything, and ignores that one join. A mark matches only its own target
 * channel, is used once, and expires: a later join by the member records as
 * usual. Every attempt has its own mark (kept under guild, member and target
 * channel): a second move of the same member, to the same or another channel,
 * never replaces the mark of an earlier, unconfirmed one, and a refused attempt
 * clears only its own. A move that Discord clearly refused clears its mark. A move whose
 * outcome is unknown (timeout) keeps it, because the move may have landed.
 * The marks are in memory: after a restart in the middle of a batch the
 * remaining joins are treated as the members' own.
 */

/**
 * How long a mark lives: longer than the write timeout (30 s), because a move
 * that timed out may still land, plus slack for the gateway event.
 */
export const HOST_MOVE_MARK_TTL_MS = 90_000;

/**
 * Every attempt is its own mark, with its own expiry, under the key (guild,
 * member, target channel): two attempts to the same channel are two marks, so
 * clearing a refused attempt never removes the protection of an earlier
 * unconfirmed one.
 */
const marks = new Map<string, Array<{ id: number; until: number }>>();
let nextAttemptId = 1;
const busy = new Set<string>();

function markKey(guildId: string, userId: string, channelId: string): string {
  return `${guildId}:${userId}:${channelId}`;
}

/**
 * Mark a host move that is about to be asked of Discord. Returns the attempt's
 * id, which is what `unmarkHostMove` needs to clear exactly this mark.
 */
export function markHostMove(
  guildId: string,
  userId: string,
  channelId: string,
  now: number = Date.now(),
): number {
  for (const [key, list] of marks) {
    const live = list.filter((m) => m.until > now);
    if (live.length === 0) marks.delete(key);
    else if (live.length !== list.length) marks.set(key, live);
  }
  const id = nextAttemptId++;
  const key = markKey(guildId, userId, channelId);
  const list = marks.get(key) ?? [];
  list.push({ id, until: now + HOST_MOVE_MARK_TTL_MS });
  marks.set(key, list);
  return id;
}

/**
 * Drop the mark of one attempt whose move Discord refused (the id
 * `markHostMove` returned). No other attempt's mark is touched.
 */
export function unmarkHostMove(
  guildId: string,
  userId: string,
  channelId: string,
  attemptId: number,
): void {
  const key = markKey(guildId, userId, channelId);
  const list = marks.get(key);
  if (!list) return;
  const rest = list.filter((m) => m.id !== attemptId);
  if (rest.length === 0) marks.delete(key);
  else marks.set(key, rest);
}

/**
 * Is this join the result of a host move? True once per mark, for the marked
 * target channel, while a mark lives (the oldest live mark is used up).
 * Synchronous on purpose.
 */
export function consumeHostMove(
  guildId: string,
  userId: string,
  channelId: string,
  now: number = Date.now(),
): boolean {
  const key = markKey(guildId, userId, channelId);
  const list = (marks.get(key) ?? []).filter((m) => m.until > now);
  const used = list.shift();
  if (list.length === 0) marks.delete(key);
  else marks.set(key, list);
  return used !== undefined;
}

export type MoveLockResult<T> = { busy: true } | { busy: false; value: T };

/**
 * Run `work` if no other bulk move or live edit of this event is running;
 * otherwise answer `{ busy: true }` without running it. The check and the take
 * are one synchronous step. The lock is released when `work` settles, however
 * it ends.
 */
export async function withEventMoveLock<T>(
  eventId: string,
  work: () => Promise<T>,
): Promise<MoveLockResult<T>> {
  if (busy.has(eventId)) return { busy: true };
  busy.add(eventId);
  try {
    return { busy: false, value: await work() };
  } finally {
    busy.delete(eventId);
  }
}

/** Tests: forget all marks and locks. */
export function resetMoveGuardForTests(): void {
  marks.clear();
  busy.clear();
}
