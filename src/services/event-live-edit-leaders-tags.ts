/**
 * The live-edit rows of leaders and clan tags (#1240, step 2 of the split of
 * #1197). They are registered in `LIVE_EDIT_ROWS` (`event-live-edit.ts`) and
 * follow its extension contract; the planner, the executor and the one result
 * need nothing from this file.
 *
 * | Row | Stored field | Follow-up (after both locks are released) |
 * | --- | --- | --- |
 * | `captainsEnabled` | `captainsEnabled` | leads-channel pass, controls pass |
 * | `captainCustomisationEnabled` | `captainCustomisationEnabled` | controls pass |
 * | `leaderLabel` | `leaderLabel` | none |
 * | `tagsEnabled` | `tagsEnabled` | nicknames: tag (on) or restore (off) |
 * | `tagsSuffix` | `tagsSuffix` | nicknames: re-tag |
 * | `groupTags` | `groups[].tag` of the team groups | nicknames: re-tag |
 *
 * ## Rules of these rows
 *
 * 1. **Every row is one conditional `$set`** on the event being open, its guild,
 *    `groupsEnabled`, and the value it was decided from. No row writes `state`,
 *    `channelId` or the `groups` array: the tag row sets `groups.$[gN].tag` by
 *    key (`arrayFilters`) and conditions every touched group with `$elemMatch`
 *    in the same filter, so a save of several tags is all or nothing.
 * 2. **Stored data is kept, the switches hide it.** Turning leaders off writes
 *    only `captainsEnabled`: `groups[].captainId` stays (`effectiveLeaders`
 *    ignores it while the switch is off, and turning leaders on again brings
 *    those leaders back). Turning customisation off keeps the chosen names and
 *    tags (the host's reset is the only thing that puts them back). The
 *    customisation switch is stored as the host sets it and is only effective
 *    while leaders are on (`customisationOn`), so "leaders on and
 *    customisation on" is one valid save whatever the order of the rows.
 * 3. **The switches are read at the moment of use, never cached.** A leader's
 *    button or modal submit (#1196) reads the fresh event; this save is what that
 *    read sees. A submit that arrives after the save is refused by the checks of
 *    `event-customise-rules.ts`, one that was written before it is a complete
 *    change under the group lock, and the two can never interleave (the
 *    customiser's write and this save both hold `withGroupLock`).
 * 4. **Nicknames are never touched here.** `afterSave` asks
 *    `EventNicknameTags` (`syncEvent`, `restoreEvent`), which decides from the
 *    stored original and a fresh read, never from the current nickname, so a
 *    tag changed from A to B is `[B] Alice` and never `[B] [A] Alice`. That work
 *    is paced per member, has its own settle window for a nickname edit whose
 *    outcome is unknown, and is not waited for (the host's result does not
 *    pretend it is finished). A member whose edit is inside the settle window is
 *    kept and finished by the sweep, so a flip back and forth converges. Tags
 *    never go through the channel rename queue (that is for channel names).
 * 5. **The host's tag is the new original.** A team a leader has customised
 *    holds the host's earlier values in `originalTag` (the host's reset goes
 *    back to them). A host edit of the tag is the host's value now, so it is
 *    written to `originalTag` in the same write (only for a customised group);
 *    otherwise a reset would bring back a tag the host has since replaced.
 * 6. **No confirmation.** The owner's decision is that leaders, customisation
 *    and tags are switchable at any time, so none of these rows needs one, and
 *    nothing else has to move `liveEditRevision` for them (that contract is
 *    for the writers of a confirmation-gated field).
 *
 * This file imports only TYPES of `event-live-edit.ts` (the registry imports
 * this file), hence `row()` instead of `defineRow`.
 */

import { Event, type IEvent } from "../models/event.js";
import { OPEN_STATES } from "./event-customise-rules.js";
import { effectiveLeaders } from "./event-leader-roles.js";
import { checkGroupTag, validateLeaderLabel } from "./event-groups.js";
import type {
  AfterSaveContext,
  JsonValue,
  LiveEditRow,
} from "./event-live-edit.js";

/** Type-erase a row for the registry (the same cast as `defineRow`). */
function row<V extends JsonValue>(r: LiveEditRow<V>): LiveEditRow {
  return r as unknown as LiveEditRow;
}

const NO_GROUPS = "This event has no groups.";

/** The event has its groups switched on and at least one group. */
function hasGroups(e: IEvent): boolean {
  return e.groupsEnabled === true && (e.groups ?? []).length > 0;
}

// ---------------------------------------------------------------
// The switches
// ---------------------------------------------------------------

type SwitchField =
  | "captainsEnabled"
  | "captainCustomisationEnabled"
  | "tagsEnabled"
  | "tagsSuffix";

