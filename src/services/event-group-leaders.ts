/**
 * Event group leaders (#1195): the one place that writes `groups[].captainId`
 * (and the event's `leaderLabel` from the host panel), and the planner behind
 * "Pull leaders only".
 *
 * The stored field is `captainId` (the model predates the UI wording); the UI
 * calls the role by the event's `leaderLabel` ("Leader" by default).
 *
 * ## The rules
 *
 * - **Gated twice.** Everything here needs `events.enabled` and the event's own
 *   `captainsEnabled`. Setting a leader checks both inside the lock; clearing
 *   one stays possible with the switch off (a host can always tidy up).
 * - **One leader per team group, and the leader is a member of it.** Checked
 *   inside the per-event group lock (`withGroupLock`, the lock of every
 *   membership change) against a FRESH read, and repeated in the write's own
 *   filter (`$elemMatch` on key, kind and `memberIds`), so a write that lost a
 *   race matches nothing and is refused instead of storing a stranger.
 * - **Unassigning clears the role.** A subscriber on `onGroupAssignmentChange`
 *   (`installLeaderCleanup`, started in `src/index.ts`) re-reads the event
 *   inside the lock and clears every leader who is no longer a member of the
 *   group they lead. It decides from that fresh read, not from the change it
 *   was told about: a member who was moved back in the meantime stays leader.
 *   Every source clears it: a host unassign or move, a randomise, a
 *   self-join into another group, and a member data reset.
 * - **A leader who is not a member is not a leader.** The listener runs after
 *   the membership write and can fail, so every reader goes through
 *   `effectiveLeaders` (a leader is `captainId` that is also in that group's
 *   `memberIds`). That closes the short window between the two writes and
 *   covers a clear that never ran.
 * - **Writes touch `groups.$[g].captainId` only**, selected with
 *   `arrayFilters`; never the whole `groups` array and never `save()`. Other
 *   issues write other fields of the same array.
 * - **Member data.** The leader id is the member's own data: exportable, and
 *   erased by a reset (`removeLeaderFromEvents`, the deleter of the registry
 *   entry `event-group-captain`). Setting a leader runs through
 *   `TrackingOptOutService.resetAwareWrite` with the host gate's ticket, like
 *   adding a member, so a reset that is running (or ran since the ticket)
 *   refuses it, and a reset waits for a write in flight.
 *
 * ## Hook for the leads channel (#1199)
 *
 * `onLeaderChange(listener)` fires once per leader change after the write
 * landed (host set or clear, the unassign cleanup, a member data reset, and the
 * end of the event: source `ended`, one change per group that had a leader).
 * Nothing subscribes yet; #1199 will update the leads channel's overwrites
 * from it. A listener that throws is logged and ignored. `resolveLeadsChannel`
 * is the one place that says which channel "Pull leaders only" aims at by
 * default.
 */

import { Event, type IEvent } from "../models/event.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { ConfigService } from "./config-service.js";
import { TrackingOptOutService } from "./tracking-opt-out-service.js";
import {
  onGroupAssignmentChange,
  withGroupLock,
} from "./event-group-assignment.js";
import type { EventPresence } from "./event-group-presence.js";
import type { MoveEventRow, MovePlan, MoveWish } from "./event-member-moves.js";

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const OPEN_STATES = ["scheduled", "active"] as const;

// ---------------------------------------------------------------------
// The hook for #1199
// ---------------------------------------------------------------------

export type LeaderChangeSource = "host" | "unassigned" | "purge" | "ended";

/** One group's leader changing. */
export interface LeaderChange {
  eventId: string;
  guildId: string;
  groupKey: string;
  /**
   * The id stored as the group's leader before the change, or null. It can be a
   * member who left the group an instant ago and whose own cleanup has not run
   * (it is then reported once, here, and the cleanup finds nothing left).
   */
  fromUserId: string | null;
  /** The leader now, or null. */
  toUserId: string | null;
  source: LeaderChangeSource;
}

