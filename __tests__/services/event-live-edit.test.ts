import crypto from "node:crypto";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Live edit of a running event (#1239): the planner, the confirmation token,
 * the locked executor and the one result, against an in-memory stand-in for the
 * Event model. The stand-in understands exactly the filter and `$set` shapes
 * the rows write and THROWS on any other, so a write that changes shape cannot
 * pass silently. The real shapes (`$nor`, `$type`, `$elemMatch`, `$ne`) are
 * proven against MongoDB in `__tests__/integration/event-live-edit`.
 *
 * Expected values in the tables are literals, never computed by a copy of the
 * logic under test.
 */

import {
  store,
  writes,
  claims,
  fake,
  EventMock,
  type Json,
} from "./event-live-edit-fake-event.js";

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

const SECRET = "live-edit-test-secret";
process.env.WEBUI_SESSION_SECRET = SECRET;

const live = await import("../../src/services/event-live-edit.js");
const {
  LIVE_EDIT_ROWS,
  editBlocker,
  planLiveEdit,
  parseSubmission,
  runLiveEdit,
  describeLiveEditOutcome,
  signConfirmation,
  verifyConfirmation,
  changeSetHash,
  validateEditedSetup,
  isGroupOverSize,
  channelsExist,
  defineRow,
  CONFIRM_TTL_MS,
} = live;
type LiveEditDeps =
  import("../../src/services/event-live-edit.js").LiveEditDeps;
type LiveEditRow = import("../../src/services/event-live-edit.js").LiveEditRow;
type IEvent = import("../../src/models/event.js").IEvent;
const { withEventMoveLock, resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");
const { withGroupLock } =
  await import("../../src/services/event-group-assignment.js");
const { moveEventMembers } =
  await import("../../src/services/event-member-moves.js");

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const OTHER_EV = "65a000000000000000000002";
const HOST = "111111111111111111";

function seed(over: Json = {}, id = EV): Json {
  const doc: Json = {
    _id: id,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    groupsLocked: false,
    channelLeadMinutes: 30,
    channelId: null,
    testName: "a",
    groups: [
      {
        key: "g_00000001",
        name: "Heli",
        kind: "team",
        size: 2,
        channelId: null,
        memberIds: ["u1", "u2", "u3"],
      },
    ],
    ...over,
  };
  store.set(id, doc);
  return doc;
}

let enabled: boolean | null = true;
let ending = false;
function deps(over: Partial<LiveEditDeps> = {}): LiveEditDeps {
  return {
    isEventsEnabled: async () => enabled,
    maxGroups: async () => 15,
    isEnding: () => ending,
    ...over,
  };
}

/** A row that needs confirmation, to exercise the round trip and the contract. */
const nameRow = defineRow<string>({
  id: "testName",
  label: "Test name",
  read: (e) => String((e as unknown as Json).testName ?? "a"),
  parse: (raw) => ({ ok: true, value: raw }),
  applicable: () => null,
  needsConfirmation: (_from, to) => (to === "danger" ? "This is risky." : null),
  describe: (v) => `"${v}"`,
  async apply({ eventId, guildId, from, to }) {
    const { Event } = await import("../../src/models/event.js");
    const r = await Event.updateOne(
      {
        _id: eventId,
        guildId,
        state: { $in: ["scheduled", "active"] },
        testName: from,
      } as never,
      { $set: { testName: to } } as never,
    );
    return (r?.matchedCount ?? 0) === 1
      ? { status: "applied" }
      : { status: "lost" };
  },
});
const ROWS: readonly LiveEditRow[] = [...LIVE_EDIT_ROWS, nameRow];

const run = (
  submission: Array<{ rowId: string; to: unknown; base: unknown }>,
  d: LiveEditDeps = deps(),
  rows: readonly LiveEditRow[] = LIVE_EDIT_ROWS,
) =>
  runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps: d,
    rows,
    submission: submission as never,
  });

/** The text with its last character changed to one that is certainly different. */
const flip = (text: string): string =>
  `${text.slice(0, -1)}${text.endsWith("A") ? "B" : "A"}`;

const lead = (to: number | null, base: number | null = 30) => ({
  rowId: "channelLeadMinutes",
  to,
  base,
});
const lock = (to: boolean, base = false) => ({
  rowId: "groupsLocked",
  to,
  base,
});

beforeEach(() => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  store.clear();
  writes.length = 0;
  claims.length = 0;
  fake.beforeWrite = null;
  fake.failReads = false;
  enabled = true;
  ending = false;
  resetMoveGuardForTests();
});

describe("editBlocker (rule 1): the one rule for whether an edit may run", () => {
  const ev = (state: string, guildId = GUILD) => ({ state, guildId });
  const table: Array<{
    name: string;
    enabled: boolean | null;
    event: { guildId: string; state: string } | null;
    ending: boolean;
    expected: string | null;
  }> = [
    {
      name: "scheduled",
      enabled: true,
      event: ev("scheduled"),
      ending: false,
      expected: null,
    },
    {
      name: "active",
      enabled: true,
      event: ev("active"),
      ending: false,
      expected: null,
    },
    {
      name: "ended",
      enabled: true,
      event: ev("ended"),
      ending: false,
      expected: "not-open",
    },
    {
      name: "cancelled",
      enabled: true,
      event: ev("cancelled"),
      ending: false,
      expected: "not-open",
    },
    {
      name: "being ended (state still active)",
      enabled: true,
      event: ev("active"),
      ending: true,
      expected: "ending",
    },
    {
      name: "events off",
      enabled: false,
      event: ev("active"),
      ending: false,
      expected: "events-off",
    },
    {
      name: "events unreadable fails closed",
      enabled: null,
      event: ev("active"),
      ending: false,
      expected: "events-off",
    },
    {
      name: "events off wins over ended",
      enabled: false,
      event: ev("ended"),
      ending: false,
      expected: "events-off",
    },
    {
      name: "no such event",
      enabled: true,
      event: null,
      ending: false,
      expected: "no-event",
    },
    {
      name: "another guild's event",
      enabled: true,
      event: ev("active", "guild-2"),
      ending: false,
      expected: "no-event",
    },
  ];
  it.each(table)("$name", (row) => {
    expect(
      editBlocker({
        enabled: row.enabled,
        event: row.event,
        guildId: GUILD,
        ending: row.ending,
      }),
    ).toBe(row.expected);
  });
});

