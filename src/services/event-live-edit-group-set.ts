/**
 * Live-edit rows that change WHICH groups a running event has (#1242, step 4 of
 * the split of #1197): adding a group and removing groups. Everything here is a
 * `LiveEditRow` of the core (`event-live-edit.ts`); read the core's module
 * comment first (rules 1 to 8 and the extension contract). The kind of a
 * group is a separate change (it has to settle what happens to a `leads`
 * channel that stops being one) and is not part of these rows.
 *
 * ## Rows
 *
 * - `groupAdd`: the new group, as a list of at most one `{ key, name, kind,
 *   size, tag }`. The KEY is minted by the server when the form is rendered and
 *   travels in a hidden field, so posting the same form twice is the same
 *   request: the second finds the key stored and is reported as already
 *   applied (`satisfied`), never a second group. Nothing about the add is
 *   confirmed: it destroys nothing.
 * - `groupRemove`: the keys of the groups to remove, always confirmed (it
 *   deletes a channel and unassigns people). Its stored value is always `[]`
 *   (a removal is a request, not a state), and `satisfied` says the request is
 *   done once none of the keys is stored any more.
 *
 * ## Adding a group
 *
 * The group is appended with ONE conditional `$push` (the event open, groups
 * on, exactly the number of groups the plan was made from, and the key not
 * stored), every field written explicitly (no schema default: a stored group
 * field never gets one). Its channel is made by the existing group pass
 * (`createGroupChannels`: it creates the channel next to the main channel,
 * restricted for a `leads` group, and puts the channels in order), inside the
 * row so that a refusal or a missing permission is a `partial` result that says
 * what is owed. Without a main channel yet (an event that has not started)
 * nothing is owed: the channels are all made together later. All assignments
 * and every other group stay as they are. After both locks are released the
 * "Customise team" message and the leaders-only channel's access are brought in
 * line (`afterSave`); the scan is the backstop for anything that fails.
 *
 * ## Removing a group
 *
 * Per group, in this order, each step decided from a fresh read and conditional
 * on what it was decided from; the first step that cannot be done stops THAT
 * group and says why, and nothing after it happens:
 *
 * 1. **Move everyone out of its channel to the main channel**, inside the
 *    live edit's move lock (`emptyGroupChannel`, the mover's lock-free entry:
 *    `moveEventMembers` would answer busy to the lock this save holds). The host
 *    is moved too, like everybody. A person who cannot be moved (missing
 *    permission, Discord rate limiting, over the 60 a run) keeps the channel
 *    alive: **nothing is removed for that group** and the result names who and
 *    why. Saving again moves the next batch (a run moves at most 60). This is
 *    the one place that differs from the issue's wording "the channel stays
 *    until empty": the group stays with it, because a removed group's channel
 *    would have no record and no pass could delete it later (only a channel
 *    recorded on a group is ever deleted).
 * 2. **Unassign its members** (`removeGroupMembersLocked`, one conditional
 *    write on exactly the member list read). `onGroupAssignmentChange` fires per
 *    member, which is what restores their nicknames: the tag module decides
 *    from the stored state and the stored original nickname, so a member is
 *    never tagged twice and an original is never lost. A leader is remembered
 *    as leaving and the leaders-only channel takes their access away in the
 *    follow-up after both locks are released (a pass inside the save would find
 *    the move lock taken by the save itself and defer the eviction).
 * 3. **Delete the channel and the group's record together**
 *    (`removeGroupChannel`, one step under the channel lock, deleting only with
 *    nobody connected and only under the id recorded). With no channel the
 *    record is pulled by one conditional write (`channelId: null`), so a channel
 *    the scan creates meanwhile makes it `lost`, never orphaned.
 *
 * A failure after step 2 (the channel could not be deleted, somebody joined it)
 * leaves the group unassigned but present: that is `partial`, and the same form
 * posted again finishes it (the group is still there, its members already gone,
 * the move and the delete are tried again). A group is never removed from the
 * event without its channel having been deleted first, and the last group of
 * an event is never removed (groups off is a separate change, #1243).
 *
 * ## Why these rows need nothing else to move `liveEditRevision`
 *
 * Group existence has no other writer than these two rows; the claim of the
 * save (the core's `$inc`) is what makes a confirmation token single use.
 *
 * ## Locks
 *
 * Rows run with the move lock and the group lock held. Everything above uses
 * lock-free internals (`removeGroupMembersLocked`, the mover's lock-free entry)
 * or a leaf: the channel lock, which no code takes before the group or move
 * lock (see `event-live-edit-groups.ts`).
 *
 * This module imports only TYPES from the core (the core lists these rows in
 * `LIVE_EDIT_ROWS`), hence `asRow` instead of `defineRow`.
 */

