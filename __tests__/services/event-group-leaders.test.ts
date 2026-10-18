import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Event group leaders (#1195) against the in-memory stand-in for the Event
 * model (`event-group-fake-event.ts`), with the REAL group lock, the REAL
 * assignment service and the REAL `installLeaderCleanup` subscription, so the
 * "unassigning clears the role" rule is proven through the same `emit` the
 * production code uses. The real write shapes are proven against MongoDB in
 * `__tests__/integration/event-group-leaders.integration.test.ts`.
 */

import {
  store,
  updates,
  fake,
  EventMock,
  type Group,
  type Doc,
} from "./event-group-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));

let eventsEnabled: boolean | "throw" = true;
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({
      getBoolean: async (key: string) => {
        if (key !== "events.enabled") throw new Error(`unexpected key ${key}`);
        if (eventsEnabled === "throw") throw new Error("config unreadable");
        return eventsEnabled;
      },
    }),
  },
}));

/** Members whose reset is "running": the barrier refuses to admit them. */
const resetting = new Set<string>();
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: {
      getInstance: () => ({
        trackWrite: async (
          _userId: string,
          _guildId: string,
          write: () => Promise<void>,
        ) => {
          await write();
          return true;
        },
        admission: () => 1,
        resetAwareWrite: async (
          userIds: string[],
          _guildId: string,
          write: (ids: string[]) => Promise<unknown>,
        ) => {
          const ids = [...new Set(userIds)].filter((id) => !resetting.has(id));
          if (ids.length === 0) return { admitted: [], value: undefined };
          return { admitted: ids, value: await write(ids) };
        },
      }),
    },
  }),
);

const {
  setGroupLeader,
  clearOrphanedLeaders,
  installLeaderCleanup,
  removeLeaderFromEvents,
  setLeaderLabel,
  onLeaderChange,
  effectiveLeaders,
  resolveLeadsChannel,
  planPullLeaders,
} = await import("../../src/services/event-group-leaders.js");
const {
  assignMember: assignMemberReal,
  randomiseMembers: randomiseMembersReal,
  handleGroupSelfJoin,
  removeMemberFromEvents,
} = await import("../../src/services/event-group-assignment.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const assignMember = (o: {
  guildId: string;
  eventId: string;
  userId: string;
  groupKey: string | null;
}) => assignMemberReal({ admission: 1, isConnected: () => true, ...o });

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const EV2 = "65a000000000000000000002";

function group(key: string, over: Partial<Group> = {}): Group {
  return {
    key,
    name: key.toUpperCase(),
    kind: "team",
    size: null,
    channelId: null,
    captainId: null,
    memberIds: [],
    ...over,
  };
}

function seed(over: Partial<Doc> = {}, id = EV): Doc {
  const doc: Doc = {
    _id: id,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    groupsLocked: false,
    captainsEnabled: true,
    leaderLabel: "Leader",
    groups: [
      group("a", { channelId: "ch-a", memberIds: ["ana", "ben"] }),
      group("b", { channelId: "ch-b", memberIds: ["cal"] }),
      group("o", { kind: "open", channelId: "ch-o" }),
      group("l", { kind: "leads", channelId: "ch-l" }),
    ],
    ...over,
  };
  store.set(id, doc);
  return doc;
}

const captainOf = (key: string, id = EV): string | null =>
  store.get(id)?.groups.find((g) => g.key === key)?.captainId ?? null;

const set = (
  groupKey: string,
  userId: string | null,
  over: { admission?: number; eventId?: string } = {},
) =>
  setGroupLeader({
    guildId: GUILD,
    eventId: over.eventId ?? EV,
    groupKey,
    userId,
    admission: over.admission ?? 1,
  });

