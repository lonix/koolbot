/**
 * Event group membership: the one place that writes `groups[].memberIds`
 * (#1191).
 *
 * Callers: the host panel (assign, unassign, randomise, lock), the voice
 * handler (self-join), and the member data reset (`removeMemberFromEvents`).
 * Later issues that move or tag people (#1192, #1194, #1195) read `memberIds`
 * from the event and change it only through the functions here.
 *
 * ## Why a lock, and what it covers
 *
 * Every membership change is read-decide-write: is the group full, is the
 * member somewhere else. Two of them at once (two host clicks, a click and a
 * self-join, the host and a reset) must not both pass the same check. So each
 * change runs under one per-event keyed lock (`withGroupLock`), reads the
 * event FRESH inside the lock, decides from that read, and writes. That read
 * is the write's own precondition; it is deliberately not the copy the host
 * panel's gate loaded. The bot is one process, like `event-cover.ts`, so a
 * promise chain per event is enough.
 *
 * ## How it writes (read before adding a writer of `groups`)
 *
 * Only `groups.$[g].memberIds` of the groups that changed, selected by `key`
 * with `arrayFilters`; never the whole `groups` array and never `save()` of a
 * document whose `groups` was modified. Other issues write other fields of the
 * same array (`channelId` by #1190, `captainId` by #1195, names and sizes by
 * #1197); a whole-array write from here would put their values back. The write
 * is also conditional on the event being open (`scheduled` or `active`) and
 * having groups, so a change that loses a race with the end of the event is
 * refused instead of editing a finished event.
 */

import { Event, type IEvent } from "../models/event.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { createKeyedLock } from "../utils/keyed-lock.js";
import { consumeHostMove } from "./event-move-guard.js";
import { ConfigService } from "./config-service.js";
import { TrackingOptOutService } from "./tracking-opt-out-service.js";
import {
  groupKeyOf,
  planAssign,
  planRandomise,
  seededRandom,
  type MemberChanges,
  type RandomiseMode,
  type RandomisePlacement,
} from "./event-group-plan.js";

const groupLock = createKeyedLock();
/** Orders one member's self-joins (see `handleGroupSelfJoin`). */
const selfJoinLock = createKeyedLock();

/** An event id as stored (a Mongo ObjectId in hex); anything else is not an event. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** States in which membership may change. */
const OPEN_STATES = ["scheduled", "active"] as const;

/**
 * Run `work` once every earlier membership change of the same event has
 * finished. Later writers of `memberIds` go through this too.
 */
export function withGroupLock<T>(
  guildId: string,
  eventId: string,
  work: () => Promise<T>,
): Promise<T> {
  return groupLock.run(`${guildId}:${eventId}`, work);
}

export type AssignmentSource = "host" | "self" | "random" | "purge";

/** One member's group changing. */
export interface GroupAssignmentChange {
  eventId: string;
  guildId: string;
  userId: string;
  /** Group the member was in, or null. */
  fromKey: string | null;
  /** Group the member is in now, or null. */
  toKey: string | null;
  source: AssignmentSource;
}

type Listener = (change: GroupAssignmentChange) => void | Promise<void>;
const listeners = new Set<Listener>();

/**
 * Subscribe to assignment changes, fired once per member after the write
 * landed (a randomise fires one per member that moved). The temporary clan
 * tags (#1194) use this: assign gives the tag, unassign restores the nickname.
 * Nothing subscribes yet. A listener that throws is logged and ignored; it can
 * never undo or fail the assignment. Returns the unsubscribe function.
 */
export function onGroupAssignmentChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(changes: GroupAssignmentChange[]): void {
  if (listeners.size === 0) return;
  for (const change of changes) {
    for (const listener of listeners) {
      try {
        void Promise.resolve(listener(change)).catch((err: unknown) => {
          logger.warn("Group assignment listener failed:", err);
        });
      } catch (err) {
        logger.warn("Group assignment listener failed:", err);
      }
    }
  }
}

