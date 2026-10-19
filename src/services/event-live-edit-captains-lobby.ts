/**
 * The live-edit row of the Captains lobby switch (#1251). It is a `LiveEditRow`
 * of the core (`event-live-edit.ts`); read the core's module comment first (rules
 * 1 to 8 and the extension contract), and the add and remove steps of
 * `event-live-edit-group-set.ts`, which this row reuses.
 *
 * ## What the switch is
 *
 * The leaders-only voice channel (#1199) has no members of its own: who may join
 * is derived from the host and the current leaders (`event-leads-access.ts`).
 * It used to be set up as a group row of kind `leads` in the group list, which
 * reads like a team people join. It is now ONE SWITCH, "Captains lobby", off by
 * default.
 *
 * ## Decisions (each stated once)
 *
 * 1. **The stored shape is unchanged and the switch is DERIVED from it.** A hidden
 *    `leads` group in `groups` carries the channel, so the group pass, the
 *    channel lifecycle and the clean-up keep working. The switch is "the event has
 *    a `leads` group" (`hasCaptainsLobby`): there is no stored flag, so nothing can
 *    disagree with the row, an event saved before this change already reads
 *    right, and a preset's `leads` row means "on" without any mapping code.
 *    The host does not see or edit that group in the group lists (`kind: "leads"`
 *    is skipped by the views, is no longer offered when a group is added, and never
 *    counts as "the group an event keeps").
 * 2. **On needs leaders on, off never does.** Turning it on is judged against
 *    leaders as THIS SAVE leaves them (`ctx.planned("captainsEnabled")`, else the
 *    fresh `captainsEnabled`), so "leaders on and lobby on" is one valid save
 *    (the leaders row runs first, in registry order), and "leaders off and lobby
 *    on" is refused. The write itself holds `captainsEnabled: true`, so a leaders
 *    row that did not land (lost, failed) makes the lobby write `lost`, never a
 *    lobby without leaders. Turning it off is always allowed, so a lobby left
 *    behind can always be removed.
 * 3. **Leaders switched off while the lobby exists.** Nothing is removed (rule 2 of
 *    `event-live-edit-leaders-tags.ts`: stored data is kept, the switches hide it).
 *    The channel stays, and the existing access rules take every leader away
 *    (`leadsLeaderIds` is empty while leaders are off), so only the host can join;
 *    the leaders-off follow-up moves connected leaders out. Turning leaders on again
 *    gives the current leaders access again. The switch shows as on and can be
 *    turned off.
 * 4. **On creates the restricted channel through the add step** (`addGroupLocked`):
 *    one conditional `$push` of a `leads` group with every field explicit (no schema
 *    default), conditional on the event being open, groups on, leaders on, the
 *    exact group count read and NO `leads` group (the one-lobby rule is part of the
 *    write, not only of the plan). Its channel is made by the existing group pass,
 *    which creates a `leads` channel restricted. Without a main channel yet nothing
 *    is owed. A refusal or missing permission is a `partial` result (the lobby
 *    is stored, its channel is owed); the same form posted again finds the value
 *    equal, sees `owed` and finishes the channel (`reconcile`). Afterwards, with no
 *    lock held, the leaders-only channel's access is brought in line.
 * 5. **Off moves everyone to the main channel and deletes the channel**, through the
 *    remove step (`removeOne`, which moves people with the lock-free mover first,
 *    then deletes the channel and the record together). Whoever is in it is moved,
 *    the host included. A person who cannot be moved keeps the channel (and the
 *    lobby) alive: the result is `failed` with who and why, nothing durable changed
 *    (the lobby is still there), and saving again plans the removal again from the
 *    fresh read.
 * 6. **Confirmation when somebody is connected.** Turning it off asks first only
 *    when anyone is connected to ANY voice channel of the event (the main channel,
 *    a group's or the lobby's), read by the core from the gateway voice-state cache
 *    inside the locks (`PlanEnv.voiceInUse`, no REST). Nobody connected: no
 *    confirmation, even when the lobby has a channel. The token is bound to
 *    `liveEditRevision` and to that answer: somebody connecting after the page was
 *    shown makes the confirmed run `stale`, so a fresh confirmation is asked.
 * 7. **Name.** The hidden group is named "<leader label> lobby" (`captainsLobbyName`),
 *    made unique among the names groups have or go back to. The host never types
 *    it. A name a host types for another group that is the lobby's name is
 *    refused with a sentence that says so (`captainsLobbyNameTaken`, in the
 *    add-group form and the name rows of the group editor), because the generic
 *    "already used by another group" would name a group that is not listed. (A
 *    leader's rename from Discord keeps the generic text.)
 *
 * ## Why nothing else has to move `liveEditRevision`
 *
 * The lobby group's existence has no writer but this row (the add row refuses
 * `leads`) and the remove row (both claim the save with the core's `$inc`).
 *
 * ## Locks
 *
 * Runs with the move lock and the group lock held and only calls lock-free
 * internals (`addGroupLocked`, `removeOne`); the leaders-only channel pass runs in
 * `afterSave`, after both are released.
 *
 * This module imports only TYPES from the core (the core lists this row in
 * `LIVE_EDIT_ROWS`), hence `asRow` instead of `defineRow`.
 */

