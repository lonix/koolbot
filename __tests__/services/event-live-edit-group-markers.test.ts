import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Live edit of the group markers (#1406 item 3): the `groupMarkers` row of
 * `event-live-edit-groups.ts` runs through the REAL core against the in-memory
 * Event stand-in, with the channel effects replaced by fakes. The marker is part
 * of the voice channel's name, so a change is a stored value plus a channel
 * rename, finished like a name edit. Expected values are literals.
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
  () => ({ TrackingOptOutService: { getInstance: () => ({}) } }),
);

process.env.WEBUI_SESSION_SECRET = "live-edit-markers-test-secret";

const {
  LIVE_EDIT_ROWS,
  runLiveEdit,
  parseSubmission,
  describeLiveEditOutcome,
} = await import("../../src/services/event-live-edit.js");
type LiveEditDeps =
  import("../../src/services/event-live-edit.js").LiveEditDeps;
type LiveEditOutcome =
  import("../../src/services/event-live-edit.js").LiveEditOutcome;
type LiveEditEffects =
  import("../../src/services/event-live-edit.js").LiveEditEffects;
type NameSyncOutcome =
  import("../../src/services/event-group-channels.js").NameSyncOutcome;
const {
  GROUP_MARKERS_ROW_ID,
  groupMarkerField,
  groupMarkerBaseField,
  groupNameRowId,
} = await import("../../src/services/event-live-edit-groups.js");
const { makeEffects } =
  await import("./event-live-edit-groups-effects-fake.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const A = "g_00000001";
const B = "g_00000002";
const C = "g_00000003";

function seed(over: Json = {}): Json {
  const mk = (
    key: string,
    name: string,
    marker: string,
    channelId: string | null,
    kind = "team",
  ): Json => ({
    key,
    name,
    kind,
    size: null,
    tag: "",
    marker,
    channelId,
    captainId: null,
    memberIds: [],
  });
  const doc: Json = {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    presetId: null,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    channelId: "c-main",
    tagsEnabled: false,
    groups: [
      mk(A, "Alpha", "🔴", "c1"),
      mk(B, "Bravo", "", "c2"),
      mk(C, "Charlie", "", null, "open"),
    ],
    ...over,
  };
  store.set(EV, doc);
  return doc;
}

const groupsOf = (): Json[] => store.get(EV)?.groups as Json[];
const group = (key: string): Json =>
  groupsOf().find((g) => g.key === key) as Json;
const rowWrites = (): typeof writes =>
  writes.filter((w) => !("$inc" in w.update));

let ending = false;
let effects: LiveEditEffects | undefined;
const deps: LiveEditDeps = {
  isEventsEnabled: async () => true,
  maxGroups: async () => 15,
  isEnding: () => ending,
  get effects(): LiveEditEffects | undefined {
    return effects;
  },
};
const calls: string[] = [];
let nameResult: (key: string) => NameSyncOutcome | null = (key) => ({
  groupKey: key,
  status: "applied",
});

beforeEach(() => {
  store.clear();
  writes.length = 0;
  calls.length = 0;
  fake.beforeWrite = null;
  fake.afterFind = null;
  ending = false;
  nameResult = (key) => ({ groupKey: key, status: "applied" });
  resetMoveGuardForTests();
  seed();
  effects = makeEffects({
    async syncGroupName(_g, _e, key) {
      calls.push(`name:${key}`);
      const out = nameResult(key);
      if (out?.status === "applied") delete group(key).nameSyncPending;
      return out;
    },
    async syncGroupUserLimit() {
      return null;
    },
  });
});

type Map = Record<string, string>;
const entry = (to: Map, base: Map) => ({
  rowId: GROUP_MARKERS_ROW_ID,
  to,
  base,
});
const STORED: Map = { [A]: "🔴", [B]: "", [C]: "" };
const run = (
  entries: Array<{ rowId: string; to: unknown; base: unknown }>,
): Promise<LiveEditOutcome> =>
  runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps,
    submission: entries as never,
  });
type Done = Extract<LiveEditOutcome, { status: "done" }>;
const done = (o: LiveEditOutcome): Done => {
  expect(o.status).toBe("done");
  return o as Done;
};
const text = (o: LiveEditOutcome): string => describeLiveEditOutcome(o).message;

