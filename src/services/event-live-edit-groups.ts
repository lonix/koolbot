/**
 * Live-edit rows for the names, sizes and preset of a running event's groups
 * (#1241, step 3 of the split of #1197). Everything here is a `LiveEditRow` of
 * the core (`event-live-edit.ts`); the planner, confirmation token, executor,
 * result text and audit are the core's and are not repeated. Read the core's
 * module comment first (rules 1 to 8 and the extension contract).
 *
 * ## Rows
 *
 * - `groupNameA`, `groupNameB`, ...: the name of the group at that POSITION.
 *   One row per position (up to `GROUP_COUNT_HARD_MAX`), because the form posts
 *   one string per field and a row is the unit of the base-value rule, of a
 *   conflict, of a `partial` and of `owed`. A row names a position, not a key:
 *   the write is selected by the group's `key` read from the fresh row, so a
 *   reorder never renames another group. A name row has the base-value
 *   protection of its own text (a reorder shows as a conflict), but that text
 *   cannot tell groups apart once a group was removed and another one with the
 *   same name was added at its position, and a SIZE row's value never can
 *   (sizes are often equal). So the form posts, for both kinds of row, the key
 *   of the group it showed, and the row's `guard` makes another group at that
 *   position a conflict (#1242: removing or adding a group moves positions).
 * - `groupSizeA`, ...: the size (max members and the channel's user limit,
 *   1 to 99, empty for no limit) of the group at that position.
 * - `groupPreset`: switch the preset, applying names, sizes and default tags to
 *   the existing groups BY POSITION. One atomic write for all groups.
 *
 * ## Decisions (each stated once)
 *
 * 1. **The stored value is the truth, the channel follows.** A rename or size
 *    change writes the value and a durable marker (`nameSyncPending`,
 *    `sizeSyncPending`, optional fields, no schema default) in ONE conditional
 *    write, then asks the channel pass to make the channel match
 *    (`syncGroupNames`, `syncGroupUserLimits`). A rate limit, a refusal
 *    (missing permission) or an unknown outcome is `partial`: the value is
 *    saved, the result says what is owed and, for a rename, when to try again;
 *    a re-save of the same form (`owed` + `reconcile`) or the scan finishes it.
 *    Nothing here ever sleeps on a rate limit: the rename goes through the
 *    shared rename queue (`getRenameQueue()`, #1196), which answers `limited`
 *    with the time left.
 * 2. **Reserved names.** A name another group currently has, or another group's
 *    stored `originalName` (the name its reset goes back to), is refused
 *    (`nameTakenByOther`, the leader customiser's rule). It is decided from a
 *    SECOND fresh read inside `apply`, not only from the plan: two renames in
 *    one save (A to X and B to X) both pass the planner, which sees the row as
 *    it was before the save, but run one after the other under the same group
 *    lock that serialises every writer of a name, so the second sees the first.
 * 3. **`originalName` of a host-renamed group.** The host's edit becomes the
 *    new original: when the group has an `originalName` (a leader renamed it
 *    first) it is set to the host's new name, and `originalTag` is kept; when it
 *    has none it stays absent (the stored name is then the original, which is
 *    what a repeating event's next occurrence starts from). A leader's reset
 *    therefore goes back to the host's latest name, never to a name the host
 *    replaced.
 * 4. **A size is a cap on joins, never a removal.** Lowering a size below the
 *    member count changes no `memberIds` and moves nobody (Discord keeps those
 *    already in the channel when its user limit drops). The group is "over
 *    size": that is DERIVED on every read (`isGroupOverSize`), never stored, and
 *    no schema default exists for it. New joins and assignments are already
 *    refused by the planner (`planAssign` and `planRandomise` refuse a group
 *    whose member count is at or above its capacity), so an over-size group
 *    takes nobody until it is below its size again; it can still lose members.
 * 5. **Switching the preset.** The posted value is the RESOLVED preset (its
 *    names, kinds, sizes and tags by position), built by the route from the
 *    server's preset catalog and never taken from the client; the signed token
 *    binds exactly that content. The planner and `validate` are synchronous, so
 *    the content has to be in the value. The stored value (`read`) has the same
 *    shape, built from the current groups, so a group changed meanwhile (by a
 *    leader, or another host save) shows as a conflict or a stale token.
 *    Rules: the preset must have as many groups as the event (adding and
 *    removing groups is #1242), and it must not change any group's kind (a kind
 *    change unassigns members, re-applies channel access and restores tags,
 *    which is #1242's job and is never written half-way here). Every name that
 *    would change needs confirmation (the signed token), which includes a name a
 *    leader chose. A switched group's name, size and tag become the preset's;
 *    a leader's customisation of it (`originalName`, `originalTag`) is cleared,
 *    because the preset is the new baseline the host's reset goes back to. The
 *    tags of its members are brought in line in the background by the one tag
 *    function when tags are on and the event is active.
 * 6. **Revision.** The preset row owns names, sizes and tags and is gated, so
 *    every other writer of those fields moves `liveEditRevision` too (the core's
 *    contract): the leader customiser's edit and reset do (`$inc` in the same
 *    write). This module's own writes are covered by the save's claim.
 *
 * ## Locks
 *
 * A row runs with the core's move lock and group lock held (see the core). The
 * channel passes called from here take the per-event CHANNEL lock after them
 * (move, group, channel). The channel lock is a leaf: nothing that runs inside
 * it awaits the group lock, the move lock or `moveEventMembers` (its callers in
 * `event-service.ts` and `event-leads-sync.ts` call the passes and move people
 * afterwards, outside), so the order cannot be reversed anywhere and the nesting
 * cannot deadlock.
 *
 * ## Dependencies on the world
 *
 * Rows have no client. The channel and nickname effects come in through
 * `ctx.effects` (`deps.effects`, built by `createLiveEditEffects` in
 * `event-live-edit-effects.ts`, the one mechanism of the core) and are replaced
 * in tests. Without them a row still stores its value and reports the channel
 * as owed.
 *
 * This module imports only TYPES from the core, so the core can list its rows in
 * `LIVE_EDIT_ROWS` without an import cycle.
 */