function switchRow(opts: {
  id: SwitchField;
  label: string;
  on: string;
  off: string;
  afterSaveGroup: string;
  afterSave: (ctx: AfterSaveContext) => Promise<void> | void;
}): LiveEditRow {
  const { id } = opts;
  return row<boolean>({
    id,
    label: opts.label,
    read: (e) => e[id] === true,
    applicable: (e) => (hasGroups(e) ? null : NO_GROUPS),
    parse: (raw) =>
      raw === "1" || raw === "0"
        ? { ok: true, value: raw === "1" }
        : { ok: false, error: `${opts.label}: choose on or off.` },
    describe: (v) => (v ? opts.on : opts.off),
    async apply({ eventId, guildId, from, to }) {
      // `$ne: true` is "off" for a stored false and for a missing field.
      const result = await Event.updateOne(
        {
          _id: eventId,
          guildId,
          state: { $in: [...OPEN_STATES] },
          groupsEnabled: true,
          [id]: from ? true : { $ne: true },
        },
        { $set: { [id]: to } },
      );
      return (result?.matchedCount ?? 0) === 1
        ? { status: "applied" }
        : { status: "lost" };
    },
    afterSaveGroup: opts.afterSaveGroup,
    afterSave: opts.afterSave,
  });
}

/**
 * Leaders and the customise controls follow the switches: the leads channel
 * (overwrites and who must leave) when leaders changed, the "Customise team"
 * messages whenever either switch changed (`customisationOn` reads both).
 * Neither takes a lock that is held while a row applies: this runs after.
 */
async function leadersFollowUp(ctx: AfterSaveContext): Promise<void> {
  const errors: unknown[] = [];
  if (ctx.saved.has("captainsEnabled")) {
    try {
      // With leaders off now, the stored leaders (kept, hidden) lost access
      // with this save: they are named so that anyone of them connected to the
      // leaders-only channel is moved out at once, not when the permission cache
      // has caught up with the overwrite change (a later scan would).
      let revoked: string[] = [];
      try {
        const fresh = (await Event.findOne({
          _id: ctx.eventId,
          guildId: ctx.guildId,
        })
          .select("captainsEnabled groups")
          .lean()) as Pick<IEvent, "captainsEnabled" | "groups"> | null;
        if (fresh && fresh.captainsEnabled !== true) {
          revoked = effectiveLeaders(fresh.groups).map((l) => l.userId);
        }
      } catch {
        // Unreadable: the pass still runs and the scan finishes the move.
      }
      await ctx.effects.syncLeadsAccess(ctx.guildId, ctx.eventId, revoked);
    } catch (err) {
      errors.push(err);
    }
  }
  try {
    await ctx.effects.syncGroupControls(ctx.eventId);
  } catch (err) {
    errors.push(err);
  }
  if (errors.length > 0) throw errors[0];
}

/**
 * Nicknames follow the switches: `restore` when tagging is off now (read fresh),
 * else `sync`. Started and not waited for.
 */
export async function tagsFollowUp(ctx: AfterSaveContext): Promise<void> {
  const fresh = (await Event.findOne({
    _id: ctx.eventId,
    guildId: ctx.guildId,
  })
    .select("tagsEnabled")
    .lean()) as Pick<IEvent, "tagsEnabled"> | null;
  if (!fresh) return;
  void ctx.effects.syncTags(
    ctx.guildId,
    ctx.eventId,
    fresh.tagsEnabled === true ? "sync" : "restore",
  );
}

export const captainsRow = switchRow({
  id: "captainsEnabled",
  label: "Leaders",
  on: "on",
  off: "off",
  afterSaveGroup: "leaders",
  afterSave: leadersFollowUp,
});

export const customisationRow = switchRow({
  id: "captainCustomisationEnabled",
  label: "Leader customisation",
  on: "on (while leaders are on)",
  off: "off",
  afterSaveGroup: "leaders",
  afterSave: leadersFollowUp,
});

export const tagsRow = switchRow({
  id: "tagsEnabled",
  label: "Clan tags on nicknames",
  on: "on (nicknames follow in the background)",
  off: "off (nicknames are being put back in the background)",
  afterSaveGroup: "tags",
  afterSave: tagsFollowUp,
});

export const tagsSuffixRow = switchRow({
  id: "tagsSuffix",
  label: "Tag position",
  on: "after the name (nicknames follow in the background)",
  off: "before the name (nicknames follow in the background)",
  afterSaveGroup: "tags",
  afterSave: tagsFollowUp,
});

// ---------------------------------------------------------------
// The leader label
// ---------------------------------------------------------------

const DEFAULT_LABEL = "Leader";

/** Row: what leaders are called on this event ("Captain", "Squad Lead"). */
export const leaderLabelRow = row<string>({
  id: "leaderLabel",
  label: "Leader label",
  read: (e) => (e.leaderLabel ? e.leaderLabel : DEFAULT_LABEL),
  applicable: (e) => (hasGroups(e) ? null : NO_GROUPS),
  parse: (raw) => {
    const checked = validateLeaderLabel(raw);
    return checked.ok
      ? { ok: true, value: checked.value }
      : { ok: false, error: checked.error };
  },
  describe: (v) => `"${v}"`,
  async apply({ eventId, guildId, from, to }) {
    // A stored default may be the text, an empty string or no field at all.
    const result = await Event.updateOne(
      {
        _id: eventId,
        guildId,
        state: { $in: [...OPEN_STATES] },
        groupsEnabled: true,
        leaderLabel: from === DEFAULT_LABEL ? { $in: [from, "", null] } : from,
      },
      { $set: { leaderLabel: to } },
    );
    return (result?.matchedCount ?? 0) === 1
      ? { status: "applied" }
      : { status: "lost" };
  },
});