export type AssignmentFailure =
  | "not-found"
  | "closed"
  | "no-groups"
  | "no-group"
  | "not-team"
  | "full"
  | "event-full"
  | "no-teams"
  | "locked"
  | "member-reset"
  | "not-connected"
  | "no-voice-state"
  | "write-failed";

/** Host-facing wording of each refusal. */
export const ASSIGNMENT_FAILURE_MESSAGE: Record<AssignmentFailure, string> = {
  "not-found": "That event no longer exists.",
  closed: "This event is no longer running, so its groups cannot change.",
  "no-groups": "This event has no groups.",
  "no-group": "That group does not exist any more. Reload the page.",
  "not-team": "Only team groups take members.",
  full: "That group is full.",
  "event-full": "This event has reached its limit of assigned people.",
  "no-teams": "This event has no team groups to put people into.",
  locked: "Groups are locked.",
  "not-connected":
    "That person is not connected to this event's voice channels.",
  "no-voice-state":
    "The bot could not read who is in the voice channels, so nobody was assigned.",
  "member-reset":
    "That member's data is being reset, so nobody was added. Try again in a moment.",
  "write-failed":
    "The groups changed while this was being saved. Reload the page and try again.",
};

export type AssignResult =
  | {
      ok: true;
      changed: boolean;
      fromKey: string | null;
      toKey: string | null;
    }
  | { ok: false; code: AssignmentFailure; message: string };

function fail(code: AssignmentFailure): {
  ok: false;
  code: AssignmentFailure;
  message: string;
} {
  return { ok: false, code, message: ASSIGNMENT_FAILURE_MESSAGE[code] };
}

/** What the planners read of an event, from a fresh lean read. */
type MemberRow = Pick<
  IEvent,
  "state" | "groupsEnabled" | "groupsLocked" | "groups"
>;

async function readRow(
  guildId: string,
  eventId: string,
): Promise<MemberRow | null> {
  if (!OBJECT_ID_RE.test(eventId)) return null;
  const row = (await Event.findOne({ _id: eventId, guildId })
    .select("state groupsEnabled groupsLocked groups")
    .lean()) as MemberRow | null;
  return row;
}

function rowFailure(row: MemberRow | null): AssignmentFailure | null {
  if (!row) return "not-found";
  if (!(OPEN_STATES as readonly string[]).includes(row.state)) return "closed";
  if (row.groupsEnabled !== true || (row.groups ?? []).length === 0) {
    return "no-groups";
  }
  return null;
}

/**
 * Write the new member lists of the changed groups (and nothing else). True
 * when the event matched, i.e. it still had groups and was still open.
 */
async function writeMembers(
  eventId: string,
  changes: MemberChanges,
): Promise<boolean> {
  const keys = Object.keys(changes);
  if (keys.length === 0) return true;
  const $set: Record<string, string[]> = {};
  const arrayFilters: Array<Record<string, string>> = [];
  keys.forEach((key, i) => {
    $set[`groups.$[g${i}].memberIds`] = changes[key];
    arrayFilters.push({ [`g${i}.key`]: key });
  });
  const result = await Event.updateOne(
    {
      _id: eventId,
      groupsEnabled: true,
      state: { $in: [...OPEN_STATES] },
    },
    { $set },
    { arrayFilters },
  );
  return (result?.matchedCount ?? 0) === 1;
}

/**
 * Put one member into a team group, or out of every group (`groupKey` null).
 * Moving to the group they are in is a no-op. A full group refuses.
 *
 * The host panel checks that the person is connected before calling this; the
 * membership rules (team only, size, one group, event limit) are decided here.
 */