import { Event, type IEvent } from "../models/event.js";
import { EVENT_GROUP_KINDS } from "../models/event-group-kinds.js";
import type { EventGroupPreset } from "../content/event-group-presets.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import {
  GROUP_COUNT_HARD_MAX,
  captainsLobbyNameTaken,
  checkGroupName,
  checkGroupSize,
  checkGroupTag,
  clashesWithCaptainsLobby,
} from "./event-groups.js";
import { OPEN_STATES, nameTakenByOther } from "./event-customise-rules.js";
import { describeRetryIn } from "./event-rename-queue.js";
import type { NameSyncOutcome } from "./event-group-channels.js";
import type {
  ApplyContext,
  JsonValue,
  LiveEditRow,
  RowOutcome,
} from "./event-live-edit.js";

// ---------------------------------------------------------------
// Row ids
// ---------------------------------------------------------------

/** One letter per position: ids are letters only (they name form fields). */
const POSITION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXY";

/** Most positions with a row (the hard cap of groups per event). */
export const GROUP_EDIT_POSITIONS = Math.min(
  GROUP_COUNT_HARD_MAX,
  POSITION_LETTERS.length,
);

export const groupNameRowId = (index: number): string =>
  `groupName${POSITION_LETTERS[index]}`;
export const groupSizeRowId = (index: number): string =>
  `groupSize${POSITION_LETTERS[index]}`;
export const GROUP_PRESET_ROW_ID = "groupPreset";
/**
 * The form field that carries the KEY of the group a size field was shown for
 * (`k_groupSizeA`): the identity the size row's guard compares (#1242).
 */
export const groupSizeKeyField = (index: number): string =>
  `k_${groupSizeRowId(index)}`;
/** Same for a name field (`k_groupNameA`): the identity the name row's guard compares. */
export const groupNameKeyField = (index: number): string =>
  `k_${groupNameRowId(index)}`;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

type GroupRowData = NonNullable<IEvent["groups"]>[number];

const groupAt = (event: IEvent, index: number): GroupRowData | undefined =>
  (event.groups ?? [])[index];

const hasGroups = (event: IEvent): boolean =>
  event.groupsEnabled === true && (event.groups ?? []).length > 0;

/** Type-erase a row for the registry (the core's `defineRow`, without importing it). */
function asRow<V extends JsonValue>(row: LiveEditRow<V>): LiveEditRow {
  return row as unknown as LiveEditRow;
}

