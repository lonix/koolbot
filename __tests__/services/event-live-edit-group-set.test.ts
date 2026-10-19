import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterAll,
} from "@jest/globals";

/**
 * Live edit that adds and removes groups of a running event (#1242): the rows
 * of `event-live-edit-group-set.ts` run through the REAL core (planner,
 * executor, both locks, confirmation round trip, result text, audit bound)
 * against the in-memory Event stand-in of
 * `event-live-edit-groups-fake-event.ts`, with the channel effects replaced by
 * fakes that behave like the real passes (the removal pulls the group, as
 * `EventGroupChannels.removeGroup` does). The stand-in throws on any filter or
 * update shape the rows do not use; the real shapes are proven against MongoDB
 * in `__tests__/integration/event-live-edit-group-set.integration.test.ts`.
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

process.env.WEBUI_SESSION_SECRET = "live-edit-group-set-test-secret";

const live = await import("../../src/services/event-live-edit.js");
const {
  groupAddRow,
  groupRemoveRow,
  groupSetRows,
  GROUP_ADD_ROW_ID,
  GROUP_REMOVE_ROW_ID,
  GROUP_ADD_FIELDS,
  GROUP_REMOVE_BASE_FIELD,
  groupRemoveField,
} = await import("../../src/services/event-live-edit-group-set.js");
const { groupSizeRowId, groupSizeKeyField, groupNameRowId } =
  await import("../../src/services/event-live-edit-groups.js");
const { makeEffects } =
  await import("./event-live-edit-groups-effects-fake.js");
const { resetMoveGuardForTests, withEventMoveLock } =
  await import("../../src/services/event-move-guard.js");
const { onGroupAssignmentChange, assignMember } =
  await import("../../src/services/event-group-assignment.js");
const { onLeaderChange } =
  await import("../../src/services/event-group-leaders.js");
const { boundAuditEntry } = await import("../../src/web/audit.js");
type LiveEditDeps =
  import("../../src/services/event-live-edit.js").LiveEditDeps;
type LiveEditEffects =
  import("../../src/services/event-live-edit.js").LiveEditEffects;
type LiveEditOutcome =
  import("../../src/services/event-live-edit.js").LiveEditOutcome;
type EmptyChannelOutcome =
  import("../../src/services/event-live-edit.js").EmptyChannelOutcome;
type GroupRemoveResult =
  import("../../src/services/event-live-edit.js").GroupRemoveResult;

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const HOST = "host-1";
const A = "g_00000001";
const B = "g_00000002";
const C = "g_00000003";
const NEW = "g_0000abcd";

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
    tagsEnabled: false,
    groups: [
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
        kind: "team",
        size: 3,
        tag: "",
        marker: "",
        channelId: "c2",
        captainId: null,
        memberIds: ["u3"],
      },
      {
        key: C,
        name: "Charlie",
        kind: "open",
        size: null,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
    ],
    ...over,
  };
  store.set(EV, doc);
  return doc;
}

const groupsOf = (): Json[] => store.get(EV)?.groups as Json[];
const keysOf = (): string[] => groupsOf().map((g) => g.key as string);
const group = (key: string): Json =>
  groupsOf().find((g) => g.key === key) as Json;
/** Row writes only: the save's revision claim is a separate update. */
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
let removeResult: (key: string) => GroupRemoveResult | null;
let createResult: () => {
  failures: Array<{ key: string; reason: string }>;
} | null;
/** What the group looked like when its channel was deleted. */
const atRemove: Record<string, { members: unknown; rowWrites: number }> = {};
const atEmpty: Record<string, { rowWrites: number }> = {};
const assignments: Array<Record<string, unknown>> = [];
const leaderChanges: Array<Record<string, unknown>> = [];

beforeEach(() => {
  store.clear();
  writes.length = 0;
  calls.length = 0;
  assignments.length = 0;
  leaderChanges.length = 0;
  for (const k of Object.keys(atRemove)) delete atRemove[k];
  for (const k of Object.keys(atEmpty)) delete atEmpty[k];
  fake.beforeWrite = null;
  fake.afterFind = null;
  fake.failReads = false;
  enabled = true;
  ending = false;
  maxGroups = 15;
  emptyResult = () => ({ status: "empty", moved: [] });
  removeResult = () => ({ status: "removed" });
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
      atEmpty[key] = { rowWrites: rowWrites().length };
      return emptyResult(key);
    },
    async removeGroupChannel(_g, _e, key, channelId, opts) {
      calls.push(`remove:${key}:${channelId}:${[...opts.ignore].join("+")}`);
      atRemove[key] = {
        members: [...((group(key)?.memberIds as unknown[]) ?? [])],
        rowWrites: rowWrites().length,
      };
      const result = removeResult(key);
      if (result?.status === "removed") {
        store.get(EV)!.groups = groupsOf().filter((g) => g.key !== key);
      }
      return result;
    },
  });
  effects.syncLeadsAccess = async (): Promise<void> => {
    calls.push("leads");
  };
  effects.syncGroupControls = async (): Promise<void> => {
    calls.push("controls");
  };
  effects.syncTags = async (_g, _e, mode): Promise<void> => {
    calls.push(`tags:${mode}`);
  };
});