import { Event, type IEvent } from "../models/event.js";
import { EVENT_GROUP_KINDS } from "../models/event-group-kinds.js";
import {
  GROUP_KEY_PATTERN,
  captainsLobbyNameTaken,
  checkGroupName,
  clashesWithCaptainsLobby,
  checkGroupSize,
  checkGroupTag,
  GROUP_COUNT_HARD_MAX,
} from "./event-groups.js";
import { OPEN_STATES, nameTakenByOther } from "./event-customise-rules.js";
import { removeGroupMembersLocked } from "./event-group-assignment.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { effectiveLeaders } from "./event-leader-roles.js";
import { tagsFollowUp } from "./event-live-edit-leaders-tags.js";
import type {
  AfterSaveContext,
  ApplyContext,
  JsonValue,
  LiveEditRow,
  RowOutcome,
} from "./event-live-edit.js";

/** Row ids (letters only: they name form fields). */
export const GROUP_ADD_ROW_ID = "groupAdd";
export const GROUP_REMOVE_ROW_ID = "groupRemove";

/** The form's fields of the add row (`s_groupAdd_name`, ...; the base is `b_groupAdd`). */
export const GROUP_ADD_FIELDS = {
  name: "s_groupAdd_name",
  kind: "s_groupAdd_kind",
  size: "s_groupAdd_size",
  tag: "s_groupAdd_tag",
  key: "s_groupAdd_key",
  base: "b_groupAdd",
} as const;
/** The remove row's checkbox of a group, and its base field. */
export const groupRemoveField = (key: string): string => `s_groupRemove_${key}`;
export const GROUP_REMOVE_BASE_FIELD = "b_groupRemove";
const REMOVE_FIELD_RE = /^s_groupRemove_(g_[0-9a-f]{8})$/;

/** A group to add, as the row's value (JSON: it travels in the signed token and the audit row). */
export type NewGroupValue = {
  key: string;
  name: string;
  kind: string;
  size: number | null;
  tag: string;
};

const OPEN = [...OPEN_STATES];
const NO_GROUPS = "This event has no groups.";

/**
 * The kinds the add row accepts. `leads` is not one of them (#1251): the
 * leaders-only channel is the Captains lobby switch (`event-live-edit-captains-lobby.ts`),
 * which is the only writer of a `leads` group, so there can never be two.
 */
const ADD_KINDS = EVENT_GROUP_KINDS.filter((k) => k !== "leads");

/**
 * What the group rows of this module need of a row's context: the lobby row
 * (#1251) reuses the add and remove steps with its own value type.
 */
export type GroupSetContext = Pick<
  ApplyContext,
  "eventId" | "guildId" | "ending" | "effects"
>;

/** Groups the host sees and counts: every one but the hidden captains lobby. */
const visibleGroups = <G extends { kind?: string }>(
  groups: readonly G[] | null | undefined,
): G[] => (groups ?? []).filter((g) => g.kind !== "leads");

function asRow<V extends JsonValue>(row: LiveEditRow<V>): LiveEditRow {
  return row as unknown as LiveEditRow;
}

const hasGroups = (e: IEvent): boolean =>
  e.groupsEnabled === true && (e.groups ?? []).length > 0;

async function readFresh(
  eventId: string,
  guildId: string,
): Promise<IEvent | null> {
  return (await Event.findOne({
    _id: eventId,
    guildId,
  }).lean()) as IEvent | null;
}

const ENDING_TEXT = "the event is being ended";

// ---------------------------------------------------------------
// Add
// ---------------------------------------------------------------

const BAD_ADD = {
  ok: false as const,
  error: "New group: the form is out of date. Reload the page.",
};