async function readFresh(
  eventId: string,
  guildId: string,
): Promise<IEvent | null> {
  return (await Event.findOne({
    _id: eventId,
    guildId,
  }).lean()) as IEvent | null;
}

/** What a failed or unfinished channel rename means for the host, or null when it is done. */
function renameOwed(outcome: NameSyncOutcome | null): string | null {
  if (!outcome) {
    return "the channel still has the old name: Discord could not be reached, KoolBot keeps trying";
  }
  switch (outcome.status) {
    case "applied":
    case "skipped":
      return null;
    case "limited":
      return `the channel is not renamed yet: Discord only allows about 2 renames per channel every 10 minutes, so it is renamed in ${describeRetryIn(outcome.retryAfterMs ?? 0)} (KoolBot does it by itself)`;
    case "failed":
    case "unconfirmed":
      return `the channel is not renamed yet: Discord did not confirm it${outcome.reason ? ` (${outcome.reason})` : ""}, KoolBot keeps trying`;
  }
}

function limitOwed(outcome: NameSyncOutcome | null): string | null {
  if (!outcome) {
    return "the channel still has the old user limit: Discord could not be reached, KoolBot keeps trying";
  }
  switch (outcome.status) {
    case "applied":
    case "skipped":
      return null;
    case "limited":
      return `the channel's user limit is not changed yet: Discord asked to wait ${describeRetryIn(outcome.retryAfterMs ?? 0)} (KoolBot does it by itself)`;
    case "failed":
    case "unconfirmed":
      return `the channel's user limit is not changed yet: Discord did not confirm it${outcome.reason ? ` (${outcome.reason})` : ""}, KoolBot keeps trying`;
  }
}

/**
 * A pass that answered no outcome for a group either could not run (the server
 * is gone, events are off, the event ended) or had nothing to do because the
 * group's marker was already cleared: the scan can finish a rename or limit
 * between the row's write and its own follow-up. Only the fresh marker tells
 * them apart, so a missing outcome counts as settled only when the group is
 * there and the marker is no longer set.
 */
async function markerSettled(
  ctx: ApplyContext<JsonValue>,
  key: string,
  flag: "nameSyncPending" | "sizeSyncPending",
): Promise<boolean> {
  try {
    const fresh = await readFresh(ctx.eventId, ctx.guildId);
    const group = (fresh?.groups ?? []).find((g) => g.key === key);
    return !!group && group[flag] !== true;
  } catch {
    return false;
  }
}

/**
 * One outward call (the channel pass for one group's name or user limit): never
 * throws, a throw is an unknown outcome, and a missing outcome is settled when
 * the fresh marker says so (see `markerSettled`).
 */
async function attempt(
  ctx: ApplyContext<JsonValue>,
  kind: "name" | "limit",
  groupKey: string,
): Promise<NameSyncOutcome | null> {
  const fx = ctx.effects;
  const what = kind === "name" ? "channel rename" : "channel user limit";
  let outcome: NameSyncOutcome | null = null;
  if (fx) {
    try {
      outcome =
        kind === "name"
          ? await fx.syncGroupName(ctx.guildId, ctx.eventId, groupKey)
          : await fx.syncGroupUserLimit(ctx.guildId, ctx.eventId, groupKey);
    } catch (err) {
      logger.error(
        `Live edit: ${what} of group ${sanitizeForLog(groupKey)} failed:`,
        err,
      );
      return { groupKey, status: "unconfirmed" };
    }
  }
  if (
    outcome === null &&
    fx &&
    (await markerSettled(
      ctx,
      groupKey,
      kind === "name" ? "nameSyncPending" : "sizeSyncPending",
    ))
  ) {
    return { groupKey, status: "applied" };
  }
  return outcome;
}

const OPEN = [...OPEN_STATES];

// ---------------------------------------------------------------
// Name rows
// ---------------------------------------------------------------

