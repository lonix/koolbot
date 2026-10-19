/**
 * The live-edit row that switches the groups of a running event on or off
 * (#1243, step 5 of the split of #1197). It is a `LiveEditRow` of the core
 * (`event-live-edit.ts`); the planner, confirmation token, executor, result text
 * and audit are the core's and are not repeated. Read the core's module comment
 * first (rules 1 to 8 and the extension contract).
 *
 * ## The row
 *
 * `groupsEnabled`, value `{ on, setup? }`. The stored value is `{ on }` only
 * (`setup` is never stored: it is the content of the groups a switch-on creates,
 * built by the route from the server's preset catalog, never taken from the
 * client). It is registered LAST in `LIVE_EDIT_ROWS`, so a save that also edits
 * names, sizes or tags applies those first and switches off after.
 *
 * ## Groups turned off (always confirmed)
 *
 * What the host is asked to confirm, and what happens, in this order:
 *
 * 1. **Everyone out of every group channel to the main channel** (the live
 *    edit's lock-free mover entry, `emptyGroupChannel`; the host is moved too).
 *    A person who cannot be moved (missing permission, rate limit, over the 60 a
 *    run) stops the whole switch: **nothing is deleted and groups stay on**, and
 *    the result names who and why. It is all-or-nothing across the event, the
 *    rule of removing a group: a group channel deleted while the groups are
 *    still on would just be re-created by the scan, and a channel kept while the
 *    flag is off would never be deleted by anything (see 2). Saving again moves
 *    the next batch.
 * 2. **Delete the channels and switch off in one hold of the channel lock**
 *    (`EventGroupChannels.removeAllGroupChannels`). Its comment states the
 *    invariant: `groupsEnabled: false` is never stored while a group still has a
 *    recorded channel, because every pass that could delete one only runs for an
 *    event with its groups on.
 * 3. **Nicknames** (`afterSave`, after both locks are released): `syncTags(...,
 *    "restore")`, decided from the stored state (`wantedTag` is null once the
 *    groups are off), in the background and paced. The issue words the order
 *    "return everyone, restore tags, delete the channels"; the restore cannot
 *    come before the switch, because the tag module reads the stored state and
 *    would keep tagging until then, and it does not depend on the channels at
 *    all. So it starts at the same moment the switch lands.
 *
 * **Assignments are kept as history**: the groups stay in the event with their
 * `memberIds`, leader, names, sizes, tags and markers; only the channel ids are
 * cleared. While the groups are off nobody is "in a group" (every assignment
 * writer, the tag module and the channel passes read `groupsEnabled`).
 *
 * ## Groups turned on
 *
 * - **The event has groups kept from before** (it was switched off earlier): one
 *   conditional `$set` of `groupsEnabled`. The kept groups come back as they
 *   were, **including their members and leaders**: the stored state is the
 *   truth, nothing was destroyed on the way off. Tags (when tagging is on and
 *   the event is active) and the leaders-only channel's access follow in
 *   `afterSave`.
 * - **The event never had groups** (a plain event): the host picks a PRESET or
 *   defines OWN starter groups (the route reads the `custom_*` rows with the event
 *   form's rules; the row validates the whole edited setup again, so the one
 *   leads group, the name rules and the group cap hold). The route resolves a
 *   preset's id against the server's catalog and the row's value
 *   carries the content (names, kinds, sizes, tags, markers, labels and the
 *   preset's tagging default). One conditional write stores `groupsEnabled`, the
 *   preset id, the labels, the tagging default and the groups (keys minted
 *   here; every group field explicit, no schema default), only while the event
 *   still has no groups. Leaders, leader customisation, the tag position and the
 *   lock stay at their stored values (off for a plain event); the host switches
 *   them on with the existing rows afterwards. A preset's captains lobby (a
 *   `leads` row, #1263) is therefore not created: `presetToSetup` leaves it out,
 *   and the host ticks the lobby (the Captains lobby row) once leaders are on.
 *   A preset's channel lead time is
 *   not applied (the event keeps its own). The host then renames, adds and
 *   removes groups with the other rows (the same planners, no second editor).
 * - Either way the channels are then made by the existing group pass
 *   (`createMissingChannels` of `event-live-edit-group-set.ts`: the pass creates
 *   them next to the main channel, a `leads` group restricted). Without a main
 *   channel yet nothing is owed: they are all made together when it is. A refusal
 *   is `partial` (stored, channel owed), and posting the same form again finishes
 *   it (`owed` + `reconcile`).
 * - An existing Discord event KoolBot only reads (`nativeAdopted`) never gets
 *   groups: no pass looks after the channels of such an event.
 *
 * ## Known limits (not widened here)
 *
 * - The main channel of an event made without groups has no host overwrites
 *   (they are added only when a group event's main channel is created).
 * - A repeating event's next occurrence is created from the CURRENT setup (the
 *   existing rule for every live edit), so groups turned off here also start the
 *   later occurrences without groups, and groups turned on start them with the
 *   preset's groups. The confirmation says so for a repeating event.
 *
 * ## Locks and the one revision
 *
 * The row runs with the move lock and the group lock held and calls only
 * lock-free internals or leaves (the channel lock). `groupsEnabled` has no other
 * writer than event creation, so nothing else has to move `liveEditRevision`.
 *
 * This module imports only TYPES from the core (the core lists this row in
 * `LIVE_EDIT_ROWS`), hence `asRow` instead of `defineRow`.
 */

