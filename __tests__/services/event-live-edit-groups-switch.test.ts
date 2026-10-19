import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Live edit that switches the groups of a running event on or off (#1243): the
 * row of `event-live-edit-groups-switch.ts` runs through the REAL core (planner,
 * executor, both locks, confirmation round trip, result text, audit bound)
 * against the in-memory Event stand-in of
 * `event-live-edit-groups-fake-event.ts`, with the channel effects replaced by
 * fakes that behave like the real passes (the switch-off clears every channel id
 * and stores the flag, as `EventGroupChannels.removeAllGroupChannels` does). The
 * stand-in throws on any filter or update shape the row does not use; the real
 * shapes are proven against MongoDB in
 * `__tests__/integration/event-live-edit-groups-switch.integration.test.ts`.
 *
 * Expected values are literals, never computed by a copy of the logic under test.
 */

import {
  store,
  writes,
  fake,
  EventMock,
  type Json,
} from "./event-live-edit-groups-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({}) },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: {
      getInstance: () => ({
        admission: () => 1,
        resetAwareWrite: async (
          ids: string[],
          _guildId: string,
          write: (ids: string[]) => Promise<unknown>,
        ) => ({ admitted: ids, value: await write(ids) }),
      }),
    },
  }),
);

process.env.WEBUI_SESSION_SECRET = "live-edit-groups-switch-test-secret";

const live = await import("../../src/services/event-live-edit.js");
const { groupsSwitchRow, GROUPS_SWITCH_ROW_ID, parseSwitchValue } =
  await import("../../src/services/event-live-edit-groups-switch.js");
const { GROUP_ADD_ROW_ID } =
  await import("../../src/services/event-live-edit-group-set.js");
const { makeEffects } =
  await import("./event-live-edit-groups-effects-fake.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");
const { boundAuditEntry } = await import("../../src/web/audit.js");
type LiveEditDeps =
  import("../../src/services/event-live-edit.js").LiveEditDeps;
type LiveEditEffects =
  import("../../src/services/event-live-edit.js").LiveEditEffects;
type LiveEditOutcome =
  import("../../src/services/event-live-edit.js").LiveEditOutcome;
type EmptyChannelOutcome =
  import("../../src/services/event-live-edit.js").EmptyChannelOutcome;
type GroupsOffResult =
  import("../../src/services/event-live-edit.js").GroupsOffResult;

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const HOST = "host-1";
const A = "g_00000001";
const B = "g_00000002";
const NEW = "g_0000abcd";

const ON = { on: true };
const OFF = { on: false };

const SETUP = {
  id: "builtin:red-vs-blue",
  groupLabel: "Team",
  leaderLabel: "Leader",
  tagsEnabled: true,
  groups: [
    { name: "Red", kind: "team", size: null, tag: "R", marker: "🔴" },
    { name: "Blue", kind: "team", size: 5, tag: "B", marker: "🔵" },
    { name: "Command", kind: "leads", size: null, tag: "", marker: "" },
  ],
};

function seedGroups(): Json[] {
  return [
    {
      key: A,
      name: "Alpha",
      kind: "team",
      size: 3,
      tag: "A",
      marker: "",
      channelId: "c1",
      captainId: "u1",
      memberIds: ["u1", "u2"],
    },
    {
      key: B,
      name: "Bravo",
      kind: "leads",
      size: null,
      tag: "",
      marker: "",
      channelId: "c2",
      captainId: null,
      memberIds: [],
    },
  ];
}

/** An event with groups on, two channels and members. */
function seed(over: Json = {}): Json {
  const doc: Json = {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    captainsEnabled: true,
    presetId: null,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    channelId: "c-main",
    tagsEnabled: true,
    recurrence: "none",
    groups: seedGroups(),
    ...over,
  };
  store.set(EV, doc);
  return doc;
}

/** A plain event: no groups at all. */
const seedPlain = (over: Json = {}): Json =>
  seed({
    groupsEnabled: false,
    captainsEnabled: false,
    tagsEnabled: false,
    groups: [],
    ...over,
  });

/** Groups kept from an earlier switch-off: members stay, no channel. */
const seedKept = (over: Json = {}): Json => {
  const groups = seedGroups().map((g) => ({ ...g, channelId: null }));
  return seed({ groupsEnabled: false, groups, ...over });
};

const doc = (): Json => store.get(EV) as Json;
const groupsOf = (): Json[] => doc().groups as Json[];
const group = (key: string): Json =>
  groupsOf().find((g) => g.key === key) as Json;
const rowWrites = (): typeof writes =>
  writes.filter((w) => !("$inc" in w.update));