export async function assignMember(opts: {
  guildId: string;
  eventId: string;
  userId: string;
  groupKey: string | null;
  source?: AssignmentSource;
  /**
   * `TrackingOptOutService.admission()`, taken synchronously before the
   * caller's first await. Adding a member is refused when a reset of that
   * member is running or has run since (the reset drains this write first, so
   * it never reports success while a membership remains). Removing is never
   * refused.
   */
  admission: number;
  /**
   * Whether the member is connected to the event's voice channels right now:
   * true, false, or null when the voice state cannot be read. Asked inside the
   * event lock, only when this change would ADD a member who is in no group
   * (moving or removing someone already placed never needs it), so whether it
   * is an add or a move is decided from the fresh row, not from a copy the
   * caller read earlier. Null refuses the add (fail closed).
   */
  isConnected: () => boolean | null;
}): Promise<AssignResult> {
  const { guildId, eventId, userId, groupKey } = opts;
  const run = (): Promise<AssignResult> =>
    withGroupLock(guildId, eventId, () => assignLocked(opts));
  if (groupKey === null) return run();
  const { admitted, value } =
    await TrackingOptOutService.getInstance().resetAwareWrite(
      [userId],
      guildId,
      run,
      opts.admission,
    );
  return admitted.length === 0 || !value ? fail("member-reset") : value;
}

async function assignLocked(opts: {
  guildId: string;
  eventId: string;
  userId: string;
  groupKey: string | null;
  source?: AssignmentSource;
  isConnected: () => boolean | null;
}): Promise<AssignResult> {
  const { guildId, eventId, userId, groupKey } = opts;
  {
    const row = await readRow(guildId, eventId);
    const bad = rowFailure(row);
    if (bad || !row) return fail(bad ?? "not-found");
    if (groupKey !== null && groupKeyOf(row.groups, userId) === null) {
      // An add (not a move): the person must be connected now.
      const connected = opts.isConnected();
      if (connected === null) return fail("no-voice-state");
      if (!connected) return fail("not-connected");
    }
    const plan = planAssign(row.groups, userId, groupKey);
    if (!plan.ok)
      return fail(plan.reason === "no-teams" ? "no-teams" : plan.reason);
    if (plan.changed && !(await writeMembers(eventId, plan.changes))) {
      return fail("write-failed");
    }
    if (plan.changed) {
      emit([
        {
          eventId,
          guildId,
          userId,
          fromKey: plan.fromKey,
          toKey: plan.toKey,
          source: opts.source ?? "host",
        },
      ]);
    }
    return {
      ok: true,
      changed: plan.changed,
      fromKey: plan.fromKey,
      toKey: plan.toKey,
    };
  }
}

export type RandomiseResult =
  | {
      ok: true;
      placed: RandomisePlacement[];
      unplaced: string[];
    }
  | { ok: false; code: AssignmentFailure; message: string };

/**
 * Deal the connected people into the team groups (see `planRandomise` for the
 * rules). One write for all groups, one lock turn; a seed makes it
 * reproducible.
 */
export async function randomiseMembers(opts: {
  guildId: string;
  eventId: string;
  candidateIds: readonly string[];
  mode: RandomiseMode;
  seed: number;
  /** As for `assignMember`: the ticket taken before the caller's first await. */
  admission: number;
}): Promise<RandomiseResult> {
  const { guildId } = opts;
  // Candidates whose data is being reset (or was, since the ticket) are left
  // out; the rest are dealt, and a reset of any of them waits for this write.
  const { admitted, value } =
    await TrackingOptOutService.getInstance().resetAwareWrite(
      opts.candidateIds,
      guildId,
      (ids) =>
        withGroupLock(guildId, opts.eventId, () =>
          randomiseLocked({ ...opts, candidateIds: ids }),
        ),
      opts.admission,
    );
  if (admitted.length === 0 || !value) {
    return opts.candidateIds.length === 0
      ? fail("no-teams")
      : fail("member-reset");
  }
  return value;
}