/** Strict reading of a posted or signed add value; null when it is not one. */
function parseAddValue(raw: string): NewGroupValue[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length > 1) return null;
  const out: NewGroupValue[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") return null;
    const { key, name, kind, size, tag } = item as Record<string, unknown>;
    if (typeof key !== "string" || !GROUP_KEY_PATTERN.test(key)) return null;
    if (typeof name !== "string" || typeof tag !== "string") return null;
    if (typeof kind !== "string") return null;
    if (!(ADD_KINDS as readonly string[]).includes(kind)) return null;
    if (size !== null && typeof size !== "number" && typeof size !== "string") {
      return null;
    }
    const nameCheck = checkGroupName(name);
    const tagCheck = checkGroupTag(tag);
    const sizeCheck = checkGroupSize(
      size === null ? "" : typeof size === "number" ? String(size) : size,
    );
    if (!nameCheck.ok || !tagCheck.ok || !sizeCheck.ok) return null;
    out.push({
      key,
      name: nameCheck.value,
      kind,
      size: sizeCheck.value,
      tag: tagCheck.value,
    });
  }
  return out;
}

/** The text a host reads for the first problem of a posted new group, or null when it is sound. */
function addFieldError(value: Record<string, unknown>): string | null {
  const name = checkGroupName(String(value.name ?? ""));
  if (!name.ok) return `New group name: ${name.error}`;
  const size = checkGroupSize(String(value.size ?? ""));
  if (!size.ok) return `New group size: ${size.error}`;
  const tag = checkGroupTag(String(value.tag ?? ""));
  if (!tag.ok) return `New group tag: ${tag.error}`;
  return kindError(String(value.kind ?? ""));
}

/** The refusal of a kind the add row does not take, or null. */
function kindError(kind: string): string | null {
  if (kind === "leads") {
    return "New group kind: the leaders-only channel is the Captains lobby switch in the leader settings, not a group to add.";
  }
  if (!(ADD_KINDS as readonly string[]).includes(kind)) {
    return "New group kind: must be team or open.";
  }
  return null;
}

/** What is still owed to a new group's channel, as text, or null. */
function channelOwed(
  failures: ReadonlyArray<{ key: string; reason: string }> | null,
  key: string,
  subject: string,
): string {
  if (failures === null) {
    return `${subject} is not created yet: the server could not be reached, KoolBot keeps trying every minute`;
  }
  const why = failures.find((f) => f.key === key)?.reason;
  return `${subject} is not created yet${why ? ` (${why})` : ""}: KoolBot keeps trying every minute`;
}