let enabled: boolean | null = true;
let ending = false;
let maxGroups: number | null = 15;
let effects: LiveEditEffects | undefined;
const deps: LiveEditDeps = {
  isEventsEnabled: async () => enabled,
  maxGroups: async () => maxGroups,
  isEnding: () => ending,
  get effects(): LiveEditEffects | undefined {
    return effects;
  },
};

const calls: string[] = [];
let emptyResult: (key: string) => EmptyChannelOutcome;
let offResult: (() => GroupsOffResult | null) | null;
let createResult: () => {
  failures: Array<{ key: string; reason: string }>;
} | null;
/** What the event looked like when the nicknames were asked to be put back. */
const atRestore: Array<{ groupsEnabled: unknown }> = [];
const atEmpty: Array<{ key: string; groupsEnabled: unknown }> = [];
const created: string[][] = [];

beforeEach(() => {
  store.clear();
  writes.length = 0;
  calls.length = 0;
  atRestore.length = 0;
  atEmpty.length = 0;
  created.length = 0;
  fake.beforeWrite = null;
  fake.afterFind = null;
  fake.extraGroupFields = new Set();
  fake.extraSettable = new Set([
    "groupsEnabled",
    "groupLabel",
    "leaderLabel",
    "tagsEnabled",
    "groups",
  ]);
  fake.failReads = false;
  enabled = true;
  ending = false;
  maxGroups = 15;
  emptyResult = () => ({ status: "empty", moved: [] });
  offResult = null;
  createResult = () => ({ failures: [] });
  resetMoveGuardForTests();
  seed();
  effects = makeEffects({
    async syncGroupName(_g, _e, key) {
      return { groupKey: key, status: "applied" };
    },
    async syncGroupUserLimit(_g, _e, key) {
      return { groupKey: key, status: "applied" };
    },
    async createGroupChannels() {
      calls.push("create");
      created.push(
        groupsOf()
          .filter((g) => !g.channelId)
          .map((g) => `${String(g.name)}:${String(g.kind)}`),
      );
      const result = createResult();
      // The real pass records a channel for every group that has none.
      if (result && result.failures.length === 0) {
        for (const g of groupsOf()) {
          if (!g.channelId) g.channelId = `made-${String(g.key)}`;
        }
      }
      return result;
    },
    async emptyGroupChannel(_g, _e, key, channelId) {
      calls.push(`empty:${key}:${channelId}`);
      atEmpty.push({ key, groupsEnabled: doc().groupsEnabled });
      return emptyResult(key);
    },
    async removeAllGroupChannels(_g, _e, opts) {
      calls.push(`removeAll:${[...opts.ignore].join("+")}`);
      const result = offResult?.() ?? { status: "off" as const, deleted: 2 };
      // The real pass clears every recorded id and stores the flag together.
      if (result.status === "off") {
        for (const g of groupsOf()) g.channelId = null;
        doc().groupsEnabled = false;
      }
      return result;
    },
    async syncTags(_g, _e, mode) {
      calls.push(`tags:${mode}`);
      if (mode === "restore") {
        atRestore.push({ groupsEnabled: doc().groupsEnabled });
      }
    },
  });
  effects.syncLeadsAccess = async (): Promise<void> => {
    calls.push("leads");
  };
  effects.syncGroupControls = async (): Promise<void> => {
    calls.push("controls");
  };
});

const entry = (rowId: string, to: unknown, base: unknown) => ({
  rowId,
  to,
  base,
});
const run = (
  entries: Array<{ rowId: string; to: unknown; base: unknown }>,
  d: LiveEditDeps = deps,
): Promise<LiveEditOutcome> =>
  live.runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps: d,
    submission: entries as never,
  });
const switchOn = (to: unknown = ON) =>
  run([entry(GROUPS_SWITCH_ROW_ID, to, OFF)]);
const switchOff = () => run([entry(GROUPS_SWITCH_ROW_ID, OFF, ON)]);

type Done = Extract<LiveEditOutcome, { status: "done" }>;
const done = (o: LiveEditOutcome): Done => {
  expect(o.status).toBe("done");
  return o as Done;
};
const text = (o: LiveEditOutcome): string =>
  live.describeLiveEditOutcome(o).message;