import { Event, type IEvent } from "../models/event.js";
import { EVENT_GROUP_KINDS } from "../models/event-group-kinds.js";
import type { EventGroupPreset } from "../content/event-group-presets.js";
import {
  DEFAULT_GROUP_LABEL,
  DEFAULT_LEADER_LABEL,
  GROUP_COUNT_HARD_MAX,
  GROUP_LABEL_MAX,
  GROUP_MARKER_MAX_CHARS,
  checkGroupName,
  checkGroupSize,
  checkGroupTag,
  newGroupKey,
  normalizeGroupText,
} from "./event-groups.js";
import { OPEN_STATES } from "./event-customise-rules.js";
import { createMissingChannels } from "./event-live-edit-group-set.js";
import type {
  AfterSaveContext,
  ApplyContext,
  JsonValue,
  LiveEditRow,
  RowOutcome,
} from "./event-live-edit.js";

export const GROUPS_SWITCH_ROW_ID = "groupsEnabled";
/** The select of the "switch on" form: a preset id, resolved by the server. */
export const GROUPS_PICK_FIELD = "groups_pick";

/** One group of the content a switch-on creates. */
export type SwitchGroup = {
  name: string;
  kind: string;
  size: number | null;
  tag: string;
  marker: string;
};

/** The content of the groups a switch-on creates (a resolved preset). */
export type SwitchSetup = {
  /** The preset's id, stored as the event's `presetId` ("" = none). */
  id: string;
  groupLabel: string;
  leaderLabel: string;
  /** The preset's default for clan tags on nicknames. */
  tagsEnabled: boolean;
  groups: SwitchGroup[];
};

export type GroupsSwitchValue = { on: boolean; setup?: SwitchSetup };

const OPEN = [...OPEN_STATES];
const PRESET_ID_MAX = 64;
const SUBJECT = "a group's channel";
const ENDING_TEXT = "the event is being ended";

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