type LeaderListener = (change: LeaderChange) => void | Promise<void>;
const leaderListeners = new Set<LeaderListener>();

/**
 * Subscribe to leader changes (#1199 updates the leads-only channel's access
 * from this). Fired after the write, once per group whose leader changed.
 * Nothing subscribes yet. A listener that throws is logged and ignored: it can
 * never undo or fail the change. Returns the unsubscribe function.
 */
export function onLeaderChange(listener: LeaderListener): () => void {
  leaderListeners.add(listener);
  return () => {
    leaderListeners.delete(listener);
  };
}

function emitLeaderChanges(changes: LeaderChange[]): void {
  if (leaderListeners.size === 0) return;
  for (const change of changes) {
    for (const listener of leaderListeners) {
      try {
        void Promise.resolve(listener(change)).catch((err: unknown) => {
          logger.warn("Leader change listener failed:", err);
        });
      } catch (err) {
        logger.warn("Leader change listener failed:", err);
      }
    }
  }
}

// ---------------------------------------------------------------------
// Pure reads
// ---------------------------------------------------------------------

/** The part of a group the leader rules read (lean rows may lack any field). */
export interface LeaderGroup {
  key: string;
  kind?: string;
  channelId?: string | null;
  memberIds?: string[];
  captainId?: string | null;
}

export interface EffectiveLeader {
  groupKey: string;
  userId: string;
}

/**
 * The leaders of an event as every reader must see them: a team group's
 * `captainId` that is also in that group's `memberIds`. A stored id that fails
 * this (the member was unassigned and the cleanup has not run, or never ran)
 * is not a leader.
 */
export function effectiveLeaders(
  groups: readonly LeaderGroup[] | null | undefined,
): EffectiveLeader[] {
  const leaders: EffectiveLeader[] = [];
  for (const g of groups ?? []) {
    const id = g.captainId;
    if (!id || g.kind !== "team") continue;
    if (!(g.memberIds ?? []).includes(id)) continue;
    leaders.push({ groupKey: g.key, userId: id });
  }
  return leaders;
}

/**
 * The channel "Pull leaders only" aims at by default: the `leads` group's
 * channel when that group exists and has one, else null. #1199 turns that
 * channel into a leaders-only one; until then it is an ordinary group channel
 * (#1190), so the default already works for an event that has a leads group.
 */
export function resolveLeadsChannel(
  event: Pick<MoveEventRow, "groups">,
): string | null {
  for (const g of event.groups ?? []) {
    if (g.kind === "leads" && g.channelId) return g.channelId;
  }
  return null;
}

// ---------------------------------------------------------------------
// Setting and clearing a leader
// ---------------------------------------------------------------------

export type LeaderFailure =
  | "events-off"
  | "not-found"
  | "closed"
  | "no-groups"
  | "leaders-off"
  | "no-group"
  | "not-team"
  | "not-member"
  | "member-reset"
  | "write-failed";

export const LEADER_FAILURE_MESSAGE: Record<LeaderFailure, string> = {
  "events-off":
    "Events are turned off, so nobody can be made a leader. Turn on events.enabled first.",
  "not-found": "That event no longer exists.",
  closed: "This event is no longer running, so its leaders cannot change.",
  "no-groups": "This event has no groups.",
  "leaders-off": "Leaders are not switched on for this event.",
  "no-group": "That group does not exist any more. Reload the page.",
  "not-team": "Only a team group has a leader.",
  "not-member":
    "A leader must be a member of the group. Assign the person to it first.",
  "member-reset":
    "That member's data is being reset, so nobody was made a leader. Try again in a moment.",
  "write-failed":
    "The groups changed while this was being saved. Reload the page and try again.",
};

export type LeaderResult =
  | {
      ok: true;
      changed: boolean;
      fromUserId: string | null;
      toUserId: string | null;
    }
  | { ok: false; code: LeaderFailure; message: string };