/** The two steps of a switch-off: the confirmation page, then the confirmed run. */
async function offConfirmed(d: LiveEditDeps = deps): Promise<LiveEditOutcome> {
  const first = await switchOff();
  expect(first.status).toBe("needs-confirmation");
  if (first.status !== "needs-confirmation") return first;
  return confirm(first, d);
}
function confirm(
  first: Extract<LiveEditOutcome, { status: "needs-confirmation" }>,
  d: LiveEditDeps = deps,
): Promise<LiveEditOutcome> {
  const token = live.signConfirmation({
    eventId: EV,
    guildId: GUILD,
    userId: HOST,
    changes: first.changes.map((c) => ({
      rowId: c.rowId,
      from: c.from,
      to: c.to,
    })),
    revision: first.revision,
  });
  const check = live.verifyConfirmation(token, {
    eventId: EV,
    guildId: GUILD,
    userId: HOST,
  });
  if (!check.ok) throw new Error("token refused");
  return live.runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps: d,
    confirmed: check.changes,
    confirmedRevision: check.revision,
  });
}

describe("registration and parsing", () => {
  it("is the last row, with a letters-only id and no duplicates", () => {
    const ids = live.LIVE_EDIT_ROWS.map((r) => r.id);
    expect(ids[ids.length - 1]).toBe("groupsEnabled");
    expect(new Set(ids).size).toBe(ids.length);
    expect(groupsSwitchRow.id).toMatch(/^[A-Za-z]+$/);
    expect(GROUPS_SWITCH_ROW_ID).toBe("groupsEnabled");
  });

  it("reads only well-formed values", () => {
    expect(parseSwitchValue('{"on":true}')).toEqual({ on: true });
    expect(parseSwitchValue('{"on":false}')).toEqual({ on: false });
    expect(
      parseSwitchValue(JSON.stringify({ on: true, setup: SETUP })),
    ).toEqual({ on: true, setup: SETUP });
    for (const bad of [
      "nope",
      "[]",
      "{}",
      '{"on":"yes"}',
      // content only travels with a switch-on
      JSON.stringify({ on: false, setup: SETUP }),
      JSON.stringify({ on: true, setup: { ...SETUP, groups: [] } }),
      JSON.stringify({
        on: true,
        setup: { ...SETUP, groups: [{ ...SETUP.groups[0], kind: "boss" }] },
      }),
      JSON.stringify({
        on: true,
        setup: { ...SETUP, groups: [{ ...SETUP.groups[0], name: "  " }] },
      }),
      JSON.stringify({
        on: true,
        setup: {
          ...SETUP,
          groups: [{ ...SETUP.groups[0], marker: "12345" }],
        },
      }),
      JSON.stringify({ on: true, setup: { ...SETUP, tagsEnabled: "yes" } }),
    ]) {
      expect(parseSwitchValue(bad)).toBeNull();
    }
  });

  it("reads the form's value field and its base like any other row", () => {
    const parsed = live.parseSubmission({
      s_groupsEnabled: '{"on":false}',
      b_groupsEnabled: '{"on":true}',
    });
    expect(parsed).toEqual({
      entries: [{ rowId: "groupsEnabled", to: OFF, base: ON }],
      errors: [],
    });
    expect(
      live.parseSubmission({ s_groupsEnabled: "x", b_groupsEnabled: "{}" })
        .errors,
    ).toEqual(["Groups: the form is out of date. Reload the page."]);
  });
});