function nameRow(index: number): LiveEditRow {
  const n = index + 1;
  const finish = async (
    ctx: ApplyContext<string>,
    key: string,
  ): Promise<RowOutcome> => {
    const group = (ctx.event.groups ?? []).find((g) => g.key === key);
    if (!group?.channelId) return { status: "applied" };
    // Synchronous check, then the outward call: nothing awaited in between.
    if (ctx.ending()) {
      return {
        status: "partial",
        message: "the channel was not renamed because the event is being ended",
      };
    }
    const outcome = await attempt(ctx, "name", key);
    const owed = renameOwed(outcome);
    return owed === null
      ? { status: "applied" }
      : { status: "partial", message: owed };
  };

  return asRow<string>({
    id: groupNameRowId(index),
    label: `Name of group ${n}`,
    read: (e) => groupAt(e, index)?.name ?? "",
    parse: (raw) => {
      const checked = checkGroupName(raw);
      return checked.ok
        ? { ok: true, value: checked.value }
        : { ok: false, error: `Group ${n} name: ${checked.error}` };
    },
    applicable: (e) =>
      hasGroups(e) && groupAt(e, index) ? null : `Group ${n} does not exist.`,
    validate: (to, ctx) => {
      const group = groupAt(ctx.event, index);
      if (!group) return `Group ${n} does not exist.`;
      if (clashesWithCaptainsLobby(ctx.event.groups, group.key, to)) {
        return captainsLobbyNameTaken(to);
      }
      if (nameTakenByOther(ctx.event.groups, group.key, to)) {
        return `"${to}" is already used by another group, or is the name another group goes back to when it is reset. Pick a different name.`;
      }
      const errors = ctx.validateSetup((input) => {
        input.rows[index].name = to;
      });
      return errors.length > 0 ? errors.join(" ") : null;
    },
    // Same identity check as the size rows: the name text alone cannot tell
    // the group the form showed from a different group with the same name that
    // took its position after a removal.
    guard: (e) => groupAt(e, index)?.key ?? "",
    collect: (body) => {
      const id = groupNameRowId(index);
      const raw = body[`s_${id}`];
      if (typeof raw !== "string") return null;
      const base = body[`b_${id}`];
      const shown = body[groupNameKeyField(index)];
      return {
        raw,
        // A missing base must still fail `parse` (an empty name is invalid).
        base: typeof base === "string" ? base : "",
        ...(typeof shown === "string" ? { guard: shown } : {}),
      };
    },
    describe: (v) => `"${v}"`,
    owed: (e) => {
      const g = groupAt(e, index);
      return g?.nameSyncPending === true && g.channelId
        ? "the channel still has the old name"
        : null;
    },
    async apply(ctx) {
      const key = groupAt(ctx.event, index)?.key;
      if (!key) return { status: "lost" };
      // A second fresh read: an earlier row of this same save may have changed
      // this group or taken the name (decision 2).
      const fresh = await readFresh(ctx.eventId, ctx.guildId);
      const group = (fresh?.groups ?? []).find((g) => g.key === key);
      if (!fresh || !group || group.name !== ctx.from)
        return { status: "lost" };
      if (nameTakenByOther(fresh.groups, key, ctx.to)) {
        return {
          status: "failed",
          message: `"${ctx.to}" is now used by another group, so this group was not renamed`,
        };
      }
      // The fresh read above was awaited after the executor's last hold check:
      // an end or cancel may have taken its hold meanwhile. Asked again here,
      // synchronously, right before the write (nothing awaited in between).
      if (ctx.ending()) {
        return {
          status: "failed",
          message: "was not saved because the event is being ended",
        };
      }
      const original = group.originalName ?? "";
      const result = await Event.updateOne(
        {
          _id: ctx.eventId,
          guildId: ctx.guildId,
          state: { $in: OPEN },
          groups: {
            $elemMatch: {
              key,
              name: ctx.from,
              originalName: original === "" ? { $in: [null, ""] } : original,
            },
          },
        },
        {
          $set: {
            "groups.$[g].name": ctx.to,
            "groups.$[g].nameSyncPending": true,
            // Decision 3: the host's edit is the new original, when there is one.
            ...(original === "" ? {} : { "groups.$[g].originalName": ctx.to }),
          },
        },
        { arrayFilters: [{ "g.key": key }] },
      );
      if ((result?.matchedCount ?? 0) !== 1) return { status: "lost" };
      return finish(ctx, key);
    },
    async reconcile(ctx) {
      const key = groupAt(ctx.event, index)?.key;
      if (!key) return { status: "lost" };
      return finish(ctx, key);
    },
  });
}

// ---------------------------------------------------------------
// Size rows
// ---------------------------------------------------------------