/** A resolved preset in the row's shape. Built by the route from the server's catalog. */
export function presetToSetup(preset: EventGroupPreset): SwitchSetup {
  return {
    id: preset.id,
    groupLabel: preset.groupLabel,
    leaderLabel: preset.leaderLabel ?? DEFAULT_LEADER_LABEL,
    tagsEnabled: preset.tagsEnabled === true,
    // The preset's captains lobby (a `leads` row) is not created here (#1263):
    // leaders are off after a switch-on, and the lobby is only effective while
    // they are on. The host switches leaders and the lobby on afterwards with
    // their own rows, which carry the confirmation rules.
    groups: preset.groups
      .filter((g) => g.kind !== "leads")
      .map((g) => ({
        name: g.name,
        kind: g.kind,
        size: g.size,
        tag: g.tag,
        marker: g.marker,
      })),
  };
}

/** Strict reading of a posted or signed value; null when it is not one. */
export function parseSwitchValue(raw: string): GroupsSwitchValue | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { on, setup } = data as { on?: unknown; setup?: unknown };
  if (typeof on !== "boolean") return null;
  if (setup === undefined) return { on };
  if (on !== true) return null;
  if (!setup || typeof setup !== "object" || Array.isArray(setup)) return null;
  const { id, groupLabel, leaderLabel, tagsEnabled, groups } = setup as Record<
    string,
    unknown
  >;
  if (typeof id !== "string" || id.length > PRESET_ID_MAX) return null;
  if (typeof groupLabel !== "string" || typeof leaderLabel !== "string") {
    return null;
  }
  if (typeof tagsEnabled !== "boolean") return null;
  if (
    !Array.isArray(groups) ||
    groups.length === 0 ||
    groups.length > GROUP_COUNT_HARD_MAX
  ) {
    return null;
  }
  const label = (text: string, fallback: string): string | null => {
    const value = normalizeGroupText(text) || fallback;
    return value.length > GROUP_LABEL_MAX ? null : value;
  };
  const group = label(groupLabel, DEFAULT_GROUP_LABEL);
  const leader = label(leaderLabel, DEFAULT_LEADER_LABEL);
  if (group === null || leader === null) return null;
  const out: SwitchGroup[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") return null;
    const { name, kind, size, tag, marker } = g as Record<string, unknown>;
    if (typeof name !== "string" || typeof tag !== "string") return null;
    if (typeof kind !== "string" || typeof marker !== "string") return null;
    if (!(EVENT_GROUP_KINDS as readonly string[]).includes(kind)) return null;
    if (size !== null && typeof size !== "number") return null;
    const nameCheck = checkGroupName(name);
    const tagCheck = checkGroupTag(tag);
    const sizeCheck = checkGroupSize(size === null ? "" : String(size));
    if (!nameCheck.ok || !tagCheck.ok || !sizeCheck.ok) return null;
    const mark = normalizeGroupText(marker);
    if (Array.from(mark).length > GROUP_MARKER_MAX_CHARS) return null;
    out.push({
      name: nameCheck.value,
      kind,
      size: sizeCheck.value,
      tag: tagCheck.value,
      marker: mark,
    });
  }
  return {
    on,
    setup: {
      id,
      groupLabel: group,
      leaderLabel: leader,
      tagsEnabled,
      groups: out,
    },
  };
}

const fail = (message: string): RowOutcome => ({ status: "failed", message });

// ---------------------------------------------------------------
// On
// ---------------------------------------------------------------