import { Event, type IEvent } from "../models/event.js";
import {
  newGroupKey,
  captainsLobbyName,
  hasCaptainsLobby,
  resolveGroupCountLimits,
} from "./event-groups.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import {
  addGroupLocked,
  createMissingChannels,
  removeOne,
} from "./event-live-edit-group-set.js";
import type {
  AfterSaveContext,
  ApplyContext,
  JsonValue,
  LiveEditRow,
  RowOutcome,
} from "./event-live-edit.js";

/** The row id (letters only: it names the form fields `s_captainsLobby` and `b_captainsLobby`). */
export const CAPTAINS_LOBBY_ROW_ID = "captainsLobby";

const NO_GROUPS = "This event has no groups.";
const NEEDS_LEADERS =
  "turn leaders on first (the lobby is for the host and the current leaders). Turning it off is always possible.";

function asRow<V extends JsonValue>(row: LiveEditRow<V>): LiveEditRow {
  return row as unknown as LiveEditRow;
}

type Lobby = NonNullable<IEvent["groups"]>[number];

const lobbyOf = (e: { groups?: IEvent["groups"] | null }): Lobby | undefined =>
  (e.groups ?? []).find((g) => g.kind === "leads");

/** Names a new group must not take: the names groups have and the names they go back to. */
function takenNames(e: Pick<IEvent, "groups">): string[] {
  return (e.groups ?? []).flatMap((g) => [g.name ?? "", g.originalName ?? ""]);
}

/** The group the switch adds, named from the event as it is now. */
function lobbyValue(e: IEvent): {
  key: string;
  name: string;
  kind: string;
  size: null;
  tag: string;
} {
  return {
    key: newGroupKey(new Set((e.groups ?? []).map((g) => g.key))),
    name: captainsLobbyName(e.leaderLabel ?? "", takenNames(e)),
    kind: "leads",
    size: null,
    tag: "",
  };
}

async function turnOn(ctx: ApplyContext<boolean>): Promise<RowOutcome> {
  // The name, the key and the group count come from a FRESH read: earlier rows
  // of this save (the leader label, a rename, a group added) have been applied
  // since the plan was made, and `ctx.event` is the plan's snapshot.
  const fresh = (await Event.findOne({
    _id: ctx.eventId,
    guildId: ctx.guildId,
  }).lean()) as IEvent | null;
  if (!fresh) return { status: "lost" };
  if (hasCaptainsLobby(fresh.groups)) return { status: "applied" };
  // The limit holds against what the save has added so far (the plan judged the
  // count it started from); the lobby counts, it is a channel.
  const maxCount = await ctx.maxGroups();
  if (maxCount === null) {
    return {
      status: "failed",
      message:
        "the group limit could not be read, so no lobby was made. Save again",
    };
  }
  const limit = resolveGroupCountLimits(1, maxCount).maxCount;
  if ((fresh.groups ?? []).length >= limit) {
    return {
      status: "failed",
      message: `the event already has ${(fresh.groups ?? []).length} groups and the limit is ${limit} (events.groups.max_count); the lobby counts as a group, so no lobby was made`,
    };
  }
  const g = lobbyValue(fresh);
  // `captainsEnabled: true` is part of the write: an earlier row of this save
  // (leaders) may have turned them off after the plan was made.
  return addGroupLocked(ctx, g, { captainsEnabled: true });
}

