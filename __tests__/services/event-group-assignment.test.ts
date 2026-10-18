import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Event group membership (#1191) against an in-memory stand-in for the Event
 * model. The stand-in understands exactly the update shapes the service
 * writes (`$set` of `groups.$[gN].memberIds` with `arrayFilters`, `$set` of a
 * top-level field, `$pull` from `groups.$[].memberIds`) and yields to the event
 * loop on every read so that unlocked callers interleave. The real shapes are
 * proven against MongoDB in `__tests__/integration/event-group-members`.
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

const optedOut = new Set<string>();
let staleTicket = false;
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: {
      getInstance: () => ({
        trackWrite: async (
          userId: string,
          _guildId: string,
          write: () => Promise<void>,
          since?: number,
        ) => {
          if (optedOut.has(userId)) return false;
          if (since !== undefined && staleTicket) return false;
          await write();
          return true;
        },
        admission: () => 1,
        // The real barrier is exercised in event-group-reset-race.test.ts.
        resetAwareWrite: async (
          userIds: string[],
          _guildId: string,
          write: (ids: string[]) => Promise<unknown>,
        ) => {
          const ids = [...new Set(userIds)];
          return { admitted: ids, value: await write(ids) };
        },
      }),
    },
  }),
);

const {
  assignMember: assignMemberReal,
  randomiseMembers: randomiseMembersReal,
  setGroupsLocked,
  handleGroupSelfJoin,
  removeMemberFromEvents,
  onGroupAssignmentChange,
} = await import("../../src/services/event-group-assignment.js");

type AssignOpts = Parameters<typeof assignMemberReal>[0];
type RandomiseOpts = Parameters<typeof randomiseMembersReal>[0];
const assignMember = (
  o: Omit<AssignOpts, "admission" | "isConnected"> &
    Partial<Pick<AssignOpts, "isConnected">>,
) => assignMemberReal({ admission: 1, isConnected: () => true, ...o });
const randomiseMembers = (o: Omit<RandomiseOpts, "admission">) =>
  randomiseMembersReal({ admission: 1, ...o });

const GUILD = "guild-1";
const EV = "65a000000000000000000001";

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
    groups: [
      group("a", { size: 1, channelId: "ch-a", captainId: "cap-1" }),
      group("b", { channelId: "ch-b" }),
      group("o", { kind: "open", channelId: "ch-o" }),
    ],
    ...over,
  };
  store.set(id, doc);
  return doc;
}

const members = (key: string, id = EV): string[] =>
  store.get(id)?.groups.find((g) => g.key === key)?.memberIds ?? [];

beforeEach(() => {
  store.clear();
  updates.length = 0;
  optedOut.clear();
  staleTicket = false;
  fake.failUpdatesFor = null;
  fake.delayFor = null;
  eventsEnabled = true;
});