export const groupAddRow: LiveEditRow = asRow<NewGroupValue[]>({
  id: GROUP_ADD_ROW_ID,
  label: "New group",
  read: () => [],
  // The form posts the new group's fields, or nothing when its name is empty.
  collect: (body) => {
    if (typeof body[GROUP_ADD_FIELDS.base] !== "string") return null;
    const str = (name: string): string => {
      const v = body[name];
      return typeof v === "string" ? v : "";
    };
    if (str(GROUP_ADD_FIELDS.name).trim() === "") return null;
    // A bad field is reported by `parse` with its own sentence: the raw value
    // carries the text as it was typed.
    return {
      raw: JSON.stringify([
        {
          key: str(GROUP_ADD_FIELDS.key),
          name: str(GROUP_ADD_FIELDS.name),
          kind: str(GROUP_ADD_FIELDS.kind),
          size: str(GROUP_ADD_FIELDS.size),
          tag: str(GROUP_ADD_FIELDS.tag),
        },
      ]),
      base: str(GROUP_ADD_FIELDS.base),
    };
  },
  parse: (raw) => {
    const value = parseAddValue(raw);
    if (value) return { ok: true, value };
    // Say which field is wrong when the posted text is readable at all.
    try {
      const data = JSON.parse(raw) as unknown;
      if (Array.isArray(data) && data.length === 1 && data[0]) {
        const item = data[0] as Record<string, unknown>;
        if (typeof item.key === "string" && GROUP_KEY_PATTERN.test(item.key)) {
          const problem = addFieldError(item);
          if (problem) return { ok: false, error: problem };
        }
      }
    } catch {
      // Fall through to the generic sentence.
    }
    return BAD_ADD;
  },
  applicable: (e) => (hasGroups(e) ? null : NO_GROUPS),
  satisfied: (e, to) =>
    to.length > 0 &&
    to.every((g) => (e.groups ?? []).some((x) => x.key === g.key)),
  validate: (to, ctx) => {
    const g = to[0];
    if (!g) return null;
    const groups = ctx.event.groups ?? [];
    // `parse` refuses it already; this also covers a value that did not come
    // through `parse` (a signed change set).
    const badKind = kindError(g.kind);
    if (badKind) return badKind;
    if (groups.length >= GROUP_COUNT_HARD_MAX) {
      return `An event can have at most ${GROUP_COUNT_HARD_MAX} groups.`;
    }
    if (clashesWithCaptainsLobby(groups, g.key, g.name)) {
      return captainsLobbyNameTaken(g.name);
    }
    if (nameTakenByOther(groups, g.key, g.name)) {
      return `"${g.name}" is already used by another group, or is the name another group goes back to when it is reset. Pick a different name.`;
    }
    const errors = ctx.validateSetup((input) => {
      input.rows.push({
        position: input.rows.length + 1,
        name: g.name,
        kind: g.kind,
        size: g.size === null ? "" : String(g.size),
        tag: g.tag,
        marker: "",
        key: g.key,
      });
    });
    return errors.length > 0 ? errors.join(" ") : null;
  },
  describe: (v) =>
    v.length === 0
      ? "no new group"
      : `"${v[0].name}" (${v[0].kind}${v[0].size === null ? "" : `, size ${v[0].size}`})`,
  auditValue: (v) => ({
    ...Object.fromEntries(
      v.map((g, i) => [
        `g${i + 1}`,
        `${g.key} | ${g.name} | ${g.kind} | ${g.size === null ? "no limit" : `size ${g.size}`} | ${g.tag === "" ? "no tag" : `tag ${g.tag}`}`,
      ]),
    ),
  }),
  async apply(ctx) {
    const g = ctx.to[0];
    if (!g) return { status: "applied" };
    return addGroupLocked(ctx, g);
  },
  // A re-posted add (the group is stored) finishes a channel that is still
  // owed: the same pass, judged by every group that has none.
  owed: (e) =>
    e.channelId && (e.groups ?? []).some((g) => !g.channelId)
      ? "a group's channel is not created yet"
      : null,
  reconcile: (ctx) => createMissingChannels(ctx, null, ADD_SUBJECT),
  afterSaveGroup: "groupSet",
  afterSave: groupSetFollowUp,
});

/** How the add row's messages name the channel that is owed. */
const ADD_SUBJECT = "its channel";

/** What the channel pass needs of a row's context. */
type ChannelPassContext = Pick<
  ApplyContext,
  "eventId" | "guildId" | "ending" | "effects"
>;

/**
 * Append one group with one conditional `$push` and make its channel (the add
 * row's apply, and the captains lobby's turning on, #1251). Runs with both
 * locks held. A `leads` group is only pushed while the event has none (the
 * one-leads-group rule is part of the write's condition, not only of the plan).
 */
export async function addGroupLocked(
  ctx: GroupSetContext,
  g: NewGroupValue,
  /** Further conditions of the write (the lobby: leaders still on). */
  mustHold: Record<string, unknown> = {},
): Promise<RowOutcome> {
  // A second fresh read: an earlier row of this save may have changed the
  // groups, and the write is conditional on exactly the count read here.
  const fresh = await readFresh(ctx.eventId, ctx.guildId);
  if (!fresh) return { status: "lost" };
  const groups = fresh.groups ?? [];
  if (groups.some((x) => x.key === g.key)) return { status: "applied" };
  if (nameTakenByOther(groups, g.key, g.name)) {
    return {
      status: "failed",
      message: `"${g.name}" is now used by another group, so no group was added`,
    };
  }
  // Synchronous check, then the write: nothing is awaited in between.
  if (ctx.ending()) {
    return {
      status: "failed",
      message: `was not saved because ${ENDING_TEXT}`,
    };
  }
  const result = await Event.updateOne(
    {
      _id: ctx.eventId,
      guildId: ctx.guildId,
      state: { $in: OPEN },
      groupsEnabled: true,
      groups: { $size: groups.length },
      "groups.key": { $ne: g.key },
      ...(g.kind === "leads" ? { "groups.kind": { $ne: "leads" } } : {}),
      ...mustHold,
    },
    {
      $push: {
        groups: {
          key: g.key,
          name: g.name,
          kind: g.kind,
          size: g.size,
          tag: g.tag,
          marker: "",
          channelId: null,
          captainId: null,
          memberIds: [],
        },
      },
    },
  );
  if ((result?.matchedCount ?? 0) !== 1) return { status: "lost" };
  return createMissingChannels(ctx, [g.key], ADD_SUBJECT);
}