function sizeRow(index: number): LiveEditRow {
  const n = index + 1;
  const finish = async (
    ctx: ApplyContext<number | null>,
    key: string,
  ): Promise<RowOutcome> => {
    const group = (ctx.event.groups ?? []).find((g) => g.key === key);
    if (!group?.channelId) return { status: "applied" };
    if (ctx.ending()) {
      return {
        status: "partial",
        message:
          "the channel's user limit was not changed because the event is being ended",
      };
    }
    const outcome = await attempt(ctx, "limit", key);
    const owed = limitOwed(outcome);
    return owed === null
      ? { status: "applied" }
      : { status: "partial", message: owed };
  };

  return asRow<number | null>({
    id: groupSizeRowId(index),
    label: `Size of group ${n}`,
    read: (e) => {
      const size = groupAt(e, index)?.size;
      return typeof size === "number" ? size : null;
    },
    parse: (raw) => {
      const checked = checkGroupSize(raw);
      return checked.ok
        ? { ok: true, value: checked.value }
        : { ok: false, error: `Group ${n} size: ${checked.error}` };
    },
    applicable: (e) =>
      hasGroups(e) && groupAt(e, index) ? null : `Group ${n} does not exist.`,
    // The row names a POSITION, and sizes are often equal: after a group was
    // removed or added, position 2 may hold another group whose size equals the
    // one the form showed, which the base value rule cannot tell. The form posts
    // the key of the group it showed (`k_groupSizeA`); another group there now
    // is a conflict (#1242, the note in the header of this file).
    guard: (e) => groupAt(e, index)?.key ?? "",
    collect: (body) => {
      const id = groupSizeRowId(index);
      const raw = body[`s_${id}`];
      if (typeof raw !== "string") return null;
      const base = body[`b_${id}`];
      const shown = body[groupSizeKeyField(index)];
      return {
        raw,
        // A missing base must still fail `parse` (an empty size is valid).
        base: typeof base === "string" ? base : "?",
        ...(typeof shown === "string" ? { guard: shown } : {}),
      };
    },
    describe: (v) => (v === null ? "no limit" : String(v)),
    owed: (e) => {
      const g = groupAt(e, index);
      return g?.sizeSyncPending === true && g.channelId
        ? "the channel still has the old user limit"
        : null;
    },
    async apply(ctx) {
      const key = groupAt(ctx.event, index)?.key;
      if (!key) return { status: "lost" };
      const result = await Event.updateOne(
        {
          _id: ctx.eventId,
          guildId: ctx.guildId,
          state: { $in: OPEN },
          // `size: null` matches a group with no size and one with the field missing.
          groups: { $elemMatch: { key, size: ctx.from } },
        },
        {
          // No member is touched: a size below the member count only makes the
          // group over size, which is derived (decision 4).
          $set: {
            "groups.$[g].size": ctx.to,
            "groups.$[g].sizeSyncPending": true,
          },
        },
        { arrayFilters: [{ "g.key": key }] },
      );
      if ((result?.matchedCount ?? 0) !== 1) return { status: "lost" };
      return finish(ctx, key);
    },
    async reconcile(ctx) {
      const key = groupAt(ctx.event, index)?.key;
      if (!key) return { status: "lost" };
      return finish(ctx, key);
    },
  });
}

// ---------------------------------------------------------------
// Preset row
// ---------------------------------------------------------------

export type PresetGroupValue = {
  name: string;
  kind: string;
  size: number | null;
  tag: string;
  /**
   * True when a leader customised this group (it has an `originalName`), only
   * then. A flag, not the name: the value travels twice in the signed
   * confirmation, whose size is bounded (`TOKEN_MAX_LENGTH`), and the name is
   * not needed to decide anything. A preset never has it, so a stored value
   * with it never equals the chosen preset: selecting the preset establishes the
   * baseline (clears the leader's originals) even when every visible value
   * already matches.
   */
  customised?: true;
};

/** The row's value: a preset id (`""` = Custom) and its groups by position. */
export type PresetValue = { id: string; groups: PresetGroupValue[] };

/** The stored setup in the row's shape (also the form's base value). */
export function readPresetValue(event: IEvent): PresetValue {
  return {
    id: event.presetId ?? "",
    groups: (event.groups ?? []).map((g) => ({
      name: g.name,
      kind: g.kind,
      size: typeof g.size === "number" ? g.size : null,
      tag: g.tag ?? "",
      ...(g.originalName ? { customised: true as const } : {}),
    })),
  };
}