describe("assignMember", () => {
  it("assigns, moves and unassigns, one group per member", async () => {
    seed();
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "b",
      }),
    ).toMatchObject({ ok: true, changed: true, fromKey: null, toKey: "b" });
    expect(members("b")).toEqual(["u1"]);

    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "a",
      }),
    ).toMatchObject({ ok: true, changed: true, fromKey: "b", toKey: "a" });
    expect(members("a")).toEqual(["u1"]);
    expect(members("b")).toEqual([]);

    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: null,
      }),
    ).toMatchObject({ ok: true, changed: true, fromKey: "a", toKey: null });
    expect(members("a")).toEqual([]);
  });

  it("refuses a full group with a clear message and writes nothing", async () => {
    seed();
    await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "u1",
      groupKey: "a",
    });
    updates.length = 0;
    const result = await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "u2",
      groupKey: "a",
    });
    expect(result).toMatchObject({ ok: false, code: "full" });
    expect(result.ok ? "" : result.message).toBe("That group is full.");
    expect(updates).toEqual([]);
    expect(members("a")).toEqual(["u1"]);
  });

  it("checks presence only for a real add, decided from the fresh row inside the lock", async () => {
    seed({
      groups: [group("a", { memberIds: ["away"] }), group("b")],
    });
    // The member is offline. A host's unassign wins the lock first; the move
    // that was prepared while they were still placed must now be an add and
    // be refused, not slip through on the stale "already in a group".
    const [unassign, move] = await Promise.all([
      assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "away",
        groupKey: null,
      }),
      assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "away",
        groupKey: "b",
        isConnected: () => false,
      }),
    ]);
    expect(unassign).toMatchObject({ ok: true, changed: true });
    expect(move).toMatchObject({ ok: false, code: "not-connected" });
    expect(members("a")).toEqual([]);
    expect(members("b")).toEqual([]);
  });

  it("moves an offline member who is still placed without asking about presence", async () => {
    seed({ groups: [group("a", { memberIds: ["away"] }), group("b")] });
    const asked = jest.fn(() => false);
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "away",
        groupKey: "b",
        isConnected: asked,
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(asked).not.toHaveBeenCalled();
    expect(members("b")).toEqual(["away"]);
  });

  it("refuses an add when the voice state cannot be read or the person is not connected", async () => {
    seed();
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "b",
        isConnected: () => null,
      }),
    ).toMatchObject({ ok: false, code: "no-voice-state" });
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "b",
        isConnected: () => false,
      }),
    ).toMatchObject({ ok: false, code: "not-connected" });
    expect(members("b")).toEqual([]);
  });

  it("refuses non-team groups, unknown groups and finished events", async () => {
    seed();
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "o",
      }),
    ).toMatchObject({ ok: false, code: "not-team" });
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "zz",
      }),
    ).toMatchObject({ ok: false, code: "no-group" });
    store.get(EV)!.state = "ended";
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "b",
      }),
    ).toMatchObject({ ok: false, code: "closed" });
    store.get(EV)!.state = "active";
    store.get(EV)!.groupsEnabled = false;
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "b",
      }),
    ).toMatchObject({ ok: false, code: "no-groups" });
    expect(
      await assignMember({
        guildId: "other",
        eventId: EV,
        userId: "u1",
        groupKey: "b",
      }),
    ).toMatchObject({ ok: false, code: "not-found" });
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: "not-an-id",
        userId: "u1",
        groupKey: "b",
      }),
    ).toMatchObject({ ok: false, code: "not-found" });
  });

  it("writes only the memberIds of the groups that changed, never the groups array", async () => {
    seed();
    await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "u1",
      groupKey: "a",
    });
    await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: "u1",
      groupKey: "b",
    });
    expect(updates.length).toBe(2);
    for (const { update } of updates) {
      const set = (update as { $set: Record<string, unknown> }).$set;
      for (const path of Object.keys(set)) {
        expect(path).toMatch(/^groups\.\$\[g\d+\]\.memberIds$/);
      }
    }
    // The other writers' fields are untouched.
    expect(store.get(EV)!.groups[0].captainId).toBe("cap-1");
    expect(store.get(EV)!.groups[0].channelId).toBe("ch-a");
    // And the write is conditional on the event still being open with groups.
    expect(updates[0].filter).toMatchObject({
      groupsEnabled: true,
      state: { $in: ["scheduled", "active"] },
    });
  });

  it("refuses when the event ended between the read and the write", async () => {
    seed();
    const real = EventMock.updateOne;
    EventMock.updateOne = async (...args: Parameters<typeof real>) => {
      store.get(EV)!.state = "ended";
      return real(...args);
    };
    try {
      expect(
        await assignMember({
          guildId: GUILD,
          eventId: EV,
          userId: "u1",
          groupKey: "b",
        }),
      ).toMatchObject({ ok: false, code: "write-failed" });
      expect(members("b")).toEqual([]);
    } finally {
      EventMock.updateOne = real;
    }
  });

  it("cannot exceed a group's size when two assignments arrive at once", async () => {
    seed();
    const results = await Promise.all(
      ["u1", "u2", "u3", "u4"].map((userId) =>
        assignMember({ guildId: GUILD, eventId: EV, userId, groupKey: "a" }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "full")).toHaveLength(3);
    expect(members("a")).toHaveLength(1);
  });

  it("keeps a member in one group when they are assigned to two at once", async () => {
    seed();
    await Promise.all([
      assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "a",
      }),
      assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "b",
      }),
      assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "a",
      }),
    ]);
    const holders = store
      .get(EV)!
      .groups.filter((g) => g.memberIds.includes("u1"));
    expect(holders).toHaveLength(1);
  });
});