async function turnOff(ctx: ApplyContext<boolean>): Promise<RowOutcome> {
  const lobby = lobbyOf(ctx.event);
  if (!lobby) return { status: "applied" };
  const mark = { committed: false };
  let step: Awaited<ReturnType<typeof removeOne>>;
  try {
    // The channel the plan and the confirmation saw: a channel the pass records
    // meanwhile (it has its own lock and does not move the revision) was not
    // part of what the host was asked about, so nothing is moved or deleted.
    step = await removeOne(ctx, lobby.key, mark, lobby.channelId ?? null);
  } catch (err) {
    logger.error(
      `Event ${sanitizeForLog(ctx.eventId)}: turning off the captains lobby failed:`,
      err,
    );
    return {
      status: "failed",
      message:
        "an unexpected error stopped it (see the log); the lobby is as it was or only partly removed. Save again to retry",
    };
  }
  switch (step.kind) {
    case "removed":
    case "gone":
      return { status: "applied" };
    case "lost":
      return { status: "lost" };
    case "refused":
    case "unfinished":
      return { status: "failed", message: step.reason };
  }
}

export const captainsLobbyRow: LiveEditRow = asRow<boolean>({
  id: CAPTAINS_LOBBY_ROW_ID,
  label: "Captains lobby",
  read: (e) => hasCaptainsLobby(e.groups),
  applicable: (e) =>
    e.groupsEnabled === true && (e.groups ?? []).length > 0 ? null : NO_GROUPS,
  parse: (raw) =>
    raw === "1" || raw === "0"
      ? { ok: true, value: raw === "1" }
      : { ok: false, error: "Captains lobby: choose on or off." },
  validate: (to, ctx) => {
    // Only a change TO on is checked: it is the only one that needs leaders.
    if (!to) return null;
    // Leaders as this save leaves them: an earlier row of the same save (the
    // leaders switch comes first) may be turning them on, which makes "leaders
    // on and the lobby on" one valid save.
    const leaders = ctx.planned("captainsEnabled");
    const leadersOn =
      typeof leaders === "boolean"
        ? leaders
        : ctx.event.captainsEnabled === true;
    if (!leadersOn) return NEEDS_LEADERS;
    const name = captainsLobbyName(
      ctx.event.leaderLabel ?? "",
      takenNames(ctx.event),
    );
    const errors = ctx.validateSetup((input) => {
      input.rows.push({
        position: input.rows.length + 1,
        name,
        kind: "leads",
        size: "",
        tag: "",
        marker: "",
      });
    });
    return errors.length > 0
      ? `the captains lobby counts as a group. ${errors.join(" ")}`
      : null;
  },
  needsConfirmation: (from, to, _event, env) => {
    if (!from || to) return null;
    // Only when somebody is connected to a voice channel of this event (the
    // main channel, a group's or the lobby's), read fresh from the gateway cache.
    if (!env.voiceInUse) return null;
    return "Somebody is connected to a voice channel of this event. Turning off the captains lobby moves everybody in its channel, you included, to the main channel, and then deletes the channel. If somebody cannot be moved the lobby is kept as it is. Turn it on again to get a new, empty channel.";
  },
  describe: (v) =>
    v
      ? "on (a leaders-only channel that only the host and the current leaders can join)"
      : "off (the channel is removed; leaders talk in the main channel)",
  async apply(ctx) {
    return ctx.to ? turnOn(ctx) : turnOff(ctx);
  },
  // Stored, but the channel is not made yet (a refusal, a missing permission).
  owed: (e) => {
    const lobby = lobbyOf(e);
    return lobby && e.channelId && !lobby.channelId
      ? "the lobby's channel is not created yet"
      : null;
  },
  async reconcile(ctx) {
    const lobby = lobbyOf(ctx.event);
    if (!lobby) return { status: "applied" };
    return createMissingChannels(ctx, [lobby.key], "its channel");
  },
  afterSaveGroup: "captainsLobby",
  afterSave: lobbyFollowUp,
});

/**
 * After both locks are released: with the lobby there, the leaders-only channel
 * gets its access (the host and the current leaders; anyone else in it is moved
 * out). With the lobby gone nothing is left to do: its channel was deleted in
 * the save. Decided from a fresh read; the scan is the backstop.
 */
async function lobbyFollowUp(ctx: AfterSaveContext): Promise<void> {
  const fresh = (await Event.findOne({
    _id: ctx.eventId,
    guildId: ctx.guildId,
  })
    .select("groups")
    .lean()) as Pick<IEvent, "groups"> | null;
  if (!fresh || !hasCaptainsLobby(fresh.groups)) return;
  await ctx.effects.syncLeadsAccess(ctx.guildId, ctx.eventId);
}