async function applyOn(
  ctx: ApplyContext<GroupsSwitchValue>,
): Promise<RowOutcome> {
  // A second fresh read, inside the locks: the write is conditional on exactly
  // what is decided from here.
  const fresh = await readFresh(ctx.eventId, ctx.guildId);
  if (!fresh || fresh.groupsEnabled === true) return { status: "lost" };
  if (fresh.nativeAdopted === true) {
    return fail("could not be switched on: this is an existing Discord event");
  }
  const kept = fresh.groups ?? [];
  const setup = ctx.to.setup;
  let filter: Record<string, unknown>;
  let update: Record<string, unknown>;
  if (kept.length > 0) {
    // The kept groups come back as they were (members and leaders included).
    if (setup) return { status: "lost" };
    filter = { groups: { $size: kept.length } };
    update = { $set: { groupsEnabled: true } };
  } else {
    if (!setup) {
      return fail("could not be switched on: no preset was chosen");
    }
    const taken = new Set<string>();
    // Every field explicit: no schema default for a stored group field.
    const groups = setup.groups.map((g) => {
      const key = newGroupKey(taken);
      taken.add(key);
      return {
        key,
        name: g.name,
        kind: g.kind,
        size: g.size,
        tag: g.tag,
        marker: g.marker,
        channelId: null,
        captainId: null,
        memberIds: [] as string[],
      };
    });
    // `groups: []` never stored (an old row) reads the same as an empty list.
    filter = {
      $or: [{ groups: { $exists: false } }, { groups: { $size: 0 } }],
    };
    update = {
      $set: {
        groupsEnabled: true,
        presetId: setup.id === "" ? null : setup.id,
        groupLabel: setup.groupLabel,
        leaderLabel: setup.leaderLabel,
        tagsEnabled: setup.tagsEnabled,
        groups,
      },
    };
  }
  // Synchronous check, then the write: nothing is awaited in between.
  if (ctx.ending()) {
    return fail(`could not be switched on because ${ENDING_TEXT}`);
  }
  const result = await Event.updateOne(
    {
      _id: ctx.eventId,
      guildId: ctx.guildId,
      state: { $in: OPEN },
      groupsEnabled: { $ne: true },
      ...filter,
    },
    update,
  );
  if ((result?.matchedCount ?? 0) !== 1) return { status: "lost" };
  return createMissingChannels(ctx, null, SUBJECT);
}

// ---------------------------------------------------------------
// Off
// ---------------------------------------------------------------

const nameOf = (event: IEvent, key: string): string =>
  (event.groups ?? []).find((g) => g.key === key)?.name ?? key;

const peopleText = (n: number): string =>
  `${n} ${n === 1 ? "person is" : "people are"}`;

async function applyOff(
  ctx: ApplyContext<GroupsSwitchValue>,
): Promise<RowOutcome> {
  const fresh = await readFresh(ctx.eventId, ctx.guildId);
  if (!fresh || fresh.groupsEnabled !== true) return { status: "lost" };
  const fx = ctx.effects;
  if (!fx) {
    return fail(
      "could not be switched off: the people in the group channels could not be moved, so nothing was changed",
    );
  }
  // 1. Everyone out of every group channel, in ONE mover run: one attempt
  // budget (60 moves) and one pacing for the whole save, so many populated groups
  // cannot multiply the bound that keeps the request short. Whoever the budget
  // did not reach is reported by group and a re-save moves the next batch.
  // Nobody is exempted from the occupancy checks of the delete: a person moved
  // early may have walked back into an earlier channel while later ones were
  // emptied, and the run waits for the cache to show the confirmed moves.
  const targets = (fresh.groups ?? []).flatMap((g) =>
    g.channelId ? [{ groupKey: g.key, channelId: g.channelId }] : [],
  );
  const ignore = new Set<string>();
  if (targets.length > 0) {
    if (ctx.ending()) {
      return fail(`could not be switched off because ${ENDING_TEXT}`);
    }
    const emptied = await fx.emptyGroupChannels(
      ctx.guildId,
      ctx.eventId,
      targets,
      ctx.ending,
    );
    if (emptied.status === "failed") {
      return fail(
        `could not be switched off: nobody was moved (${emptied.reason}). Nothing was deleted and the groups are still on`,
      );
    }
    const problems = emptied.occupied.map(
      (o) =>
        `"${nameOf(fresh, o.groupKey)}": ${peopleText(o.remaining)} still in its channel (${emptied.detail})`,
    );
    if (problems.length === 0 && emptied.unconfirmed > 0) {
      problems.push(
        `${emptied.unconfirmed} move${emptied.unconfirmed === 1 ? " is" : "s are"} not confirmed by Discord (${emptied.detail})`,
      );
    }
    if (problems.length > 0) {
      return fail(
        `could not be switched off: ${problems.join("; ")}. Nothing was deleted and the groups are still on`,
      );
    }
  }
  // 2. Delete the channels and switch off, in one step.
  if (ctx.ending()) {
    return fail(`could not be switched off because ${ENDING_TEXT}`);
  }
  const done = await fx.removeAllGroupChannels(ctx.guildId, ctx.eventId, {
    ignore,
    ending: ctx.ending,
  });
  if (done === null) {
    return fail(
      "could not be switched off: the server could not be reached, so nothing was deleted",
    );
  }
  switch (done.status) {
    case "off":
      return { status: "applied" };
    case "lost":
      return { status: "lost" };
    case "occupied":
      return fail(
        `could not be switched off: ${peopleText(done.remaining)} in the channel of "${nameOf(fresh, done.groupKey)}", so nothing was deleted and the groups are still on`,
      );
    case "failed":
      return fail(
        done.deleted > 0
          ? `could not be switched off: ${done.reason}. ${done.deleted} group channel${done.deleted === 1 ? " was" : "s were"} already deleted (KoolBot does not re-create ${done.deleted === 1 ? "it" : "them"} for ten minutes) but the groups are still on`
          : `could not be switched off: ${done.reason}. Nothing was deleted and the groups are still on`,
      );
  }
}