describe("onGroupAssignmentChange", () => {
  it("fires after a change, never for a no-op, and a failing listener cannot break it", async () => {
    seed();
    const seen: unknown[] = [];
    const off = onGroupAssignmentChange((c) => {
      seen.push(c);
    });
    const off2 = onGroupAssignmentChange(() => {
      throw new Error("listener bug");
    });
    try {
      const r = await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "b",
      });
      expect(r.ok).toBe(true);
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "u1",
        groupKey: "b",
      });
      expect(seen).toEqual([
        {
          eventId: EV,
          guildId: GUILD,
          userId: "u1",
          fromKey: null,
          toKey: "b",
          source: "host",
        },
      ]);
    } finally {
      off();
      off2();
    }
  });
});

describe("randomiseMembers", () => {
  it("writes the deal in one update and reports the overflow", async () => {
    seed({
      groups: [
        group("a", { size: 2 }),
        group("b", { size: 1 }),
        group("o", { kind: "open" }),
      ],
    });
    const seen: string[] = [];
    const off = onGroupAssignmentChange((c) => {
      seen.push(`${c.userId}:${c.toKey}:${c.source}`);
    });
    try {
      const result = await randomiseMembers({
        guildId: GUILD,
        eventId: EV,
        candidateIds: ["u1", "u2", "u3", "u4", "u5"],
        mode: "unassigned",
        seed: 42,
      });
      if (!result.ok) throw new Error("expected success");
      expect(result.placed).toHaveLength(3);
      expect(result.unplaced).toHaveLength(2);
      expect(members("a")).toHaveLength(2);
      expect(members("b")).toHaveLength(1);
      expect(members("o")).toEqual([]);
      expect(updates).toHaveLength(1);
      expect(seen).toHaveLength(3);
      expect(seen.every((s) => s.endsWith(":random"))).toBe(true);
    } finally {
      off();
    }
  });

  it("gives the same deal for the same seed", async () => {
    const run = async (): Promise<string[][]> => {
      seed({ groups: [group("a"), group("b")] });
      await randomiseMembers({
        guildId: GUILD,
        eventId: EV,
        candidateIds: ["u1", "u2", "u3", "u4", "u5", "u6"],
        mode: "unassigned",
        seed: 7,
      });
      return [members("a"), members("b")];
    };
    expect(await run()).toEqual(await run());
  });

  it("refuses an event without team groups", async () => {
    seed({ groups: [group("o", { kind: "open" })] });
    expect(
      await randomiseMembers({
        guildId: GUILD,
        eventId: EV,
        candidateIds: ["u1"],
        mode: "unassigned",
        seed: 1,
      }),
    ).toMatchObject({ ok: false, code: "no-teams" });
  });
});

describe("setGroupsLocked", () => {
  it("sets the flag to the requested state and refuses a finished event", async () => {
    seed();
    expect(
      await setGroupsLocked({ guildId: GUILD, eventId: EV, locked: true }),
    ).toEqual({
      ok: true,
    });
    expect(store.get(EV)!.groupsLocked).toBe(true);
    // Posting the same state twice does not flip it back.
    await setGroupsLocked({ guildId: GUILD, eventId: EV, locked: true });
    expect(store.get(EV)!.groupsLocked).toBe(true);
    await setGroupsLocked({ guildId: GUILD, eventId: EV, locked: false });
    expect(store.get(EV)!.groupsLocked).toBe(false);
    store.get(EV)!.state = "ended";
    expect(
      await setGroupsLocked({ guildId: GUILD, eventId: EV, locked: true }),
    ).toMatchObject({ ok: false, code: "closed" });
  });
});

