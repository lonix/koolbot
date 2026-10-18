/**
 * Keeping the leads channel (#1199) in line with who leads: what happens when
 * a leader changes, and who is moved out of the channel.
 *
 * Two entry points, both ending in the same pass:
 *
 * - `installLeadsChannelSync` subscribes to `onLeaderChange` (#1195), once at
 *   startup, for every source of a change (the host panel, the unassign
 *   cleanup, a member data reset). The listener decides nothing from the
 *   change: it only asks for a pass. Passes are coalesced per event, with the
 *   flag cleared the moment a pass starts reading, so a change that arrives
 *   while one runs queues exactly one more, and the stored "from" ids of every
 *   coalesced change are kept for the people-out step.
 * - The scan (`EventService`) runs the same pass when the cache says the
 *   channel needs attention (never verified, overwrites differ, an unwelcome
 *   person is in it, a move is still owed), which is also the restart
 *   reconcile.
 *
 * `syncLeadsAccess` = `EventGroupChannels.syncLeads` (the overwrite writes,
 * under the per-event channel lock) THEN `evictFromLeads` (the moves). The two
 * never nest: the mover has its own busy lock and must not run inside the
 * channel lock or the group lock (#1221).
 */

import type { Client } from "discord.js";
import { Event } from "../models/event.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { onLeaderChange } from "./event-group-leaders.js";
import { readEventPresence } from "./event-group-presence.js";
import type { EventGroupChannels } from "./event-group-channels.js";
import { resolveLeadsChannel } from "./event-leader-roles.js";
import { planLeadsEviction } from "./event-leads-access.js";
import {
  MOVE_SKIP_LABEL,
  moveEventMembers,
  type MoveEventRow,
  type MovePlan,
  type MovePlanContext,
  type MoveSkipReason,
} from "./event-member-moves.js";

const MS_PER_MINUTE = 60_000;
/** A move that failed for a cause that will not fix itself in a minute waits this long. */
const EVICT_RETRY_MS = 5 * MS_PER_MINUTE;
/** A busy mover (a host run is going) is asked again on the next scan. */
const EVICT_BUSY_RETRY_MS = MS_PER_MINUTE;
const EVICT_PROBLEM = "#leads-evict";
const EVICT_PROBLEM_NAME = "Leaders-only channel";

/** Why a person was not moved out for a reason that a later try may fix. */
const RETRY_REASONS: ReadonlySet<MoveSkipReason> = new Set([
  "error",
  "rate-limited",
  "over-limit",
  "group-full",
  "missing-permission",
]);

type LeadsOps = Pick<
  EventGroupChannels,
  | "syncLeads"
  | "leadsProbe"
  | "leadsAdminRoles"
  | "queueEviction"
  | "holdEviction"
  | "setLeadsProblem"
>;

/**
 * One pass for an event: make the overwrites right, then move out whoever must
 * leave. Never throws.
 */
export async function syncLeadsAccess(opts: {
  client: Client;
  channels: LeadsOps;
  guildId: string;
  eventId: string;
  takeRevoked?: () => readonly string[];
}): Promise<void> {
  const { client, channels, guildId, eventId } = opts;
  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      logger.warn(
        `Could not read server ${sanitizeForLog(guildId)} to update the leaders-only channel of event ${sanitizeForLog(eventId)}`,
      );
      return;
    }
    const result = await channels.syncLeads(eventId, guild, {
      takeRevoked: opts.takeRevoked,
    });
    if (result.status !== "ok") return;
    await evictFromLeads({
      client,
      channels,
      guildId: guild.id,
      eventId,
      revoked: result.evict,
    });
  } catch (error) {
    logger.error(
      `Updating the leaders-only channel of event ${sanitizeForLog(eventId)} failed:`,
      error,
    );
  }
}

/**
 * Move out of the leads channel the people who must not be in it: those who
 * lost access just now (`revoked`) and anyone the permission cache says cannot
 * connect, never the host, a current leader or an administrator. They go to
 * their team group's channel, else to main. A person not moved for a cause a
 * later try may fix is remembered, with a hold, and shown on the host panel.
 */