describe("the executor over field x event state x toggle state", () => {
  type Case = {
    name: string;
    setup: () => void;
    expected: { status: string; code?: string };
  };
  const cases: Case[] = [
    {
      name: "active, events on",
      setup: () => seed(),
      expected: { status: "done" },
    },
    {
      name: "scheduled, events on",
      setup: () => seed({ state: "scheduled" }),
      expected: { status: "done" },
    },
    {
      name: "ended",
      setup: () => seed({ state: "ended" }),
      expected: { status: "refused", code: "not-open" },
    },
    {
      name: "cancelled",
      setup: () => seed({ state: "cancelled" }),
      expected: { status: "refused", code: "not-open" },
    },
    {
      name: "being ended",
      setup: () => {
        seed();
        ending = true;
      },
      expected: { status: "refused", code: "ending" },
    },
    {
      name: "events off",
      setup: () => {
        seed();
        enabled = false;
      },
      expected: { status: "refused", code: "events-off" },
    },
    {
      name: "events unreadable",
      setup: () => {
        seed();
        enabled = null;
      },
      expected: { status: "refused", code: "events-off" },
    },
    {
      name: "event unreadable",
      setup: () => {
        seed();
        fake.failReads = true;
      },
      expected: { status: "refused", code: "unreadable" },
    },
    {
      name: "no such event",
      setup: () => undefined,
      expected: { status: "refused", code: "no-event" },
    },
  ];
  for (const field of ["lead", "lock"] as const) {
    it.each(cases)(`${field}: $name`, async (c) => {
      c.setup();
      const entry = field === "lead" ? lead(45) : lock(true);
      const out = await run([entry]);
      expect(out).toMatchObject(c.expected);
      if (c.expected.status === "refused") {
        // A refusal changes nothing.
        expect(writes).toEqual([]);
        expect(store.get(EV)?.channelLeadMinutes ?? 30).toBe(30);
        expect(store.get(EV)?.groupsLocked ?? false).toBe(false);
      } else {
        expect(writes).toHaveLength(1);
        expect(store.get(EV)).toMatchObject(
          field === "lead"
            ? { channelLeadMinutes: 45, groupsLocked: false }
            : { channelLeadMinutes: 30, groupsLocked: true },
        );
      }
    });
  }

  it("lead time: editable before any channel exists, read-only after (main or group channel)", async () => {
    const table: Array<[string, Json, string]> = [
      ["no channels", {}, "applied"],
      ["main channel exists", { channelId: "c-main" }, "invalid"],
      [
        "a group channel exists",
        {
          groups: [
            {
              key: "g_00000001",
              name: "A",
              kind: "team",
              size: null,
              channelId: "c-a",
              memberIds: [],
            },
          ],
        },
        "invalid",
      ],
      ["an empty channel id counts as none", { channelId: "" }, "applied"],
    ];
    for (const [, over, expected] of table) {
      store.clear();
      writes.length = 0;
      seed(over);
      const out = await run([lead(45)]);
      expect(out.status).toBe(expected === "applied" ? "done" : "invalid");
      expect(writes).toHaveLength(expected === "applied" ? 1 : 0);
    }
  });

  it("lock: refused for an event without groups, never writes", async () => {
    seed({ groupsEnabled: false, groups: [] });
    const out = await run([lock(true)]);
    expect(out).toEqual({
      status: "invalid",
      errors: ["Lock groups: This event has no groups."],
    });
    expect(writes).toEqual([]);
  });

  it("lock off: both directions apply", async () => {
    seed({ groupsLocked: true });
    expect(await run([lock(false, true)])).toMatchObject({ status: "done" });
    expect(store.get(EV)?.groupsLocked).toBe(false);
  });

  it("a legacy row without the lock field reads as unlocked and locks", async () => {
    const doc = seed();
    delete doc.groupsLocked;
    expect(await run([lock(true)])).toMatchObject({ status: "done" });
    expect(store.get(EV)?.groupsLocked).toBe(true);
  });
});

describe("the base value rule (rule 3): only what the host changed is written", () => {
  const event = (over: Json = {}): IEvent => seed(over) as unknown as IEvent;
  const plan = (
    entries: Array<{ rowId: string; to: unknown; base: unknown }>,
    over: Json = {},
  ) =>
    planLiveEdit({
      event: event(over),
      entries: entries as never,
      maxGroups: 15,
    });

  it.each([
    // [name, to, base, stored lead, expected]
    ["untouched: submitted equals base", 30, 30, 30, "nothing"],
    ["untouched even when stored moved on", 30, 30, 60, "nothing"],
    ["already applied: submitted equals stored", 45, 30, 45, "already"],
    ["conflict: stored changed, host changed too", 45, 30, 60, "conflict"],
    ["a change: stored equals base", 45, 30, 30, "change"],
  ] as const)("%s", (_name, to, base, stored, expected) => {
    const p = plan([lead(to, base)], { channelLeadMinutes: stored });
    expect({
      changes: p.changes.length,
      already: p.alreadyApplied.length,
      conflicts: p.conflicts.length,
      errors: p.errors.length,
    }).toEqual(
      {
        nothing: { changes: 0, already: 0, conflicts: 0, errors: 0 },
        already: { changes: 0, already: 1, conflicts: 0, errors: 0 },
        conflict: { changes: 0, already: 0, conflicts: 1, errors: 0 },
        change: { changes: 1, already: 0, conflicts: 0, errors: 0 },
      }[expected],
    );
  });

  it("a stale form cannot revert somebody else's lock by saving an unrelated field", async () => {
    // The host's form showed "unlocked"; meanwhile the Assign section locked.
    seed({ groupsLocked: true });
    const out = await run([lead(45), lock(false, false)]);
    // The lock field was posted unchanged (to == base == false): untouched.
    expect(out).toMatchObject({ status: "done" });
    expect(store.get(EV)).toMatchObject({
      channelLeadMinutes: 45,
      groupsLocked: true,
    });
    expect(writes.map((w) => Object.keys(w.set))).toEqual([
      ["channelLeadMinutes"],
    ]);
  });

  it("a real conflict is reported as not applied, nothing is written for it, and the other field still saves", async () => {
    // The form showed 30; somebody set 60 meanwhile; the host typed 45.
    seed({ channelLeadMinutes: 60 });
    const out = await run([lead(45, 30), lock(true, false)]);
    expect(out).toMatchObject({
      status: "done",
      applied: [{ rowId: "groupsLocked" }],
      notApplied: [{ rowId: "channelLeadMinutes" }],
    });
    expect(store.get(EV)).toMatchObject({
      channelLeadMinutes: 60,
      groupsLocked: true,
    });
    const r = describeLiveEditOutcome(out);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(
      "Saved: Lock groups is now locked. Not saved: Channel creation time was changed by someone else while you were editing. Reload the page and try again. Save again to retry.",
    );
  });
});