/**
 * Make the channels the event's groups lack, and judge the outcome by `keys`
 * (the group just added, or every group without one when a re-save finishes
 * it). Nothing is owed while the event has no main channel (the channels are
 * made together later) or when those groups have one already. Shared with the
 * groups on/off row (#1243), which names the owed channel its own way
 * (`subject`, for example "its channel").
 */
export async function createMissingChannels(
  ctx: ChannelPassContext,
  keys: readonly string[] | null,
  subject: string,
): Promise<RowOutcome> {
  // The group is already stored when this runs: a failed read here must not
  // turn the save into "not saved" (the core would), it is owed work.
  try {
    return await createChannelsUnguarded(ctx, keys, subject);
  } catch (err) {
    logger.error(
      `Event ${sanitizeForLog(ctx.eventId)}: the group channels could not be checked after saving:`,
      err,
    );
    return {
      status: "partial",
      message: `${subject} could not be checked after saving (see the log); KoolBot keeps trying every minute`,
    };
  }
}

async function createChannelsUnguarded(
  ctx: ChannelPassContext,
  keys: readonly string[] | null,
  subject: string,
): Promise<RowOutcome> {
  const lacking = (fresh: IEvent): string[] =>
    (fresh.groups ?? [])
      .filter((x) => !x.channelId && (keys === null || keys.includes(x.key)))
      .map((x) => x.key);
  const fresh = await readFresh(ctx.eventId, ctx.guildId);
  if (!fresh) return { status: "lost" };
  if (
    keys !== null &&
    !keys.every((k) => (fresh.groups ?? []).some((g) => g.key === k))
  ) {
    return { status: "lost" };
  }
  if (!fresh.channelId || lacking(fresh).length === 0) {
    return { status: "applied" };
  }
  if (ctx.ending()) {
    return {
      status: "partial",
      message: `${subject} is not created because ${ENDING_TEXT}`,
    };
  }
  const fx = ctx.effects;
  if (!fx) {
    return {
      status: "partial",
      message: `${subject} is created by the next scan`,
    };
  }
  let failures: Array<{ key: string; reason: string }> | null;
  try {
    failures =
      (await fx.createGroupChannels(ctx.guildId, ctx.eventId))?.failures ??
      null;
  } catch {
    failures = null;
  }
  const after = await readFresh(ctx.eventId, ctx.guildId);
  const still = after ? lacking(after) : [];
  return still.length === 0
    ? { status: "applied" }
    : {
        status: "partial",
        message: channelOwed(failures, still[0], subject),
      };
}

// ---------------------------------------------------------------
// Remove
// ---------------------------------------------------------------

const BAD_REMOVE = {
  ok: false as const,
  error: "Remove groups: the form is out of date. Reload the page.",
};

const memberCountText = (n: number): string =>
  n === 0
    ? "nobody assigned"
    : `${n} ${n === 1 ? "person" : "people"} assigned`;

/** What one group's removal did. */
export type RemoveStep =
  /** Gone from the event (the channel deleted first). */
  | { kind: "removed" }
  /** Already gone before this save: nothing to do. */
  | { kind: "gone" }
  /** Nothing was stored for this group: why. */
  | { kind: "refused"; reason: string }
  /** The group's members were unassigned, but it is still there: why. */
  | { kind: "unfinished"; reason: string }
  /** Something else changed it meanwhile: nothing further was done. */
  | { kind: "lost" };

/**
 * Leaders who lost their group in this save, by event, until the follow-up
 * (after both locks are released) takes their access to the leaders-only
 * channel away and moves them out. In memory only: an ids-only hint for one
 * pass; the scan notices a leader without access anyway.
 */