async function randomiseLocked(opts: {
  guildId: string;
  eventId: string;
  candidateIds: readonly string[];
  mode: RandomiseMode;
  seed: number;
}): Promise<RandomiseResult> {
  const { guildId, eventId } = opts;
  {
    const row = await readRow(guildId, eventId);
    const bad = rowFailure(row);
    if (bad || !row) return fail(bad ?? "not-found");
    const plan = planRandomise(
      row.groups,
      opts.candidateIds,
      opts.mode,
      seededRandom(opts.seed),
    );
    if (!plan.ok) return fail("no-teams");
    if (!(await writeMembers(eventId, plan.changes))) {
      return fail("write-failed");
    }
    emit(
      plan.placed
        .filter((p) => plan.before[p.userId] !== p.groupKey)
        .map((p) => ({
          eventId,
          guildId,
          userId: p.userId,
          fromKey: plan.before[p.userId] ?? null,
          toKey: p.groupKey,
          source: "random" as const,
        })),
    );
    // Dealt again but fitted nowhere: they lost their old group.
    emit(
      plan.unplaced
        .filter((id) => (plan.before[id] ?? null) !== null)
        .map((id) => ({
          eventId,
          guildId,
          userId: id,
          fromKey: plan.before[id] ?? null,
          toKey: null,
          source: "random" as const,
        })),
    );
    return { ok: true, placed: plan.placed, unplaced: plan.unplaced };
  }
}

/**
 * Turn the host's "lock groups" switch on or off. Idempotent: the host posts
 * the state it wants, not a toggle, so a double click cannot flip it back.
 */
export async function setGroupsLocked(opts: {
  guildId: string;
  eventId: string;
  locked: boolean;
}): Promise<
  { ok: true } | { ok: false; code: AssignmentFailure; message: string }
> {
  const { guildId, eventId } = opts;
  return withGroupLock(guildId, eventId, async () => {
    const row = await readRow(guildId, eventId);
    const bad = rowFailure(row);
    if (bad) return fail(bad);
    const result = await Event.updateOne(
      {
        _id: eventId,
        groupsEnabled: true,
        state: { $in: [...OPEN_STATES] },
      },
      { $set: { groupsLocked: opts.locked } },
    );
    if ((result?.matchedCount ?? 0) !== 1) return fail("write-failed");
    return { ok: true };
  });
}

export type SelfJoinOutcome =
  | "recorded"
  | "unchanged"
  | "no-event"
  | "locked"
  | "full"
  | "not-team"
  | "disabled"
  | "blocked"
  | "host-move";

/**
 * A member joined a voice channel: when it is a team group's channel of an
 * open event, record them as a member of that group, moving them out of any
 * other group (the clan-match flow: people pick a squad by joining it).
 *
 * Nothing changes when the channel is not a team group's (main, open and
 * leads channels, any other channel), when the host has locked the groups (a
 * locked member who hops channels keeps their stored group), when the group
 * is full, or when the member opted out of tracking or is being reset.
 * `admission` is the ticket the caller took synchronously, before its first
 * await (`TrackingOptOutService.admission()`), so a reset that engaged
 * meanwhile cannot be undone by this write.
 *
 * A join that the host's own move caused (#1192, marked by the mover before
 * it asked Discord, see `event-move-guard.ts`) is ignored whatever the target
 * channel and whether or not the groups are locked: a host move never changes
 * who is in which group. Only that one join is ignored; the mark is single use
 * and expires.
 *
 * Not audited (a self-join is the member's own act, not a host action), but it
 * fires `onGroupAssignmentChange` like any other change.
 */
export async function handleGroupSelfJoin(opts: {
  guildId: string;
  userId: string;
  channelId: string;
  admission: number;
}): Promise<SelfJoinOutcome> {
  const { guildId, userId } = opts;
  // Synchronous, before anything is queued or awaited: the mark was set before
  // the move was sent, and this call runs in gateway event order.
  if (consumeHostMove(guildId, userId, opts.channelId)) return "host-move";
  // One at a time per member, queued in call order. The gateway starts these
  // calls in event order, synchronously, so queueing here (before any await)
  // keeps a member's joins in that order: a later join to B can never be
  // overtaken by the lookup of an earlier join to A and then be overwritten.
  return selfJoinLock.run(`${guildId}:${userId}`, () => selfJoinOnce(opts));
}