describe("handleGroupSelfJoin", () => {
  const join = (userId: string, channelId: string, admission = 1) =>
    handleGroupSelfJoin({ guildId: GUILD, userId, channelId, admission });

  it("records a member who joins a team group's channel", async () => {
    seed();
    expect(await join("u1", "ch-b")).toBe("recorded");
    expect(members("b")).toEqual(["u1"]);
  });

  it("moves the assignment when they join another team channel", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a" }),
        group("b", { channelId: "ch-b" }),
      ],
    });
    await join("u1", "ch-a");
    expect(await join("u1", "ch-b")).toBe("recorded");
    expect(members("a")).toEqual([]);
    expect(members("b")).toEqual(["u1"]);
    expect(await join("u1", "ch-b")).toBe("unchanged");
  });

  it("changes nothing when groups are locked, even for a member who hops channels", async () => {
    seed({
      groupsLocked: true,
      groups: [
        group("a", { channelId: "ch-a", memberIds: ["u1"] }),
        group("b", { channelId: "ch-b" }),
      ],
    });
    expect(await join("u1", "ch-b")).toBe("locked");
    expect(members("a")).toEqual(["u1"]);
    expect(members("b")).toEqual([]);
    // A newcomer is not recorded either.
    expect(await join("u2", "ch-b")).toBe("locked");
    expect(updates).toEqual([]);
  });

  it("keeps the stored group when the member joins an open channel or the main channel", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a", memberIds: ["u1"] }),
        group("o", { kind: "open", channelId: "ch-o" }),
      ],
    });
    expect(await join("u1", "ch-o")).toBe("not-team");
    expect(await join("u1", "ch-main")).toBe("no-event");
    expect(members("a")).toEqual(["u1"]);
  });

  it("does not record into a full group", async () => {
    seed({
      groups: [group("a", { size: 1, channelId: "ch-a", memberIds: ["u1"] })],
    });
    expect(await join("u2", "ch-a")).toBe("full");
    expect(members("a")).toEqual(["u1"]);
  });

  it("ignores finished events and events without groups enabled", async () => {
    seed({ state: "ended" });
    expect(await join("u1", "ch-b")).toBe("no-event");
    seed({ state: "active", groupsEnabled: false });
    expect(await join("u1", "ch-b")).toBe("no-event");
    expect(updates).toEqual([]);
  });

  it("writes nothing for a member who opted out or is being reset", async () => {
    seed();
    optedOut.add("u1");
    expect(await join("u1", "ch-b")).toBe("blocked");
    staleTicket = true;
    expect(await join("u2", "ch-b")).toBe("blocked");
    expect(members("b")).toEqual([]);
  });

  it("cannot exceed a size when several members join at once", async () => {
    seed({ groups: [group("a", { size: 2, channelId: "ch-a" })] });
    const out = await Promise.all(
      ["u1", "u2", "u3", "u4", "u5"].map((u) => join(u, "ch-a")),
    );
    expect(out.filter((o) => o === "recorded")).toHaveLength(2);
    expect(out.filter((o) => o === "full")).toHaveLength(3);
    expect(members("a")).toHaveLength(2);
  });

  it("keeps a member's joins in the order they happened, even when the earlier lookup is slower", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a" }),
        group("b", { channelId: "ch-b" }),
      ],
    });
    // The lookup for the earlier join (to A) takes far longer than the later one.
    fake.delayFor = (filter) =>
      filter["groups.channelId"] === "ch-a" ? 60 : 0;
    const first = join("u1", "ch-a");
    const second = join("u1", "ch-b");
    expect(await Promise.all([first, second])).toEqual([
      "recorded",
      "recorded",
    ]);
    expect(members("b")).toEqual(["u1"]);
    expect(members("a")).toEqual([]);
  });

  it("records no membership at all while Events is switched off, or when the switch cannot be read", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a" }),
        group("b", { channelId: "ch-b", memberIds: ["u1"] }),
      ],
    });
    eventsEnabled = false;
    expect(await join("u2", "ch-a")).toBe("disabled");
    expect(await join("u1", "ch-a")).toBe("disabled");
    eventsEnabled = "throw";
    expect(await join("u2", "ch-a")).toBe("disabled");
    expect(updates).toEqual([]);
    expect(members("a")).toEqual([]);
    expect(members("b")).toEqual(["u1"]);
    // Switched back on, joins are recorded again.
    eventsEnabled = true;
    expect(await join("u2", "ch-a")).toBe("recorded");
  });

  it("loses cleanly to a host assignment that fills the group first", async () => {
    seed({ groups: [group("a", { size: 1, channelId: "ch-a" })] });
    const [host, self] = await Promise.all([
      assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "h1",
        groupKey: "a",
      }),
      join("u1", "ch-a"),
    ]);
    expect(host.ok && self === "full").toBe(true);
    expect(members("a")).toEqual(["h1"]);
  });
});