function fail(code: LeaderFailure): {
  ok: false;
  code: LeaderFailure;
  message: string;
} {
  return { ok: false, code, message: LEADER_FAILURE_MESSAGE[code] };
}

type LeaderRow = Pick<
  IEvent,
  "state" | "groupsEnabled" | "captainsEnabled" | "groups"
>;

async function readLeaderRow(
  guildId: string,
  eventId: string,
): Promise<LeaderRow | null> {
  if (!OBJECT_ID_RE.test(eventId)) return null;
  return (await Event.findOne({ _id: eventId, guildId })
    .select("state groupsEnabled captainsEnabled groups")
    .lean()) as LeaderRow | null;
}

async function eventsEnabled(): Promise<boolean> {
  try {
    return await ConfigService.getInstance().getBoolean(
      "events.enabled",
      false,
    );
  } catch (err) {
    logger.warn("Could not read events.enabled for a leader change:", err);
    return false;
  }
}

/**
 * Make `userId` the leader of the team group `groupKey`, or clear that group's
 * leader (`userId` null). Replacing a leader is one write.
 *
 * `admission` is `TrackingOptOutService.admission()` taken before the caller's
 * first await (in the host router: `req.hostAdmission`). It matters when
 * setting: a member whose data reset is running, or ran since the ticket, is
 * refused. Clearing is never refused.
 */
export async function setGroupLeader(opts: {
  guildId: string;
  eventId: string;
  groupKey: string;
  userId: string | null;
  admission: number;
}): Promise<LeaderResult> {
  const { guildId, eventId, userId } = opts;
  const run = (): Promise<LeaderResult> =>
    withGroupLock(guildId, eventId, () => setLeaderLocked(opts));
  if (userId === null) return run();
  const { admitted, value } =
    await TrackingOptOutService.getInstance().resetAwareWrite(
      [userId],
      guildId,
      run,
      opts.admission,
    );
  return admitted.length === 0 || !value ? fail("member-reset") : value;
}

async function setLeaderLocked(opts: {
  guildId: string;
  eventId: string;
  groupKey: string;
  userId: string | null;
}): Promise<LeaderResult> {
  const { guildId, eventId, groupKey, userId } = opts;
  // Setting needs the Events switch; read inside the lock, fails closed.
  if (userId !== null && !(await eventsEnabled())) return fail("events-off");
  const row = await readLeaderRow(guildId, eventId);
  if (!row) return fail("not-found");
  if (!(OPEN_STATES as readonly string[]).includes(row.state)) {
    return fail("closed");
  }
  if (row.groupsEnabled !== true || (row.groups ?? []).length === 0) {
    return fail("no-groups");
  }
  if (userId !== null && row.captainsEnabled !== true) {
    return fail("leaders-off");
  }
  const group = (row.groups ?? []).find((g) => g.key === groupKey);
  if (!group) return fail("no-group");
  if (group.kind !== "team") return fail("not-team");
  if (userId !== null && !(group.memberIds ?? []).includes(userId)) {
    return fail("not-member");
  }
  // The hook reports the STORED id as "from", not the effective leader: a
  // leader who was just unassigned and not yet cleared (their cleanup is queued
  // behind this write) must still be named as losing the role, or the
  // leads channel (#1199) would never hear about them.
  const stored = group.captainId ?? null;
  const before = stored;
  if (stored === userId) {
    return { ok: true, changed: false, fromUserId: before, toUserId: userId };
  }

  const result =
    userId === null
      ? await Event.updateOne(
          {
            _id: eventId,
            guildId,
            groupsEnabled: true,
            state: { $in: [...OPEN_STATES] },
          },
          { $set: { "groups.$[g].captainId": null } },
          { arrayFilters: [{ "g.key": groupKey, "g.captainId": stored }] },
        )
      : await Event.updateOne(
          {
            _id: eventId,
            guildId,
            groupsEnabled: true,
            captainsEnabled: true,
            state: { $in: [...OPEN_STATES] },
            groups: {
              $elemMatch: { key: groupKey, kind: "team", memberIds: userId },
            },
          },
          { $set: { "groups.$[g].captainId": userId } },
          { arrayFilters: [{ "g.key": groupKey }] },
        );
  // `modifiedCount`, not `matchedCount`: an array filter that matches no
  // element still matches the document.
  if ((result?.modifiedCount ?? 0) !== 1) return fail("write-failed");
  emitLeaderChanges([
    {
      eventId,
      guildId,
      groupKey,
      fromUserId: before,
      toUserId: userId,
      source: "host",
    },
  ]);
  return { ok: true, changed: true, fromUserId: before, toUserId: userId };
}