const revokedLeaders = new Map<string, Set<string>>();
function rememberRevoked(eventId: string, userId: string): void {
  const set = revokedLeaders.get(eventId) ?? new Set<string>();
  set.add(userId);
  revokedLeaders.set(eventId, set);
}

export async function removeOne(
  ctx: GroupSetContext,
  key: string,
  /** Set once a write of this group landed (the members were unassigned). */
  mark: { committed: boolean },
  /**
   * The channel the plan (and the confirmation) saw for this group: when it is
   * not the one stored now, nothing is done, so the next save is planned, and
   * asked, from the new state. `undefined`: not checked.
   */
  expectChannel?: string | null,
  /**
   * People in the channel were shown to the host and confirmed (the default: a
   * group removal is always confirmed). False: look again right before moving.
   */
  occupantsConfirmed = true,
): Promise<RemoveStep> {
  const fresh = await readFresh(ctx.eventId, ctx.guildId);
  if (!fresh) return { kind: "lost" };
  const groups = fresh.groups ?? [];
  const group = groups.find((g) => g.key === key);
  if (!group) return { kind: "gone" };
  const name = `"${group.name}"`;
  if (
    expectChannel !== undefined &&
    (group.channelId ?? null) !== expectChannel
  ) {
    return {
      kind: "refused",
      reason: `${name}: its channel changed since you reviewed it, so nothing was removed. Save again (you are asked again if anybody is connected)`,
    };
  }
  // An event keeps at least one group the host can see: the hidden captains
  // lobby (#1251) is not one, so it never counts as the group that is left.
  const lobby = group.kind === "leads";
  if (visibleGroups(groups).length <= (lobby ? 0 : 1)) {
    return {
      kind: "refused",
      reason: lobby
        ? `${name} is the only group of the event (an event saved with only a leaders-only group), and an event keeps at least one group: add a group first, or switch groups off under "Groups on or off", which removes it`
        : `${name} is the last group of the event, and an event keeps at least one`,
    };
  }
  const channelId = group.channelId ?? null;
  // 1. Everyone out of its channel.
  if (channelId) {
    if (ctx.ending()) {
      return { kind: "refused", reason: `${name}: ${ENDING_TEXT}` };
    }
    const fx = ctx.effects;
    if (!fx) {
      return {
        kind: "refused",
        reason: `${name}: the people in its channel could not be moved, so nothing was removed`,
      };
    }
    // Moving people was not part of what the host confirmed (the plan found the
    // event's channels empty): somebody who joined since is not moved. The group
    // is kept and the next save is planned, and asked, from the new state.
    if (!occupantsConfirmed) {
      let joined = true;
      try {
        joined = fx.eventVoiceInUse(ctx.guildId, [channelId]);
      } catch {
        // Unreadable: treated as somebody being there.
      }
      if (joined) {
        return {
          kind: "refused",
          reason: `${name}: somebody joined its channel since you reviewed it, so nobody was moved and nothing was removed. Save again (you are asked first when anybody is connected)`,
        };
      }
    }
    const emptied = await fx.emptyGroupChannel(
      ctx.guildId,
      ctx.eventId,
      key,
      channelId,
      ctx.ending,
    );
    if (emptied.status === "failed") {
      return {
        kind: "refused",
        reason: `${name}: nobody was moved and nothing was removed (${emptied.reason})`,
      };
    }
    if (emptied.status === "occupied") {
      return {
        kind: "refused",
        reason: `${name}: ${emptied.remaining} ${emptied.remaining === 1 ? "person is" : "people are"} still in its channel (${emptied.detail}), so it was kept. Save again to move the rest, or let them leave first`,
      };
    }
  }

  // 2. Unassign its members; the nicknames follow from the stored state.
  // Synchronous check, then the write: nothing is awaited in between.
  if (ctx.ending()) {
    return { kind: "refused", reason: `${name}: ${ENDING_TEXT}` };
  }
  const members = group.memberIds ?? [];
  const leader =
    fresh.captainsEnabled === true
      ? (effectiveLeaders([group])[0]?.userId ?? null)
      : null;
  const unassigned = await removeGroupMembersLocked({
    guildId: ctx.guildId,
    eventId: ctx.eventId,
    groupKey: key,
    memberIds: members,
  });
  if (unassigned === "lost") return { kind: "lost" };
  mark.committed = true;
  if (leader) rememberRevoked(ctx.eventId, leader);

  // 3. The channel and the record, together.
  const unfinished = (reason: string): RemoveStep => ({
    kind: "unfinished",
    // The captains lobby has no members: nothing was unassigned (#1251).
    reason: lobby
      ? `${name}: ${reason}. Save again to retry`
      : `${name}: its members were unassigned, but ${reason}. Save again to finish`,
  });
  if (channelId) {
    if (ctx.ending())
      return unfinished(`it was not removed because ${ENDING_TEXT}`);
    const fx = ctx.effects;
    if (!fx) return unfinished("its channel could not be deleted");
    const removed = await fx.removeGroupChannel(
      ctx.guildId,
      ctx.eventId,
      key,
      channelId,
      { ignore: new Set<string>(), ending: ctx.ending },
    );
    if (removed === null) {
      return unfinished(
        "the server could not be reached to delete its channel",
      );
    }
    switch (removed.status) {
      case "removed":
        return { kind: "removed" };
      case "occupied":
        return unfinished(
          `${removed.remaining} ${removed.remaining === 1 ? "person" : "people"} joined its channel, so it was kept`,
        );
      case "lost":
        return unfinished("the group changed meanwhile");
      case "failed":
        return unfinished(
          `its channel could not be deleted (${removed.reason})`,
        );
    }
  }
  if (ctx.ending())
    return unfinished(`it was not removed because ${ENDING_TEXT}`);
  const result = await Event.updateOne(
    {
      _id: ctx.eventId,
      guildId: ctx.guildId,
      state: { $in: OPEN },
      groupsEnabled: true,
      $and: [
        { groups: { $size: groups.length } },
        { groups: { $elemMatch: { key, channelId: null } } },
      ],
    },
    { $pull: { groups: { key, channelId: null } } },
  );
  return (result?.matchedCount ?? 0) === 1
    ? { kind: "removed" }
    : unfinished("the group changed meanwhile");
}