const offAssign = onGroupAssignmentChange((c) => {
  assignments.push({ ...c });
});
const offLeader = onLeaderChange((c) => {
  leaderChanges.push({ ...c });
});
afterAll(() => {
  offAssign();
  offLeader();
});

const entry = (rowId: string, to: unknown, base: unknown) => ({
  rowId,
  to,
  base,
});
const newGroup = (over: Record<string, unknown> = {}) => ({
  key: NEW,
  name: "Delta",
  kind: "team",
  size: 4,
  tag: "D",
  ...over,
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
const addForm = (over: Record<string, unknown> = {}) =>
  run([entry(GROUP_ADD_ROW_ID, [newGroup(over)], [])]);

type Done = Extract<LiveEditOutcome, { status: "done" }>;
const done = (o: LiveEditOutcome): Done => {
  expect(o.status).toBe("done");
  return o as Done;
};
const text = (o: LiveEditOutcome): string =>
  live.describeLiveEditOutcome(o).message;

/** The two steps of a removal: the confirmation page, then the confirmed run. */
async function removeConfirmed(
  keys: string[],
  d: LiveEditDeps = deps,
): Promise<LiveEditOutcome> {
  const first = await run([entry(GROUP_REMOVE_ROW_ID, keys, [])], d);
  expect(first.status).toBe("needs-confirmation");
  if (first.status !== "needs-confirmation") return first;
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

describe("registration", () => {
  it("lists remove then add, last, with letters-only ids and no duplicates", () => {
    const ids = live.LIVE_EDIT_ROWS.map((r) => r.id);
    expect(ids.slice(-2)).toEqual(["groupRemove", "groupAdd"]);
    expect(groupSetRows.map((r) => r.id)).toEqual(["groupRemove", "groupAdd"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of groupSetRows) expect(row.id).toMatch(/^[A-Za-z]+$/);
    expect(GROUP_ADD_ROW_ID).toBe("groupAdd");
    expect(GROUP_REMOVE_ROW_ID).toBe("groupRemove");
  });
});

describe("parseSubmission of the two forms", () => {
  it("reads the add form's fields into one new group, with the minted key", () => {
    const parsed = live.parseSubmission({
      [GROUP_ADD_FIELDS.name]: "  New   Squad ",
      [GROUP_ADD_FIELDS.kind]: "open",
      [GROUP_ADD_FIELDS.size]: "5",
      [GROUP_ADD_FIELDS.tag]: " NS ",
      [GROUP_ADD_FIELDS.key]: NEW,
      [GROUP_ADD_FIELDS.base]: "[]",
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toEqual([
      {
        rowId: "groupAdd",
        to: [{ key: NEW, name: "New Squad", kind: "open", size: 5, tag: "NS" }],
        base: [],
      },
    ]);
  });

  it("an add form with an empty name is no change at all", () => {
    const parsed = live.parseSubmission({
      [GROUP_ADD_FIELDS.name]: "   ",
      [GROUP_ADD_FIELDS.kind]: "team",
      [GROUP_ADD_FIELDS.key]: NEW,
      [GROUP_ADD_FIELDS.base]: "[]",
    });
    expect(parsed).toEqual({ entries: [], errors: [] });
  });

  it.each([
    [{ [GROUP_ADD_FIELDS.name]: "x".repeat(51) }, "New group name"],
    [{ [GROUP_ADD_FIELDS.size]: "100" }, "New group size"],
    [{ [GROUP_ADD_FIELDS.tag]: "123456789" }, "New group tag"],
    [{ [GROUP_ADD_FIELDS.kind]: "boss" }, "New group kind"],
  ])("names the field that is wrong (%#)", (over, expected) => {
    const parsed = live.parseSubmission({
      [GROUP_ADD_FIELDS.name]: "Delta",
      [GROUP_ADD_FIELDS.kind]: "team",
      [GROUP_ADD_FIELDS.size]: "",
      [GROUP_ADD_FIELDS.tag]: "",
      [GROUP_ADD_FIELDS.key]: NEW,
      [GROUP_ADD_FIELDS.base]: "[]",
      ...over,
    });
    expect(parsed.entries).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain(expected);
  });

  it("a key that is not one of ours is a form out of date", () => {
    const parsed = live.parseSubmission({
      [GROUP_ADD_FIELDS.name]: "Delta",
      [GROUP_ADD_FIELDS.kind]: "team",
      [GROUP_ADD_FIELDS.key]: "not-a-key",
      [GROUP_ADD_FIELDS.base]: "[]",
    });
    expect(parsed.errors).toEqual([
      "New group: the form is out of date. Reload the page.",
    ]);
  });

  it("reads the ticked boxes of the remove form as a sorted list of keys", () => {
    const parsed = live.parseSubmission({
      [groupRemoveField(B)]: "1",
      [groupRemoveField(A)]: "1",
      [groupRemoveField(C)]: "0",
      [GROUP_REMOVE_BASE_FIELD]: "[]",
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toEqual([
      { rowId: "groupRemove", to: [A, B], base: [] },
    ]);
  });

  it("a remove form with nothing ticked is no change at all", () => {
    expect(live.parseSubmission({ [GROUP_REMOVE_BASE_FIELD]: "[]" })).toEqual({
      entries: [],
      errors: [],
    });
  });

  it("a remove form whose base is not the empty list's text is out of date", () => {
    const parsed = live.parseSubmission({
      [groupRemoveField(A)]: "1",
      [GROUP_REMOVE_BASE_FIELD]: "nonsense",
    });
    expect(parsed.errors).toEqual([
      "Group removal: the form is out of date. Reload the page.",
    ]);
  });
});

describe("add a group", () => {
  it("appends it with every field written explicitly, keeps every other group and assignment, and counts the save once", async () => {
    const out = await addForm();
    expect(done(out).applied.map((c) => c.rowId)).toEqual(["groupAdd"]);
    expect(keysOf()).toEqual([A, B, C, NEW]);
    expect(group(NEW)).toEqual({
      key: NEW,
      name: "Delta",
      kind: "team",
      size: 4,
      tag: "D",
      marker: "",
      channelId: "made-g_0000abcd",
      captainId: null,
      memberIds: [],
    });
    // Everything else is as it was.
    expect(group(A).memberIds).toEqual(["u1", "u2"]);
    expect(group(A).captainId).toBe("u1");
    expect(group(B).memberIds).toEqual(["u3"]);
    expect(store.get(EV)?.liveEditRevision).toBe(1);
    const [write] = rowWrites();
    expect(write.update).toEqual({
      $push: {
        groups: {
          key: NEW,
          name: "Delta",
          kind: "team",
          size: 4,
          tag: "D",
          marker: "",
          channelId: null,
          captainId: null,
          memberIds: [],
        },
      },
    });
    expect(write.filter).toMatchObject({
      guildId: GUILD,
      state: { $in: ["scheduled", "active"] },
      groupsEnabled: true,
      groups: { $size: 3 },
      "groups.key": { $ne: NEW },
    });
    expect(text(out)).toBe('Saved: New group is now "Delta" (team, size 4).');
  });

  it("needs no confirmation: it destroys nothing", async () => {
    const out = await addForm();
    expect(out.status).toBe("done");
  });

  it("creates the channel through the group pass, then follows up with the leaders channel and the controls", async () => {
    await addForm({ kind: "leads" });
    expect(calls).toEqual(["create", "leads", "controls"]);
    expect(group(NEW).channelId).toBe("made-g_0000abcd");
  });

  it("an event whose channels do not exist yet owes nothing: no pass is asked for", async () => {
    store.get(EV)!.channelId = null;
    const out = await addForm();
    expect(done(out).applied).toHaveLength(1);
    expect(calls).toEqual(["leads", "controls"]);
    expect(group(NEW).channelId).toBeNull();
  });

  it("a channel the pass could not make is saved and reported as owed, never as success", async () => {
    createResult = () => ({
      failures: [{ key: NEW, reason: "Discord refused: Missing Permissions" }],
    });
    const out = await addForm();
    const result = done(out);
    expect(result.applied).toEqual([]);
    expect(result.partial).toHaveLength(1);
    expect(keysOf()).toEqual([A, B, C, NEW]);
    expect(group(NEW).channelId).toBeNull();
    expect(text(out)).toBe(
      'Saved but not finished: New group is now "Delta" (team, size 4) (its channel is not created yet (Discord refused: Missing Permissions): KoolBot keeps trying every minute). Save again to finish.',
    );
    expect(live.describeLiveEditOutcome(out).ok).toBe(false);
    // The follow-up still runs for a stored change.
    expect(calls).toContain("leads");
  });

  it("posting the same form again finishes the owed channel and adds no second group", async () => {
    createResult = () => ({
      failures: [{ key: NEW, reason: "category full" }],
    });
    await addForm();
    expect(keysOf()).toEqual([A, B, C, NEW]);
    calls.length = 0;
    createResult = () => ({ failures: [] });
    const again = await addForm();
    const result = done(again);
    expect(keysOf()).toEqual([A, B, C, NEW]);
    expect(result.applied.map((c) => [c.rowId, c.reconcile])).toEqual([
      ["groupAdd", true],
    ]);
    expect(group(NEW).channelId).toBe("made-g_0000abcd");
    expect(calls).toEqual(["create", "leads", "controls"]);
    expect(text(again)).toBe("Saved: New group is finished.");
  });

  it("is idempotent: posting the same form twice is one group, one revision and no second write", async () => {
    await addForm();
    const revision = store.get(EV)?.liveEditRevision;
    const before = writes.length;
    calls.length = 0;
    const again = await addForm();
    const result = done(again);
    expect(keysOf()).toEqual([A, B, C, NEW]);
    expect(result.alreadyApplied).toEqual(["groupAdd"]);
    expect(result.applied).toEqual([]);
    expect(writes).toHaveLength(before);
    expect(store.get(EV)?.liveEditRevision).toBe(revision);
    expect(calls).toEqual([]);
    expect(text(again)).toBe(
      "Nothing to change: the event already has these settings.",
    );
  });

  it("two different forms are two different groups: the key is what makes a post the same request", async () => {
    await addForm();
    await addForm({ key: "g_0000beef", name: "Echo" });
    expect(keysOf()).toEqual([A, B, C, NEW, "g_0000beef"]);
  });

  describe("validation is the event form's own", () => {
    it("refuses a name another group has, whatever the case", async () => {
      const out = await addForm({ name: "bravo" });
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain('"bravo" is already used by another group');
      expect(keysOf()).toEqual([A, B, C]);
      expect(writes).toEqual([]);
    });

    it("refuses a name another group goes back to when its leader rename is reset", async () => {
      group(B).name = "Bravo Crew";
      group(B).originalName = "Bravo";
      const out = await addForm({ name: "BRAVO" });
      expect(out).toMatchObject({ status: "invalid" });
      expect(writes).toEqual([]);
    });

    it("allows only one leads group", async () => {
      group(C).kind = "leads";
      const out = await addForm({ kind: "leads" });
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain("only one leads group is allowed");
      expect(keysOf()).toEqual([A, B, C]);
    });

    it("respects events.groups.max_count", async () => {
      maxGroups = 3;
      const out = await addForm();
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain("at most 3 groups");
      expect(keysOf()).toEqual([A, B, C]);
    });

    it("fails closed when the cap cannot be read", async () => {
      maxGroups = null;
      const out = await addForm();
      expect(out).toMatchObject({ status: "invalid" });
      expect(keysOf()).toEqual([A, B, C]);
    });

    it("an event whose groups are off cannot get one", async () => {
      store.get(EV)!.groupsEnabled = false;
      const out = await addForm();
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain("This event has no groups.");
    });
  });

  describe("the rules of every live edit", () => {
    it("refuses with events.enabled off or unreadable, and changes nothing", async () => {
      enabled = false;
      expect(await addForm()).toMatchObject({
        status: "refused",
        code: "events-off",
      });
      enabled = null;
      expect(await addForm()).toMatchObject({
        status: "refused",
        code: "events-off",
      });
      expect(keysOf()).toEqual([A, B, C]);
      expect(writes).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("refuses an event that is no longer running", async () => {
      store.get(EV)!.state = "ended";
      expect(await addForm()).toMatchObject({
        status: "refused",
        code: "not-open",
      });
      expect(keysOf()).toEqual([A, B, C]);
    });

    it("an end holding the event stops it before the write", async () => {
      ending = true;
      expect(await addForm()).toMatchObject({
        status: "refused",
        code: "ending",
      });
      expect(keysOf()).toEqual([A, B, C]);
      expect(writes).toEqual([]);
    });

    it("an end that takes its hold after the row's own read is asked again right before the write", async () => {
      // The core's read is the first find, the row's own read the second.
      let finds = 0;
      fake.afterFind = (): void => {
        finds += 1;
        if (finds === 2) ending = true;
      };
      const out = await addForm();
      const result = done(out);
      expect(result.notApplied).toEqual([
        {
          rowId: "groupAdd",
          label: "New group",
          reason: "was not saved because the event is being ended",
        },
      ]);
      expect(keysOf()).toEqual([A, B, C]);
      expect(rowWrites()).toEqual([]);
    });

    it("a group removed between the row's read and its write loses the write instead of landing at another position", async () => {
      fake.beforeWrite = (): void => {
        if (writes.length === 1) {
          store.get(EV)!.groups = groupsOf().filter((g) => g.key !== C);
        }
      };
      const out = await addForm();
      expect(done(out).applied).toEqual([]);
      expect(done(out).notApplied).toHaveLength(1);
      expect(keysOf()).toEqual([A, B]);
    });

    it("a concurrent add between the row's own read and its write is lost, never applied twice", async () => {
      let armed = false;
      fake.afterFind = (): void => {
        armed = true;
      };
      fake.beforeWrite = (): void => {
        if (armed && writes.length === 1) {
          groupsOf().push({
            key: "g_00000009",
            name: "Foxtrot",
            kind: "open",
            size: null,
            tag: "",
            marker: "",
            channelId: null,
            captainId: null,
            memberIds: [],
          });
        }
      };
      const out = await addForm();
      const result = done(out);
      expect(result.applied).toEqual([]);
      expect(result.notApplied).toEqual([
        {
          rowId: "groupAdd",
          label: "New group",
          reason:
            "was changed by someone else while this was being saved. Try again",
        },
      ]);
      expect(keysOf()).toEqual([A, B, C, "g_00000009"]);
      // A save that stored nothing runs no follow-up.
      expect(calls).toEqual([]);
    });
  });

  it("is audited once with the group flattened, within the audit bound", async () => {
    const out = await addForm();
    const { details } = live.describeLiveEditOutcome(out);
    const bounded = boundAuditEntry({
      action: "event.host-settings",
      details,
    } as never) as { details: Record<string, unknown> };
    expect(bounded.details.outcome).toBe("applied");
    expect(bounded.details.changes).toEqual([
      {
        row: "groupAdd",
        from: {},
        to: { g1: "g_0000abcd | Delta | team | size 4 | tag D" },
      },
    ]);
  });
});

describe("remove a group", () => {
  it("always asks for confirmation first, names the group and what happens, and changes nothing yet", async () => {
    const out = await run([entry(GROUP_REMOVE_ROW_ID, [A], [])]);
    expect(out.status).toBe("needs-confirmation");
    if (out.status !== "needs-confirmation") return;
    expect(out.reasons).toEqual([
      "Removing this group: Alpha (2 people assigned, with a voice channel). Everybody in the group's channel, you included, is moved to the main channel first; then the members are unassigned (their clan tags come off their nicknames), and then the channel is deleted. If somebody cannot be moved the group is kept as it is. This cannot be undone.",
    ]);
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(keysOf()).toEqual([A, B, C]);
    expect(store.get(EV)?.liveEditRevision).toBeUndefined();
  });

  it("moves everyone out FIRST, then unassigns, then deletes the channel and the group, keeping every other group", async () => {
    const out = await removeConfirmed([A]);
    expect(done(out).applied.map((c) => c.rowId)).toEqual(["groupRemove"]);
    expect(keysOf()).toEqual([B, C]);
    // Order: the move happened before any write of this row, the members were
    // already unassigned when the channel went.
    expect(calls.slice(0, 2)).toEqual([
      "empty:g_00000001:c1",
      "remove:g_00000001:c1:",
    ]);
    expect(atEmpty[A].rowWrites).toBe(0);
    expect(atRemove[A]).toEqual({ members: [], rowWrites: 1 });
    // The other groups and their assignments are as they were.
    expect(group(B).memberIds).toEqual(["u3"]);
    expect(group(B).channelId).toBe("c2");
    expect(rowWrites()[0].update).toEqual({
      $set: { "groups.$[g].memberIds": [] },
    });
    expect(rowWrites()[0].filter).toMatchObject({
      groups: { $elemMatch: { key: A, memberIds: ["u1", "u2"] } },
    });
    expect(text(out)).toBe("Saved: Group removal is now done for 1 group.");
  });

  it("every member is unassigned through the one hook that restores nicknames, and the leader is announced leaving", async () => {
    await removeConfirmed([A]);
    expect(assignments).toEqual([
      {
        eventId: EV,
        guildId: GUILD,
        userId: "u1",
        fromKey: A,
        toKey: null,
        source: "host",
      },
      {
        eventId: EV,
        guildId: GUILD,
        userId: "u2",
        fromKey: A,
        toKey: null,
        source: "host",
      },
    ]);
    expect(leaderChanges).toEqual([
      {
        eventId: EV,
        guildId: GUILD,
        groupKey: A,
        fromUserId: "u1",
        toUserId: null,
        source: "unassigned",
      },
    ]);
  });

  it("no leader is announced while leaders are off", async () => {
    store.get(EV)!.captainsEnabled = false;
    await removeConfirmed([A]);
    expect(leaderChanges).toEqual([]);
  });

  it("passes the people who just left to the delete, so the cache lagging a confirmed move does not keep the channel", async () => {
    emptyResult = () => ({ status: "empty", moved: ["u1", "u2"] });
    await removeConfirmed([A]);
    expect(calls).toContain("remove:g_00000001:c1:u1+u2");
  });

  it("a group with no channel yet is removed by one conditional pull, with no move and no delete", async () => {
    const out = await removeConfirmed([C]);
    expect(done(out).applied).toHaveLength(1);
    expect(keysOf()).toEqual([A, B]);
    // No move and no delete: only the nickname backstop after the save.
    expect(calls).toEqual(["tags:restore"]);
    const [write] = rowWrites();
    expect(write.update).toEqual({
      $pull: { groups: { key: C, channelId: null } },
    });
    expect(write.filter).toMatchObject({
      $and: [
        { groups: { $size: 3 } },
        { groups: { $elemMatch: { key: C, channelId: null } } },
      ],
    });
  });

  it("a channel the scan creates for that group meanwhile makes the pull lost: nothing is orphaned", async () => {
    fake.beforeWrite = (): void => {
      if (writes.length === 1) group(C).channelId = "made-by-scan";
    };
    const out = await removeConfirmed([C]);
    const result = done(out);
    expect(result.applied).toEqual([]);
    expect(result.partial).toHaveLength(1);
    expect(keysOf()).toEqual([A, B, C]);
    expect(group(C).channelId).toBe("made-by-scan");
    expect(text(out)).toContain("the group changed meanwhile");
  });

  describe("a person who cannot be moved keeps the group", () => {
    it("with members present: the group, its members, its leader and its channel are all kept, and the result says who and why", async () => {
      emptyResult = () => ({
        status: "occupied",
        moved: ["u9"],
        remaining: 1,
        detail: "1 missing permission",
      });
      const out = await removeConfirmed([A]);
      const result = done(out);
      expect(result.applied).toEqual([]);
      expect(result.partial).toEqual([]);
      expect(result.notApplied).toEqual([
        {
          rowId: "groupRemove",
          label: "Group removal",
          reason:
            '"Alpha": 1 person is still in its channel (1 missing permission), so it was kept. Save again to move the rest, or let them leave first',
        },
      ]);
      expect(keysOf()).toEqual([A, B, C]);
      expect(group(A).memberIds).toEqual(["u1", "u2"]);
      expect(group(A).captainId).toBe("u1");
      expect(group(A).channelId).toBe("c1");
      // Nothing after the move was attempted: no unassign write, no delete.
      expect(rowWrites()).toEqual([]);
      expect(calls).toEqual(["empty:g_00000001:c1"]);
      expect(assignments).toEqual([]);
      expect(leaderChanges).toEqual([]);
      expect(live.describeLiveEditOutcome(out).ok).toBe(false);
      // No follow-up for a save that stored nothing.
      expect(calls).not.toContain("tags:restore");
    });

    it("saving again after they left finishes the removal", async () => {
      emptyResult = () => ({
        status: "occupied",
        moved: [],
        remaining: 2,
        detail: "2 not attempted (Discord is rate limiting)",
      });
      await removeConfirmed([A]);
      expect(keysOf()).toEqual([A, B, C]);
      emptyResult = () => ({ status: "empty", moved: ["u1", "u2"] });
      const out = await removeConfirmed([A]);
      expect(done(out).applied).toHaveLength(1);
      expect(keysOf()).toEqual([B, C]);
    });

    it("the mover refusing (no permission, busy, group changed) keeps everything too", async () => {
      emptyResult = () => ({
        status: "failed",
        reason: "The bot lacks the Move Members permission",
      });
      const out = await removeConfirmed([A]);
      expect(done(out).notApplied[0].reason).toBe(
        '"Alpha": nobody was moved and nothing was removed (The bot lacks the Move Members permission)',
      );
      expect(keysOf()).toEqual([A, B, C]);
      expect(rowWrites()).toEqual([]);
    });

    it("without a Discord client behind the row nothing is removed", async () => {
      effects = undefined;
      const out = await removeConfirmed([A]);
      expect(done(out).notApplied[0].reason).toContain("nothing was removed");
      expect(keysOf()).toEqual([A, B, C]);
    });
  });

  describe("a failure after the members were unassigned is reported and finished by saving again", () => {
    it("the channel could not be deleted: the group stays, empty, and the result says so", async () => {
      removeResult = () => ({
        status: "failed",
        reason: "Missing Permissions",
      });
      const out = await removeConfirmed([A]);
      const result = done(out);
      expect(result.partial).toHaveLength(1);
      expect(result.applied).toEqual([]);
      expect(keysOf()).toEqual([A, B, C]);
      expect(group(A).memberIds).toEqual([]);
      expect(group(A).channelId).toBe("c1");
      expect(text(out)).toBe(
        'Saved but not finished: Group removal is now done for 1 group ("Alpha": its members were unassigned, but its channel could not be deleted (Missing Permissions). Save again to finish). Save again to finish.',
      );
      // The members were unassigned once, and tags are brought in line.
      expect(assignments).toHaveLength(2);
      expect(calls).toContain("tags:restore");
    });

    it("saving again moves nobody twice, announces nobody twice and removes the group", async () => {
      removeResult = () => ({
        status: "failed",
        reason: "Missing Permissions",
      });
      await removeConfirmed([A]);
      expect(assignments).toHaveLength(2);
      expect(leaderChanges).toHaveLength(1);
      removeResult = () => ({ status: "removed" });
      const out = await removeConfirmed([A]);
      expect(done(out).applied).toHaveLength(1);
      expect(keysOf()).toEqual([B, C]);
      expect(assignments).toHaveLength(2);
      expect(leaderChanges).toHaveLength(1);
    });

    it("somebody joined the channel meanwhile: kept, reported, finished later", async () => {
      removeResult = () => ({ status: "occupied", remaining: 1 });
      const out = await removeConfirmed([A]);
      expect(text(out)).toContain(
        "1 person joined its channel, so it was kept",
      );
      expect(keysOf()).toEqual([A, B, C]);
    });

    it("the group changing under the delete is reported, not ignored", async () => {
      removeResult = () => ({ status: "lost" });
      const out = await removeConfirmed([A]);
      expect(text(out)).toContain("the group changed meanwhile");
      expect(done(out).partial).toHaveLength(1);
    });

    it("an unreachable server is reported", async () => {
      removeResult = () => null;
      const out = await removeConfirmed([A]);
      expect(text(out)).toContain(
        "the server could not be reached to delete its channel",
      );
    });

    it("an end taking its hold between the unassign and the delete stops before the delete", async () => {
      // The hold is taken the moment the members are unassigned (the unassign
      // announces them synchronously, right after its write).
      const stop = onGroupAssignmentChange(() => {
        ending = true;
      });
      try {
        const out = await removeConfirmed([A]);
        expect(text(out)).toContain("the event is being ended");
        expect(done(out).partial).toHaveLength(1);
        expect(keysOf()).toEqual([A, B, C]);
        expect(group(A).memberIds).toEqual([]);
        expect(calls.some((c) => c.startsWith("remove:"))).toBe(false);
      } finally {
        stop();
      }
    });
  });

  it("an end taking its hold while the people are being moved stops before anybody is unassigned", async () => {
    const original = (effects as LiveEditEffects).emptyGroupChannel;
    (effects as LiveEditEffects).emptyGroupChannel = async (...args) => {
      const result = await original(...args);
      // The hold is taken while the mover was busy.
      ending = true;
      return result;
    };
    const out = await removeConfirmed([A]);
    expect(done(out).notApplied).toEqual([
      {
        rowId: "groupRemove",
        label: "Group removal",
        reason: '"Alpha": the event is being ended',
      },
    ]);
    expect(rowWrites()).toEqual([]);
    expect(group(A).memberIds).toEqual(["u1", "u2"]);
    expect(assignments).toEqual([]);
    expect(keysOf()).toEqual([A, B, C]);
  });

  it("a membership that changed between the read and the unassign is lost: nothing is unassigned, deleted or announced", async () => {
    fake.beforeWrite = (): void => {
      if (writes.length === 1) group(A).memberIds = ["u1", "u2", "u7"];
    };
    const out = await removeConfirmed([A]);
    const result = done(out);
    expect(result.applied).toEqual([]);
    expect(result.notApplied).toEqual([
      {
        rowId: "groupRemove",
        label: "Group removal",
        reason:
          "was changed by someone else while this was being saved. Try again",
      },
    ]);
    expect(group(A).memberIds).toEqual(["u1", "u2", "u7"]);
    expect(keysOf()).toEqual([A, B, C]);
    expect(calls.some((c) => c.startsWith("remove:"))).toBe(false);
    expect(assignments).toEqual([]);
    expect(leaderChanges).toEqual([]);
  });

  it("several groups in one save: the one that cannot be moved is kept, the others go, and the result says which", async () => {
    emptyResult = (key) =>
      key === B
        ? {
            status: "occupied",
            moved: [],
            remaining: 1,
            detail: "1 missing permission",
          }
        : { status: "empty", moved: [] };
    const out = await removeConfirmed([A, B]);
    const result = done(out);
    expect(result.partial).toHaveLength(1);
    expect(keysOf()).toEqual([B, C]);
    expect(text(out)).toContain('"Bravo": 1 person is still in its channel');
    expect(group(B).memberIds).toEqual(["u3"]);
  });

  describe("the last group, unknown groups and replays", () => {
    it("refuses to remove every group", async () => {
      const out = await run([entry(GROUP_REMOVE_ROW_ID, [A, B, C], [])]);
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain("an event keeps at least one group");
      expect(keysOf()).toEqual([A, B, C]);
    });

    it("never removes the last one even when the others went after the plan was made", async () => {
      // The plan saw three groups, so removing one is fine; by the time the
      // row looks again, somebody else has removed the other two.
      fake.beforeWrite = (): void => {
        if (writes.length === 0) {
          store.get(EV)!.groups = groupsOf().filter((g) => g.key === A);
        }
      };
      const out = await removeConfirmed([A]);
      expect(done(out).notApplied).toEqual([
        {
          rowId: "groupRemove",
          label: "Group removal",
          reason:
            '"Alpha" is the last group of the event, and an event keeps at least one',
        },
      ]);
      expect(keysOf()).toEqual([A]);
      expect(calls).toEqual([]);
    });

    it("a group that is already gone is already applied: no confirmation, no write", async () => {
      store.get(EV)!.groups = groupsOf().filter((g) => g.key !== A);
      const out = await run([entry(GROUP_REMOVE_ROW_ID, [A], [])]);
      const result = done(out);
      expect(result.alreadyApplied).toEqual(["groupRemove"]);
      expect(writes).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("a confirmation cannot be replayed after the removal: it is stale", async () => {
      const first = await run([entry(GROUP_REMOVE_ROW_ID, [A], [])]);
      if (first.status !== "needs-confirmation") throw new Error("no");
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
      if (!check.ok) throw new Error("token");
      const apply = (): Promise<LiveEditOutcome> =>
        live.runLiveEdit({
          guildId: GUILD,
          eventId: EV,
          deps,
          confirmed: check.changes,
          confirmedRevision: check.revision,
        });
      expect(done(await apply()).applied).toHaveLength(1);
      expect(await apply()).toMatchObject({ status: "stale" });
      expect(keysOf()).toEqual([B, C]);
    });

    it("an event that is not open, with events off, or being ended, removes nothing", async () => {
      store.get(EV)!.state = "ended";
      expect(await run([entry(GROUP_REMOVE_ROW_ID, [A], [])])).toMatchObject({
        status: "refused",
        code: "not-open",
      });
      store.get(EV)!.state = "active";
      enabled = false;
      expect(await run([entry(GROUP_REMOVE_ROW_ID, [A], [])])).toMatchObject({
        status: "refused",
        code: "events-off",
      });
      enabled = true;
      ending = true;
      expect(await run([entry(GROUP_REMOVE_ROW_ID, [A], [])])).toMatchObject({
        status: "refused",
        code: "ending",
      });
      expect(keysOf()).toEqual([A, B, C]);
      expect(writes).toEqual([]);
    });
  });

  it("a join racing the removal waits for the group lock and is then refused: the removed group is not written back", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = (effects as LiveEditEffects).emptyGroupChannel;
    (effects as LiveEditEffects).emptyGroupChannel = async (...args) => {
      await gate;
      return original(...args);
    };
    const first = await run([entry(GROUP_REMOVE_ROW_ID, [A], [])]);
    if (first.status !== "needs-confirmation") throw new Error("no");
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
    if (!check.ok) throw new Error("token");
    const removal = live.runLiveEdit({
      guildId: GUILD,
      eventId: EV,
      deps,
      confirmed: check.changes,
      confirmedRevision: check.revision,
    });
    // The removal is now inside the group lock, waiting on the mover.
    await new Promise((r) => setTimeout(r, 5));
    const join = assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "u9",
      groupKey: A,
      admission: 1,
      isConnected: () => true,
    });
    release();
    const [removed, joined] = await Promise.all([removal, join]);
    expect(done(removed).applied).toHaveLength(1);
    expect(joined.ok).toBe(false);
    expect(keysOf()).toEqual([B, C]);
    // Nobody was written into the removed group.
    expect(
      rowWrites().filter((w) => JSON.stringify(w.update).includes('"u9"')),
    ).toEqual([]);
  });

  it("holds the move lock for the whole save: a bulk move asked meanwhile answers busy", async () => {
    let seen: boolean | null = null;
    const original = (effects as LiveEditEffects).emptyGroupChannel;
    (effects as LiveEditEffects).emptyGroupChannel = async (...args) => {
      const probe = await withEventMoveLock(EV, async () => "ran");
      seen = probe.busy;
      return original(...args);
    };
    await removeConfirmed([A]);
    expect(seen).toBe(true);
  });

  it("is audited once, with the keys, within the audit bound", async () => {
    const out = await removeConfirmed([A, B]);
    const { details } = live.describeLiveEditOutcome(out);
    const bounded = boundAuditEntry({
      action: "event.host-settings",
      details,
    } as never) as { details: Record<string, unknown> };
    expect(bounded.details.outcome).toBe("applied");
    expect(bounded.details.changes).toEqual([
      { row: "groupRemove", from: [], to: [A, B] },
    ]);
  });
});

describe("the size rows are guarded by the key of the group the form showed (#1242)", () => {
  const SIZE_B = groupSizeRowId(1);

  it("collects the posted key as the entry's guard", () => {
    const parsed = live.parseSubmission({
      [`s_${SIZE_B}`]: "5",
      [`b_${SIZE_B}`]: "3",
      [groupSizeKeyField(1)]: B,
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toEqual([
      { rowId: SIZE_B, to: 5, base: 3, guard: B },
    ]);
  });

  it("a form posted before another group was removed does not resize the group that moved into the position", async () => {
    // The form showed position 2 = Bravo (size 3). Alpha was removed since, so
    // position 2 now holds Charlie, and Charlie's size happens to be 3 as well:
    // the base value rule alone would resize Charlie.
    group(C).size = 3;
    const parsed = live.parseSubmission({
      [`s_${groupSizeRowId(2)}`]: "9",
      [`b_${groupSizeRowId(2)}`]: "3",
      [groupSizeKeyField(2)]: B,
    });
    expect(parsed.errors).toEqual([]);
    store.get(EV)!.groups = groupsOf().filter((g) => g.key !== A);
    store.get(EV)!.groups = [group(C), group(B)];
    const out = await run(parsed.entries);
    const result = done(out);
    expect(result.applied).toEqual([]);
    expect(result.notApplied).toEqual([
      {
        rowId: groupSizeRowId(2),
        label: "Size of group 3",
        reason:
          "was changed by someone else while you were editing. Reload the page and try again",
      },
    ]);
    expect(rowWrites()).toEqual([]);
    expect(group(C).size).toBe(3);
    expect(group(B).size).toBe(3);
  });

  it("a form whose key is still at the position is applied as before", async () => {
    const parsed = live.parseSubmission({
      [`s_${SIZE_B}`]: "5",
      [`b_${SIZE_B}`]: "3",
      [groupSizeKeyField(1)]: B,
    });
    const out = await run(parsed.entries);
    expect(done(out).applied).toHaveLength(1);
    expect(group(B).size).toBe(5);
  });

  it("a post without a key (an older form) is not checked", async () => {
    const parsed = live.parseSubmission({
      [`s_${SIZE_B}`]: "5",
      [`b_${SIZE_B}`]: "3",
    });
    expect(parsed.entries[0]).toEqual({ rowId: SIZE_B, to: 5, base: 3 });
    const out = await run(parsed.entries);
    expect(done(out).applied).toHaveLength(1);
  });

  it("a missing base is still a form out of date, not an empty size", () => {
    const parsed = live.parseSubmission({
      [`s_${SIZE_B}`]: "5",
      [groupSizeKeyField(1)]: B,
    });
    expect(parsed.entries).toEqual([]);
    expect(parsed.errors).toEqual([
      "Size of group 2: the form is out of date. Reload the page.",
    ]);
  });

  it("a name row needs no key: names are unique, so a different group there is a different base", async () => {
    store.get(EV)!.groups = groupsOf().filter((g) => g.key !== A);
    const out = await run([entry(groupNameRowId(1), "Zulu", "Bravo")]);
    // Position 2 is Charlie now: its name is not the base the form showed.
    expect(done(out).notApplied).toHaveLength(1);
    expect(group(C).name).toBe("Charlie");
  });
});

describe("the core's two small hooks", () => {
  it("`satisfied` is what makes a re-posted request already applied; without it the row would apply twice", () => {
    expect(groupAddRow.satisfied).toBeDefined();
    expect(groupRemoveRow.satisfied).toBeDefined();
    const event = store.get(EV) as never;
    expect(groupAddRow.satisfied?.(event, [newGroup()] as never)).toBe(false);
    expect(
      groupAddRow.satisfied?.(event, [newGroup({ key: B })] as never),
    ).toBe(true);
    expect(groupRemoveRow.satisfied?.(event, [A] as never)).toBe(false);
    expect(groupRemoveRow.satisfied?.(event, ["g_ffffffff"] as never)).toBe(
      true,
    );
    // An empty request is never "satisfied": it is no request.
    expect(groupAddRow.satisfied?.(event, [] as never)).toBe(false);
    expect(groupRemoveRow.satisfied?.(event, [] as never)).toBe(false);
  });
});