// ---------------------------------------------------------------
// The row
// ---------------------------------------------------------------

function describeValue(v: GroupsSwitchValue): string {
  if (!v.on) return "off";
  return v.setup
    ? `on, with ${v.setup.groups.map((g) => `"${g.name}"`).join(", ")}`
    : "on, with the groups it had";
}

/** The setup in the audit row: flat strings, so the bound keeps every group. */
function auditOf(v: GroupsSwitchValue): JsonValue {
  const out: { [key: string]: JsonValue } = { on: v.on };
  if (!v.setup) return out;
  out.preset = v.setup.id;
  out.tagging = v.setup.tagsEnabled ? "on" : "off";
  v.setup.groups.forEach((g, i) => {
    out[`g${i + 1}`] =
      `${g.name} | ${g.kind} | ${g.size === null ? "no limit" : `size ${g.size}`} | ${g.tag === "" ? "no tag" : `tag ${g.tag}`}`;
  });
  return out;
}

/** A group channel is owed: groups are on, the main channel exists, a group has none. */
function channelOwed(e: IEvent): boolean {
  return (
    e.groupsEnabled === true &&
    !!e.channelId &&
    (e.groups ?? []).some((g) => !g.channelId)
  );
}

export const groupsSwitchRow: LiveEditRow = asRow<GroupsSwitchValue>({
  id: GROUPS_SWITCH_ROW_ID,
  label: "Groups",
  read: (e) => ({ on: e.groupsEnabled === true }),
  parse: (raw) => {
    const value = parseSwitchValue(raw);
    return value
      ? { ok: true, value }
      : {
          ok: false,
          error: "Groups: the form is out of date. Reload the page.",
        };
  },
  applicable: (e) =>
    e.nativeAdopted === true
      ? "This is an existing Discord event KoolBot only reads, so it has no groups."
      : null,
  // Posted with a preset's content, the request is met once the groups are on,
  // whatever the content was: a double submit never builds the groups twice.
  satisfied: (e, to) => to.on && e.groupsEnabled === true,
  validate: (to, ctx) => {
    if (!to.on) return null;
    const kept = ctx.event.groups ?? [];
    const setup = to.setup;
    if (kept.length > 0) {
      if (setup) {
        return "this event has groups kept from before, so there is no preset to choose. Reload the page.";
      }
      const errors = ctx.validateSetup((input) => {
        input.enabled = true;
      });
      return errors.length > 0 ? errors.join(" ") : null;
    }
    if (!setup) {
      return "this event has no groups yet. Choose a preset to switch groups on with.";
    }
    const errors = ctx.validateSetup((input) => {
      input.enabled = true;
      input.groupLabel = setup.groupLabel;
      input.leaderLabel = setup.leaderLabel;
      input.tagsEnabled = setup.tagsEnabled;
      input.rows = setup.groups.map((g, i) => ({
        position: i + 1,
        name: g.name,
        kind: g.kind,
        size: g.size === null ? "" : String(g.size),
        tag: g.tag,
        marker: g.marker,
      }));
    });
    return errors.length > 0 ? errors.join(" ") : null;
  },
  needsConfirmation: (from, to, event) => {
    if (!from.on || to.on) return null;
    const groups = event.groups ?? [];
    const channels = groups.filter((g) => !!g.channelId).length;
    const people = groups.reduce((n, g) => n + (g.memberIds ?? []).length, 0);
    const list = groups
      .map(
        (g) =>
          `${g.name} (${(g.memberIds ?? []).length === 0 ? "nobody assigned" : `${(g.memberIds ?? []).length} assigned`}${g.channelId ? ", with a voice channel" : ""})`,
      )
      .join("; ");
    const repeats =
      event.recurrence && event.recurrence !== "none"
        ? " This event repeats, and the next one is made from the settings it has now, so it starts without groups too."
        : "";
    const tags =
      event.tagsEnabled === true
        ? " The clan tags come off the nicknames."
        : "";
    return `Switching groups off: ${list}. Everybody in the ${channels} group channel${channels === 1 ? "" : "s"}, you included, is moved to the main channel first, and then the channels are deleted.${tags} The groups and the ${people} assignment${people === 1 ? "" : "s"} are kept, but nobody counts as in a group while groups are off. Switching groups on again brings them back, with new channels. If somebody cannot be moved, nothing is deleted and groups stay on.${repeats}`;
  },
  describe: describeValue,
  auditValue: auditOf,
  owed: (e) => (channelOwed(e) ? "a group's channel is not created yet" : null),
  async apply(ctx) {
    return ctx.to.on ? applyOn(ctx) : applyOff(ctx);
  },
  reconcile: (ctx) => createMissingChannels(ctx, null, SUBJECT),
  afterSaveGroup: "groupsSwitch",
  afterSave: switchFollowUp,
});