describe("parseSubmission", () => {
  it("reads value and base, leaves absent rows untouched, refuses a value without its base", () => {
    expect(
      parseSubmission({
        s_channelLeadMinutes: "45",
        b_channelLeadMinutes: "30",
        s_groupsLocked: "1",
        b_groupsLocked: "0",
      }),
    ).toEqual({
      entries: [
        { rowId: "channelLeadMinutes", to: 45, base: 30 },
        { rowId: "groupsLocked", to: true, base: false },
      ],
      errors: [],
    });
    expect(parseSubmission({})).toEqual({ entries: [], errors: [] });
    expect(parseSubmission({ s_groupsLocked: "1" }).errors).toEqual([
      "Lock groups: the form is out of date. Reload the page.",
    ]);
  });

  it("empty lead time is the server default; bad values are refused with the shared message", () => {
    expect(
      parseSubmission({ s_channelLeadMinutes: "", b_channelLeadMinutes: "30" })
        .entries,
    ).toEqual([{ rowId: "channelLeadMinutes", to: null, base: 30 }]);
    for (const bad of ["-1", "1441", "abc", "1.5", "99999999"]) {
      const r = parseSubmission({
        s_channelLeadMinutes: bad,
        b_channelLeadMinutes: "30",
      });
      expect(r.entries).toEqual([]);
      expect(r.errors[0]).toContain(
        "Channel creation time must be a whole number",
      );
    }
    expect(
      parseSubmission({ s_groupsLocked: "yes", b_groupsLocked: "0" }).errors,
    ).toEqual(["Lock groups: choose locked or unlocked."]);
  });

  it("ignores non-string values (an array or object posted by hand)", () => {
    expect(
      parseSubmission({
        s_groupsLocked: ["1"],
        b_groupsLocked: "0",
      } as never),
    ).toEqual({ entries: [], errors: [] });
  });
});

describe("the executor: fresh read, conditional writes, one result", () => {
  it("decides from the fresh row, not from anything the caller saw earlier", async () => {
    seed({ channelLeadMinutes: 30 });
    // Before the executor reads, a channel appears: the earlier form allowed the edit.
    const gate = store.get(EV) as Json;
    gate.channelId = "c-main";
    const out = await run([lead(45)]);
    expect(out.status).toBe("invalid");
    expect(writes).toEqual([]);
  });

  it("a channel created between the read and the write is a lost write, not a success", async () => {
    seed();
    fake.beforeWrite = (): void => {
      (store.get(EV) as Json).channelId = "c-main";
    };
    const out = await run([lead(45)]);
    expect(out).toMatchObject({
      status: "done",
      applied: [],
      notApplied: [{ rowId: "channelLeadMinutes" }],
    });
    expect(store.get(EV)?.channelLeadMinutes).toBe(30);
    const r = describeLiveEditOutcome(out);
    expect(r.ok).toBe(false);
    expect(r.details.outcome).toBe("not-applied");
  });

  it("another writer changing the value between the read and the write is lost, never overwritten", async () => {
    seed();
    fake.beforeWrite = (): void => {
      (store.get(EV) as Json).channelLeadMinutes = 99;
    };
    const out = await run([lead(45)]);
    expect(out).toMatchObject({ status: "done", applied: [] });
    expect(store.get(EV)?.channelLeadMinutes).toBe(99);
  });

  it("the event ending between rows stops the later write and says so", async () => {
    seed();
    let calls = 0;
    const out = await run(
      [lead(45), lock(true)],
      deps({
        isEnding: () => {
          calls += 1;
          // 1: after the read; 2: before the claim; 3: before row 1; 4: before row 2.
          return calls >= 4;
        },
      }),
    );
    expect(out).toMatchObject({
      status: "done",
      applied: [{ rowId: "channelLeadMinutes" }],
      notApplied: [
        {
          rowId: "groupsLocked",
          reason: "was not saved because the event is being ended",
        },
      ],
    });
    expect(store.get(EV)).toMatchObject({
      channelLeadMinutes: 45,
      groupsLocked: false,
    });
  });

  it("writes only the row's own field and never state, channelId or groups", async () => {
    seed();
    await run([lead(45), lock(true)]);
    expect(writes.map((w) => Object.keys(w.set).sort())).toEqual([
      ["channelLeadMinutes"],
      ["groupsLocked"],
    ]);
    for (const w of writes) {
      expect(w.filter).toMatchObject({
        guildId: GUILD,
        state: { $in: ["scheduled", "active"] },
      });
    }
    // The stored groups are exactly as seeded (members, over-size, no new fields).
    expect(store.get(EV)?.groups).toEqual([
      {
        key: "g_00000001",
        name: "Heli",
        kind: "team",
        size: 2,
        channelId: null,
        memberIds: ["u1", "u2", "u3"],
      },
    ]);
  });

  it("is idempotent: saving the same form twice reports nothing to do the second time", async () => {
    seed();
    const first = await run([lead(45), lock(true)]);
    expect(first).toMatchObject({ status: "done", notApplied: [] });
    // The same posted form again: base is still the old values.
    const second = await run([lead(45), lock(true)]);
    expect(second).toEqual({
      status: "done",
      applied: [],
      notApplied: [],
      partial: [],
      alreadyApplied: ["channelLeadMinutes", "groupsLocked"],
    });
    expect(writes).toHaveLength(2);
    const r = describeLiveEditOutcome(second);
    expect(r).toMatchObject({
      ok: true,
      message: "Nothing to change: the event already has these settings.",
    });
    expect(r.details.outcome).toBe("nothing-to-do");
  });

  it("partial success is explicit and re-saving converges", async () => {
    seed();
    let first = true;
    fake.beforeWrite = (): void => {
      // Only the first write of the first save loses its condition.
      if (first) {
        first = false;
        (store.get(EV) as Json).channelId = "c-main";
      }
    };
    const a = await run([lead(45), lock(true)]);
    expect(a).toMatchObject({
      applied: [{ rowId: "groupsLocked" }],
      notApplied: [{ rowId: "channelLeadMinutes" }],
    });
    expect(describeLiveEditOutcome(a)).toMatchObject({
      ok: false,
      details: { outcome: "partial" },
    });
    // Re-save: the lock is "already applied"; the lead time is now refused
    // because a channel exists (and reported, nothing hidden).
    const b = await run([lead(45), lock(true)]);
    expect(b).toMatchObject({ status: "invalid" });
    expect(store.get(EV)).toMatchObject({
      groupsLocked: true,
      channelLeadMinutes: 30,
    });
  });

  it("a write that throws is reported as not applied, the others still run", async () => {
    seed();
    const { Event } = await import("../../src/models/event.js");
    const real = Event.updateOne.bind(Event);
    let n = 0;
    jest.spyOn(Event, "updateOne").mockImplementation(((...a: unknown[]) => {
      n += 1; // 1 is the save claim; 2 is the first row write
      if (n === 2) throw new Error("write conflict");
      return (real as (...x: unknown[]) => unknown)(...a);
    }) as never);
    const out = await run([lead(45), lock(true)]);
    expect(out).toMatchObject({
      applied: [{ rowId: "groupsLocked" }],
      notApplied: [{ rowId: "channelLeadMinutes" }],
    });
    jest.restoreAllMocks();
  });

  it("derived over-size state is computed, not stored", () => {
    expect(isGroupOverSize({ size: 2, memberIds: ["a", "b", "c"] })).toBe(true);
    expect(isGroupOverSize({ size: 3, memberIds: ["a", "b", "c"] })).toBe(
      false,
    );
    expect(isGroupOverSize({ size: null, memberIds: ["a", "b", "c"] })).toBe(
      false,
    );
    expect(isGroupOverSize({ size: 1, memberIds: undefined })).toBe(false);
  });

  it("channelsExist reads main and group channel ids", () => {
    expect(channelsExist({ channelId: null, groups: [] })).toBe(false);
    expect(channelsExist({ channelId: "x" })).toBe(true);
    expect(channelsExist({ groups: [{ channelId: "y" }] })).toBe(true);
    expect(channelsExist({ groups: [{ channelId: "" }, {}] })).toBe(false);
  });

  it("refuses an id that is not an event id", async () => {
    expect(
      await runLiveEdit({
        guildId: GUILD,
        eventId: "not-an-id",
        deps: deps(),
        submission: [],
      }),
    ).toMatchObject({ status: "refused", code: "no-event" });
  });
});