export async function evictFromLeads(opts: {
  client: Client;
  channels: LeadsOps;
  guildId: string;
  eventId: string;
  revoked: readonly string[];
}): Promise<void> {
  const { client, channels, guildId, eventId } = opts;
  const revoked = new Set(opts.revoked);
  // Read before the plan (which runs inside the mover's lock and must not
  // wait on the database): the admins who are never moved.
  const admins = await channels.leadsAdminRoles(guildId);
  const plan = (ctx: MovePlanContext): MovePlan => {
    const leadsId = resolveLeadsChannel(ctx.event);
    // Without a channel to read permissions from, nobody is judged a stranger.
    const probe = leadsId
      ? channels.leadsProbe(ctx.guild, leadsId, admins)
      : null;
    return planLeadsEviction(ctx.event, ctx.presence, {
      revoked,
      isAdmin: probe?.isAdmin ?? ((): boolean => true),
      canConnect: probe?.canConnect ?? ((): null => null),
    });
  };
  const clearProblem = (): void =>
    channels.setLeadsProblem(eventId, EVICT_PROBLEM, null);

  // Nothing to move is the common case: decide it from the cache, with no
  // lock and no request, before asking the mover.
  const row = (await Event.findById(eventId).lean()) as unknown as
    (MoveEventRow & { guildId: string }) | null;
  const guild = client.guilds?.cache?.get(guildId);
  if (!row || !guild) return;
  const early = plan({
    event: row,
    guild,
    presence: readEventPresence(
      client,
      row as unknown as Parameters<typeof readEventPresence>[1],
    ),
  });
  if (Array.isArray(early) && early.length === 0) {
    clearProblem();
    return;
  }

  const outcome = await moveEventMembers({
    client,
    guildId,
    eventId,
    plan,
  });
  if (outcome.status === "busy") {
    channels.queueEviction(eventId, revoked);
    channels.holdEviction(eventId, EVICT_BUSY_RETRY_MS);
    return;
  }
  if (outcome.status === "refused") {
    if (
      outcome.code === "no-permission" ||
      outcome.code === "unreadable" ||
      outcome.code === "no-guild" ||
      outcome.code === "plan"
    ) {
      channels.queueEviction(eventId, revoked);
      channels.holdEviction(eventId, EVICT_RETRY_MS);
      channels.setLeadsProblem(eventId, EVICT_PROBLEM, {
        name: EVICT_PROBLEM_NAME,
        reason: `People who should not be in the leaders-only channel were not moved out: ${outcome.message} It is tried again later.`,
      });
    } else {
      // Events off, event gone or over, no groups: nothing left to do.
      clearProblem();
    }
    return;
  }
  const { report } = outcome;
  const unresolved = new Set<string>(report.unconfirmed);
  const reasons = new Map<string, number>();
  for (const skip of report.skipped) {
    if (!RETRY_REASONS.has(skip.reason)) continue;
    unresolved.add(skip.userId);
    reasons.set(
      MOVE_SKIP_LABEL[skip.reason],
      (reasons.get(MOVE_SKIP_LABEL[skip.reason]) ?? 0) + 1,
    );
  }
  if (report.unconfirmed.length > 0) {
    reasons.set("Discord did not confirm the move", report.unconfirmed.length);
  }
  if (unresolved.size === 0) {
    clearProblem();
    return;
  }
  channels.queueEviction(eventId, unresolved);
  channels.holdEviction(eventId, EVICT_RETRY_MS);
  const why = [...reasons.entries()]
    .map(([label, n]) => `${n} ${label}`)
    .join("; ");
  channels.setLeadsProblem(eventId, EVICT_PROBLEM, {
    name: EVICT_PROBLEM_NAME,
    reason: `${unresolved.size} ${unresolved.size === 1 ? "person" : "people"} could not be moved out of the leaders-only channel (${why}). It is tried again later.`,
  });
}

let unsubscribe: (() => void) | null = null;
/** Events with a pass queued that has not started reading yet. */
const queued = new Set<string>();
/** Stored "from" ids of the changes a queued pass covers. */
const pendingRevoked = new Map<string, Set<string>>();

/**
 * Start updating the leads channel whenever a leader changes (see the module
 * comment). Idempotent. Called once at startup from `src/index.ts`; `run` is
 * `EventService.syncLeadsAccess`. Returns the unsubscribe function (tests).
 */
export function installLeadsChannelSync(
  run: (
    guildId: string,
    eventId: string,
    takeRevoked: () => readonly string[],
  ) => Promise<void>,
): () => void {
  if (unsubscribe) return unsubscribe;
  const off = onLeaderChange((change) => {
    const key = `${change.guildId}:${change.eventId}`;
    if (change.fromUserId) {
      const set = pendingRevoked.get(key) ?? new Set<string>();
      set.add(change.fromUserId);
      pendingRevoked.set(key, set);
    }
    if (queued.has(key)) return;
    queued.add(key);
    let started = false;
    return run(change.guildId, change.eventId, () => {
      // The pass is reading from here on; a later change queues its own.
      started = true;
      queued.delete(key);
      const ids = [...(pendingRevoked.get(key) ?? [])];
      pendingRevoked.delete(key);
      return ids;
    }).finally(() => {
      // A pass that never started (it failed before taking the lock) must not
      // leave the flag set, or every later change would be dropped. One that
      // did start has cleared it itself, and the flag may now belong to the
      // next queued pass.
      if (!started) queued.delete(key);
    });
  });
  unsubscribe = (): void => {
    off();
    queued.clear();
    pendingRevoked.clear();
    unsubscribe = null;
  };
  return unsubscribe;
}