/**
 * After both locks are released, from a fresh read. Off: put every nickname
 * back (explicitly `restore`, not `tagsFollowUp`: that one chooses from
 * `tagsEnabled`, which stays on). On: the leaders-only channel's access, the
 * "Customise team" messages, and the tags of the kept members. Each part is its
 * own try, the first error is rethrown after all ran (the executor logs it; the
 * scan converges).
 */
async function switchFollowUp(ctx: AfterSaveContext): Promise<void> {
  const fresh = (await Event.findOne({
    _id: ctx.eventId,
    guildId: ctx.guildId,
  })
    .select("groupsEnabled tagsEnabled state")
    .lean()) as Pick<IEvent, "groupsEnabled" | "tagsEnabled" | "state"> | null;
  if (!fresh) return;
  if (fresh.groupsEnabled !== true) {
    // Never rejects; paced per member, and the sweep is the backstop.
    void ctx.effects.syncTags(ctx.guildId, ctx.eventId, "restore");
    return;
  }
  const errors: unknown[] = [];
  const run = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (err) {
      errors.push(err);
    }
  };
  await run(() => ctx.effects.syncLeadsAccess(ctx.guildId, ctx.eventId));
  await run(() => ctx.effects.syncGroupControls(ctx.eventId));
  if (fresh.tagsEnabled === true && fresh.state === "active") {
    void ctx.effects.syncTags(ctx.guildId, ctx.eventId, "sync");
  }
  if (errors.length > 0) throw errors[0];
}

/** The rows of this step. */
export const groupsSwitchRows: readonly LiveEditRow[] = [groupsSwitchRow];