async function selfJoinOnce(opts: {
  guildId: string;
  userId: string;
  channelId: string;
  admission: number;
}): Promise<SelfJoinOutcome> {
  const { guildId, userId, channelId, admission } = opts;
  // The Events master switch (CLAUDE.md). With Events off the scan stops but
  // open rows stay, so without this a join to a stored group channel would
  // still add or move members. Fails closed: an unreadable key counts as off.
  // Checked inside the member's queue, so join order is kept.
  let enabled = false;
  try {
    enabled = await ConfigService.getInstance().getBoolean(
      "events.enabled",
      false,
    );
  } catch (err) {
    logger.warn("Could not read events.enabled for a group self-join:", err);
  }
  if (!enabled) return "disabled";
  // Hot path (every channel change in the guild): one indexed lookup, which
  // finds nothing for any channel that is not a group channel of an open event.
  const candidate = (await Event.findOne({
    guildId,
    groupsEnabled: true,
    state: { $in: [...OPEN_STATES] },
    "groups.channelId": channelId,
  })
    .select("_id")
    .lean()) as { _id: unknown } | null;
  if (!candidate) return "no-event";
  const eventId = String(candidate._id);

  let outcome: SelfJoinOutcome = "blocked";
  await TrackingOptOutService.getInstance().trackWrite(
    userId,
    guildId,
    async () => {
      outcome = await withGroupLock(guildId, eventId, async () => {
        const row = await readRow(guildId, eventId);
        if (rowFailure(row) || !row) return "no-event";
        if (row.groupsLocked === true) return "locked";
        const target = row.groups.find(
          (g) => g.channelId === channelId && g.kind === "team",
        );
        if (!target) return "not-team";
        const plan = planAssign(row.groups, userId, target.key);
        if (!plan.ok) return plan.reason === "full" ? "full" : "not-team";
        if (!plan.changed) return "unchanged";
        if (!(await writeMembers(eventId, plan.changes))) return "no-event";
        emit([
          {
            eventId,
            guildId,
            userId,
            fromKey: plan.fromKey,
            toKey: plan.toKey,
            source: "self",
          },
        ]);
        return "recorded";
      });
    },
    admission,
  );
  return outcome;
}

export interface MembershipRemoval {
  matched: number;
  removed: number;
  failed: number;
}

/**
 * Take a member out of every group of every event of the guild, finished
 * events included (the member data reset). Each event goes through the same
 * lock as any other change, so a reset cannot interleave with a change that
 * would write the member back. A failure on one event is counted and does not
 * stop the others. The leader slot is not written here: the change this fires
 * (`source: "purge"`) lets `event-group-leaders.ts` clear a leader whose
 * membership ended, and the reset's own `event-group-captain` step clears the
 * rest (#1195).
 */
export async function removeMemberFromEvents(
  guildId: string,
  userId: string,
): Promise<MembershipRemoval> {
  const rows = (await Event.find({ guildId, "groups.memberIds": userId })
    .select("_id")
    .lean()) as Array<{ _id: unknown }>;
  let removed = 0;
  let failed = 0;
  for (const { _id } of rows) {
    const eventId = String(_id);
    try {
      const done = await withGroupLock(guildId, eventId, async () => {
        const row = (await Event.findOne({ _id: eventId, guildId })
          .select("groups")
          .lean()) as Pick<IEvent, "groups"> | null;
        // Gone, or the member is already out (a concurrent reset or change):
        // the data is gone, which is what the reset owes.
        if (!row) return true;
        const fromKeys = row.groups
          .filter((g) => (g.memberIds ?? []).includes(userId))
          .map((g) => g.key);
        if (fromKeys.length === 0) return true;
        const result = await Event.updateOne(
          { _id: eventId, guildId, "groups.memberIds": userId },
          { $pull: { "groups.$[].memberIds": userId } },
        );
        if ((result?.modifiedCount ?? 0) !== 1) return false;
        emit(
          fromKeys.map((fromKey) => ({
            eventId,
            guildId,
            userId,
            fromKey,
            toKey: null,
            source: "purge" as const,
          })),
        );
        return true;
      });
      if (done) removed++;
    } catch (err) {
      failed++;
      logger.error(
        `Could not remove ${sanitizeForLog(userId)} from the groups of event ${eventId}:`,
        err,
      );
    }
  }
  return { matched: rows.length, removed, failed };
}