describe("the marker row is part of the core's registry", () => {
  it("is listed once, with a letters-only id, and the form fields are per group key", () => {
    expect(GROUP_MARKERS_ROW_ID).toBe("groupMarkers");
    expect(LIVE_EDIT_ROWS.filter((r) => r.id === "groupMarkers")).toHaveLength(
      1,
    );
    expect(groupMarkerField(A)).toBe("s_groupMarkers_g_00000001");
    expect(groupMarkerBaseField(A)).toBe("b_groupMarkers_g_00000001");
  });
});

describe("parsing the posted form", () => {
  it("reads one value and one shown value per group key, normalised", () => {
    const parsed = parseSubmission({
      [groupMarkerField(A)]: "  🔵 ",
      [groupMarkerBaseField(A)]: "🔴",
      [groupMarkerField(B)]: "",
      [groupMarkerBaseField(B)]: "",
    });
    expect(parsed.entries).toEqual([
      {
        rowId: GROUP_MARKERS_ROW_ID,
        to: { [A]: "🔵", [B]: "" },
        base: { [A]: "🔴", [B]: "" },
      },
    ]);
  });

  it("a form without marker fields leaves the row alone", () => {
    const parsed = parseSubmission({
      [`s_${groupNameRowId(0)}`]: "Apex",
      [`b_${groupNameRowId(0)}`]: "Alpha",
    });
    expect(parsed.entries.map((e) => e.rowId)).toEqual([groupNameRowId(0)]);
  });

  it("a marker without its shown value is an out-of-date form, never a change from empty", () => {
    const parsed = parseSubmission({ [groupMarkerField(A)]: "🔵" });
    expect(parsed.errors.join(" ")).toContain("Reload the page");
    expect(parsed.entries).toEqual([]);
  });

  it("ignores a field whose key is not a group key", () => {
    const parsed = parseSubmission({
      s_groupMarkers_evil: "x",
      b_groupMarkers_evil: "",
    });
    expect(parsed.entries).toEqual([]);
  });
});

describe("change a marker", () => {
  it("writes only the changed group, with the marker and a pending rename in one conditional write, then renames the channel", async () => {
    const out = await run([entry({ [A]: "🔴", [B]: "🔵", [C]: "" }, STORED)]);
    expect(done(out).applied.map((c) => c.rowId)).toEqual(["groupMarkers"]);
    expect(group(B).marker).toBe("🔵");
    expect(group(A).marker).toBe("🔴");
    expect(calls).toEqual([`name:${B}`]);
    const [write] = rowWrites();
    expect(write.update).toEqual({
      $set: {
        "groups.$[g0].marker": "🔵",
        "groups.$[g0].nameSyncPending": true,
      },
    });
    expect(write.options).toEqual({ arrayFilters: [{ "g0.key": B }] });
    expect(write.filter).toMatchObject({
      guildId: GUILD,
      state: { $in: ["scheduled", "active"] },
      groupsEnabled: true,
      $and: [
        {
          groups: {
            $elemMatch: { key: B, marker: { $in: ["", null] } },
          },
        },
      ],
    });
    expect(text(out)).toContain("Saved");
  });

  it("clears a marker (empty) and changes an open group's marker too", async () => {
    await run([entry({ [A]: "", [B]: "", [C]: "⭐" }, STORED)]);
    expect(group(A).marker).toBe("");
    expect(group(C).marker).toBe("⭐");
    // The open group has no channel yet: left to the channel pass.
    expect(calls).toEqual([`name:${A}`]);
    expect(group(C).nameSyncPending).toBe(true);
  });

  it("is addressed by group key, not position: a reorder never moves a marker to another group", async () => {
    const groups = groupsOf();
    store.get(EV)!.groups = [groups[1], groups[0], groups[2]];
    await run([entry({ [A]: "🟢", [B]: "", [C]: "" }, STORED)]);
    expect(group(A).marker).toBe("🟢");
    expect(group(B).marker).toBe("");
  });

  it("an unchanged form writes nothing", async () => {
    const out = await run([entry(STORED, STORED)]);
    expect(rowWrites()).toEqual([]);
    expect(done(out).applied).toEqual([]);
  });

  it("saving the same change again is already applied", async () => {
    const to = { [A]: "🔴", [B]: "🔵", [C]: "" };
    await run([entry(to, STORED)]);
    const again = await run([entry(to, STORED)]);
    expect(done(again).alreadyApplied).toEqual(["groupMarkers"]);
    expect(calls).toEqual([`name:${B}`]);
  });
});