// ---------------------------------------------------------------
// The tag of each team
// ---------------------------------------------------------------

/** Posted per team: `s_groupTags_<key>` (value) and `b_groupTags_<key>` (shown). */
export const groupTagField = (key: string): string => `s_groupTags_${key}`;
export const groupTagBaseField = (key: string): string => `b_groupTags_${key}`;
const TAG_VALUE_RE = /^s_groupTags_(g_[0-9a-f]{8})$/;

type TagMap = { [groupKey: string]: string };

const isTeam = (g: { kind?: string }): boolean => g.kind === "team";

/** Normalised text of a stored tag (the form's own rules). */
const tagText = (raw: string | null | undefined): string =>
  checkGroupTag(raw ?? "").value;

/** Row: the clan tag of every team group, as one map from group key to tag. */
export const groupTagsRow = row<TagMap>({
  id: "groupTags",
  label: "Team tags",
  read: (e) => {
    const map: TagMap = {};
    for (const g of e.groups ?? []) {
      if (isTeam(g)) map[g.key] = tagText(g.tag);
    }
    return map;
  },
  applicable: (e) =>
    e.groupsEnabled === true && (e.groups ?? []).some(isTeam)
      ? null
      : "This event has no team groups to tag.",
  collect: (body) => {
    const raw: TagMap = {};
    const base: TagMap = {};
    let posted = false;
    let baseMissing = false;
    for (const [name, value] of Object.entries(body)) {
      const m = TAG_VALUE_RE.exec(name);
      if (!m || typeof value !== "string") continue;
      posted = true;
      raw[m[1]] = value;
      const shown = body[groupTagBaseField(m[1])];
      if (typeof shown === "string") base[m[1]] = shown;
      else baseMissing = true;
    }
    if (!posted) return null;
    // An empty base cannot be parsed: the form is "out of date".
    return {
      raw: JSON.stringify(raw),
      base: baseMissing ? "" : JSON.stringify(base),
    };
  },
  parse: (raw) => {
    const bad = {
      ok: false as const,
      error: "Team tags: the form is not valid. Reload the page.",
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return bad;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return bad;
    }
    const map: TagMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") return bad;
      map[k] = tagText(v);
    }
    return { ok: true, value: map };
  },
  validate: (to, ctx) => {
    const teams = (ctx.event.groups ?? []).filter(isTeam);
    const keys = new Set(teams.map((g) => g.key));
    const sameKeys =
      Object.keys(to).length === keys.size &&
      Object.keys(to).every((k) => keys.has(k));
    if (!sameKeys) {
      return "the teams changed while you were editing. Reload the page and try again.";
    }
    const errors: string[] = [];
    for (const g of teams) {
      const checked = checkGroupTag(to[g.key]);
      if (!checked.ok) errors.push(`${g.name}: ${checked.error}`);
    }
    return errors.length > 0 ? errors.join(" ") : null;
  },
  describe: (v) => {
    const parts = Object.values(v).filter((t) => t !== "");
    const what =
      parts.length === 0
        ? "no tags"
        : `tags ${parts.map((t) => `"${t}"`).join(", ")}`;
    return `${what} (nicknames follow in the background)`;
  },
  async apply({ event, eventId, guildId, from, to }) {
    const changed = Object.keys(to).filter((k) => to[k] !== from[k]);
    if (changed.length === 0) return { status: "applied" };
    const customised = new Set(
      (event.groups ?? [])
        .filter((g) => typeof g.originalName === "string" && g.originalName)
        .map((g) => g.key),
    );
    const set: Record<string, string> = {};
    const arrayFilters: Array<Record<string, string>> = [];
    const mustHold: Array<Record<string, unknown>> = [];
    changed.forEach((key, i) => {
      set[`groups.$[g${i}].tag`] = to[key];
      // The host's value is the new original of a customised team (rule 5).
      if (customised.has(key)) set[`groups.$[g${i}].originalTag`] = to[key];
      arrayFilters.push({ [`g${i}.key`]: key });
      mustHold.push({
        groups: {
          $elemMatch: {
            key,
            kind: "team",
            tag: from[key] === "" ? { $in: ["", null] } : from[key],
          },
        },
      });
    });
    const result = await Event.updateOne(
      {
        _id: eventId,
        guildId,
        state: { $in: [...OPEN_STATES] },
        groupsEnabled: true,
        $and: mustHold,
      },
      { $set: set },
      { arrayFilters },
    );
    return (result?.matchedCount ?? 0) === 1
      ? { status: "applied" }
      : { status: "lost" };
  },
  afterSaveGroup: "tags",
  afterSave: tagsFollowUp,
});

/** The rows of this step, in execution order (leaders first, then tags). */
export const leadersTagsRows: readonly LiveEditRow[] = [
  captainsRow,
  customisationRow,
  leaderLabelRow,
  tagsRow,
  tagsSuffixRow,
  groupTagsRow,
];