describe("concurrency with host moves (shared locks)", () => {
  it("while a bulk move holds the move lock the edit answers busy and writes nothing", async () => {
    seed();
    let release!: () => void;
    const held = withEventMoveLock(
      EV,
      () => new Promise<void>((r) => (release = r)),
    );
    const out = await run([lead(45)]);
    expect(out).toMatchObject({ status: "refused", code: "busy" });
    expect(writes).toEqual([]);
    release();
    await held;
    expect(await run([lead(45)])).toMatchObject({ status: "done" });
  });

  it("while an edit runs, a bulk move through the real mover answers busy", async () => {
    seed();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.beforeWrite = (): Promise<void> => gate;
    const editing = run([lead(45)]);
    // Let the edit take its locks and reach its (held) write.
    await new Promise((r) => setTimeout(r, 5));
    const moved = await moveEventMembers({
      client: {} as never,
      guildId: GUILD,
      eventId: EV,
      plan: () => [],
    });
    expect(moved).toEqual({ status: "busy" });
    release();
    expect(await editing).toMatchObject({ status: "done" });
  });

  it("the edit queues behind a membership change on the group lock instead of interleaving", async () => {
    seed();
    const order: string[] = [];
    let release!: () => void;
    const membership = withGroupLock(
      GUILD,
      EV,
      () =>
        new Promise<void>((r) => {
          release = (): void => {
            order.push("membership done");
            r();
          };
        }),
    );
    const editing = run([lead(45)]).then((o) => {
      order.push("edit done");
      return o;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(writes).toEqual([]);
    release();
    await membership;
    expect(await editing).toMatchObject({ status: "done" });
    expect(order).toEqual(["membership done", "edit done"]);
  });

  it("releases the locks when the read fails, so the next save is not busy", async () => {
    seed();
    fake.failReads = true;
    expect(await run([lead(45)])).toMatchObject({
      status: "refused",
      code: "unreadable",
    });
    fake.failReads = false;
    expect(await run([lead(45)])).toMatchObject({ status: "done" });
  });
});
describe("requireConfirmation (#1344): confirm or change nothing", () => {
  const only = (
    submission: Array<{ rowId: string; to: unknown; base: unknown }>,
    d: LiveEditDeps = deps(),
    rows: readonly LiveEditRow[] = LIVE_EDIT_ROWS,
  ) =>
    runLiveEdit({
      guildId: GUILD,
      eventId: EV,
      deps: d,
      rows,
      submission: submission as never,
      requireConfirmation: true,
    });

  it("refuses a plan that needs no confirmation before anything is claimed or written", async () => {
    seed();
    const before = JSON.stringify([...store.values()]);
    expect(await only([lead(45)])).toMatchObject({
      status: "refused",
      code: "not-confirmable",
    });
    expect(writes).toEqual([]);
    expect(JSON.stringify([...store.values()])).toBe(before);
  });

  it("refuses an empty plan too", async () => {
    seed();
    expect(await only([lead(30)])).toMatchObject({ code: "not-confirmable" });
    expect(writes).toEqual([]);
  });

  it("without the option the same plan is applied", async () => {
    seed();
    expect(await run([lead(45)])).toMatchObject({ status: "done" });
    expect(writes).not.toEqual([]);
  });

  it("a plan that needs confirmation is still answered with it, and writes nothing", async () => {
    seed();
    const out = await only(
      [{ rowId: "testName", to: "danger", base: "a" }],
      deps(),
      ROWS,
    );
    expect(out.status).toBe("needs-confirmation");
    expect(writes).toEqual([]);
  });
});

describe("the confirmation round trip (rule 6) with a row that needs it", () => {
  const dangerous = { rowId: "testName", to: "danger", base: "a" };

  const plan = async (): Promise<
    Extract<Awaited<ReturnType<typeof run>>, { status: "needs-confirmation" }>
  > => {
    const out = await run([dangerous], deps(), ROWS);
    if (out.status !== "needs-confirmation") throw new Error(out.status);
    return out;
  };
  const sign = async (
    over: Partial<Parameters<typeof signConfirmation>[0]> = {},
  ): Promise<string> => {
    const p = await plan();
    const token = signConfirmation({
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
      changes: p.changes,
      revision: p.revision,
      ...over,
    });
    if (!token) throw new Error("no token");
    return token;
  };
  const verify = (
    token: unknown,
    over: Partial<Parameters<typeof verifyConfirmation>[1]> = {},
  ) =>
    verifyConfirmation(token, {
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
      ...over,
    });
  const confirm = (token: unknown, d: LiveEditDeps = deps()) => {
    const v = verify(token);
    if (!v.ok) throw new Error(v.reason);
    return runLiveEdit({
      guildId: GUILD,
      eventId: EV,
      deps: d,
      rows: ROWS,
      confirmed: v.changes,
      confirmedRevision: v.revision,
    });
  };

  it("a change that needs confirmation applies nothing and returns the change set and the reasons", async () => {
    seed();
    const out = await plan();
    expect(out.reasons).toEqual(["This is risky."]);
    expect(out.changes).toEqual([
      {
        rowId: "testName",
        label: "Test name",
        from: "a",
        to: "danger",
        confirm: "This is risky.",
      },
    ]);
    expect(writes).toEqual([]);
  });

  it("a plain change in the same save is held back with it (nothing is applied before the yes)", async () => {
    seed();
    const out = await run([lead(45), dangerous], deps(), ROWS);
    expect(out.status).toBe("needs-confirmation");
    expect(writes).toEqual([]);
  });

  it("confirming applies the whole confirmed change set", async () => {
    seed();
    const token = await sign();
    const out = await confirm(token);
    expect(out).toMatchObject({
      status: "done",
      applied: [{ rowId: "testName", to: "danger" }],
      notApplied: [],
    });
    expect(store.get(EV)?.testName).toBe("danger");
  });

  it("a replay of the same token after the change was applied applies nothing", async () => {
    seed();
    const token = await sign();
    expect(await confirm(token)).toMatchObject({ status: "done" });
    writes.length = 0;
    expect(await confirm(token)).toMatchObject({ status: "stale" });
    expect(writes).toEqual([]);
  });

  it("a used token cannot be replayed after the value was reversed (A to B, B to A, token again)", async () => {
    seed();
    const token = await sign();
    // A to B, confirmed.
    expect(await confirm(token)).toMatchObject({ status: "done" });
    expect(store.get(EV)?.testName).toBe("danger");
    // B to A, a plain save (needs no confirmation).
    expect(
      await run([{ rowId: "testName", to: "a", base: "danger" }], deps(), ROWS),
    ).toMatchObject({ status: "done", applied: [{ rowId: "testName" }] });
    expect(store.get(EV)?.testName).toBe("a");
    writes.length = 0;
    // The fresh plan is A to B again, exactly the confirmed change set, but the
    // token was issued at an older revision: nothing is applied.
    expect(await confirm(token)).toMatchObject({ status: "stale" });
    expect(store.get(EV)?.testName).toBe("a");
    expect(writes).toEqual([]);
  });

  it("every save that applies something moves the revision on once; asking, refusing and nothing-to-do do not", async () => {
    seed();
    const rev = (): unknown => store.get(EV)?.liveEditRevision;
    await run([dangerous], deps(), ROWS); // needs confirmation
    await run([lead(30, 30)]); // untouched
    expect(rev()).toBeUndefined();
    expect(claims).toEqual([]);
    await run([lead(45)]);
    expect(rev()).toBe(1);
    await run([lead(45)]); // already applied
    expect(rev()).toBe(1);
    ending = true;
    await run([lead(50, 45)]); // refused
    ending = false;
    expect(rev()).toBe(1);
    await run([lead(50, 45)]);
    expect(rev()).toBe(2);
    // The claim is conditional on the revision the plan was made at.
    expect(claims[0]).toMatchObject({
      liveEditRevision: { $in: [0, null] },
    });
    expect(claims[1]).toMatchObject({ liveEditRevision: 1 });
  });

  it("a save whose revision claim is lost applies nothing", async () => {
    seed();
    const { Event } = await import("../../src/models/event.js");
    const real = Event.updateOne.bind(Event);
    jest.spyOn(Event, "updateOne").mockImplementation(((
      filter: Json,
      update: Json,
    ) => {
      // Someone else's save lands between our read and our claim.
      if (update.$inc) (store.get(EV) as Json).liveEditRevision = 7;
      return (real as (...x: unknown[]) => unknown)(filter, update);
    }) as never);
    const out = await run([lead(45)]);
    jest.restoreAllMocks();
    expect(out).toMatchObject({ status: "stale" });
    expect(writes).toEqual([]);
    expect(store.get(EV)?.channelLeadMinutes).toBe(30);
  });

  it("a stale token (the event changed since the page was shown) applies nothing", async () => {
    seed();
    const token = await sign();
    (store.get(EV) as Json).testName = "b";
    expect(await confirm(token)).toMatchObject({ status: "stale" });
    expect(store.get(EV)?.testName).toBe("b");
    expect(writes).toEqual([]);
  });

  it("a token for another event is refused", async () => {
    seed();
    const token = await sign({ eventId: OTHER_EV });
    expect(verify(token)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("a token for another guild is refused", async () => {
    seed();
    const token = await sign({ guildId: "guild-2" });
    expect(verify(token)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("a token issued to another host is refused", async () => {
    seed();
    const token = await sign({ userId: "999999999999999999" });
    expect(verify(token)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("a token for a different change set is not the same token (the hash differs)", async () => {
    seed();
    const a = changeSetHash([{ rowId: "testName", from: "a", to: "danger" }]);
    const b = changeSetHash([{ rowId: "testName", from: "a", to: "other" }]);
    const c = changeSetHash([{ rowId: "testName", from: "x", to: "danger" }]);
    expect(new Set([a, b, c]).size).toBe(3);
    // Order independent.
    expect(
      changeSetHash([
        { rowId: "b", from: 1, to: 2 },
        { rowId: "a", from: 1, to: 2 },
      ]),
    ).toBe(
      changeSetHash([
        { rowId: "a", from: 1, to: 2 },
        { rowId: "b", from: 1, to: 2 },
      ]),
    );
  });

  it("an expired token is refused; one inside its lifetime is accepted", async () => {
    seed();
    const now = Date.now();
    const token = await sign({ now });
    expect(verify(token, { now: now + CONFIRM_TTL_MS - 1 }).ok).toBe(true);
    expect(verify(token, { now: now + CONFIRM_TTL_MS })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("a tampered token is refused (payload, mac, junk, empty, wrong type, oversized)", async () => {
    seed();
    const token = await sign();
    const [body, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        e: EV,
        g: GUILD,
        u: HOST,
        x: Date.now() + 1e9,
        h: "x",
        c: [],
      }),
    ).toString("base64url");
    for (const bad of [
      `${forged}.${mac}`,
      // Last character flipped to one that is certainly different.
      `${body}.${flip(mac)}`,
      `${body}.`,
      body,
      "",
      "a.b.c",
      123,
      null,
      undefined,
      `${"x".repeat(20_000)}.${mac}`,
    ]) {
      // Every variant really differs from the valid token before it is tried.
      expect(bad).not.toBe(token);
      expect(verify(bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("a correctly signed token whose change set does not match its own hash is refused", () => {
    // Forged with the real key, as only a bug in the signer could: the changes
    // say one thing, the recorded hash another.
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        e: EV,
        g: GUILD,
        u: HOST,
        x: Date.now() + 60_000,
        h: changeSetHash([{ rowId: "testName", from: "a", to: "safe" }]),
        n: 0,
        c: [{ r: "testName", f: "a", t: "danger" }],
      }),
    ).toString("base64url");
    const mac = crypto
      .createHmac("sha256", SECRET)
      .update(`live-edit-confirm\0${payload}`)
      .digest("base64url");
    expect(verify(`${payload}.${mac}`)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("a token signed with another secret is refused", async () => {
    seed();
    const token = await sign();
    process.env.WEBUI_SESSION_SECRET = "another-secret";
    expect(verify(token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("fails closed without a session secret: nothing is signed, nothing verifies", async () => {
    seed();
    const token = await sign();
    delete process.env.WEBUI_SESSION_SECRET;
    expect(
      signConfirmation({
        eventId: EV,
        guildId: GUILD,
        userId: HOST,
        changes: [],
        revision: 0,
      }),
    ).toBeNull();
    expect(verify(token)).toEqual({ ok: false, reason: "no-secret" });
  });

  it("an event id in upper case is the same event", async () => {
    seed();
    const token = await sign({ eventId: EV.toUpperCase() });
    expect(verify(token).ok).toBe(true);
  });

  it("a stale form with a conflict plus a confirm-needing change is refused as stale, not confirmed", async () => {
    seed({ channelLeadMinutes: 30, groupsLocked: true });
    const out = await run(
      [dangerous, { rowId: "groupsLocked", to: false, base: "x" as never }],
      deps(),
      ROWS,
    );
    // base "x" != stored true and != to: a conflict.
    expect(out.status).toBe("stale");
    expect(writes).toEqual([]);
  });

  it("a confirmed run still refuses an event that ended after the page was shown", async () => {
    seed();
    const token = await sign();
    (store.get(EV) as Json).state = "ended";
    expect(await confirm(token)).toMatchObject({
      status: "refused",
      code: "not-open",
    });
    expect(writes).toEqual([]);
  });

  it("a confirmed change set naming a row that does not exist is stale", async () => {
    seed();
    expect(
      await runLiveEdit({
        guildId: GUILD,
        eventId: EV,
        deps: deps(),
        confirmed: [{ rowId: "nope", from: 1, to: 2 }],
        confirmedRevision: 0,
      }),
    ).toMatchObject({ status: "stale" });
  });
});

describe("a row that stores its target and owes a follow-up (partial), then converges", () => {
  /**
   * Stores the target and a durable "owed" marker, then reports partial (as a
   * rename whose Discord call failed would). `reconcile` finishes it.
   */
  const makeRow = (confirmReconcile: boolean): LiveEditRow =>
    defineRow<string>({
      id: "testPartial",
      label: "Test partial",
      read: (e) => String((e as unknown as Json).testPartial ?? "a"),
      parse: (raw) => ({ ok: true, value: raw }),
      applicable: () => null,
      needsConfirmation: (from, to) =>
        confirmReconcile && from === to ? "Finishing this is risky." : null,
      owed: (e) =>
        (e as unknown as Json).testOwed === true
          ? "the channel still has the old name"
          : null,
      describe: (v) => `"${v}"`,
      async apply({ eventId, guildId, from, to }) {
        const { Event } = await import("../../src/models/event.js");
        const r = await Event.updateOne(
          {
            _id: eventId,
            guildId,
            state: { $in: ["scheduled", "active"] },
            testPartial: from,
          } as never,
          { $set: { testPartial: to, testOwed: true } } as never,
        );
        return (r?.matchedCount ?? 0) === 1
          ? { status: "partial", message: "the channel still has the old name" }
          : { status: "lost" };
      },
      async reconcile({ eventId, guildId }) {
        const { Event } = await import("../../src/models/event.js");
        const r = await Event.updateOne(
          {
            _id: eventId,
            guildId,
            state: { $in: ["scheduled", "active"] },
            testOwed: true,
          } as never,
          { $set: { testOwed: false } } as never,
        );
        return (r?.matchedCount ?? 0) === 1
          ? { status: "applied" }
          : { status: "lost" };
      },
    });
  const form = { rowId: "testPartial", to: "b", base: "a" };
  const runWith = (rows: readonly LiveEditRow[], entries: unknown[] = [form]) =>
    run(entries as never, deps(), rows);

  it("keeps the stored change in the result and the audit with what is owed (not 'not applied')", async () => {
    seed({ testPartial: "a" });
    const rows = [...LIVE_EDIT_ROWS, makeRow(false)];
    const out = await runWith(rows);
    expect(out).toMatchObject({
      status: "done",
      applied: [],
      notApplied: [],
      partial: [
        {
          rowId: "testPartial",
          from: "a",
          to: "b",
          owed: "the channel still has the old name",
        },
      ],
    });
    expect(store.get(EV)).toMatchObject({ testPartial: "b", testOwed: true });
    const r = describeLiveEditOutcome(out, rows);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(
      'Saved but not finished: Test partial is now "b" (the channel still has the old name). Save again to finish.',
    );
    expect(r.details).toMatchObject({
      outcome: "partial",
      stored: [
        {
          row: "testPartial",
          from: "a",
          to: "b",
          owed: "the channel still has the old name",
        },
      ],
    });
  });

  it("re-saving the same form runs the follow-up (reconcile) instead of 'already applied', then converges", async () => {
    seed({ testPartial: "a" });
    const rows = [...LIVE_EDIT_ROWS, makeRow(false)];
    await runWith(rows);
    const second = await runWith(rows);
    expect(second).toMatchObject({
      status: "done",
      applied: [{ rowId: "testPartial", reconcile: true }],
      partial: [],
      alreadyApplied: [],
    });
    expect(store.get(EV)).toMatchObject({ testPartial: "b", testOwed: false });
    const r = describeLiveEditOutcome(second, rows);
    expect(r).toMatchObject({
      ok: true,
      message: "Saved: Test partial is finished.",
    });
    expect(r.details).toMatchObject({
      outcome: "applied",
      changes: [{ row: "testPartial", reconcile: true }],
    });
    // A third save has nothing left to do.
    expect(await runWith(rows)).toMatchObject({
      applied: [],
      partial: [],
      alreadyApplied: ["testPartial"],
    });
  });

  it("the normal browser retry converges: the REFRESHED form shows the stored value as both value and base", async () => {
    seed({ testPartial: "a" });
    const rows = [...LIVE_EDIT_ROWS, makeRow(false)];
    await runWith(rows);
    // After the redirect the form is rendered from the stored row: b / b.
    const refreshed = { rowId: "testPartial", to: "b", base: "b" };
    const retry = await runWith(rows, [refreshed]);
    expect(retry).toMatchObject({
      status: "done",
      applied: [{ rowId: "testPartial", reconcile: true }],
    });
    expect(store.get(EV)).toMatchObject({ testPartial: "b", testOwed: false });
    // Once nothing is owed, the refreshed form is untouched: nothing to do.
    expect(await runWith(rows, [refreshed])).toMatchObject({
      applied: [],
      partial: [],
      alreadyApplied: [],
    });
    expect(describeLiveEditOutcome(retry, rows).message).toBe(
      "Saved: Test partial is finished.",
    );
  });

  it("a reconcile asks for confirmation like any change, and the confirmed run still reconciles", async () => {
    seed({ testPartial: "a" });
    const rows = [...LIVE_EDIT_ROWS, makeRow(true)];
    await runWith(rows);
    const asked = await runWith(rows);
    if (asked.status !== "needs-confirmation") throw new Error(asked.status);
    expect(asked.reasons).toEqual(["Finishing this is risky."]);
    expect(asked.changes).toMatchObject([
      { rowId: "testPartial", from: "b", to: "b", reconcile: true },
    ]);
    expect(store.get(EV)?.testOwed).toBe(true);
    const token = signConfirmation({
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
      changes: asked.changes,
      revision: asked.revision,
    });
    const verified = verifyConfirmation(token, {
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
    });
    if (!verified.ok) throw new Error(verified.reason);
    const confirmed = () =>
      runLiveEdit({
        guildId: GUILD,
        eventId: EV,
        deps: deps(),
        rows,
        confirmed: verified.changes,
        confirmedRevision: verified.revision,
      });
    expect(await confirmed()).toMatchObject({
      status: "done",
      applied: [{ rowId: "testPartial", reconcile: true }],
    });
    expect(store.get(EV)?.testOwed).toBe(false);
    // Replayed once nothing is owed any more: stale, nothing written.
    writes.length = 0;
    expect(await confirmed()).toMatchObject({ status: "stale" });
    expect(writes).toEqual([]);
  });

  it("the reconcile flag is part of the signed change set", () => {
    const plain = changeSetHash([{ rowId: "r", from: "b", to: "b" }]);
    const reconcile = changeSetHash([
      { rowId: "r", from: "b", to: "b", reconcile: true },
    ]);
    expect(plain).not.toBe(reconcile);
  });

  it("a row without a durable owed marker is simply 'already applied' on a re-save", async () => {
    seed({ testName: "b" });
    expect(
      await run([{ rowId: "testName", to: "b", base: "a" }], deps(), ROWS),
    ).toMatchObject({ applied: [], alreadyApplied: ["testName"] });
  });
});

describe("validation of an edited setup (rule 8)", () => {
  const event = (over: Json = {}): IEvent =>
    seed({
      presetId: "builtin:deleted-long-ago",
      groupLabel: "Team",
      leaderLabel: "Leader",
      groups: [
        {
          key: "g_00000001",
          name: "Heli",
          kind: "team",
          size: 2,
          tag: "",
          marker: "",
          channelId: null,
          memberIds: [],
        },
        {
          key: "g_00000002",
          name: "Logi",
          kind: "team",
          size: null,
          tag: "",
          marker: "",
          channelId: null,
          memberIds: [],
        },
      ],
      ...over,
    }) as unknown as IEvent;

  it("never validates with the stored preset id: a deleted or disabled preset does not block an edit", () => {
    expect(validateEditedSetup(event(), 15, () => undefined)).toEqual([]);
  });

  it("is checked with the same rules as the event form (a bad size is named)", () => {
    const errors = validateEditedSetup(event(), 15, (input) => {
      input.rows[0].size = "100";
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Group 1 size");
  });

  it("two groups with the same name are refused", () => {
    const errors = validateEditedSetup(event(), 15, (input) => {
      input.rows[1].name = "Heli";
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("a lowered events.groups.max_count never locks the host out of the groups the event already has", () => {
    expect(validateEditedSetup(event(), 1, () => undefined)).toEqual([]);
    // Adding one more than the event has is still over the lowered cap.
    const errors = validateEditedSetup(event(), 1, (input) => {
      input.rows.push({
        position: 3,
        name: "Extra",
        kind: "team",
        size: "",
        tag: "",
        marker: "",
      });
    });
    expect(errors.join(" ")).toContain("at most 2 groups");
  });

  it("fails closed when the group limit cannot be read", () => {
    expect(validateEditedSetup(event(), null, () => undefined)).toEqual([
      "The group limit could not be read, so nothing was changed.",
    ]);
  });

  it("the validator's output is never written (the rows only check)", async () => {
    seed();
    await run([lead(45)]);
    expect(writes.every((w) => !("groups" in w.set))).toBe(true);
  });

  it("a row that changes the group list validates through ctx.validateSetup", () => {
    const sizeRow = defineRow<number | null>({
      id: "firstSize",
      label: "First size",
      read: (e) => e.groups[0].size ?? null,
      parse: () => ({ ok: true, value: 100 }),
      applicable: () => null,
      validate: (to, ctx) =>
        ctx.validateSetup((input) => {
          input.rows[0].size = to === null ? "" : String(to);
        })[0] ?? null,
      describe: String,
      apply: async () => ({ status: "applied" }),
    });
    const p = planLiveEdit({
      event: event(),
      entries: [{ rowId: "firstSize", to: 100, base: 2 }],
      rows: [sizeRow],
      maxGroups: 15,
    });
    expect(p.changes).toEqual([]);
    expect(p.errors[0]).toContain("First size: Group 1 size");
  });
});

describe("the result text", () => {
  it("lists what was saved in plain words", () => {
    const r = describeLiveEditOutcome({
      status: "done",
      applied: [
        {
          rowId: "channelLeadMinutes",
          label: "Channel creation time",
          from: 30,
          to: null,
          confirm: null,
        },
        {
          rowId: "groupsLocked",
          label: "Lock groups",
          from: false,
          to: true,
          confirm: null,
        },
      ],
      partial: [],
      notApplied: [],
      alreadyApplied: [],
    });
    expect(r.ok).toBe(true);
    expect(r.message).toBe(
      "Saved: Channel creation time is now the server default; Lock groups is now locked.",
    );
    expect(r.details).toMatchObject({
      outcome: "applied",
      changes: [
        { row: "channelLeadMinutes", from: 30, to: null },
        { row: "groupsLocked", from: false, to: true },
      ],
    });
  });

  it("every refusal has its own words and code", () => {
    for (const code of [
      "events-off",
      "no-event",
      "unreadable",
      "not-open",
      "ending",
      "busy",
      "no-secret",
    ] as const) {
      const r = describeLiveEditOutcome({
        status: "refused",
        code,
        message: live.REFUSAL_MESSAGE[code],
      });
      expect(r.ok).toBe(false);
      expect(r.errorMessage).toBe(code);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });
});

describe("the planner's two hooks for rows that name a thing or take a request (#1242)", () => {
  const event = (over: Json = {}): IEvent => seed(over) as unknown as IEvent;
  const noop = async (): Promise<{ status: "applied" }> => ({
    status: "applied",
  });

  /** A row of "the thing at position 1", whose value cannot tell which thing it is. */
  const sizeRow = (shownKey: () => string): LiveEditRow =>
    defineRow<number>({
      id: "testSize",
      label: "Test size",
      read: (e) => Number((e as unknown as Json).testSize ?? 1),
      parse: (raw) => ({ ok: true, value: Number(raw) }),
      applicable: () => null,
      guard: () => shownKey(),
      describe: (v) => String(v),
      apply: noop,
    });
  const entry = (guard?: string) => ({
    rowId: "testSize",
    to: 5,
    base: 1,
    ...(guard === undefined ? {} : { guard }),
  });
  const plan = (row: LiveEditRow, entries: unknown[]) =>
    planLiveEdit({
      event: event({ testSize: 1 }),
      entries: entries as never,
      rows: [row],
      maxGroups: 15,
    });

  it("guard: the form's identity equal to the fresh row's is a change", () => {
    const p = plan(
      sizeRow(() => "g_a"),
      [entry("g_a")],
    );
    expect(p.changes).toHaveLength(1);
    expect(p.conflicts).toEqual([]);
  });

  it("guard: another thing at that position is a conflict, never a write", () => {
    const p = plan(
      sizeRow(() => "g_b"),
      [entry("g_a")],
    );
    expect(p.changes).toEqual([]);
    expect(p.conflicts).toEqual([
      {
        rowId: "testSize",
        label: "Test size",
        message:
          "was changed by someone else while you were editing. Reload the page and try again",
      },
    ]);
  });

  it("guard: a post without an identity (an older form, a confirmed change set) is not checked", () => {
    const p = plan(
      sizeRow(() => "g_b"),
      [entry()],
    );
    expect(p.changes).toHaveLength(1);
  });

  it("guard: a field the host did not change is untouched whatever the identity", () => {
    const p = plan(
      sizeRow(() => "g_b"),
      [{ rowId: "testSize", to: 1, base: 1, guard: "g_a" }],
    );
    expect(p).toMatchObject({ changes: [], conflicts: [], alreadyApplied: [] });
  });

  it("guard: collect returns it into the submitted entry, and nothing else adds one", () => {
    const row = defineRow<number>({
      id: "testSize",
      label: "Test size",
      read: () => 1,
      parse: (raw) => ({ ok: true, value: Number(raw) }),
      applicable: () => null,
      collect: (body) => ({
        raw: String(body.v),
        base: String(body.b),
        guard: String(body.k),
      }),
      describe: String,
      apply: noop,
    });
    expect(
      parseSubmission({ v: "5", b: "1", k: "g_a" }, [row]).entries,
    ).toEqual([{ rowId: "testSize", to: 5, base: 1, guard: "g_a" }]);
    expect(
      parseSubmission({ s_testSize: "5", b_testSize: "1" }, [nameRow]).entries,
    ).toEqual([]);
  });

  /** A row whose value is a request: its stored value is always empty. */
  const requestRow = (
    satisfied: (to: string[]) => boolean,
    extra: Partial<LiveEditRow<string[]>> = {},
  ): LiveEditRow =>
    defineRow<string[]>({
      id: "testReq",
      label: "Test request",
      read: () => [],
      parse: (raw) => ({ ok: true, value: JSON.parse(raw) as string[] }),
      applicable: () => null,
      satisfied: (_e, to) => satisfied(to),
      describe: (v) => v.join(","),
      apply: noop,
      ...extra,
    });
  const reqPlan = (row: LiveEditRow, to: string[]) =>
    planLiveEdit({
      event: event(),
      entries: [{ rowId: "testReq", to, base: [] }] as never,
      rows: [row],
      maxGroups: 15,
    });

  it("satisfied: a request the fresh row already satisfies is already applied, not applied again", () => {
    const p = reqPlan(
      requestRow(() => true),
      ["x"],
    );
    expect(p).toMatchObject({
      changes: [],
      alreadyApplied: ["testReq"],
      conflicts: [],
    });
  });

  it("satisfied: a request it does not satisfy is a change from the stored empty value", () => {
    const p = reqPlan(
      requestRow(() => false),
      ["x"],
    );
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]).toMatchObject({ from: [], to: ["x"] });
    expect(p.alreadyApplied).toEqual([]);
  });

  it("satisfied: finishes an owed follow-up of a re-posted request", () => {
    const p = reqPlan(
      requestRow(() => true, {
        owed: () => "still owed",
        reconcile: noop,
      }),
      ["x"],
    );
    expect(p.changes).toEqual([
      expect.objectContaining({ rowId: "testReq", reconcile: true }),
    ]);
    expect(p.alreadyApplied).toEqual([]);
  });

  it("satisfied: without the hook the same re-posted request would be applied twice", () => {
    const row = requestRow(() => true);
    const bare = defineRow<string[]>({
      id: "testReq",
      label: "Test request",
      read: () => [],
      parse: (raw) => ({ ok: true, value: JSON.parse(raw) as string[] }),
      applicable: () => null,
      describe: (v) => v.join(","),
      apply: noop,
    });
    expect(reqPlan(row, ["x"]).changes).toHaveLength(0);
    expect(reqPlan(bare, ["x"]).changes).toHaveLength(1);
  });

  it("satisfied: a confirmed change set of a request that was satisfied meanwhile is stale", async () => {
    seed();
    const row = requestRow(() => true, {
      needsConfirmation: () => "Sure?",
    });
    const out = await runLiveEdit({
      guildId: GUILD,
      eventId: EV,
      deps: deps(),
      rows: [row],
      confirmed: [{ rowId: "testReq", from: [], to: ["x"] }],
      confirmedRevision: 0,
    });
    expect(out).toMatchObject({ status: "stale" });
  });
});