// ---------------------------------------------------------------------
// Unassigning clears the role
// ---------------------------------------------------------------------

/**
 * Clear every leader of the event who is no longer a member of the group they
 * lead. Inside the group lock, from a fresh read; each clear is conditional on
 * that group still holding that same leader. Returns how many were cleared.
 */
export async function clearOrphanedLeaders(
  guildId: string,
  eventId: string,
  source: LeaderChangeSource = "unassigned",
  onStart?: () => void,
): Promise<number> {
  return withGroupLock(guildId, eventId, async () => {
    // From here on a request for another pass must queue its own.
    onStart?.();
    const row = (await Event.findOne({ _id: eventId, guildId })
      .select("groups")
      .lean()) as Pick<IEvent, "groups"> | null;
    if (!row) return 0;
    const orphans = (row.groups ?? []).filter(
      (g) => !!g.captainId && !(g.memberIds ?? []).includes(g.captainId),
    );
    if (orphans.length === 0) return 0;
    const $set: Record<string, null> = {};
    const arrayFilters: Array<Record<string, string>> = [];
    orphans.forEach((g, i) => {
      $set[`groups.$[g${i}].captainId`] = null;
      arrayFilters.push({
        [`g${i}.key`]: g.key,
        [`g${i}.captainId`]: g.captainId as string,
      });
    });
    const result = await Event.updateOne(
      { _id: eventId, guildId },
      { $set },
      { arrayFilters },
    );
    if ((result?.modifiedCount ?? 0) !== 1) return 0;
    emitLeaderChanges(
      orphans.map((g) => ({
        eventId,
        guildId,
        groupKey: g.key,
        fromUserId: g.captainId as string,
        toUserId: null,
        source,
      })),
    );
    return orphans.length;
  });
}

/**
 * Clear every leader of an event that has ended (the shared end teardown,
 * #1193): leaders are not needed once the event is over. Same shape as
 * `clearOrphanedLeaders`: inside the group lock, from a fresh read, each clear
 * conditional on that group still holding that same stored id. It acts only on
 * an event that reads `ended` (never on a running or cancelled one) and fires
 * `onLeaderChange` with source `ended` and the STORED id as `fromUserId`, so the
 * leads-only channel (#1199) can take the access away. Assignments are not
 * touched. Returns how many leaders were cleared.
 */
export async function clearLeadersOnEnd(
  guildId: string,
  eventId: string,
): Promise<number> {
  return withGroupLock(guildId, eventId, async () => {
    const row = (await Event.findOne({ _id: eventId, guildId })
      .select("state groups")
      .lean()) as Pick<IEvent, "state" | "groups"> | null;
    if (!row || row.state !== "ended") return 0;
    const held = (row.groups ?? []).filter((g) => !!g.captainId);
    if (held.length === 0) return 0;
    const $set: Record<string, null> = {};
    const arrayFilters: Array<Record<string, string>> = [];
    held.forEach((g, i) => {
      $set[`groups.$[g${i}].captainId`] = null;
      arrayFilters.push({
        [`g${i}.key`]: g.key,
        [`g${i}.captainId`]: g.captainId as string,
      });
    });
    const result = await Event.updateOne(
      { _id: eventId, guildId, state: "ended" },
      { $set },
      { arrayFilters },
    );
    if ((result?.modifiedCount ?? 0) !== 1) return 0;
    emitLeaderChanges(
      held.map((g) => ({
        eventId,
        guildId,
        groupKey: g.key,
        fromUserId: g.captainId as string,
        toUserId: null,
        source: "ended" as const,
      })),
    );
    return held.length;
  });
}

