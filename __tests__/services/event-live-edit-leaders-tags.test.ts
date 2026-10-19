import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Live edit of leaders, leader customisation, the leader label, clan tags, the
 * tag position and each team's tag (#1240): the rows of
 * `event-live-edit-leaders-tags.ts` through the REAL executor (both locks, the
 * fresh read, the claim, the one result), the REAL leader customiser (#1196) for
 * the in-flight form, and the REAL nickname tag logic (#1194, #1228) with a
 * fake Discord. The Event model is an in-memory stand-in that throws on any
 * shape the rows do not write; the real shapes are proven against MongoDB in
 * `__tests__/integration/event-live-edit-leaders-tags.integration.test.ts`.
 *
 * Expected values are literals, never computed by a copy of the logic under
 * test.
 */

import {
  lstore,
  lwrites,
  lfake,
  LEventMock,
  type Doc,
} from "./event-live-leaders-fake-event.js";
import { MemTagStore, FakeTagDiscord } from "./event-nickname-tags-fakes.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: LEventMock,
}));
jest.unstable_mockModule("../../src/models/event-nickname-backup.js", () => ({
  EventNicknameBackup: {},
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({
      getBoolean: async () => true,
      getString: async () => "guild-1",
    }),
  },
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

process.env.WEBUI_SESSION_SECRET = "leaders-tags-test-secret";

const live = await import("../../src/services/event-live-edit.js");
const rowsMod =
  await import("../../src/services/event-live-edit-leaders-tags.js");
const { createLiveEditEffects } =
  await import("../../src/services/event-live-edit-effects.js");
const tagsMod = await import("../../src/services/event-nickname-tags.js");
const { withEventMoveLock, resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");
const { withGroupLock } =
  await import("../../src/services/event-group-assignment.js");
const { customiseGroup, resetGroupCustomisation } =
  await import("../../src/services/event-leader-customise.js");
const { customiseRefusal } =
  await import("../../src/services/event-customise-rules.js");
const { leadsLeaderIds, planLeadsEviction } =
  await import("../../src/services/event-leads-access.js");
type LiveEditEffects =
  import("../../src/services/event-live-edit.js").LiveEditEffects;
type LiveEditDeps =
  import("../../src/services/event-live-edit.js").LiveEditDeps;
type IEvent = import("../../src/models/event.js").IEvent;

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const RED = "g_00000001";
const BLUE = "g_00000002";

function seed(over: Doc = {}, groupOver: Doc[] = []): Doc {
  const doc: Doc = {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    captainsEnabled: false,
    captainCustomisationEnabled: false,
    leaderLabel: "Leader",
    tagsEnabled: false,
    tagsSuffix: false,
    groups: [
      {
        key: RED,
        name: "Red",
        kind: "team",
        size: null,
        tag: "RED",
        marker: "",
        channelId: null,
        captainId: "alice",
        memberIds: ["alice"],
        ...(groupOver[0] ?? {}),
      },
      {
        key: BLUE,
        name: "Blue",
        kind: "team",
        size: null,
        tag: "BLUE",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: ["bob"],
        ...(groupOver[1] ?? {}),
      },
    ],
    ...over,
  };
  lstore.set(EV, doc);
  return doc;
}

const stored = (): Doc => lstore.get(EV) as Doc;
const groupOf = (key: string): Doc =>
  (stored().groups as Doc[]).find((g) => g.key === key) as Doc;

let ending = false;
let clock = 1_000_000_000_000;
let tagWork: Promise<void>[] = [];
let calls: string[] = [];
let effects: LiveEditEffects;
let discord: InstanceType<typeof FakeTagDiscord>;
let tagStore: InstanceType<typeof MemTagStore>;
let tagService: InstanceType<typeof tagsMod.EventNicknameTags>;

function deps(over: Partial<LiveEditDeps> = {}): LiveEditDeps {
  return {
    isEventsEnabled: async () => true,
    maxGroups: async () => 15,
    isEnding: () => ending,
    effects,
    ...over,
  };
}

type Entry = { rowId: string; to: unknown; base: unknown };
const flag = (rowId: string, to: boolean, base: boolean): Entry => ({
  rowId,
  to,
  base,
});
const save = (entries: Entry[], d: LiveEditDeps = deps()) =>
  live.runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps: d,
    submission: entries as never,
  });
type Done = Extract<
  Awaited<ReturnType<typeof live.runLiveEdit>>,
  { status: "done" }
>;
const done = (o: Awaited<ReturnType<typeof live.runLiveEdit>>): Done => {
  expect(o.status).toBe("done");
  return o as Done;
};
/** Wait for every nickname pass the saves started. */
const settleTags = async (): Promise<void> => {
  await Promise.all(tagWork);
  await tagService.sweep(GUILD);
};

beforeEach(() => {
  lstore.clear();
  lwrites.length = 0;
  lfake.beforeWrite = null;
  ending = false;
  clock = 1_000_000_000_000;
  calls = [];
  tagWork = [];
  resetMoveGuardForTests();
  discord = new FakeTagDiscord();
  discord.members.set("alice", { nickname: "Alice", displayName: "Alice" });
  discord.members.set("bob", { nickname: null, displayName: "Bob G" });
  tagStore = new MemTagStore(() => lstore.values());
  tagService = new tagsMod.EventNicknameTags({} as never, {
    store: tagStore,
    discord,
    eventsEnabled: async () => true,
    paceMs: 0,
    now: () => clock,
  });
  tagsMod.EventNicknameTags.setInstanceForTests(tagService);
  const real = createLiveEditEffects({} as never);
  effects = {
    syncLeadsAccess: jest.fn(async (_g: string, e: string) => {
      calls.push(`leads:${e}`);
    }),
    syncGroupControls: jest.fn(async (e: string) => {
      calls.push(`controls:${e}`);
    }),
    syncTags: (g, e, mode) => {
      calls.push(`tags:${mode}`);
      const work = real.syncTags(g, e, mode);
      tagWork.push(work);
      return work;
    },
  };
});

// ---------------------------------------------------------------------
// The registry and the form's reading of a team's tag
// ---------------------------------------------------------------------

describe("registration", () => {
  it("adds the six rows after the core rows, in this order", async () => {
    // The names, sizes and preset rows (#1241) are listed too; this is about
    // the order of the rows of this step.
    const groupRows = new Set(
      (
        await import("../../src/services/event-live-edit-groups.js")
      ).GROUP_EDIT_ROWS.map((r) => r.id),
    );
    expect(
      live.LIVE_EDIT_ROWS.map((r) => r.id).filter((id) => !groupRows.has(id)),
    ).toEqual([
      "channelLeadMinutes",
      "groupsLocked",
      "captainsEnabled",
      "captainCustomisationEnabled",
      "leaderLabel",
      "tagsEnabled",
      "tagsSuffix",
      "groupTags",
      // Removing and adding groups (#1242), then the groups switch (#1243).
      "groupRemove",
      "groupAdd",
      // The Captains lobby switch (#1251), then the groups switch (#1243).
      "captainsLobby",
      "groupsEnabled",
    ]);
  });
});

describe("parseSubmission with the per-team tag inputs", () => {
  it("collects one value and one base per team into the row's two texts", () => {
    const parsed = live.parseSubmission({
      [rowsMod.groupTagField(RED)]: "  SKY ",
      [rowsMod.groupTagBaseField(RED)]: "RED",
      [rowsMod.groupTagField(BLUE)]: "BLUE",
      [rowsMod.groupTagBaseField(BLUE)]: "BLUE",
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toEqual([
      {
        rowId: "groupTags",
        to: { [RED]: "SKY", [BLUE]: "BLUE" },
        base: { [RED]: "RED", [BLUE]: "BLUE" },
      },
    ]);
  });

  it("leaves the row untouched when no team input was posted", () => {
    expect(live.parseSubmission({ _csrf: "x" })).toEqual({
      entries: [],
      errors: [],
    });
  });

  it("refuses a team value that has no base (a form this page did not make)", () => {
    const parsed = live.parseSubmission({
      [rowsMod.groupTagField(RED)]: "SKY",
    });
    expect(parsed.entries).toEqual([]);
    expect(parsed.errors).toEqual([
      "Team tags: the form is out of date. Reload the page.",
    ]);
  });

  it("ignores an input whose name is not a group key and a repeated (array) value", () => {
    const parsed = live.parseSubmission({
      s_groupTags_nonsense: "X",
      [rowsMod.groupTagField(RED)]: ["A", "B"],
    });
    expect(parsed).toEqual({ entries: [], errors: [] });
  });
});

// ---------------------------------------------------------------------
// Leaders on and off
// ---------------------------------------------------------------------

describe("leaders on", () => {
  it("stores the switch with one conditional write and asks for the leads and controls passes once", async () => {
    seed();
    const out = done(await save([flag("captainsEnabled", true, false)]));
    expect(out.applied.map((c) => c.rowId)).toEqual(["captainsEnabled"]);
    expect(stored().captainsEnabled).toBe(true);
    expect(lwrites).toHaveLength(1);
    expect(lwrites[0].filter).toEqual({
      _id: EV,
      guildId: GUILD,
      state: { $in: ["scheduled", "active"] },
      groupsEnabled: true,
      captainsEnabled: { $ne: true },
    });
    expect(lwrites[0].update).toEqual({ $set: { captainsEnabled: true } });
    expect(calls).toEqual([`leads:${EV}`, `controls:${EV}`]);
  });

  it("makes the stored leader a leader again (hidden while off, back when on)", async () => {
    seed();
    expect(leadsLeaderIds(stored() as never)).toEqual([]);
    await save([flag("captainsEnabled", true, false)]);
    expect(leadsLeaderIds(stored() as never)).toEqual(["alice"]);
  });

  it("is idempotent: a second save of the same form writes nothing and runs no follow-up", async () => {
    seed();
    await save([flag("captainsEnabled", true, false)]);
    calls.length = 0;
    lwrites.length = 0;
    const out = done(await save([flag("captainsEnabled", true, false)]));
    expect(out.applied).toEqual([]);
    expect(out.alreadyApplied).toEqual(["captainsEnabled"]);
    expect(lwrites).toEqual([]);
    expect(calls).toEqual([]);
    expect(live.describeLiveEditOutcome(out).message).toBe(
      "Nothing to change: the event already has these settings.",
    );
  });

  it("is refused with a reason for an event without groups, and changes nothing", async () => {
    seed({ groupsEnabled: false, groups: [] });
    const out = await save([flag("captainsEnabled", true, false)]);
    expect(out).toEqual({
      status: "invalid",
      errors: ["Leaders: This event has no groups."],
    });
    expect(lwrites).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reports a lost write (someone switched it first) and runs no follow-up", async () => {
    seed();
    lfake.beforeWrite = () => {
      stored().captainsEnabled = true;
    };
    const out = done(await save([flag("captainsEnabled", true, false)]));
    expect(out.applied).toEqual([]);
    expect(out.notApplied).toEqual([
      {
        rowId: "captainsEnabled",
        label: "Leaders",
        reason:
          "was changed by someone else while this was being saved. Try again",
      },
    ]);
    expect(calls).toEqual([]);
  });

  it("leaves a change someone else made while the form was open alone (stale base)", async () => {
    seed({ captainsEnabled: true });
    // The form showed "off", somebody turned it on, the host also asks for on.
    const out = done(await save([flag("captainsEnabled", true, false)]));
    expect(out.alreadyApplied).toEqual(["captainsEnabled"]);
    expect(calls).toEqual([]);
  });
});

describe("leaders off", () => {
  it("removes leads access and controls at once and keeps the stored leader", async () => {
    seed({ captainsEnabled: true, captainCustomisationEnabled: true });
    expect(leadsLeaderIds(stored() as never)).toEqual(["alice"]);
    const out = done(await save([flag("captainsEnabled", false, true)]));
    expect(out.applied.map((c) => c.rowId)).toEqual(["captainsEnabled"]);
    expect(stored().captainsEnabled).toBe(false);
    // Kept, hidden everywhere: no leads access, and the leader's form is refused.
    expect(groupOf(RED).captainId).toBe("alice");
    expect(leadsLeaderIds(stored() as never)).toEqual([]);
    expect(
      customiseRefusal({
        event: stored() as never,
        eventsEnabled: true,
        groupKey: RED,
        actorId: "alice",
      }),
    ).toBe("leaders-off");
    expect(calls).toEqual([`leads:${EV}`, `controls:${EV}`]);
  });

  it("keeps the names and tags leaders chose", async () => {
    seed({ captainsEnabled: true, captainCustomisationEnabled: true }, [
      { name: "Reds", tag: "RDS", originalName: "Red", originalTag: "RED" },
    ]);
    await save([flag("captainsEnabled", false, true)]);
    expect(groupOf(RED)).toMatchObject({
      name: "Reds",
      tag: "RDS",
      originalName: "Red",
      originalTag: "RED",
    });
  });
});

describe("leaders off moves a connected ex-leader out of the leaders-only channel", () => {
  /** An event with a leads channel, Alice leading Red whose channel is c-red. */
  function seedWithLeadsChannel(over: Doc = {}): void {
    seed({ captainsEnabled: true, ...over }, [{ channelId: "c-red" }]);
    (stored().groups as Doc[]).push({
      key: "g_00000009",
      name: "Leaders",
      kind: "leads",
      channelId: "c-leads",
      captainId: null,
      memberIds: [],
    });
  }
  const connected = {
    ok: true,
    members: [
      { id: "alice", channelId: "c-leads" },
      { id: "bob", channelId: "c-blue" },
    ],
  };

  it("names the stored leaders as revoked, and the real eviction plan then moves them to their team channel", async () => {
    seedWithLeadsChannel();
    const seen: Array<readonly string[] | undefined> = [];
    effects.syncLeadsAccess = async (_g, _e, revoked): Promise<void> => {
      seen.push(revoked);
    };
    done(await save([flag("captainsEnabled", false, true)]));
    expect(seen).toEqual([["alice"]]);
    // The permission cache has not caught up with the overwrite change yet
    // (it still says Alice can connect): only the revoked list moves her.
    const plan = planLeadsEviction(stored() as never, connected, {
      revoked: new Set(seen[0]),
      isAdmin: () => false,
      canConnect: () => true,
    });
    expect(plan).toEqual([
      { userId: "alice", toChannelId: "c-red", fromChannelId: "c-leads" },
    ]);
    // Without the list, the stale cache leaves her where she is until a scan.
    expect(
      planLeadsEviction(stored() as never, connected, {
        revoked: new Set(),
        isAdmin: () => false,
        canConnect: () => true,
      }),
    ).toEqual([]);
  });

  it("names nobody when leaders are turned on (they gain access)", async () => {
    seedWithLeadsChannel({ captainsEnabled: false });
    const seen: Array<readonly string[] | undefined> = [];
    effects.syncLeadsAccess = async (_g, _e, revoked): Promise<void> => {
      seen.push(revoked);
    };
    done(await save([flag("captainsEnabled", true, false)]));
    expect(seen).toEqual([[]]);
  });

  it("the host and the stored data are untouched: only access and presence change", async () => {
    seedWithLeadsChannel();
    done(await save([flag("captainsEnabled", false, true)]));
    expect(groupOf(RED).captainId).toBe("alice");
    expect(groupOf(RED).memberIds).toEqual(["alice"]);
  });
});

describe("follow-ups run after both locks are released", () => {
  it("the leads pass can take the move lock and the group lock (it would be busy inside apply)", async () => {
    seed();
    let moveLock: { busy: boolean } | null = null;
    let groupLockRan = false;
    effects.syncLeadsAccess = async (): Promise<void> => {
      moveLock = await withEventMoveLock(EV, async () => "ran");
      await withGroupLock(GUILD, EV, async () => {
        groupLockRan = true;
      });
    };
    done(await save([flag("captainsEnabled", true, false)]));
    expect(moveLock).toMatchObject({ busy: false, value: "ran" });
    expect(groupLockRan).toBe(true);
  });

  it("a follow-up that throws is logged, never turns a stored save into a failure", async () => {
    seed();
    effects.syncGroupControls = async (): Promise<void> => {
      throw new Error("discord down");
    };
    const out = done(await save([flag("captainsEnabled", true, false)]));
    expect(out.applied.map((c) => c.rowId)).toEqual(["captainsEnabled"]);
    expect(stored().captainsEnabled).toBe(true);
    // The leads pass still ran although the controls pass threw after it.
    expect(calls).toEqual([`leads:${EV}`]);
  });

  it("without effects the save still stores and nothing else happens", async () => {
    seed();
    const out = done(
      await save(
        [flag("captainsEnabled", true, false)],
        deps({ effects: undefined }),
      ),
    );
    expect(out.applied).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("runs one pass per save for rows that share a follow-up (leaders and customisation together)", async () => {
    seed();
    const out = done(
      await save([
        flag("captainsEnabled", true, false),
        flag("captainCustomisationEnabled", true, false),
      ]),
    );
    expect(out.applied.map((c) => c.rowId)).toEqual([
      "captainsEnabled",
      "captainCustomisationEnabled",
    ]);
    expect(stored()).toMatchObject({
      captainsEnabled: true,
      captainCustomisationEnabled: true,
    });
    expect(calls).toEqual([`leads:${EV}`, `controls:${EV}`]);
  });
});

// ---------------------------------------------------------------------
// Leader customisation on and off
// ---------------------------------------------------------------------

describe("leader customisation", () => {
  it("on: stored, controls pass only (no leads pass)", async () => {
    seed({ captainsEnabled: true });
    done(await save([flag("captainCustomisationEnabled", true, false)]));
    expect(stored().captainCustomisationEnabled).toBe(true);
    expect(calls).toEqual([`controls:${EV}`]);
    expect(
      customiseRefusal({
        event: stored() as never,
        eventsEnabled: true,
        groupKey: RED,
        actorId: "alice",
      }),
    ).toBeNull();
  });

  it("can be stored while leaders are off and has no effect until they are on", async () => {
    seed();
    done(await save([flag("captainCustomisationEnabled", true, false)]));
    expect(stored().captainCustomisationEnabled).toBe(true);
    expect(
      customiseRefusal({
        event: stored() as never,
        eventsEnabled: true,
        groupKey: RED,
        actorId: "alice",
      }),
    ).toBe("leaders-off");
    done(await save([flag("captainsEnabled", true, false)]));
    expect(
      customiseRefusal({
        event: stored() as never,
        eventsEnabled: true,
        groupKey: RED,
        actorId: "alice",
      }),
    ).toBeNull();
  });

  it("off: the controls pass runs, chosen names and tags are kept", async () => {
    seed({ captainsEnabled: true, captainCustomisationEnabled: true }, [
      { name: "Reds", tag: "RDS", originalName: "Red", originalTag: "RED" },
    ]);
    done(await save([flag("captainCustomisationEnabled", false, true)]));
    expect(stored().captainCustomisationEnabled).toBe(false);
    expect(groupOf(RED)).toMatchObject({ name: "Reds", tag: "RDS" });
    expect(calls).toEqual([`controls:${EV}`]);
  });

  it("idempotent re-save", async () => {
    seed({ captainsEnabled: true, captainCustomisationEnabled: true });
    await save([flag("captainCustomisationEnabled", false, true)]);
    calls.length = 0;
    const out = done(
      await save([flag("captainCustomisationEnabled", false, true)]),
    );
    expect(out.alreadyApplied).toEqual(["captainCustomisationEnabled"]);
    expect(calls).toEqual([]);
  });
});

describe("a leader's form that is open while the host flips a switch", () => {
  const submit = (rawName: string | null, rawTag: string | null) =>
    customiseGroup(
      {
        guildId: GUILD,
        eventId: EV,
        groupKey: RED,
        actorId: "alice",
        channelId: null,
        rawName,
        rawTag,
      },
      {
        eventsEnabled: async () => true,
        syncName: async () => null,
        retag: jest.fn(),
      },
    );

  it("is refused once customisation was turned off, and nothing is written", async () => {
    seed({ captainsEnabled: true, captainCustomisationEnabled: true });
    // The leader opened the form; the host turns customisation off; the leader submits.
    done(await save([flag("captainCustomisationEnabled", false, true)]));
    const result = await submit("Crimson", "CRM");
    expect(result).toMatchObject({ ok: false, code: "customise-off" });
    expect(groupOf(RED)).toMatchObject({ name: "Red", tag: "RED" });
  });

  it("is refused once leaders were turned off", async () => {
    seed({ captainsEnabled: true, captainCustomisationEnabled: true });
    done(await save([flag("captainsEnabled", false, true)]));
    const result = await submit("Crimson", null);
    expect(result).toMatchObject({ ok: false, code: "leaders-off" });
    expect(groupOf(RED).name).toBe("Red");
  });

  it("a submit queued first is saved whole, then the flip keeps what it chose", async () => {
    seed({ captainsEnabled: true, captainCustomisationEnabled: true });
    const [result, outcome] = await Promise.all([
      submit("Crimson", "CRM"),
      save([flag("captainCustomisationEnabled", false, true)]),
    ]);
    expect(result).toMatchObject({ ok: true, changed: true });
    done(outcome);
    expect(stored().captainCustomisationEnabled).toBe(false);
    expect(groupOf(RED)).toMatchObject({ name: "Crimson", tag: "CRM" });
  });

  it("a flip that holds the locks refuses the submit queued behind it", async () => {
    seed({ captainsEnabled: true, captainCustomisationEnabled: true });
    let queued: ReturnType<typeof submit> | null = null;
    // The submit arrives while the save is inside its locks.
    const d = deps({
      isEventsEnabled: async () => {
        queued = submit("Crimson", "CRM");
        return true;
      },
    });
    done(await save([flag("captainCustomisationEnabled", false, true)], d));
    expect(await queued).toMatchObject({ ok: false, code: "customise-off" });
    expect(groupOf(RED).name).toBe("Red");
  });

  it("the host's reset still works after customisation was turned off (names and tags are kept until reset)", async () => {
    seed({ captainsEnabled: true, captainCustomisationEnabled: true }, [
      { name: "Crimson", tag: "CRM", originalName: "Red", originalTag: "RED" },
    ]);
    done(await save([flag("captainCustomisationEnabled", false, true)]));
    expect(groupOf(RED)).toMatchObject({ name: "Crimson", tag: "CRM" });
    const reset = await resetGroupCustomisation(
      { guildId: GUILD, eventId: EV, groupKey: RED },
      {
        eventsEnabled: async () => true,
        syncName: async () => null,
        retag: jest.fn(),
      },
    );
    expect(reset).toMatchObject({ ok: true });
    expect(groupOf(RED)).toMatchObject({ name: "Red", tag: "RED" });
  });
});

// ---------------------------------------------------------------------
// The leader label
// ---------------------------------------------------------------------

describe("leader label", () => {
  it("changes the label by one conditional write and runs no follow-up", async () => {
    seed();
    const out = done(
      await save([{ rowId: "leaderLabel", to: "Captain", base: "Leader" }]),
    );
    expect(out.applied).toHaveLength(1);
    expect(stored().leaderLabel).toBe("Captain");
    expect(lwrites[0].filter).toMatchObject({
      leaderLabel: { $in: ["Leader", "", null] },
    });
    expect(calls).toEqual([]);
  });

  it("can be set in the same save that turns leaders on", async () => {
    seed();
    done(
      await save([
        flag("captainsEnabled", true, false),
        { rowId: "leaderLabel", to: "Squad Lead", base: "Leader" },
      ]),
    );
    expect(stored()).toMatchObject({
      captainsEnabled: true,
      leaderLabel: "Squad Lead",
    });
  });

  it("treats a missing stored label as the default", async () => {
    const doc = seed();
    delete doc.leaderLabel;
    const out = done(
      await save([{ rowId: "leaderLabel", to: "Captain", base: "Leader" }]),
    );
    expect(out.applied).toHaveLength(1);
    expect(stored().leaderLabel).toBe("Captain");
  });

  it("refuses a label over the limit while parsing the form", () => {
    const parsed = live.parseSubmission({
      s_leaderLabel: "x".repeat(21),
      b_leaderLabel: "Leader",
    });
    expect(parsed.entries).toEqual([]);
    expect(parsed.errors).toEqual([
      "Leader label: at most 20 characters (got 21).",
    ]);
  });

  it("an empty label reads as the default", () => {
    const parsed = live.parseSubmission({
      s_leaderLabel: "  ",
      b_leaderLabel: "Captain",
    });
    expect(parsed.entries).toEqual([
      { rowId: "leaderLabel", to: "Leader", base: "Captain" },
    ]);
  });
});

// ---------------------------------------------------------------------
// Clan tags, through the real tag logic
// ---------------------------------------------------------------------

describe("tagging on", () => {
  it("backs up the originals, then tags from them (never from the current nickname)", async () => {
    seed();
    const out = done(await save([flag("tagsEnabled", true, false)]));
    expect(out.applied.map((c) => c.rowId)).toEqual(["tagsEnabled"]);
    expect(calls).toEqual(["tags:sync"]);
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(discord.members.get("bob")?.nickname).toBe("[BLUE] Bob G");
    // The originals are backed up: a nickname Alice had, and none for Bob.
    expect(tagStore.rows.get("alice")).toMatchObject({
      original: "Alice",
      base: "Alice",
      intended: "[RED] Alice",
      confirmedTarget: "[RED] Alice",
    });
    expect(tagStore.rows.get("bob")).toMatchObject({
      original: null,
      base: "Bob G",
    });
  });

  it("returns before the nicknames are done (no lock is held while they are paced)", async () => {
    seed();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = discord.setNickname.bind(discord);
    discord.setNickname = async (g, u, n) => {
      await gate;
      return original(g, u, n);
    };
    const out = done(await save([flag("tagsEnabled", true, false)]));
    expect(out.applied).toHaveLength(1);
    // The save has answered; nothing was edited yet and the locks are free.
    expect(discord.edits).toEqual([]);
    const lock = await withEventMoveLock(EV, async () => "free");
    expect(lock).toMatchObject({ busy: false, value: "free" });
    release();
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
  });

  it("idempotent re-save: no second pass, no second edit", async () => {
    seed();
    await save([flag("tagsEnabled", true, false)]);
    await settleTags();
    const edits = discord.edits.length;
    calls.length = 0;
    const out = done(await save([flag("tagsEnabled", true, false)]));
    expect(out.alreadyApplied).toEqual(["tagsEnabled"]);
    expect(calls).toEqual([]);
    expect(discord.edits).toHaveLength(edits);
  });

  it("does nothing to nicknames of a scheduled event (the tag logic tags only an active one)", async () => {
    seed({ state: "scheduled" });
    done(await save([flag("tagsEnabled", true, false)]));
    await settleTags();
    expect(discord.edits).toEqual([]);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });
});

describe("tagging off", () => {
  it("restores the original nicknames now and drops the backups", async () => {
    seed({ tagsEnabled: true });
    await tagService.syncEvent(GUILD, EV);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    const out = done(await save([flag("tagsEnabled", false, true)]));
    expect(out.applied).toHaveLength(1);
    expect(calls).toEqual(["tags:restore"]);
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(discord.members.get("bob")?.nickname).toBeNull();
    expect([...tagStore.rows.keys()]).toEqual([]);
  });

  it("on again after off tags from the original, never twice", async () => {
    seed({ tagsEnabled: true });
    await tagService.syncEvent(GUILD, EV);
    await save([flag("tagsEnabled", false, true)]);
    await settleTags();
    await save([flag("tagsEnabled", true, false)]);
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
  });
});

describe("tag position", () => {
  it("re-tags from the stored original with the tag after the name", async () => {
    seed({ tagsEnabled: true });
    await tagService.syncEvent(GUILD, EV);
    done(await save([flag("tagsSuffix", true, false)]));
    expect(calls).toEqual(["tags:sync"]);
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("Alice [RED]");
    expect(tagStore.rows.get("alice")?.original).toBe("Alice");
    done(await save([flag("tagsSuffix", false, true)]));
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
  });
});

describe("tag changed", () => {
  const tagEntry = (
    to: Record<string, string>,
    base: Record<string, string>,
  ): Entry => ({
    rowId: "groupTags",
    to,
    base,
  });

  it("re-tags from the stored original: [SKY] Alice, never [SKY] [RED] Alice", async () => {
    seed({ tagsEnabled: true });
    await tagService.syncEvent(GUILD, EV);
    const out = done(
      await save([
        tagEntry(
          { [RED]: "SKY", [BLUE]: "BLUE" },
          { [RED]: "RED", [BLUE]: "BLUE" },
        ),
      ]),
    );
    expect(out.applied.map((c) => c.rowId)).toEqual(["groupTags"]);
    expect(groupOf(RED).tag).toBe("SKY");
    expect(groupOf(BLUE).tag).toBe("BLUE");
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("[SKY] Alice");
    expect(discord.members.get("bob")?.nickname).toBe("[BLUE] Bob G");
    expect(tagStore.rows.get("alice")?.original).toBe("Alice");
  });

  it("changing it back and forth never stacks tags", async () => {
    seed({ tagsEnabled: true });
    await tagService.syncEvent(GUILD, EV);
    const both = (r: string): Record<string, string> => ({
      [RED]: r,
      [BLUE]: "BLUE",
    });
    await save([tagEntry(both("A1"), both("RED"))]);
    await settleTags();
    await save([tagEntry(both("B2"), both("A1"))]);
    await settleTags();
    await save([tagEntry(both("RED"), both("B2"))]);
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
  });

  it("an emptied tag takes the tag off that team's members only", async () => {
    seed({ tagsEnabled: true });
    await tagService.syncEvent(GUILD, EV);
    done(
      await save([
        tagEntry(
          { [RED]: "", [BLUE]: "BLUE" },
          { [RED]: "RED", [BLUE]: "BLUE" },
        ),
      ]),
    );
    await settleTags();
    expect(groupOf(RED).tag).toBe("");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(discord.members.get("bob")?.nickname).toBe("[BLUE] Bob G");
  });

  it("a tag set on a team that had none tags its members from their originals", async () => {
    seed({ tagsEnabled: true }, [{ tag: "" }]);
    await tagService.syncEvent(GUILD, EV);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    done(
      await save([
        tagEntry(
          { [RED]: "NEW", [BLUE]: "BLUE" },
          { [RED]: "", [BLUE]: "BLUE" },
        ),
      ]),
    );
    expect(lwrites[0].filter).toMatchObject({
      $and: [
        {
          groups: {
            $elemMatch: { key: RED, kind: "team", tag: { $in: ["", null] } },
          },
        },
      ],
    });
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("[NEW] Alice");
  });

  it("does not touch nicknames while tagging is off (the pass finds nothing owed)", async () => {
    seed({ tagsEnabled: false });
    done(
      await save([
        tagEntry(
          { [RED]: "SKY", [BLUE]: "BLUE" },
          { [RED]: "RED", [BLUE]: "BLUE" },
        ),
      ]),
    );
    expect(calls).toEqual(["tags:restore"]);
    await settleTags();
    expect(discord.edits).toEqual([]);
    expect(groupOf(RED).tag).toBe("SKY");
  });

  it("writes only the tags that changed, by key, and keeps everything else of the group", async () => {
    seed();
    done(
      await save([
        tagEntry(
          { [RED]: "SKY", [BLUE]: "BLUE" },
          { [RED]: "RED", [BLUE]: "BLUE" },
        ),
      ]),
    );
    expect(lwrites).toHaveLength(1);
    expect(lwrites[0].update).toEqual({ $set: { "groups.$[g0].tag": "SKY" } });
    expect(lwrites[0].options).toEqual({ arrayFilters: [{ "g0.key": RED }] });
    expect(groupOf(RED)).toMatchObject({
      name: "Red",
      captainId: "alice",
      memberIds: ["alice"],
    });
  });

  it("is all or nothing: one team changed meanwhile means no tag of the save is written", async () => {
    seed();
    lfake.beforeWrite = () => {
      groupOf(BLUE).tag = "NAVY";
    };
    const out = done(
      await save([
        tagEntry(
          { [RED]: "SKY", [BLUE]: "ICE" },
          { [RED]: "RED", [BLUE]: "BLUE" },
        ),
      ]),
    );
    expect(out.applied).toEqual([]);
    expect(out.notApplied.map((n) => n.rowId)).toEqual(["groupTags"]);
    expect(groupOf(RED).tag).toBe("RED");
    expect(groupOf(BLUE).tag).toBe("NAVY");
    expect(calls).toEqual([]);
  });

  it("a stale form (the tag changed since it was shown) is a conflict, not a write", async () => {
    seed();
    groupOf(RED).tag = "NAVY";
    const out = done(
      await save([
        tagEntry(
          { [RED]: "SKY", [BLUE]: "BLUE" },
          { [RED]: "RED", [BLUE]: "BLUE" },
        ),
      ]),
    );
    expect(out.applied).toEqual([]);
    expect(out.notApplied[0]).toMatchObject({ rowId: "groupTags" });
    expect(out.notApplied[0].reason).toContain(
      "was changed by someone else while you were editing",
    );
    expect(groupOf(RED).tag).toBe("NAVY");
  });

  it("idempotent re-save", async () => {
    seed({ tagsEnabled: true });
    const e = tagEntry(
      { [RED]: "SKY", [BLUE]: "BLUE" },
      { [RED]: "RED", [BLUE]: "BLUE" },
    );
    await save([e]);
    await settleTags();
    calls.length = 0;
    lwrites.length = 0;
    const out = done(await save([e]));
    expect(out.alreadyApplied).toEqual(["groupTags"]);
    expect(lwrites).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses a tag over the limit, naming the team, and writes nothing", async () => {
    seed();
    const out = await save([
      tagEntry(
        { [RED]: "TOOLONGTAG", [BLUE]: "BLUE" },
        { [RED]: "RED", [BLUE]: "BLUE" },
      ),
    ]);
    expect(out).toMatchObject({ status: "invalid" });
    expect((out as { errors: string[] }).errors[0]).toMatch(
      /^Team tags: Red: at most 8 characters/,
    );
    expect(lwrites).toEqual([]);
  });

  it("refuses a form whose teams are not the event's teams", async () => {
    seed();
    const out = await save([tagEntry({ [RED]: "SKY" }, { [RED]: "RED" })]);
    // Base lacks BLUE: the stored map differs from the base, so this is a conflict.
    expect(done(out).notApplied[0]).toMatchObject({ rowId: "groupTags" });
    expect(lwrites).toEqual([]);
  });

  it("a team the host's change makes customised keeps the host's tag as its original", async () => {
    seed({ tagsEnabled: true }, [
      { name: "Reds", tag: "RDS", originalName: "Red", originalTag: "RED" },
    ]);
    done(
      await save([
        tagEntry(
          { [RED]: "SKY", [BLUE]: "BLUE" },
          { [RED]: "RDS", [BLUE]: "BLUE" },
        ),
      ]),
    );
    expect(groupOf(RED)).toMatchObject({
      name: "Reds",
      tag: "SKY",
      originalName: "Red",
      originalTag: "SKY",
    });
    expect(lwrites[0].update).toEqual({
      $set: { "groups.$[g0].tag": "SKY", "groups.$[g0].originalTag": "SKY" },
    });
  });

  it("a team nobody customised gets no originalTag", async () => {
    seed();
    done(
      await save([
        tagEntry(
          { [RED]: "SKY", [BLUE]: "BLUE" },
          { [RED]: "RED", [BLUE]: "BLUE" },
        ),
      ]),
    );
    expect("originalTag" in groupOf(RED)).toBe(false);
  });

  it("leaves non-team groups out of the map and the write", async () => {
    seed({}, []);
    (stored().groups as Doc[]).push({
      key: "g_00000003",
      name: "Open",
      kind: "open",
      tag: "",
      memberIds: [],
    });
    const row = live.LIVE_EDIT_ROWS.find((r) => r.id === "groupTags");
    expect(row?.read(stored() as unknown as IEvent)).toEqual({
      [RED]: "RED",
      [BLUE]: "BLUE",
    });
  });
});

describe("a tag change inside the settle window of an unconfirmed edit", () => {
  it("keeps the row, edits nothing more until the outcome has settled, then re-tags once from the original", async () => {
    seed({ tagsEnabled: true });
    // Alice's first edit lands at Discord but the answer is lost: unresolved.
    discord.loseNext.add("alice");
    await tagService.syncEvent(GUILD, EV);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(tagStore.rows.get("alice")?.confirmedTarget).toBeNull();
    const editsBefore = discord.edits.filter(
      (e) => e.userId === "alice",
    ).length;

    const both = (r: string): Record<string, string> => ({
      [RED]: r,
      [BLUE]: "BLUE",
    });
    done(
      await save([{ rowId: "groupTags", to: both("SKY"), base: both("RED") }]),
    );
    await settleTags();
    // Inside the window nothing is edited and nothing is dropped.
    expect(discord.edits.filter((e) => e.userId === "alice")).toHaveLength(
      editsBefore,
    );
    expect(tagStore.rows.get("alice")?.original).toBe("Alice");

    // After the window the sweep resolves the row and re-tags from the original.
    clock += tagsMod.OUTCOME_SETTLE_MS + 1;
    await tagService.sweep(GUILD);
    expect(discord.members.get("alice")?.nickname).toBe("[SKY] Alice");
    expect(tagStore.rows.get("alice")).toMatchObject({
      original: "Alice",
      confirmedTarget: "[SKY] Alice",
    });
  });
});

describe("one save, several rows, one nickname pass", () => {
  it("tags on, a new tag and the suffix together start one pass and end tagged right", async () => {
    seed();
    const out = done(
      await save([
        flag("tagsEnabled", true, false),
        flag("tagsSuffix", true, false),
        {
          rowId: "groupTags",
          to: { [RED]: "SKY", [BLUE]: "BLUE" },
          base: { [RED]: "RED", [BLUE]: "BLUE" },
        },
      ]),
    );
    expect(out.applied.map((c) => c.rowId)).toEqual([
      "tagsEnabled",
      "tagsSuffix",
      "groupTags",
    ]);
    expect(calls).toEqual(["tags:sync"]);
    await settleTags();
    expect(discord.members.get("alice")?.nickname).toBe("Alice [SKY]");
  });
});

describe("the gates of the core still apply", () => {
  it("events off: nothing is written and no follow-up runs", async () => {
    seed();
    const out = await save(
      [flag("captainsEnabled", true, false)],
      deps({ isEventsEnabled: async () => false }),
    );
    expect(out).toMatchObject({ status: "refused", code: "events-off" });
    expect(lwrites).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an event being ended is refused before the write", async () => {
    seed();
    ending = true;
    const out = await save([flag("tagsEnabled", true, false)]);
    expect(out).toMatchObject({ status: "refused", code: "ending" });
    expect(lwrites).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an ended event can no longer be edited", async () => {
    seed({ state: "ended" });
    const out = await save([flag("tagsEnabled", true, false)]);
    expect(out).toMatchObject({ status: "refused", code: "not-open" });
  });

  it("a save that stores a row counts one revision (a single claim)", async () => {
    seed();
    await save([
      flag("captainsEnabled", true, false),
      flag("tagsEnabled", true, false),
    ]);
    expect(stored().liveEditRevision).toBe(1);
  });
});