/** Let fire-and-forget listeners and their queued lock turns finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++)
    await new Promise((r) => globalThis.setTimeout(r, 0));
}

let uninstall: () => void = () => undefined;

beforeEach(() => {
  uninstall();
  store.clear();
  updates.length = 0;
  resetting.clear();
  fake.failUpdatesFor = null;
  fake.delayFor = null;
  fake.gateFindById = null;
  eventsEnabled = true;
  resetMoveGuardForTests();
  uninstall = installLeaderCleanup();
});

describe("setGroupLeader", () => {
  it("makes a member of a team group its leader and replaces one in a single write", async () => {
    seed();
    expect(await set("a", "ana")).toMatchObject({
      ok: true,
      changed: true,
      fromUserId: null,
      toUserId: "ana",
    });
    expect(captainOf("a")).toBe("ana");

    updates.length = 0;
    expect(await set("a", "ben")).toMatchObject({
      ok: true,
      changed: true,
      fromUserId: "ana",
      toUserId: "ben",
    });
    expect(captainOf("a")).toBe("ben");
    expect(updates).toHaveLength(1);
  });

  it("writes only the positional captainId and carries the precondition in its own filter", async () => {
    seed();
    await set("a", "ana");
    expect(updates).toHaveLength(1);
    const [{ filter, update }] = updates as Array<{
      filter: Record<string, unknown>;
      update: { $set: Record<string, unknown> };
    }>;
    expect(Object.keys(update.$set)).toEqual(["groups.$[g].captainId"]);
    expect(filter).toMatchObject({
      groupsEnabled: true,
      captainsEnabled: true,
      groups: {
        $elemMatch: { key: "a", kind: "team", memberIds: "ana" },
      },
    });
  });

  it("refuses someone who is not in that group, and non-team groups", async () => {
    seed();
    expect(await set("a", "cal")).toMatchObject({
      ok: false,
      code: "not-member",
    });
    expect(await set("o", "ana")).toMatchObject({
      ok: false,
      code: "not-team",
    });
    expect(await set("l", "ana")).toMatchObject({
      ok: false,
      code: "not-team",
    });
    expect(await set("zzz", "ana")).toMatchObject({
      ok: false,
      code: "no-group",
    });
    expect(captainOf("a")).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it("changes nothing when asked for the leader it already has", async () => {
    seed();
    await set("a", "ana");
    updates.length = 0;
    expect(await set("a", "ana")).toMatchObject({ ok: true, changed: false });
    expect(await set("b", null)).toMatchObject({ ok: true, changed: false });
    expect(updates).toHaveLength(0);
  });

  it("clears a leader", async () => {
    seed();
    await set("a", "ana");
    expect(await set("a", null)).toMatchObject({
      ok: true,
      changed: true,
      fromUserId: "ana",
      toUserId: null,
    });
    expect(captainOf("a")).toBeNull();
  });

  it("is gated on the event's leaders switch (decided on the fresh row) and on events.enabled", async () => {
    seed({ captainsEnabled: false });
    expect(await set("a", "ana")).toMatchObject({
      ok: false,
      code: "leaders-off",
    });
    seed();
    eventsEnabled = false;
    expect(await set("a", "ana")).toMatchObject({
      ok: false,
      code: "events-off",
    });
    // Fails closed: an unreadable switch counts as off.
    eventsEnabled = "throw";
    expect(await set("a", "ana")).toMatchObject({
      ok: false,
      code: "events-off",
    });
    expect(captainOf("a")).toBeNull();
  });

  it("lets a leader be cleared while the switches are off (a host can always tidy up)", async () => {
    seed({ groups: [group("a", { memberIds: ["ana"], captainId: "ana" })] });
    eventsEnabled = false;
    store.get(EV)!.captainsEnabled = false;
    expect(await set("a", null)).toMatchObject({ ok: true, changed: true });
    expect(captainOf("a")).toBeNull();
  });

  it("refuses a finished event, an unknown event and an event without groups", async () => {
    seed({ state: "ended" });
    expect(await set("a", "ana")).toMatchObject({ code: "closed" });
    seed({ state: "cancelled" });
    expect(await set("a", null)).toMatchObject({ code: "closed" });
    seed({ groupsEnabled: false, groups: [] });
    expect(await set("a", "ana")).toMatchObject({ code: "no-groups" });
    expect(await set("a", "ana", { eventId: "not-an-id" })).toMatchObject({
      code: "not-found",
    });
  });

  it("refuses a member whose data reset is running; clearing is never refused", async () => {
    seed({ groups: [group("a", { memberIds: ["ana"], captainId: "ana" })] });
    resetting.add("ana");
    expect(await set("a", "ana", { admission: 0 })).toMatchObject({
      ok: false,
      code: "member-reset",
    });
    expect(await set("a", null)).toMatchObject({ ok: true, changed: true });
  });

  it("reports write-failed, never success, when the write matched no element", async () => {
    seed();
    // The member leaves the group between the fresh read and the write: the
    // read-decide-write lock normally prevents it, so simulate a writer that
    // does not hold it.
    const realUpdate = EventMock.updateOne;
    EventMock.updateOne = (async (
      filter: Record<string, unknown>,
      update: never,
      options: never,
    ) => {
      store.get(EV)!.groups[0].memberIds = [];
      return realUpdate(filter, update, options);
    }) as typeof EventMock.updateOne;
    try {
      expect(await set("a", "ana")).toMatchObject({
        ok: false,
        code: "write-failed",
      });
    } finally {
      EventMock.updateOne = realUpdate;
    }
    expect(captainOf("a")).toBeNull();
  });

  it("decides from the fresh row inside the lock: an unassign that queued first wins", async () => {
    seed();
    // Both calls are issued together; the unassign takes the lock first, so
    // the leader write finds the member gone and is refused.
    const unassign = assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "ana",
      groupKey: null,
    });
    const lead = set("a", "ana");
    const [u, l] = await Promise.all([unassign, lead]);
    expect(u).toMatchObject({ ok: true });
    expect(l).toMatchObject({ ok: false, code: "not-member" });
    await settle();
    expect(captainOf("a")).toBeNull();
  });
});

describe("unassigning clears the role (through the assignment hook)", () => {
  it("clears the leader when the host unassigns them", async () => {
    seed();
    await set("a", "ana");
    await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "ana",
      groupKey: null,
    });
    await settle();
    expect(captainOf("a")).toBeNull();
    expect(store.get(EV)!.groups[0].memberIds).toEqual(["ben"]);
  });

  it("clears the leader when the host moves them to another group, and leaves other leaders", async () => {
    seed();
    await set("a", "ana");
    await set("b", "cal");
    await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "ana",
      groupKey: "b",
    });
    await settle();
    expect(captainOf("a")).toBeNull();
    expect(captainOf("b")).toBe("cal");
  });

  it("clears the leader when a self-join moves them into another group", async () => {
    seed();
    await set("a", "ana");
    const outcome = await handleGroupSelfJoin({
      guildId: GUILD,
      userId: "ana",
      channelId: "ch-b",
      admission: 1,
    });
    expect(outcome).toBe("recorded");
    await settle();
    expect(captainOf("a")).toBeNull();
  });

  it("clears a leader whom a randomise dealt into another group, and keeps one it left in place", async () => {
    // A dealt-again leader keeps the role only if the deal put them back in
    // the group they lead. Try several seeds: both outcomes must occur, and
    // the rule must hold for each.
    const outcomes = new Set<string>();
    for (let seedValue = 1; seedValue <= 12; seedValue++) {
      seed({
        groups: [
          group("a", { size: 1, memberIds: ["ana"], captainId: "ana" }),
          group("b", { memberIds: [] }),
        ],
      });
      await randomiseMembersReal({
        guildId: GUILD,
        eventId: EV,
        candidateIds: ["ana", "ben", "cal"],
        mode: "everyone",
        seed: seedValue,
        admission: 1,
      });
      await settle();
      const inA = store.get(EV)!.groups[0].memberIds.includes("ana");
      expect(captainOf("a")).toBe(inA ? "ana" : null);
      outcomes.add(inA ? "kept" : "cleared");
    }
    expect([...outcomes].sort()).toEqual(["cleared", "kept"]);
  });

  it("clears the leader when a member data reset pulls them out of their group", async () => {
    seed();
    await set("a", "ana");
    await removeMemberFromEvents(GUILD, "ana");
    await settle();
    expect(captainOf("a")).toBeNull();
  });

  it("decides from the fresh row: a member moved back in before the cleanup ran stays leader", async () => {
    seed();
    await set("a", "ana");
    // Unassign and re-assign are issued back to back, so the cleanup that the
    // unassign queued runs AFTER the re-assign. The change it was told about
    // ("ana left a") is stale by then.
    const out = assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "ana",
      groupKey: null,
    });
    const back = assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "ana",
      groupKey: "a",
    });
    await Promise.all([out, back]);
    await settle();
    expect(store.get(EV)!.groups[0].memberIds).toContain("ana");
    expect(captainOf("a")).toBe("ana");
  });

  it("does nothing for a person who was in no group, and installs only once", async () => {
    seed();
    const again = installLeaderCleanup();
    expect(again).toBe(uninstall);
    await set("a", "ana");
    updates.length = 0;
    await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "newcomer",
      groupKey: "b",
    });
    await settle();
    // Only the assignment's own write; the cleanup found nothing to clear.
    expect(updates).toHaveLength(1);
    expect(captainOf("a")).toBe("ana");
  });

  it("a cleanup that fails is logged and never fails the assignment", async () => {
    seed();
    await set("a", "ana");
    const realFindOne = EventMock.findOne;
    let calls = 0;
    EventMock.findOne = ((filter: Record<string, unknown>) => {
      calls++;
      // The assignment's own fresh read is call 1; the cleanup's is call 2.
      if (calls === 2) {
        return {
          select: () => ({
            lean: async () => {
              throw new Error("db down");
            },
          }),
        };
      }
      return realFindOne(filter);
    }) as typeof EventMock.findOne;
    try {
      const result = await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "ana",
        groupKey: null,
      });
      expect(result).toMatchObject({ ok: true });
      await settle();
    } finally {
      EventMock.findOne = realFindOne;
    }
    // The stored id survives, but nobody treats it as a leader.
    expect(captainOf("a")).toBe("ana");
    expect(effectiveLeaders(store.get(EV)!.groups)).toEqual([]);
  });

  it("clearOrphanedLeaders clears only leaders who left their group, conditional on the same id", async () => {
    seed({
      groups: [
        group("a", { memberIds: ["ben"], captainId: "ana" }),
        group("b", { memberIds: ["cal"], captainId: "cal" }),
      ],
    });
    updates.length = 0;
    expect(await clearOrphanedLeaders(GUILD, EV)).toBe(1);
    expect(captainOf("a")).toBeNull();
    expect(captainOf("b")).toBe("cal");
    const [{ update }] = updates as Array<{
      update: { $set: Record<string, unknown> };
    }>;
    expect(Object.keys(update.$set)).toEqual(["groups.$[g0].captainId"]);
    expect(await clearOrphanedLeaders(GUILD, EV)).toBe(0);
  });
});

describe("effectiveLeaders and the reads built on it", () => {
  it("counts a captainId only while the person is also a member of that team group", () => {
    const groups = [
      group("a", { memberIds: ["ana"], captainId: "ana" }),
      group("b", { memberIds: ["cal"], captainId: "ben" }),
      group("o", { kind: "open", memberIds: ["dan"], captainId: "dan" }),
      group("c", { memberIds: ["eve"], captainId: null }),
    ];
    expect(effectiveLeaders(groups)).toEqual([
      { groupKey: "a", userId: "ana" },
    ]);
    expect(effectiveLeaders(undefined)).toEqual([]);
  });

  it("resolveLeadsChannel is the leads group's channel, or null", () => {
    expect(
      resolveLeadsChannel({
        groups: [
          { key: "a", name: "A", kind: "team", channelId: "ch-a" },
          { key: "l", name: "L", kind: "leads", channelId: "ch-l" },
        ],
      }),
    ).toBe("ch-l");
    expect(
      resolveLeadsChannel({
        groups: [{ key: "l", name: "L", kind: "leads", channelId: null }],
      }),
    ).toBeNull();
    expect(resolveLeadsChannel({})).toBeNull();
  });
});

describe("the hook for the leads channel (#1199)", () => {
  it("fires once per leader change: host set, replace, clear, unassign cleanup and reset", async () => {
    seed();
    const seen: Array<Record<string, unknown>> = [];
    const off = onLeaderChange((c) => {
      seen.push({ ...c });
    });
    await set("a", "ana");
    await set("a", "ben");
    await set("a", null);
    await set("a", "ana");
    await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "ana",
      groupKey: null,
    });
    await settle();
    await set("b", "cal");
    await removeLeaderFromEvents(GUILD, "cal");
    off();
    expect(seen).toEqual([
      expect.objectContaining({
        groupKey: "a",
        fromUserId: null,
        toUserId: "ana",
        source: "host",
      }),
      expect.objectContaining({
        fromUserId: "ana",
        toUserId: "ben",
        source: "host",
      }),
      expect.objectContaining({
        fromUserId: "ben",
        toUserId: null,
        source: "host",
      }),
      expect.objectContaining({ fromUserId: null, toUserId: "ana" }),
      expect.objectContaining({
        groupKey: "a",
        fromUserId: "ana",
        toUserId: null,
        source: "unassigned",
      }),
      expect.objectContaining({ groupKey: "b", toUserId: "cal" }),
      expect.objectContaining({
        groupKey: "b",
        fromUserId: "cal",
        toUserId: null,
        source: "purge",
      }),
    ]);
  });

  it("does not fire for a refused or unchanged change, and a throwing listener changes nothing", async () => {
    seed();
    const seen: unknown[] = [];
    const off = onLeaderChange((c) => {
      seen.push(c);
      throw new Error("listener broke");
    });
    await set("a", "cal"); // not a member
    await set("a", null); // already none
    expect(seen).toHaveLength(0);
    expect(await set("a", "ana")).toMatchObject({ ok: true, changed: true });
    expect(seen).toHaveLength(1);
    expect(captainOf("a")).toBe("ana");
    off();
  });
});

describe("review findings on #1222", () => {
  it("the hook names the unassigned leader as 'from' when a replacement ran before their cleanup", async () => {
    seed();
    await set("a", "ana");
    const seen: Array<Record<string, unknown>> = [];
    const off = onLeaderChange((c) => {
      seen.push({ ...c });
    });
    // The unassign takes the lock first; the replacement is already queued
    // behind it, so it runs BEFORE the cleanup the unassign queued.
    const unassign = assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "ana",
      groupKey: null,
    });
    const replace = set("a", "ben");
    await Promise.all([unassign, replace]);
    await settle();
    off();
    expect(captainOf("a")).toBe("ben");
    expect(seen).toEqual([
      expect.objectContaining({
        groupKey: "a",
        fromUserId: "ana",
        toUserId: "ben",
      }),
    ]);
  });

  it("a randomise of many people costs a few cleanup reads, not one per person, and leaves no orphan", async () => {
    const many = Array.from({ length: 24 }, (_, i) => `p${i}`);
    seed({
      groups: [
        group("a", { memberIds: [...many], captainId: "p0" }),
        group("b", { memberIds: [] }),
      ],
    });
    const realFindOne = EventMock.findOne;
    let reads = 0;
    EventMock.findOne = ((filter: Record<string, unknown>) => {
      reads++;
      return realFindOne(filter);
    }) as typeof EventMock.findOne;
    try {
      for (const seedValue of [1, 2, 3]) {
        reads = 0;
        store.get(EV)!.groups[0].memberIds = [...many];
        store.get(EV)!.groups[1].memberIds = [];
        store.get(EV)!.groups[0].captainId = "p0";
        await randomiseMembersReal({
          guildId: GUILD,
          eventId: EV,
          candidateIds: many,
          mode: "everyone",
          seed: seedValue,
          admission: 1,
        });
        await settle();
        // The randomise's own read plus a couple of passes.
        expect(reads).toBeLessThanOrEqual(4);
        const inA = store.get(EV)!.groups[0].memberIds.includes("p0");
        expect(captainOf("a")).toBe(inA ? "p0" : null);
      }
    } finally {
      EventMock.findOne = realFindOne;
    }
  });

  it("a change that arrives while a cleanup pass is running gets another pass", async () => {
    seed();
    await set("a", "ana");
    await set("b", "cal");
    // Two unassigns back to back: the second lands after the first pass has
    // started its read, so it must queue one more.
    await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "ana",
      groupKey: null,
    });
    await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "cal",
      groupKey: null,
    });
    await settle();
    expect(captainOf("a")).toBeNull();
    expect(captainOf("b")).toBeNull();
  });

  it("a reset counts an event the unassign cleanup already cleared as done", async () => {
    seed();
    await set("a", "ana");
    // The membership purge fires the cleanup, which queues on the lock ahead
    // of the leader step's own turn; the leader step then finds it cleared.
    const [members, leader] = await Promise.all([
      removeMemberFromEvents(GUILD, "ana"),
      removeLeaderFromEvents(GUILD, "ana"),
    ]);
    await settle();
    expect(members.removed).toBe(members.matched);
    expect(leader.removed).toBe(leader.matched);
    expect(leader.failed).toBe(0);
    expect(captainOf("a")).toBeNull();
  });

  it("a reset counts an event cleared between its search and its locked read as done", async () => {
    seed({ groups: [group("a", { memberIds: ["ana"], captainId: "ana" })] });
    const realFind = EventMock.find;
    EventMock.find = ((filter: Record<string, unknown>) => {
      const q = realFind(filter);
      return {
        select: () => ({
          lean: async () => {
            const rows = await q.lean();
            // The cleanup lands after the search found the event.
            store.get(EV)!.groups[0].captainId = null;
            return rows;
          },
        }),
      };
    }) as typeof EventMock.find;
    try {
      expect(await removeLeaderFromEvents(GUILD, "ana")).toEqual({
        matched: 1,
        removed: 1,
        failed: 0,
      });
    } finally {
      EventMock.find = realFind;
    }
  });

  it("two resets of the same member both count as done", async () => {
    seed();
    const [one, two] = await Promise.all([
      removeMemberFromEvents(GUILD, "ana"),
      removeMemberFromEvents(GUILD, "ana"),
    ]);
    expect(one.removed).toBe(one.matched);
    expect(two.removed).toBe(two.matched);
  });

  it("a reset whose event vanished counts it as done", async () => {
    seed({ groups: [group("a", { memberIds: ["ana"], captainId: "ana" })] });
    const realFindOne = EventMock.findOne;
    EventMock.findOne = ((filter: Record<string, unknown>) => {
      const q = realFindOne(filter);
      return {
        select: () => ({
          lean: async () => {
            store.clear();
            return null;
          },
        }),
        lean: q.lean,
      };
    }) as typeof EventMock.findOne;
    try {
      const r = await removeLeaderFromEvents(GUILD, "ana");
      expect(r).toEqual({ matched: 1, removed: 1, failed: 0 });
    } finally {
      EventMock.findOne = realFindOne;
    }
  });
});

describe("removeLeaderFromEvents (member data reset)", () => {
  it("clears the member in every event of the guild, finished ones and orphaned ids included", async () => {
    seed({ groups: [group("a", { memberIds: ["ana"], captainId: "ana" })] });
    seed(
      {
        state: "ended",
        groups: [
          group("a", { memberIds: ["ben"], captainId: "ana" }),
          group("b", { memberIds: ["ana"], captainId: "cal" }),
        ],
      },
      EV2,
    );
    store.set("65a000000000000000000003", {
      ...store.get(EV)!,
      _id: "65a000000000000000000003",
      guildId: "other-guild",
      groups: [group("a", { memberIds: ["ana"], captainId: "ana" })],
    });
    const result = await removeLeaderFromEvents(GUILD, "ana");
    expect(result).toEqual({ matched: 2, removed: 2, failed: 0 });
    expect(captainOf("a")).toBeNull();
    expect(captainOf("a", EV2)).toBeNull();
    // Another leader of the same event and another guild are untouched.
    expect(captainOf("b", EV2)).toBe("cal");
    expect(captainOf("a", "65a000000000000000000003")).toBe("ana");
    expect(await removeLeaderFromEvents(GUILD, "ana")).toEqual({
      matched: 0,
      removed: 0,
      failed: 0,
    });
  });

  it("counts a failed event and carries on with the others", async () => {
    seed({ groups: [group("a", { memberIds: ["ana"], captainId: "ana" })] });
    seed(
      { groups: [group("a", { memberIds: ["ana"], captainId: "ana" })] },
      EV2,
    );
    fake.failUpdatesFor = EV;
    const result = await removeLeaderFromEvents(GUILD, "ana");
    expect(result).toEqual({ matched: 2, removed: 1, failed: 1 });
    expect(captainOf("a", EV2)).toBeNull();
  });
});

describe("setLeaderLabel", () => {
  it("renames on a running event with leaders on, writing only the label", async () => {
    seed();
    updates.length = 0;
    expect(
      await setLeaderLabel({ guildId: GUILD, eventId: EV, label: "Captain" }),
    ).toEqual({ ok: true });
    expect(store.get(EV)!.leaderLabel).toBe("Captain");
    expect(
      (updates[0] as { update: { $set: Record<string, unknown> } }).update.$set,
    ).toEqual({ leaderLabel: "Captain" });
  });

  it("refuses with leaders off, a finished event and no groups", async () => {
    seed({ captainsEnabled: false });
    expect(
      await setLeaderLabel({ guildId: GUILD, eventId: EV, label: "X" }),
    ).toMatchObject({ ok: false, code: "leaders-off" });
    seed({ state: "ended" });
    expect(
      await setLeaderLabel({ guildId: GUILD, eventId: EV, label: "X" }),
    ).toMatchObject({ ok: false, code: "closed" });
    seed({ groupsEnabled: false, groups: [] });
    expect(
      await setLeaderLabel({ guildId: GUILD, eventId: EV, label: "X" }),
    ).toMatchObject({ ok: false, code: "no-groups" });
  });
});

describe("planPullLeaders", () => {
  const present = (id: string, channelId: string) => ({
    id,
    name: id,
    channelId,
  });
  const event = (over: Record<string, unknown> = {}) =>
    ({
      _id: EV,
      guildId: GUILD,
      state: "active",
      groupsEnabled: true,
      captainsEnabled: true,
      leaderLabel: "Captain",
      channelId: "ch-main",
      createdBy: "host",
      groups: [
        {
          key: "a",
          name: "A",
          kind: "team",
          channelId: "ch-a",
          memberIds: ["ana", "ben"],
          captainId: "ana",
        },
        {
          key: "b",
          name: "B",
          kind: "team",
          channelId: "ch-b",
          memberIds: ["cal"],
          captainId: "cal",
        },
        {
          key: "l",
          name: "L",
          kind: "leads",
          channelId: "ch-l",
          memberIds: [],
        },
      ],
      ...over,
    }) as never;
  const presence = {
    ok: true,
    members: [present("host", "ch-b"), present("ana", "ch-a")],
  };

  it("wishes for every leader, to the leads channel by default", () => {
    expect(planPullLeaders(event(), presence, "default", "host")).toEqual([
      { userId: "ana", toChannelId: "ch-l" },
      { userId: "cal", toChannelId: "ch-l" },
    ]);
  });

  it("falls back to the main channel, then to the acting host's channel", () => {
    const noLeads = event({
      groups: (event() as { groups: unknown[] }).groups.slice(0, 2),
    });
    expect(planPullLeaders(noLeads, presence, "default", "host")).toEqual([
      { userId: "ana", toChannelId: "ch-main" },
      { userId: "cal", toChannelId: "ch-main" },
    ]);
    const noMain = event({
      channelId: null,
      groups: (event() as { groups: unknown[] }).groups.slice(0, 2),
    });
    expect(planPullLeaders(noMain, presence, "default", "host")).toEqual([
      { userId: "ana", toChannelId: "ch-b" },
      { userId: "cal", toChannelId: "ch-b" },
    ]);
    expect(planPullLeaders(noMain, presence, "default", "stranger")).toEqual({
      refuse: expect.stringContaining("does not exist"),
    });
  });

  it("maps main, here and a group key from the row, never a posted channel id", () => {
    expect(planPullLeaders(event(), presence, "main", "host")).toEqual([
      { userId: "ana", toChannelId: "ch-main" },
      { userId: "cal", toChannelId: "ch-main" },
    ]);
    expect(planPullLeaders(event(), presence, "here", "host")).toEqual([
      { userId: "ana", toChannelId: "ch-b" },
      { userId: "cal", toChannelId: "ch-b" },
    ]);
    expect(planPullLeaders(event(), presence, "a", "host")).toEqual([
      { userId: "ana", toChannelId: "ch-a" },
      { userId: "cal", toChannelId: "ch-a" },
    ]);
    for (const bad of ["ch-main", "ch-a", " a", "nope", ""]) {
      expect(planPullLeaders(event(), presence, bad, "host")).toEqual({
        refuse: expect.any(String),
      });
    }
    expect(planPullLeaders(event(), presence, "here", "stranger")).toEqual({
      refuse: expect.stringContaining("not connected"),
    });
  });

  it("refuses with leaders off on the fresh row, and with no leader", () => {
    expect(
      planPullLeaders(event({ captainsEnabled: false }), presence, "main", "h"),
    ).toEqual({ refuse: expect.stringContaining("not switched on") });
    expect(
      planPullLeaders(
        event({ captainsEnabled: undefined }),
        presence,
        "main",
        "h",
      ),
    ).toEqual({ refuse: expect.stringContaining("not switched on") });
    const none = event({
      groups: [
        {
          key: "a",
          name: "A",
          kind: "team",
          channelId: "ch-a",
          memberIds: [],
          captainId: null,
        },
      ],
    });
    expect(planPullLeaders(none, presence, "main", "host")).toEqual({
      refuse: expect.stringContaining("no captains"),
    });
  });

  it("never wishes for a captainId who is no longer a member (a stale or failed clear)", () => {
    const stale = event({
      groups: [
        {
          key: "a",
          name: "A",
          kind: "team",
          channelId: "ch-a",
          memberIds: ["ben"],
          captainId: "ana",
        },
        {
          key: "b",
          name: "B",
          kind: "team",
          channelId: "ch-b",
          memberIds: ["cal"],
          captainId: "cal",
        },
      ],
    });
    expect(planPullLeaders(stale, presence, "main", "host")).toEqual([
      { userId: "cal", toChannelId: "ch-main" },
    ]);
  });
});