let unsubscribeCleanup: (() => void) | null = null;
/** Events with a cleanup pass queued that has not started its read yet. */
const pendingCleanups = new Set<string>();

/**
 * Start clearing a leader whenever their group membership ends (see the module
 * comment). Idempotent. Called once at startup from `src/index.ts`, for every
 * source of assignment changes (the Web UI, self-join, member data resets), so
 * it is not tied to the Web UI. Returns the unsubscribe function (tests).
 */
export function installLeaderCleanup(): () => void {
  if (unsubscribeCleanup) return unsubscribeCleanup;
  const off = onGroupAssignmentChange((change) => {
    // Only a member leaving a group can orphan a leader.
    if (change.fromKey === null) return;
    // Coalesce: a randomise fires one change per person, but one pass that
    // has not yet read the event sees all of them (its read is after every
    // change already written). A pass that is running has cleared its flag,
    // so a later change queues exactly one more.
    const key = `${change.guildId}:${change.eventId}`;
    if (pendingCleanups.has(key)) return;
    pendingCleanups.add(key);
    return clearOrphanedLeaders(
      change.guildId,
      change.eventId,
      "unassigned",
      () => pendingCleanups.delete(key),
    ).then(
      () => {
        pendingCleanups.delete(key);
      },
      (err: unknown) => {
        logger.error(
          `Could not clear the leader of event ${sanitizeForLog(change.eventId)} after ${sanitizeForLog(change.userId)} left a group:`,
          err,
        );
      },
    );
  });
  unsubscribeCleanup = (): void => {
    off();
    unsubscribeCleanup = null;
  };
  return unsubscribeCleanup;
}

// ---------------------------------------------------------------------
// Member data reset
// ---------------------------------------------------------------------

export interface LeaderRemoval {
  matched: number;
  removed: number;
  failed: number;
}

/**
 * Take a member out of every group's leader slot of every event of the guild,
 * finished events included (the member data reset). Each event goes through
 * the group lock. Does not rely on the unassign cleanup: a leader who is
 * already no longer a member never triggers it. A failure on one event is
 * counted and does not stop the others.
 */
export async function removeLeaderFromEvents(
  guildId: string,
  userId: string,
): Promise<LeaderRemoval> {
  const rows = (await Event.find({ guildId, "groups.captainId": userId })
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
        // Gone, or already cleared (by the unassign cleanup that the membership
        // purge started): the data is gone, which is what the reset owes.
        if (!row) return true;
        const keys = (row.groups ?? [])
          .filter((g) => g.captainId === userId)
          .map((g) => g.key);
        if (keys.length === 0) return true;
        const result = await Event.updateOne(
          { _id: eventId, guildId, "groups.captainId": userId },
          { $set: { "groups.$[g].captainId": null } },
          { arrayFilters: [{ "g.captainId": userId }] },
        );
        if ((result?.modifiedCount ?? 0) !== 1) return false;
        emitLeaderChanges(
          keys.map((groupKey) => ({
            eventId,
            guildId,
            groupKey,
            fromUserId: userId,
            toUserId: null,
            source: "purge" as const,
          })),
        );
        return true;
      });
      if (done) removed++;
    } catch (err) {
      failed++;
      logger.error(
        `Could not clear ${sanitizeForLog(userId)} as a leader of event ${eventId}:`,
        err,
      );
    }
  }
  return { matched: rows.length, removed, failed };
}