/** A resolved preset in the row's shape. Built by the route from the server's catalog. */
export function presetToValue(preset: EventGroupPreset): PresetValue {
  return {
    id: preset.id,
    groups: preset.groups.map((g) => ({
      name: g.name,
      kind: g.kind,
      size: g.size,
      tag: g.tag,
    })),
  };
}

const PRESET_ID_MAX = 64;

/** Strict reading of a posted or signed preset value; null when it is not one. */
function parsePresetValue(raw: string): PresetValue | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { id, groups } = data as { id?: unknown; groups?: unknown };
  if (typeof id !== "string" || id.length > PRESET_ID_MAX) return null;
  if (
    !Array.isArray(groups) ||
    groups.length === 0 ||
    groups.length > GROUP_EDIT_POSITIONS
  ) {
    return null;
  }
  const out: PresetGroupValue[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") return null;
    const { name, kind, size, tag, customised } = g as Record<string, unknown>;
    if (customised !== undefined && customised !== true) return null;
    if (typeof name !== "string" || typeof tag !== "string") return null;
    if (typeof kind !== "string") return null;
    if (!(EVENT_GROUP_KINDS as readonly string[]).includes(kind)) return null;
    if (size !== null && typeof size !== "number") return null;
    const nameCheck = checkGroupName(name);
    const tagCheck = checkGroupTag(tag);
    const sizeCheck = checkGroupSize(size === null ? "" : String(size));
    if (!nameCheck.ok || !tagCheck.ok || !sizeCheck.ok) return null;
    out.push({
      name: nameCheck.value,
      kind,
      size: sizeCheck.value,
      tag: tagCheck.value,
      ...(customised === true ? { customised: true as const } : {}),
    });
  }
  return { id, groups: out };
}

function describePreset(v: PresetValue): string {
  return v.groups
    .map(
      (g) =>
        `${g.name}${g.tag ? ` [${g.tag}]` : ""}${g.size === null ? "" : ` (size ${g.size})`}`,
    )
    .join(", ");
}

/**
 * The preset value as it goes into the audit row: one flat string per group
 * (`g1`: "Squad 1 | team | size 4 | tag S1"). The audit bound replaces any
 * object or array nested deeper than four levels with "[truncated]", which
 * would drop every name, size and tag of the nested group list; this keeps
 * them, within the bound's key and string limits (25 groups, short strings).
 */
function presetAuditValue(v: PresetValue): JsonValue {
  const out: { [key: string]: JsonValue } = { id: v.id };
  v.groups.forEach((g, i) => {
    out[`g${i + 1}`] =
      `${g.name} | ${g.kind} | ${g.size === null ? "no limit" : `size ${g.size}`} | ${g.tag === "" ? "no tag" : `tag ${g.tag}`}${g.customised ? " | customised by a leader" : ""}`;
  });
  return out;
}

/** The groups a switch would change, by position. */
function presetDiff(
  event: IEvent,
  to: PresetValue,
): Array<{
  index: number;
  group: GroupRowData;
  name: boolean;
  size: boolean;
  tag: boolean;
}> {
  const out: ReturnType<typeof presetDiff> = [];
  (event.groups ?? []).forEach((group, index) => {
    const want = to.groups[index];
    if (!want) return;
    const size = typeof group.size === "number" ? group.size : null;
    out.push({
      index,
      group,
      name: group.name !== want.name,
      size: size !== want.size,
      tag: (group.tag ?? "") !== want.tag,
    });
  });
  return out;
}