// `apply` can return `partial` (members unassigned, channel not yet deleted) but
// this row has no `owed` / `reconcile`: its stored value is always `[]`, never
// equal to the posted keys while the group exists, so posting the same removal
// again simply plans (and, as every removal, confirms) a normal change from the
// fresh row, and `removeOne` finishes whatever step is left.
export const groupRemoveRow: LiveEditRow = asRow<string[]>({
  id: GROUP_REMOVE_ROW_ID,
  label: "Group removal",
  read: () => [],
  // The form posts one checkbox per group, or nothing when none is ticked.
  collect: (body) => {
    if (typeof body[GROUP_REMOVE_BASE_FIELD] !== "string") return null;
    const keys: string[] = [];
    for (const [name, value] of Object.entries(body)) {
      const m = REMOVE_FIELD_RE.exec(name);
      if (m && value === "1") keys.push(m[1]);
    }
    if (keys.length === 0) return null;
    return {
      raw: JSON.stringify(keys.sort()),
      base: body[GROUP_REMOVE_BASE_FIELD] as string,
    };
  },
  parse: (raw) => {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return BAD_REMOVE;
    }
    if (
      !Array.isArray(data) ||
      data.length > GROUP_COUNT_HARD_MAX ||
      !data.every((k) => typeof k === "string" && GROUP_KEY_PATTERN.test(k))
    ) {
      return BAD_REMOVE;
    }
    return { ok: true, value: [...new Set(data as string[])].sort() };
  },
  applicable: (e) => (hasGroups(e) ? null : NO_GROUPS),
  satisfied: (e, to) =>
    to.length > 0 &&
    to.every((k) => !(e.groups ?? []).some((g) => g.key === k)),
  validate: (to, ctx) => {
    const groups = ctx.event.groups ?? [];
    const present = to.filter((k) => groups.some((g) => g.key === k));
    if (present.length === 0) return null;
    // The hidden captains lobby is not a group that is left (#1251).
    const leaving = present.filter((k) =>
      visibleGroups(groups).some((g) => g.key === k),
    );
    if (leaving.length >= visibleGroups(groups).length) {
      return "an event keeps at least one group. Add another group first, or leave one in place.";
    }
    const errors = ctx.validateSetup((input) => {
      input.rows = input.rows.filter((r) => !present.includes(r.key ?? ""));
    });
    return errors.length > 0 ? errors.join(" ") : null;
  },
  needsConfirmation: (_from, to, event) => {
    const groups = (event.groups ?? []).filter((g) => to.includes(g.key));
    if (groups.length === 0) return null;
    const list = groups
      .map(
        (g) =>
          `${g.name} (${memberCountText((g.memberIds ?? []).length)}${g.channelId ? ", with a voice channel" : ""})`,
      )
      .join("; ");
    return `Removing ${groups.length === 1 ? "this group" : `these ${groups.length} groups`}: ${list}. Everybody in the group's channel, you included, is moved to the main channel first; then the members are unassigned (their clan tags come off their nicknames), and then the channel is deleted. If somebody cannot be moved the group is kept as it is. This cannot be undone.`;
  },
  describe: (v) => `done for ${v.length} group${v.length === 1 ? "" : "s"}`,
  async apply(ctx) {
    const steps: RemoveStep[] = [];
    for (const key of ctx.to) {
      const mark = { committed: false };
      try {
        steps.push(await removeOne(ctx, key, mark));
      } catch (err) {
        // A database error after a write landed must not discard what was
        // committed (the core would call the whole row not saved).
        logger.error(
          `Event ${sanitizeForLog(ctx.eventId)}: removing group ${sanitizeForLog(key)} failed:`,
          err,
        );
        steps.push(
          mark.committed
            ? {
                kind: "unfinished",
                reason: `${key}: its members were unassigned, but an unexpected error stopped the rest (see the log). Save again to finish`,
              }
            : {
                kind: "refused",
                reason: `${key}: an unexpected error (see the log) stopped it before anything was stored`,
              },
        );
      }
    }
    const notes = steps.flatMap((s) =>
      s.kind === "refused" || s.kind === "unfinished" ? [s.reason] : [],
    );
    const lost = steps.some((s) => s.kind === "lost");
    // Something stored: a group removed, or one whose members were unassigned.
    const stored = steps.some(
      (s) => s.kind === "removed" || s.kind === "unfinished",
    );
    if (notes.length === 0 && !lost) return { status: "applied" };
    if (lost) notes.push("a group changed meanwhile, so it was left as it is");
    if (stored) return { status: "partial", message: notes.join("; ") };
    if (notes.length === 1 && lost) return { status: "lost" };
    return { status: "failed", message: notes.join("; ") };
  },
  afterSaveGroup: "groupSet",
  afterSave: groupSetFollowUp,
});