describe("removeMemberFromEvents (member data reset)", () => {
  it("pulls the member out of every group of every event, finished ones too", async () => {
    seed(
      { state: "active", groups: [group("a", { memberIds: ["me", "x"] })] },
      "65a000000000000000000001",
    );
    seed(
      {
        state: "ended",
        groups: [
          group("a", { memberIds: ["me"] }),
          group("b", { memberIds: ["y"] }),
        ],
      },
      "65a000000000000000000002",
    );
    seed(
      { state: "cancelled", groups: [group("a", { memberIds: ["y"] })] },
      "65a000000000000000000003",
    );
    const seen: string[] = [];
    const off = onGroupAssignmentChange((c) => {
      seen.push(`${c.eventId.slice(-1)}:${c.fromKey}:${c.toKey}:${c.source}`);
    });
    try {
      const result = await removeMemberFromEvents(GUILD, "me");
      expect(result).toEqual({ matched: 2, removed: 2, failed: 0 });
      expect(members("a", "65a000000000000000000001")).toEqual(["x"]);
      expect(members("a", "65a000000000000000000002")).toEqual([]);
      // Other members and untouched events stand.
      expect(members("b", "65a000000000000000000002")).toEqual(["y"]);
      expect(members("a", "65a000000000000000000003")).toEqual(["y"]);
      expect(seen.sort()).toEqual(["1:a:null:purge", "2:a:null:purge"]);
    } finally {
      off();
    }
  });

  it("counts a failing event and still clears the others", async () => {
    seed(
      { groups: [group("a", { memberIds: ["me"] })] },
      "65a000000000000000000001",
    );
    seed(
      { groups: [group("a", { memberIds: ["me"] })] },
      "65a000000000000000000002",
    );
    fake.failUpdatesFor = "65a000000000000000000001";
    const result = await removeMemberFromEvents(GUILD, "me");
    expect(result).toEqual({ matched: 2, removed: 1, failed: 1 });
    expect(members("a", "65a000000000000000000002")).toEqual([]);
  });

  it("does not write the member back when a reset races an assignment", async () => {
    seed({ groups: [group("a", { memberIds: ["me"] }), group("b")] });
    await Promise.all([
      removeMemberFromEvents(GUILD, "me"),
      assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: "me",
        groupKey: "b",
      }),
    ]);
    // Either order is valid, but never in two groups.
    const holders = store
      .get(EV)!
      .groups.filter((g) => g.memberIds.includes("me"));
    expect(holders.length).toBeLessThanOrEqual(1);
  });
});