describe("the shared checks", () => {
  it("refuses a marker over the limit and control characters, naming the group, and writes nothing", async () => {
    const tooLong = await run([
      entry({ [A]: "abcde", [B]: "", [C]: "" }, STORED),
    ]);
    expect(text(tooLong)).toContain("Alpha");
    expect(text(tooLong)).toContain("at most");
    const control = await run([
      entry({ [A]: "🔴", [B]: "\u0001", [C]: "" }, STORED),
    ]);
    expect(text(control)).toContain("Bravo");
    expect(text(control)).toContain("control characters");
    expect(rowWrites()).toEqual([]);
  });
});

describe("the stale guard", () => {
  it("a marker changed by someone else meanwhile is a conflict, not overwritten", async () => {
    group(A).marker = "🟣";
    const out = await run([entry({ [A]: "🔵", [B]: "", [C]: "" }, STORED)]);
    expect(done(out).notApplied[0]).toMatchObject({ rowId: "groupMarkers" });
    expect(text(out)).toContain("was changed by someone else");
    expect(group(A).marker).toBe("🟣");
  });

  it("a group removed since the form was shown is a conflict for the whole row (the shown values no longer match): nothing is saved", async () => {
    store.get(EV)!.groups = groupsOf().filter((g) => g.key !== C);
    const removed = await run([
      entry({ [A]: "🔴", [B]: "🔵", [C]: "" }, STORED),
    ]);
    expect(done(removed).notApplied[0]).toMatchObject({
      rowId: "groupMarkers",
    });
    expect(text(removed)).toContain("was changed by someone else");
    expect(group(B).marker).toBe("");
    expect(rowWrites()).toEqual([]);
  });

  it("an event whose groups are off cannot be edited", async () => {
    store.get(EV)!.groupsEnabled = false;
    const out = await run([entry({ [A]: "🔵", [B]: "", [C]: "" }, STORED)]);
    expect(rowWrites()).toEqual([]);
    expect(text(out)).toContain("no groups");
  });

  it("the write is conditional: a marker that changed between the plan and the write is lost, never reported as saved", async () => {
    fake.beforeWrite = (): void => {
      if (!writes.some((w) => "$inc" in w.update)) return;
      fake.beforeWrite = null;
      group(B).marker = "🟤";
    };
    const out = await run([entry({ [A]: "🔴", [B]: "🔵", [C]: "" }, STORED)]);
    expect(done(out).applied).toEqual([]);
    expect(group(B).marker).toBe("🟤");
    expect(calls).toEqual([]);
  });
});

describe("the channel follows", () => {
  it("a rate limit: the marker is saved, the result says when the channel follows, and the pending marker stays", async () => {
    nameResult = (key) => ({
      groupKey: key,
      status: "limited",
      retryAfterMs: 5 * 60_000,
    });
    const out = await run([entry({ [A]: "🔵", [B]: "", [C]: "" }, STORED)]);
    expect(done(out).partial).toHaveLength(1);
    expect(group(A).marker).toBe("🔵");
    expect(group(A).nameSyncPending).toBe(true);
    expect(text(out)).toContain("renamed in");
  });

  it("without effects wired the marker is saved and the channel is owed", async () => {
    effects = undefined;
    const out = await run([entry({ [A]: "🔵", [B]: "", [C]: "" }, STORED)]);
    expect(group(A).marker).toBe("🔵");
    expect(done(out).partial).toHaveLength(1);
  });

  it("an event that is being ended is refused: nothing saved, Discord not called", async () => {
    ending = true;
    const out = await run([entry({ [A]: "🔵", [B]: "", [C]: "" }, STORED)]);
    expect(out.status).toBe("refused");
    expect(group(A).marker).toBe("🔴");
    expect(calls).toEqual([]);
  });

  it("a marker and a name changed in one save are one rename each, both saved", async () => {
    const out = await run([
      {
        rowId: groupNameRowId(0),
        to: "Apex",
        base: "Alpha",
      },
      entry({ [A]: "🔵", [B]: "", [C]: "" }, STORED),
    ]);
    expect(done(out).applied.map((c) => c.rowId)).toEqual([
      groupNameRowId(0),
      "groupMarkers",
    ]);
    expect(group(A)).toMatchObject({ name: "Apex", marker: "🔵" });
  });
});