/** What is still owed to the channels of a group (names and user limits), as text. */
function pendingChannelWork(event: IEvent): string | null {
  const parts: string[] = [];
  (event.groups ?? []).forEach((g, i) => {
    if (!g.channelId) return;
    if (g.nameSyncPending === true) {
      parts.push(`group ${i + 1}'s channel still has the old name`);
    }
    if (g.sizeSyncPending === true) {
      parts.push(`group ${i + 1}'s channel still has the old user limit`);
    }
  });
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Run the channel and nickname follow-ups of the groups in `work`; the owed texts. */
async function runFollowUps(
  ctx: ApplyContext<PresetValue>,
  work: Array<{
    key: string;
    channelId: string | null | undefined;
    name: boolean;
    size: boolean;
    retag: string[] | null;
  }>,
): Promise<string[]> {
  const owed: string[] = [];
  for (const item of work) {
    const where = `Group ${(ctx.event.groups ?? []).findIndex((g) => g.key === item.key) + 1}`;
    if (item.channelId) {
      if (item.name) {
        if (ctx.ending()) {
          owed.push(`${where}: the channel was not renamed (event ending)`);
        } else {
          const text = renameOwed(await attempt(ctx, "name", item.key));
          if (text) owed.push(`${where}: ${text}`);
        }
      }
      if (item.size) {
        if (ctx.ending()) {
          owed.push(`${where}: the user limit was not changed (event ending)`);
        } else {
          const text = limitOwed(await attempt(ctx, "limit", item.key));
          if (text) owed.push(`${where}: ${text}`);
        }
      }
    }
    if (item.retag && item.retag.length > 0) {
      try {
        ctx.effects?.retagMembers(ctx.guildId, ctx.eventId, item.retag);
      } catch (err) {
        logger.error("Live edit: could not start the nickname update:", err);
      }
    }
  }
  return owed;
}

export const groupPresetRow: LiveEditRow = asRow<PresetValue>({
  id: GROUP_PRESET_ROW_ID,
  label: "Switch preset",
  read: (e) => readPresetValue(e),
  parse: (raw) => {
    const value = parsePresetValue(raw);
    return value
      ? { ok: true, value }
      : {
          ok: false,
          error: "Switch preset: the form is out of date. Reload the page.",
        };
  },
  applicable: (e) =>
    hasGroups(e) ? null : "This event has no groups to apply a preset to.",
  validate: (to, ctx) => {
    const groups = ctx.event.groups ?? [];
    if (to.groups.length !== groups.length) {
      return `That preset has ${to.groups.length} groups and this event has ${groups.length}. A preset is applied to the existing groups by position, so the numbers must match; adding or removing groups is a separate change.`;
    }
    const kindChange = groups.findIndex((g, i) => g.kind !== to.groups[i].kind);
    if (kindChange >= 0) {
      return `That preset would change the kind of group ${kindChange + 1} (${groups[kindChange].kind} to ${to.groups[kindChange].kind}). Changing a group's kind also changes its members and channel access, so it is a separate change.`;
    }
    const errors = ctx.validateSetup((input) => {
      to.groups.forEach((g, i) => {
        input.rows[i].name = g.name;
        input.rows[i].size = g.size === null ? "" : String(g.size);
        input.rows[i].tag = g.tag;
      });
    });
    return errors.length > 0 ? errors.join(" ") : null;
  },
  needsConfirmation: (_from, to, event) => {
    const diff = presetDiff(event, to);
    const renamed = diff.filter((d) => d.name);
    const leaderSet = diff.filter(
      (d) => d.group.originalName && (d.name || d.tag),
    );
    if (renamed.length === 0 && leaderSet.length === 0) return null;
    const count = renamed.length;
    const leaders =
      leaderSet.length > 0
        ? ` ${leaderSet.length} of them ${leaderSet.length === 1 ? "was" : "were"} changed by a leader, and that is replaced too.`
        : "";
    return `Switching the preset replaces the name${count === 1 ? "" : "s"} of ${count} group${count === 1 ? "" : "s"}, whoever set them.${leaders}`;
  },
  describe: (v) => describePreset(v),
  auditValue: (v) => presetAuditValue(v),
  owed: (e) => pendingChannelWork(e),
  async apply(ctx) {
    const { event, to, from } = ctx;
    const groups = event.groups ?? [];
    const diff = presetDiff(event, to);
    // Every group the plan was made from must still be exactly that.
    const same = groups.map((g) => {
      const original = g.originalName ?? "";
      const tag = g.tag ?? "";
      return {
        groups: {
          $elemMatch: {
            key: g.key,
            name: g.name,
            kind: g.kind,
            size: typeof g.size === "number" ? g.size : null,
            tag: tag === "" ? { $in: ["", null] } : tag,
            originalName: original === "" ? { $in: [null, ""] } : original,
          },
        },
      };
    });
    const $set: Record<string, unknown> = {
      presetId: to.id === "" ? null : to.id,
    };
    const $unset: Record<string, ""> = {};
    const arrayFilters: Array<Record<string, string>> = [];
    const work: Array<{
      key: string;
      channelId: string | null | undefined;
      name: boolean;
      size: boolean;
      retag: string[] | null;
    }> = [];
    const retagNow = event.tagsEnabled === true && event.state === "active";
    for (const d of diff) {
      const customised = !!d.group.originalName;
      // Channel work still owed from an earlier save (a rename the budget held
      // back, a limit Discord refused) is retried and reported by this switch
      // too, also for a group whose values the preset leaves as they are.
      const owesChannel =
        !!d.group.channelId &&
        (d.group.nameSyncPending === true || d.group.sizeSyncPending === true);
      if (owesChannel) {
        work.push({
          key: d.group.key,
          channelId: d.group.channelId,
          name: d.name || d.group.nameSyncPending === true,
          size: d.size || d.group.sizeSyncPending === true,
          retag:
            d.tag && retagNow && (d.group.memberIds ?? []).length > 0
              ? [...d.group.memberIds]
              : null,
        });
      }
      if (!d.name && !d.size && !d.tag && !customised) continue;
      const id = `g${d.index}`;
      arrayFilters.push({ [`${id}.key`]: d.group.key });
      const want = to.groups[d.index];
      if (d.name) {
        $set[`groups.$[${id}].name`] = want.name;
        $set[`groups.$[${id}].nameSyncPending`] = true;
      }
      if (d.size) {
        $set[`groups.$[${id}].size`] = want.size;
        $set[`groups.$[${id}].sizeSyncPending`] = true;
      }
      if (d.tag) $set[`groups.$[${id}].tag`] = want.tag;
      if (customised) {
        // The preset is the new baseline (decision 5).
        $unset[`groups.$[${id}].originalName`] = "";
        $unset[`groups.$[${id}].originalTag`] = "";
      }
      if (!owesChannel) {
        work.push({
          key: d.group.key,
          channelId: d.group.channelId,
          name: d.name,
          size: d.size,
          retag:
            d.tag && retagNow && (d.group.memberIds ?? []).length > 0
              ? [...d.group.memberIds]
              : null,
        });
      }
    }
    const result = await Event.updateOne(
      {
        _id: ctx.eventId,
        guildId: ctx.guildId,
        state: { $in: OPEN },
        groupsEnabled: true,
        presetId: from.id === "" ? { $in: [null, ""] } : from.id,
        $and: [
          { groups: { $size: groups.length } },
          ...same.map((s) => ({ groups: s.groups })),
        ],
      },
      {
        $set,
        ...(Object.keys($unset).length > 0 ? { $unset } : {}),
      },
      arrayFilters.length > 0 ? { arrayFilters } : {},
    );
    if ((result?.matchedCount ?? 0) !== 1) return { status: "lost" };
    const owed = await runFollowUps(ctx, work);
    return owed.length === 0
      ? { status: "applied" }
      : { status: "partial", message: owed.join("; ") };
  },
  async reconcile(ctx) {
    const work = (ctx.event.groups ?? []).flatMap((g) =>
      g.channelId && (g.nameSyncPending === true || g.sizeSyncPending === true)
        ? [
            {
              key: g.key,
              channelId: g.channelId,
              name: g.nameSyncPending === true,
              size: g.sizeSyncPending === true,
              retag: null,
            },
          ]
        : [],
    );
    const owed = await runFollowUps(ctx, work);
    return owed.length === 0
      ? { status: "applied" }
      : { status: "partial", message: owed.join("; ") };
  },
});

// ---------------------------------------------------------------
// The registry entries (added to `LIVE_EDIT_ROWS` by the core)
// ---------------------------------------------------------------

export const groupNameRows: readonly LiveEditRow[] = Array.from(
  { length: GROUP_EDIT_POSITIONS },
  (_, i) => nameRow(i),
);

export const groupSizeRows: readonly LiveEditRow[] = Array.from(
  { length: GROUP_EDIT_POSITIONS },
  (_, i) => sizeRow(i),
);

/** Every row of this step, in execution order: names, sizes, then the preset. */
export const GROUP_EDIT_ROWS: readonly LiveEditRow[] = [
  ...groupNameRows,
  ...groupSizeRows,
  groupPresetRow,
];