describe("groups turned on: groups kept from before", () => {
  beforeEach(() => {
    seedKept();
  });

  it("switches on, brings the members and leaders back, and creates the channels", async () => {
    const out = done(await switchOn());
    expect(out.applied.map((c) => c.rowId)).toEqual(["groupsEnabled"]);
    expect(doc().groupsEnabled).toBe(true);
    // Nothing destroyed on the way off comes back changed.
    expect(group(A).memberIds).toEqual(["u1", "u2"]);
    expect(group(A).captainId).toBe("u1");
    expect(groupsOf().map((g) => g.channelId)).toEqual([
      `made-${A}`,
      `made-${B}`,
    ]);
    // Exactly one row write, conditional on the flag being off and the groups
    // being the ones the plan was made from.
    expect(rowWrites()).toHaveLength(1);
    expect(rowWrites()[0].filter).toEqual({
      _id: EV,
      guildId: GUILD,
      state: { $in: ["scheduled", "active"] },
      groupsEnabled: { $ne: true },
      groups: { $size: 2 },
    });
    expect(rowWrites()[0].update).toEqual({ $set: { groupsEnabled: true } });
    expect(text(out)).toBe("Saved: Groups is now on, with the groups it had.");
  });

  it("creates the restricted leaders-only channel through the group pass, and starts the tags (tagging is on, the event is running)", async () => {
    await switchOn();
    // The pass is asked once, after the flag is stored, for every group that has none.
    expect(created).toEqual([["Alpha:team", "Bravo:leads"]]);
    expect(calls).toEqual(["create", "leads", "controls", "tags:sync"]);
  });

  it("does not start tags when tagging is off, nor on a scheduled event", async () => {
    seedKept({ tagsEnabled: false });
    await switchOn();
    expect(calls).toEqual(["create", "leads", "controls"]);
    calls.length = 0;
    seedKept({ state: "scheduled" });
    await switchOn();
    expect(calls).toEqual(["create", "leads", "controls"]);
  });

  it("without a main channel yet nothing is owed: the channels are made together later", async () => {
    seedKept({ channelId: null });
    const out = done(await switchOn());
    expect(out.partial).toEqual([]);
    expect(calls).not.toContain("create");
    expect(doc().groupsEnabled).toBe(true);
  });

  it("a refused channel is stored but owed, and the same form posted again finishes it", async () => {
    createResult = () => ({
      failures: [{ key: A, reason: "Discord refused: Missing Permissions" }],
    });
    const first = done(await switchOn());
    expect(first.partial).toHaveLength(1);
    expect(doc().groupsEnabled).toBe(true);
    expect(text(first)).toBe(
      "Saved but not finished: Groups is now on, with the groups it had (a group's channel is not created yet (Discord refused: Missing Permissions): KoolBot keeps trying every minute). Save again to finish.",
    );
    expect(live.describeLiveEditOutcome(first).ok).toBe(false);

    createResult = () => ({ failures: [] });
    // The refreshed form shows the stored state as value and base.
    const again = done(await run([entry(GROUPS_SWITCH_ROW_ID, ON, ON)]));
    expect(again.partial).toEqual([]);
    expect(again.applied.map((c) => [c.rowId, c.reconcile])).toEqual([
      ["groupsEnabled", true],
    ]);
    expect(text(again)).toBe("Saved: Groups is finished.");
    expect(groupsOf().every((g) => !!g.channelId)).toBe(true);
    // The reconcile writes no field.
    expect(rowWrites()).toHaveLength(1);
  });

  it("posting the same switch-on twice is the second one already applied, with no second write", async () => {
    await switchOn();
    const writesBefore = writes.length;
    const again = done(await switchOn());
    expect(again.alreadyApplied).toEqual(["groupsEnabled"]);
    expect(again.applied).toEqual([]);
    expect(writes.length).toBe(writesBefore);
    expect(text(again)).toBe(
      "Nothing to change: the event already has these settings.",
    );
  });

  it("a preset posted for an event that has kept groups is refused (the page was out of date)", async () => {
    const out = await switchOn({ on: true, setup: SETUP });
    expect(out).toEqual({
      status: "invalid",
      errors: [
        "Groups: this event has groups kept from before, so there is no preset to choose. Reload the page.",
      ],
    });
    expect(doc().groupsEnabled).toBe(false);
  });
});