/**
 * After both locks are released: the leaders-only channel's access and the
 * "Customise team" message follow a new group; the nicknames of removed
 * groups' members are brought in line once more (the unassign events already
 * did, this is the backstop; a removed leader's access is taken away by a
 * leaders-only channel pass that names them). Each part is its own try, the first error is
 * rethrown after all ran (the executor logs it; the scan converges).
 */
async function groupSetFollowUp(ctx: AfterSaveContext): Promise<void> {
  const errors: unknown[] = [];
  const run = async (work: () => Promise<void> | void): Promise<void> => {
    try {
      await work();
    } catch (err) {
      errors.push(err);
    }
  };
  if (ctx.saved.has(GROUP_ADD_ROW_ID)) {
    await run(() => ctx.effects.syncLeadsAccess(ctx.guildId, ctx.eventId));
    await run(() => ctx.effects.syncGroupControls(ctx.eventId));
  }
  if (ctx.saved.has(GROUP_REMOVE_ROW_ID)) {
    const revoked = [...(revokedLeaders.get(ctx.eventId) ?? [])];
    revokedLeaders.delete(ctx.eventId);
    // Both locks are released here: the pass can move the removed leaders out.
    if (revoked.length > 0) {
      await run(() =>
        ctx.effects.syncLeadsAccess(ctx.guildId, ctx.eventId, revoked),
      );
    }
    await run(() => tagsFollowUp(ctx));
  }
  if (errors.length > 0) throw errors[0];
}

/** The rows of this step, in execution order: remove first, then add. */
export const groupSetRows: readonly LiveEditRow[] = [
  groupRemoveRow,
  groupAddRow,
];