// ---------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------

/**
 * Rename what leaders are called on one event ("Captain", "Squad Lead"). A
 * top-level field, so it never touches `groups`. The caller validates the text
 * (`validateLeaderLabel`).
 */
export async function setLeaderLabel(opts: {
  guildId: string;
  eventId: string;
  label: string;
}): Promise<
  { ok: true } | { ok: false; code: LeaderFailure; message: string }
> {
  const { guildId, eventId } = opts;
  return withGroupLock(guildId, eventId, async () => {
    const row = await readLeaderRow(guildId, eventId);
    if (!row) return fail("not-found");
    if (!(OPEN_STATES as readonly string[]).includes(row.state)) {
      return fail("closed");
    }
    if (row.groupsEnabled !== true) return fail("no-groups");
    if (row.captainsEnabled !== true) return fail("leaders-off");
    const result = await Event.updateOne(
      {
        _id: eventId,
        guildId,
        groupsEnabled: true,
        captainsEnabled: true,
        state: { $in: [...OPEN_STATES] },
      },
      { $set: { leaderLabel: opts.label } },
    );
    // A label already equal to the stored one matches and modifies nothing.
    if ((result?.matchedCount ?? 0) !== 1) return fail("write-failed");
    return { ok: true };
  });
}

// ---------------------------------------------------------------------
// Pull leaders only
// ---------------------------------------------------------------------

/**
 * Where "Pull leaders only" sends the leaders, as posted by the panel (never a
 * channel id):
 *
 * - `default`: the leads channel when the event has one, else the main
 *   channel, else the channel the acting host is in;
 * - `main`: the main channel;
 * - `here`: the event channel the acting host is connected to now;
 * - a group key: that group's channel.
 */
export const PULL_DEFAULT = "default";
export const PULL_MAIN = "main";
export const PULL_HERE = "here";

/**
 * Planner for the mover (`moveEventMembers`): a wish for every leader of the
 * FRESH row. Runs inside the mover's lock and must stay pure: it never takes
 * `withGroupLock` or the move lock. Not connected, elsewhere, full, the host
 * and the rest are skipped and reported by the mover. Moves never change
 * anyone's group, and no leader is moved who is not one right now.
 */
export function planPullLeaders(
  event: MoveEventRow,
  presence: EventPresence,
  destination: string,
  actingUserId: string,
): MovePlan {
  if (event.captainsEnabled !== true) {
    return { refuse: "Leaders are not switched on for this event." };
  }
  const label = (event.leaderLabel || "Leader").toLowerCase();
  const leaders = effectiveLeaders(event.groups);
  if (leaders.length === 0) {
    return {
      refuse: `This event has no ${label}s yet, so nobody was moved. Pick a ${label} for a group first.`,
    };
  }
  const hostChannel =
    presence.members.find((m) => m.id === actingUserId)?.channelId ?? null;

  let channelId: string | null | undefined;
  if (destination === PULL_DEFAULT) {
    channelId =
      resolveLeadsChannel(event) ?? event.channelId ?? hostChannel ?? null;
  } else if (destination === PULL_MAIN) {
    channelId = event.channelId;
  } else if (destination === PULL_HERE) {
    if (!hostChannel) {
      return {
        refuse:
          "You are not connected to one of this event's voice channels, so there is no channel here to pull to. Pick another destination.",
      };
    }
    channelId = hostChannel;
  } else {
    channelId = (event.groups ?? []).find(
      (g) => g.key === destination,
    )?.channelId;
  }
  if (!channelId) {
    return {
      refuse:
        "That channel does not exist (yet), so nobody was moved. Pick another destination.",
    };
  }
  const toChannelId: string = channelId;
  const wishes: MoveWish[] = leaders.map((l) => ({
    userId: l.userId,
    toChannelId,
  }));
  return wishes;
}