describe("groups turned on: an event that never had groups", () => {
  beforeEach(() => {
    seedPlain();
  });

  it("builds the groups from the chosen preset, every field explicit, and creates the channels", async () => {
    const out = done(await switchOn({ on: true, setup: SETUP }));
    expect(out.applied).toHaveLength(1);
    expect(doc().groupsEnabled).toBe(true);
    expect(doc().presetId).toBe("builtin:red-vs-blue");
    expect(doc().groupLabel).toBe("Team");
    expect(doc().leaderLabel).toBe("Leader");
    expect(doc().tagsEnabled).toBe(true);
    // The other switches stay as they were stored (off for a plain event).
    expect(doc().captainsEnabled).toBe(false);
    expect(groupsOf()).toHaveLength(3);
    groupsOf().forEach((g, i) => {
      expect(g.key).toMatch(/^g_[0-9a-f]{8}$/);
      expect(Object.keys(g).sort()).toEqual([
        "captainId",
        "channelId",
        "key",
        "kind",
        "marker",
        "memberIds",
        "name",
        "size",
        "tag",
      ]);
      expect({
        name: g.name,
        kind: g.kind,
        size: g.size,
        tag: g.tag,
        marker: g.marker,
        captainId: g.captainId,
        memberIds: g.memberIds,
      }).toEqual({ ...SETUP.groups[i], captainId: null, memberIds: [] });
    });
    expect(new Set(groupsOf().map((g) => g.key)).size).toBe(3);
    // The pass makes all three, the leaders-only one among them.
    expect(created).toEqual([["Red:team", "Blue:team", "Command:leads"]]);
    expect(groupsOf().every((g) => !!g.channelId)).toBe(true);
    // Tagging is on (the preset's default) and the event is running.
    expect(calls).toEqual(["create", "leads", "controls", "tags:sync"]);
    // One conditional write, only while the event has no groups and groups are off.
    expect(rowWrites()).toHaveLength(1);
    expect(rowWrites()[0].filter).toEqual({
      _id: EV,
      guildId: GUILD,
      state: { $in: ["scheduled", "active"] },
      groupsEnabled: { $ne: true },
      $or: [{ groups: { $exists: false } }, { groups: { $size: 0 } }],
    });
  });

  it("an event row from before groups (no groups field at all) can be switched on too", async () => {
    delete doc().groups;
    done(await switchOn({ on: true, setup: SETUP }));
    expect(groupsOf()).toHaveLength(3);
  });

  it("refuses a switch-on with no preset: there is nothing to create", async () => {
    expect(await switchOn()).toEqual({
      status: "invalid",
      errors: [
        "Groups: this event has no groups yet. Choose a preset to switch groups on with.",
      ],
    });
    expect(writes).toEqual([]);
  });

  it("refuses a preset with more groups than events.groups.max_count, and a group name used twice", async () => {
    maxGroups = 2;
    const tooMany = await switchOn({ on: true, setup: SETUP });
    expect(tooMany.status).toBe("invalid");
    expect(
      (tooMany as Extract<LiveEditOutcome, { status: "invalid" }>).errors[0],
    ).toContain("at most 2 groups");
    maxGroups = 15;
    const twice = await switchOn({
      on: true,
      setup: {
        ...SETUP,
        groups: [SETUP.groups[0], { ...SETUP.groups[1], name: "red" }],
      },
    });
    expect(twice.status).toBe("invalid");
    expect(writes).toEqual([]);
  });

  it("an unreadable group limit fails closed", async () => {
    maxGroups = null;
    expect((await switchOn({ on: true, setup: SETUP })).status).toBe("invalid");
    expect(writes).toEqual([]);
  });

  it("two posts of the same form build the groups once", async () => {
    await switchOn({ on: true, setup: SETUP });
    const keys = groupsOf().map((g) => g.key);
    const again = done(await switchOn({ on: true, setup: SETUP }));
    expect(again.alreadyApplied).toEqual(["groupsEnabled"]);
    expect(groupsOf().map((g) => g.key)).toEqual(keys);
  });

  it("two saves racing: the second finds groups already there and writes nothing", async () => {
    // The groups appear between this save's plan and its write.
    fake.beforeWrite = () => {
      if (rowWrites().length === 0 && writes.length === 1) {
        doc().groupsEnabled = true;
        doc().groups = seedGroups();
      }
    };
    const out = done(await switchOn({ on: true, setup: SETUP }));
    expect(out.applied).toEqual([]);
    expect(text(out)).toContain("changed by someone else");
    expect(groupsOf()).toHaveLength(2);
  });

  it("an existing Discord event KoolBot only reads never gets groups", async () => {
    seedPlain({ nativeAdopted: true });
    expect(await switchOn({ on: true, setup: SETUP })).toEqual({
      status: "invalid",
      errors: [
        "Groups: This is an existing Discord event KoolBot only reads, so it has no groups.",
      ],
    });
  });

  it("is refused while events are off, the event is over or being ended, like every row", async () => {
    enabled = false;
    expect((await switchOn({ on: true, setup: SETUP })).status).toBe("refused");
    enabled = true;
    seedPlain({ state: "ended" });
    expect((await switchOn({ on: true, setup: SETUP })).status).toBe("refused");
    seedPlain();
    ending = true;
    expect((await switchOn({ on: true, setup: SETUP })).status).toBe("refused");
    expect(writes).toEqual([]);
  });

  it("an end taking its hold between the plan and the write stops the write", async () => {
    let asked = 0;
    const d: LiveEditDeps = {
      ...deps,
      // Asked by the gate, the claim, the executor and then the row itself:
      // the 4th question is the row's, right before its write.
      isEnding: () => ++asked >= 4,
    };
    const out = done(
      await run(
        [entry(GROUPS_SWITCH_ROW_ID, { on: true, setup: SETUP }, OFF)],
        d,
      ),
    );
    expect(out.applied).toEqual([]);
    expect(text(out)).toBe(
      "Not saved: Groups could not be switched on because the event is being ended. Save again to retry.",
    );
    expect(rowWrites()).toEqual([]);
    expect(doc().groupsEnabled).toBe(false);
    expect(calls).toEqual([]);
  });

  it("audits the setup flat, group by group, within the audit bound", async () => {
    const outcome = done(await switchOn({ on: true, setup: SETUP }));
    const result = live.describeLiveEditOutcome(outcome);
    const audited = boundAuditEntry({
      action: "event.settings",
      details: result.details,
    } as never) as unknown as { details: Record<string, unknown> };
    expect(audited.details.changes).toEqual([
      {
        row: "groupsEnabled",
        from: { on: false },
        to: {
          on: true,
          preset: "builtin:red-vs-blue",
          tagging: "on",
          g1: "Red | team | no limit | tag R",
          g2: "Blue | team | size 5 | tag B",
          g3: "Command | leads | no limit | no tag",
        },
      },
    ]);
  });
});

describe("groups turned off", () => {
  it("asks for confirmation first, changing nothing and moving nobody", async () => {
    const first = await switchOff();
    expect(first.status).toBe("needs-confirmation");
    const out = first as Extract<
      LiveEditOutcome,
      { status: "needs-confirmation" }
    >;
    expect(out.reasons).toEqual([
      "Switching groups off: Alpha (2 assigned, with a voice channel); Bravo (nobody assigned, with a voice channel). Everybody in the 2 group channels, you included, is moved to the main channel first, and then the channels are deleted. The clan tags come off the nicknames. The groups and the 2 assignments are kept, but nobody counts as in a group while groups are off. Switching groups on again brings them back, with new channels. If somebody cannot be moved, nothing is deleted and groups stay on.",
    ]);
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(doc().groupsEnabled).toBe(true);
  });

  it("says so on the confirmation of a repeating event, and leaves the tags out when tagging is off", async () => {
    seed({ recurrence: "weekly", tagsEnabled: false });
    const first = (await switchOff()) as Extract<
      LiveEditOutcome,
      { status: "needs-confirmation" }
    >;
    expect(first.reasons[0]).toContain(
      "This event repeats, and the next one is made from the settings it has now, so it starts without groups too.",
    );
    expect(first.reasons[0]).not.toContain("clan tags");
  });

  it("returns everyone to main, deletes the channels, keeps the assignments, and puts the nicknames back only once the groups are off", async () => {
    const out = done(await offConfirmed());
    expect(out.applied.map((c) => c.rowId)).toEqual(["groupsEnabled"]);
    // Both channels emptied first (with the groups still on), then deleted.
    expect(calls).toEqual([
      `empty:${A}:c1`,
      `empty:${B}:c2`,
      "removeAll:",
      "tags:restore",
    ]);
    expect(atEmpty).toEqual([
      { key: A, groupsEnabled: true },
      { key: B, groupsEnabled: true },
    ]);
    expect(doc().groupsEnabled).toBe(false);
    expect(groupsOf().map((g) => g.channelId)).toEqual([null, null]);
    // Assignments are history: kept.
    expect(group(A).memberIds).toEqual(["u1", "u2"]);
    expect(group(A).captainId).toBe("u1");
    expect(groupsOf().map((g) => g.name)).toEqual(["Alpha", "Bravo"]);
    // The nicknames are asked to come back when the flag is already off, so
    // the tag module (which reads the stored state) restores them.
    expect(atRestore).toEqual([{ groupsEnabled: false }]);
    expect(text(out)).toBe("Saved: Groups is now off.");
  });

  it("hands the people just moved to the channel pass, so the cache lagging behind does not hold the channels", async () => {
    emptyResult = (key) => ({
      status: "empty",
      moved: key === A ? ["u1", "u2"] : ["u9"],
    });
    await offConfirmed();
    expect(calls).toContain("removeAll:u1+u2+u9");
  });

  it("an event whose channels do not exist yet is switched off without moving anybody", async () => {
    seed({ groups: seedGroups().map((g) => ({ ...g, channelId: null })) });
    done(await offConfirmed());
    expect(calls).toEqual(["removeAll:", "tags:restore"]);
    expect(doc().groupsEnabled).toBe(false);
  });

  describe("a person who cannot be moved", () => {
    it("keeps everything: nothing is deleted, the flag stays, the result names the group and why", async () => {
      emptyResult = (key) =>
        key === B
          ? {
              status: "occupied",
              moved: [],
              remaining: 2,
              detail: "2 missing permission",
            }
          : { status: "empty", moved: ["u1"] };
      const out = done(await offConfirmed());
      expect(out.applied).toEqual([]);
      expect(doc().groupsEnabled).toBe(true);
      expect(groupsOf().map((g) => g.channelId)).toEqual(["c1", "c2"]);
      // Every channel was tried (so everybody who can be moved is), none deleted.
      expect(calls).toEqual([`empty:${A}:c1`, `empty:${B}:c2`]);
      expect(text(out)).toBe(
        'Not saved: Groups could not be switched off: "Bravo": 2 people are still in its channel (2 missing permission). Nothing was deleted and the groups are still on. Save again to retry.',
      );
      expect(live.describeLiveEditOutcome(out).ok).toBe(false);
    });

    it("a refusal of the mover stops at once and says nobody was moved", async () => {
      emptyResult = () => ({
        status: "failed",
        reason: "a move is already running",
      });
      const out = done(await offConfirmed());
      expect(calls).toEqual([`empty:${A}:c1`]);
      expect(text(out)).toBe(
        'Not saved: Groups could not be switched off: "Alpha": nobody was moved (a move is already running). Nothing was deleted and the groups are still on. Save again to retry.',
      );
      expect(doc().groupsEnabled).toBe(true);
    });

    it("a re-save after the failure finishes the job once they are out (the first confirmation is spent)", async () => {
      emptyResult = () => ({
        status: "occupied",
        moved: [],
        remaining: 1,
        detail: "1 missing permission",
      });
      const first = (await switchOff()) as Extract<
        LiveEditOutcome,
        { status: "needs-confirmation" }
      >;
      const failed = done(await confirm(first));
      expect(failed.notApplied).toHaveLength(1);
      expect(doc().groupsEnabled).toBe(true);

      // The failed save still moved the revision on: the old page cannot be replayed.
      const replay = await confirm(first);
      expect(replay.status).toBe("stale");

      emptyResult = () => ({ status: "empty", moved: ["u1"] });
      calls.length = 0;
      const second = done(await offConfirmed());
      expect(second.applied).toHaveLength(1);
      expect(doc().groupsEnabled).toBe(false);
      expect(groupsOf().map((g) => g.channelId)).toEqual([null, null]);
      expect(calls).toEqual([
        `empty:${A}:c1`,
        `empty:${B}:c2`,
        "removeAll:u1",
        "tags:restore",
      ]);
    });

    it("never restores the nicknames of a switch-off that did not happen", async () => {
      emptyResult = () => ({
        status: "occupied",
        moved: [],
        remaining: 1,
        detail: "x",
      });
      await offConfirmed();
      expect(calls.some((c) => c.startsWith("tags"))).toBe(false);
    });
  });

  describe("the channels cannot all be deleted", () => {
    it("somebody joined: nothing deleted, the flag stays, the group is named", async () => {
      offResult = () => ({ status: "occupied", remaining: 1, groupKey: B });
      const out = done(await offConfirmed());
      expect(text(out)).toBe(
        'Not saved: Groups could not be switched off: 1 person is in the channel of "Bravo", so nothing was deleted and the groups are still on. Save again to retry.',
      );
      expect(doc().groupsEnabled).toBe(true);
      expect(calls.some((c) => c.startsWith("tags"))).toBe(false);
    });

    it("a delete failing halfway is reported with how many are gone, and a re-save finishes it", async () => {
      offResult = () => ({
        status: "failed",
        reason: "Discord is rate limiting",
        deleted: 1,
      });
      const out = done(await offConfirmed());
      expect(text(out)).toBe(
        "Not saved: Groups could not be switched off: Discord is rate limiting. 1 group channel was already deleted (KoolBot does not re-create it for ten minutes) but the groups are still on. Save again to retry.",
      );
      expect(doc().groupsEnabled).toBe(true);
      expect(calls.some((c) => c.startsWith("tags"))).toBe(false);

      offResult = null;
      calls.length = 0;
      done(await offConfirmed());
      expect(doc().groupsEnabled).toBe(false);
      expect(calls).toEqual([
        `empty:${A}:c1`,
        `empty:${B}:c2`,
        "removeAll:",
        "tags:restore",
      ]);
    });

    it("a failure with nothing deleted says so", async () => {
      offResult = () => ({
        status: "failed",
        reason: 'the channel of "Alpha" could not be checked',
        deleted: 0,
      });
      expect(text(done(await offConfirmed()))).toContain(
        'could not be switched off: the channel of "Alpha" could not be checked. Nothing was deleted and the groups are still on.',
      );
    });

    it("the server not being found is a failure that changes nothing", async () => {
      effects!.removeAllGroupChannels = async () => null;
      expect(text(done(await offConfirmed()))).toContain(
        "the server could not be reached, so nothing was deleted",
      );
      expect(doc().groupsEnabled).toBe(true);
    });

    it("the event changing under the switch is a lost write, never a success", async () => {
      offResult = () => ({ status: "lost" });
      const out = done(await offConfirmed());
      expect(out.applied).toEqual([]);
      expect(text(out)).toContain("changed by someone else");
    });
  });

  it("an end holding the event stops the switch before anybody is moved", async () => {
    const first = (await switchOff()) as Extract<
      LiveEditOutcome,
      { status: "needs-confirmation" }
    >;
    // The hold appears after the confirmed run planned: the row's own check
    // (asked before each outward call) sees it.
    let asked = 0;
    const d: LiveEditDeps = { ...deps, isEnding: () => ++asked >= 4 };
    const out = done(await confirm(first, d));
    expect(out.applied).toEqual([]);
    expect(calls).toEqual([]);
    expect(doc().groupsEnabled).toBe(true);
  });

  it("without the channel effects it stores nothing and says nobody could be moved", async () => {
    effects = undefined;
    const out = done(await offConfirmed({ ...deps, effects: undefined }));
    expect(text(out)).toBe(
      "Not saved: Groups could not be switched off: the people in the group channels could not be moved, so nothing was changed. Save again to retry.",
    );
    expect(doc().groupsEnabled).toBe(true);
  });

  it("posting the switch-off again after it went through is already applied, with no write and no second restore", async () => {
    await offConfirmed();
    const writesBefore = writes.length;
    calls.length = 0;
    const again = done(await switchOff());
    expect(again.alreadyApplied).toEqual(["groupsEnabled"]);
    expect(writes.length).toBe(writesBefore);
    expect(calls).toEqual([]);
  });

  it("a confirmation is bound to the groups it was shown for: an added group in between makes it stale", async () => {
    const first = (await switchOff()) as Extract<
      LiveEditOutcome,
      { status: "needs-confirmation" }
    >;
    const added = await run([
      entry(
        GROUP_ADD_ROW_ID,
        [{ key: NEW, name: "Delta", kind: "team", size: 4, tag: "D" }],
        [],
      ),
    ]);
    expect(added.status).toBe("done");
    expect(await confirm(first)).toEqual({
      status: "stale",
      message:
        "The settings changed since you reviewed them, so nothing was applied. Review the form again.",
    });
    expect(doc().groupsEnabled).toBe(true);
  });

  it("a token for another event, user or an expired one never applies", async () => {
    const first = (await switchOff()) as Extract<
      LiveEditOutcome,
      { status: "needs-confirmation" }
    >;
    const token = live.signConfirmation({
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
      changes: first.changes.map((c) => ({
        rowId: c.rowId,
        from: c.from,
        to: c.to,
      })),
      revision: first.revision,
    });
    expect(
      live.verifyConfirmation(token, {
        eventId: EV,
        guildId: GUILD,
        userId: "someone-else",
      }),
    ).toEqual({ ok: false, reason: "mismatch" });
    expect(
      live.verifyConfirmation(token, {
        eventId: EV,
        guildId: GUILD,
        userId: HOST,
        now: Date.now() + live.CONFIRM_TTL_MS + 1,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("is applied after the other rows of the same save (it is last)", async () => {
    const first = (await run([
      entry(GROUPS_SWITCH_ROW_ID, OFF, ON),
      entry("groupsLocked", true, false),
    ])) as Extract<LiveEditOutcome, { status: "needs-confirmation" }>;
    const out = done(await confirm(first));
    expect(out.applied.map((c) => c.rowId)).toEqual([
      "groupsLocked",
      "groupsEnabled",
    ]);
  });

  it("audits the switch-off as one entry with the from and to values", async () => {
    const outcome = done(await offConfirmed());
    const audited = boundAuditEntry({
      action: "event.settings",
      details: live.describeLiveEditOutcome(outcome).details,
    } as never) as unknown as { details: Record<string, unknown> };
    expect(audited.details).toMatchObject({
      outcome: "applied",
      changes: [
        { row: "groupsEnabled", from: { on: true }, to: { on: false } },
      ],
    });
  });
});

describe("what the switch does not do", () => {
  it("never writes a group's members, leader or channel itself", async () => {
    await offConfirmed();
    // The row's own writes: none at all (the fake pass cleared the channels).
    expect(rowWrites()).toEqual([]);
  });

  it("is a no-op for an unchanged form", async () => {
    const out = done(await run([entry(GROUPS_SWITCH_ROW_ID, ON, ON)]));
    expect(out.applied).toEqual([]);
    expect(out.partial).toEqual([]);
    expect(writes).toEqual([]);
  });
});
