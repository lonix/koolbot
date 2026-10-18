import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

// The one teardown of an ending event (#1193). The real `EventTeardown`, the
// real end-of-event hook registry, the real group lock and the real planners
// run here; the database is a small stateful fake (so the atomic claim really
// matches on state), and Discord is what the injected deps and the mover see.

type Row = Record<string, unknown>;
let rows: Map<string, Row>;
let claimDelay: Promise<void> | null = null;
const calls: string[] = [];

function matches(row: Row, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$and") {
      for (const clause of v as Array<Record<string, unknown>>) {
        if (!matches(row, clause)) return false;
      }
    } else if (k === "$or") {
      if (!(v as Array<Record<string, unknown>>).some((c) => matches(row, c))) {
        return false;
      }
    } else if (k === "groups") {
      const groups = (row.groups as Row[]) ?? [];
      const g = v as {
        $exists?: boolean;
        $size?: number;
        $elemMatch?: { key: string; channelId: string | null };
      };
      if (g.$exists === false && row.groups !== undefined) return false;
      if (g.$size !== undefined && groups.length !== g.$size) return false;
      if (
        g.$elemMatch &&
        !groups.some(
          (x) =>
            x.key === g.$elemMatch?.key &&
            ((x.channelId as string | null) ?? null) ===
              g.$elemMatch?.channelId,
        )
      ) {
        return false;
      }
    } else if (k === "channelId") {
      if (((row.channelId as string | null) ?? null) !== v) return false;
    } else if (k === "_id") {
      if (row._id !== v) return false;
    } else if (v && typeof v === "object" && "$in" in (v as object)) {
      if (!((v as { $in: unknown[] }).$in as unknown[]).includes(row[k])) {
        return false;
      }
    } else if (v instanceof Date) {
      if (!(row[k] instanceof Date) || +(row[k] as Date) !== +v) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

const EventMock = {
  findOneAndUpdate: jest.fn(
    async (filter: Record<string, unknown>, update: { $set: Row }) => {
      if (claimDelay) await claimDelay;
      const row = rows.get(filter._id as string);
      if (!row || !matches(row, filter)) return null;
      Object.assign(row, update.$set);
      return { ...row };
    },
  ),
  findById: jest.fn((id: string) => ({
    lean: async () => {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
  })),
  updateOne: jest.fn(async () => ({ modifiedCount: 0 })),
  // The leaders module reads the row (state and groups) inside the group lock.
  findOne: jest.fn((filter: { _id: string }) => ({
    select: () => ({
      lean: async () => {
        const row = rows.get(filter._id);
        return row ? { ...row } : null;
      },
    }),
  })),
};
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
  EVENT_GROUP_KINDS: ["team", "open", "leads"],
}));

const moveEventMembers = jest.fn<(opts: unknown) => Promise<unknown>>(
  async () => ({
    status: "done" as const,
    report: { moved: [], skipped: [], unconfirmed: [] },
    considered: 0,
  }),
);
const actualMoves = await import("../../src/services/event-member-moves.js");
jest.unstable_mockModule("../../src/services/event-member-moves.js", () => ({
  ...actualMoves,
  moveEventMembers,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { EventTeardown, summariseEnd } =
  await import("../../src/services/event-teardown.js");
const hooks = await import("../../src/services/event-end-hooks.js");
const { withGroupLock } =
  await import("../../src/services/event-group-assignment.js");
const { onLeaderChange, clearLeadersOnEnd } =
  await import("../../src/services/event-group-leaders.js");

const GUILD = "guild-1";
const ID = "evt1";
const START = new Date("2030-01-01T19:00:00Z");

function row(over: Row = {}): Row {
  return {
    _id: ID,
    guildId: GUILD,
    title: "Quiz night",
    state: "active",
    startTime: START,
    durationMinutes: 120,
    channelId: "c-main",
    groupsEnabled: true,
    groups: [
      {
        key: "g_a",
        name: "Red",
        kind: "team",
        channelId: "c-red",
        captainId: "cap-1",
        memberIds: ["cap-1"],
      },
      {
        key: "g_b",
        name: "Blue",
        kind: "team",
        channelId: "c-blue",
        captainId: null,
        memberIds: [],
      },
    ],
    nativeEventId: "n0",
    nativeCreateStartedAt: null,
    nativeAdopted: false,
    announcementMessageId: "m1",
    ...over,
  };
}

function emptyReport(over: Partial<Record<string, unknown>> = {}): never {
  return {
    created: 0,
    removed: 2,
    occupied: 0,
    failures: [],
    warnings: [],
    ...over,
  } as never;
}

const guild = { id: GUILD } as never;
const client = {} as never;

interface DepOverrides {
  updateAnnouncement?: () => Promise<boolean>;
  syncNative?: (e: Row) => Promise<void>;
  cleanupGroupChannels?: () => Promise<never>;
}

function make(over: DepOverrides = {}): {
  teardown: InstanceType<typeof EventTeardown>;
  begin: jest.Mock;
  abort: jest.Mock;
} {
  let holds = 0;
  const begin = jest.fn(() => ++holds);
  const abort = jest.fn();
  const teardown = new EventTeardown({
    client,
    updateAnnouncement: async () => {
      calls.push("announcement");
      return over.updateAnnouncement ? over.updateAnnouncement() : true;
    },
    syncNative: async (e) => {
      calls.push("native");
      if (over.syncNative) await over.syncNative(e as unknown as Row);
      // The real sync releases the link once the Discord event is closed.
      else (e as unknown as Row).nativeEventId = null;
    },
    cleanupGroupChannels: async () => {
      calls.push("cleanup");
      return over.cleanupGroupChannels
        ? over.cleanupGroupChannels()
        : emptyReport();
    },
    logLifecycle: async () => {
      calls.push("lifecycle");
    },
    getGraceMinutes: async () => 15,
    beginEnding: begin,
    abortEnding: abort,
    finishEnding: jest.fn(),
    settleMs: 0,
  });
  return { teardown, begin, abort };
}

const NOW = new Date("2030-01-01T20:00:00Z");

function manual(over: Record<string, unknown> = {}): never {
  return {
    eventId: ID,
    guildId: GUILD,
    trigger: "manual",
    pullBack: true,
    now: NOW,
    endedAt: NOW,
    fromStates: ["active"],
    guild,
    syncNative: true,
    ...over,
  } as never;
}

function scheduled(over: Record<string, unknown> = {}): never {
  return {
    eventId: ID,
    guildId: GUILD,
    trigger: "scheduled",
    pullBack: false,
    now: NOW,
    endedAt: new Date(START.getTime() + 120 * 60_000),
    fromStates: ["scheduled", "active"],
    expectTimes: { startTime: START, durationMinutes: 120 },
    guild,
    syncNative: false,
    ...over,
  } as never;
}

beforeEach(() => {
  rows = new Map([[ID, row()]]);
  claimDelay = null;
  calls.length = 0;
  hooks.resetEventEndHooksForTests();
  jest.clearAllMocks();
  moveEventMembers.mockImplementation(async () => {
    calls.push("pull-back");
    return {
      status: "done" as const,
      report: { moved: ["u1"], skipped: [], unconfirmed: [] },
      considered: 1,
    };
  });
  EventMock.updateOne.mockImplementation(async () => {
    calls.push("captains");
    return { modifiedCount: 1 };
  });
});

afterEach(() => {
  hooks.resetEventEndHooksForTests();
});

describe("the claim", () => {
  it("saves the end first, atomically, only from an allowed state", async () => {
    const { teardown } = make();
    const outcome = await teardown.run(manual());
    expect(outcome.status).toBe("ended");
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = EventMock.findOneAndUpdate.mock
      .calls[0] as unknown as [Row, { $set: Row }, Row];
    expect(filter).toEqual({
      _id: ID,
      guildId: GUILD,
      state: { $in: ["active"] },
    });
    expect(update.$set).toEqual({ state: "ended", endedAt: NOW });
    expect(options).toEqual({ new: true });
    expect(rows.get(ID)?.state).toBe("ended");
    expect(rows.get(ID)?.endedAt).toEqual(NOW);
  });

  it("the scheduled end also requires the times it decided from", async () => {
    const { teardown } = make();
    await teardown.run(scheduled());
    const [filter] = EventMock.findOneAndUpdate.mock.calls[0] as unknown as [
      Row,
    ];
    expect(filter.state).toEqual({ $in: ["scheduled", "active"] });
    expect(filter.startTime).toEqual(START);
    expect(filter.durationMinutes).toBe(120);
  });

  it("the scheduled end also requires the channels its occupancy check looked at", async () => {
    const { teardown } = make();
    const expectChannels = {
      main: "c-main",
      groups: [
        { key: "g_a", channelId: "c-red" },
        { key: "g_b", channelId: "c-blue" },
      ],
    };
    await teardown.run(scheduled({ expectChannels }));
    const [filter] = EventMock.findOneAndUpdate.mock.calls[0] as unknown as [
      Row,
    ];
    expect(filter.channelId).toBe("c-main");
    expect(filter.$and).toEqual([
      { groups: { $size: 2 } },
      { groups: { $elemMatch: { key: "g_a", channelId: "c-red" } } },
      { groups: { $elemMatch: { key: "g_b", channelId: "c-blue" } } },
    ]);
    expect(rows.get(ID)?.state).toBe("ended");
  });

  it.each([
    ["the main channel changed", { main: "other" }],
    [
      "a group's channel changed",
      {
        groups: [
          { key: "g_a", channelId: "c-new" },
          { key: "g_b", channelId: "c-blue" },
        ],
      },
    ],
    [
      "a group was added since",
      { groups: [{ key: "g_a", channelId: "c-red" }] },
    ],
  ])("is 'changed', and nothing runs, when %s", async (_name, change) => {
    const expectChannels = {
      main: "c-main",
      groups: [
        { key: "g_a", channelId: "c-red" },
        { key: "g_b", channelId: "c-blue" },
      ],
      ...change,
    };
    const { teardown } = make();
    const outcome = await teardown.run(scheduled({ expectChannels }));
    expect(outcome).toEqual({ status: "changed" });
    expect(rows.get(ID)?.state).toBe("active");
    expect(calls).toEqual([]);
  });

  it("a stored event with no groups field at all can be ended when no groups were expected", async () => {
    const legacy = row({ groupsEnabled: undefined, channelId: null });
    delete legacy.groups;
    rows.set(ID, legacy);
    const { teardown } = make();
    const outcome = await teardown.run(
      scheduled({ expectChannels: { main: null, groups: [] } }),
    );
    expect(outcome.status).toBe("ended");
    const filter = (
      EventMock.findOneAndUpdate.mock.calls[0] as unknown as [Row]
    )[0];
    expect(filter.$and).toEqual([
      {
        $or: [{ groups: { $exists: false } }, { groups: { $size: 0 } }],
      },
    ]);
  });

  it("a group the check never saw is still refused for a stored event with no groups field", async () => {
    const legacy = row({ groupsEnabled: undefined, channelId: null });
    delete legacy.groups;
    rows.set(ID, legacy);
    const { teardown } = make();
    const outcome = await teardown.run(
      scheduled({
        expectChannels: { main: null, groups: [{ key: "g", channelId: null }] },
      }),
    );
    expect(outcome).toEqual({ status: "changed" });
  });

  it("a schedule edited since the scan read it is 'changed', and nothing else runs", async () => {
    rows.set(ID, row({ durationMinutes: 30 }));
    const { teardown, abort } = make();
    const outcome = await teardown.run(scheduled());
    expect(outcome).toEqual({ status: "changed" });
    expect(rows.get(ID)?.state).toBe("active");
    expect(calls).toEqual([]);
    expect(abort).toHaveBeenCalledWith(ID, 1);
  });

  it("holds the scan off before its first await, and lets go when the claim is lost", async () => {
    rows.set(ID, row({ state: "ended", endedAt: NOW }));
    const { teardown, begin, abort } = make();
    const promise = teardown.run(manual());
    // Synchronously, before anything was awaited.
    expect(begin).toHaveBeenCalledWith(ID);
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
    await promise;
    // Only this caller's own hold is given up (its token), never the event's.
    expect(abort).toHaveBeenCalledWith(ID, 1);
  });

  it("a manual end of a scheduled (not started) event is refused, with no change", async () => {
    rows.set(ID, row({ state: "scheduled" }));
    const { teardown } = make();
    expect(await teardown.run(manual())).toEqual({
      status: "not-running",
      state: "scheduled",
    });
    expect(rows.get(ID)?.state).toBe("scheduled");
    expect(calls).toEqual([]);
  });

  it("a cancelled event is not ended", async () => {
    rows.set(ID, row({ state: "cancelled" }));
    const { teardown } = make();
    expect(await teardown.run(manual())).toEqual({
      status: "not-running",
      state: "cancelled",
    });
    expect(rows.get(ID)?.state).toBe("cancelled");
  });

  it("an unknown event, or another server's, is not found", async () => {
    const { teardown } = make();
    expect(await teardown.run(manual({ eventId: "nope" }))).toEqual({
      status: "not-found",
    });
    expect(await teardown.run(manual({ guildId: "other-guild" }))).toEqual({
      status: "not-found",
    });
    expect(rows.get(ID)?.state).toBe("active");
  });

  it("a claim that cannot be saved does nothing else", async () => {
    EventMock.findOneAndUpdate.mockRejectedValueOnce(new Error("db down"));
    const { teardown } = make();
    const outcome = await teardown.run(manual());
    expect(outcome.status).toBe("failed");
    expect(calls).toEqual([]);
    expect(moveEventMembers).not.toHaveBeenCalled();
  });

  it("a failed read after a refused claim is 'failed', not a guess", async () => {
    rows.set(ID, row({ state: "ended" }));
    EventMock.findById.mockImplementationOnce(() => ({
      lean: async () => {
        throw new Error("db down");
      },
    }));
    const { teardown } = make();
    expect((await teardown.run(manual())).status).toBe("failed");
  });
});

describe("idempotency", () => {
  it("ending an ended event is a no-op with a clear message, and runs nothing", async () => {
    const { teardown } = make();
    expect((await teardown.run(manual())).status).toBe("ended");
    calls.length = 0;
    moveEventMembers.mockClear();
    const again = await teardown.run(manual());
    expect(again.status).toBe("already-ended");
    expect(calls).toEqual([]);
    expect(moveEventMembers).not.toHaveBeenCalled();
    const summary = summariseEnd(again);
    expect(summary.ok).toBe(true);
    expect(summary.message).toMatch(/already ended.*Nothing was changed/);
  });

  it("two presses at the same moment: exactly one runs the teardown", async () => {
    let release!: () => void;
    claimDelay = new Promise((resolve) => {
      release = resolve;
    });
    const { teardown } = make();
    const a = teardown.run(manual());
    const b = teardown.run(manual());
    release();
    const outcomes = await Promise.all([a, b]);
    expect(outcomes.map((o) => o.status).sort()).toEqual([
      "already-ended",
      "ended",
    ]);
    expect(calls.filter((c) => c === "cleanup")).toHaveLength(1);
    expect(moveEventMembers).toHaveBeenCalledTimes(1);
  });

  it("a manual end and the scheduled end at the same moment: one teardown", async () => {
    let release!: () => void;
    claimDelay = new Promise((resolve) => {
      release = resolve;
    });
    const { teardown } = make();
    const a = teardown.run(manual());
    const b = teardown.run(scheduled());
    release();
    const outcomes = await Promise.all([a, b]);
    expect(outcomes.filter((o) => o.status === "ended")).toHaveLength(1);
    expect(calls.filter((c) => c === "cleanup")).toHaveLength(1);
  });
});

describe("the order of the steps", () => {
  it("claim, announcement, pull-back, hooks, group channels, group leaders, native, then the lifecycle log", async () => {
    let stateSeenByHook: unknown;
    hooks.registerEventEndHook("probe", async () => {
      calls.push("hook");
      stateSeenByHook = rows.get(ID)?.state;
    });
    const { teardown } = make();
    const outcome = await teardown.run(manual());
    expect(outcome.status).toBe("ended");
    // The row is already ended when a hook runs.
    expect(stateSeenByHook).toBe("ended");
    expect(calls).toEqual([
      "announcement",
      "pull-back",
      "hook",
      "cleanup",
      "captains",
      "native",
      "lifecycle",
    ]);
  });

  it("the pull-back is already running against an ended row (allowFinished) and nobody is left out", async () => {
    const { teardown } = make();
    await teardown.run(manual());
    const opts = moveEventMembers.mock.calls[0]?.[0] as unknown as {
      allowFinished: boolean;
      excludeUserIds: string[];
      guildId: string;
      eventId: string;
      plan: (ctx: unknown) => unknown;
    };
    expect(opts.allowFinished).toBe(true);
    expect(opts.excludeUserIds).toEqual([]);
    expect(opts.guildId).toBe(GUILD);
    expect(opts.eventId).toBe(ID);
    // The planner is "return to main, open and leader-only channels included".
    const plan = opts.plan({
      event: {
        channelId: "c-main",
        groups: [
          { key: "a", kind: "team", channelId: "c-red" },
          { key: "b", kind: "leads", channelId: "c-leads" },
        ],
      },
      presence: {
        ok: true,
        members: [
          { id: "u1", channelId: "c-red" },
          { id: "u2", channelId: "c-leads" },
          { id: "u3", channelId: "c-main" },
        ],
      },
    });
    expect(plan).toEqual([
      { userId: "u1", toChannelId: "c-main" },
      { userId: "u2", toChannelId: "c-main" },
    ]);
  });

  it("the group channels are cleaned up after the pull-back, in sequence, not inside it", async () => {
    let movesFinished = false;
    moveEventMembers.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 20));
      movesFinished = true;
      return {
        status: "done" as const,
        report: { moved: ["u1"], skipped: [], unconfirmed: [] },
        considered: 1,
      };
    });
    let finishedWhenCleaning: boolean | undefined;
    const { teardown } = make({
      cleanupGroupChannels: async () => {
        finishedWhenCleaning = movesFinished;
        return emptyReport();
      },
    });
    await teardown.run(manual());
    expect(finishedWhenCleaning).toBe(true);
  });

  it("the main channel is left for the scan's grace period and the host is told when", async () => {
    const { teardown } = make();
    const outcome = await teardown.run(manual());
    if (outcome.status !== "ended") throw new Error("not ended");
    const main = outcome.steps.find((s) => s.id === "main-channel");
    expect(main?.ok).toBe(true);
    expect(main?.note).toMatch(/15 minute\(s\) from now/);
    // Nothing deletes the main channel here: no deps for it exist.
    expect(calls).not.toContain("delete-main");
  });
});

describe("what runs for which event", () => {
  it("a plain event: no pull-back, no group channel pass, no leader clearing", async () => {
    rows.set(ID, row({ groupsEnabled: false, groups: [] }));
    const { teardown } = make();
    const outcome = await teardown.run(manual());
    expect(outcome.status).toBe("ended");
    expect(moveEventMembers).not.toHaveBeenCalled();
    expect(calls).toEqual(["announcement", "native", "lifecycle"]);
    expect(EventMock.updateOne).not.toHaveBeenCalled();
  });

  it("the pull-back is only for a manual end that asked for it, and an event with group channels", async () => {
    const a = make().teardown;
    await a.run(manual({ pullBack: false }));
    expect(moveEventMembers).not.toHaveBeenCalled();

    rows.set(ID, row());
    await a.run(scheduled({ pullBack: true }));
    // A scheduled end never pulls people back, whatever the flag says.
    expect(moveEventMembers).not.toHaveBeenCalled();

    rows.set(
      ID,
      row({ groups: [{ key: "g", name: "G", kind: "team", channelId: null }] }),
    );
    await a.run(manual());
    // Groups, but no channel was ever created: nobody to move.
    expect(moveEventMembers).not.toHaveBeenCalled();
  });

  it("the scheduled end leaves the native event to the scan's own sync", async () => {
    const { teardown } = make();
    await teardown.run(scheduled());
    expect(calls).not.toContain("native");
    expect(calls).not.toContain("lifecycle");
  });

  it("the scan's save must not write the claimed state again (a cancel in between would be overwritten)", async () => {
    const ignored: string[] = [];
    const event = {
      ...row(),
      endedAt: null,
      $ignore: (path: string) => ignored.push(path),
    } as Row;
    const { teardown } = make();
    await teardown.run(scheduled({ event }));
    expect(ignored.sort()).toEqual(["endedAt", "state"]);
  });

  it("the scheduled end keeps the scan's copy and syncs it with the claim", async () => {
    const event = { ...row(), state: "active", endedAt: null } as Row;
    const { teardown } = make();
    const outcome = await teardown.run(scheduled({ event }));
    expect(outcome.status).toBe("ended");
    expect(event.state).toBe("ended");
    expect(event.endedAt).toEqual(new Date(START.getTime() + 120 * 60_000));
  });
});

describe("partial failure never aborts the rest", () => {
  async function ended(
    teardown: InstanceType<typeof EventTeardown>,
  ): Promise<{ steps: Array<{ id: string; ok: boolean; note: string }> }> {
    const outcome = await teardown.run(manual());
    if (outcome.status !== "ended") throw new Error(outcome.status);
    return outcome;
  }

  it("a pull-back that throws", async () => {
    moveEventMembers.mockRejectedValueOnce(new Error("boom"));
    const { teardown } = make();
    const outcome = await ended(teardown);
    expect(outcome.steps.find((s) => s.id === "pull-back")?.ok).toBe(false);
    expect(calls).toEqual(
      expect.arrayContaining(["cleanup", "captains", "native", "lifecycle"]),
    );
  });

  it("a pull-back that was refused or busy is reported and the channels stay while occupied", async () => {
    moveEventMembers.mockResolvedValueOnce({
      status: "refused",
      message: "The bot lacks Move Members.",
    } as never);
    const a = await ended(make().teardown);
    expect(a.steps.find((s) => s.id === "pull-back")).toMatchObject({
      ok: false,
      note: "The bot lacks Move Members.",
    });
    rows.set(ID, row());
    moveEventMembers.mockResolvedValueOnce({ status: "busy" } as never);
    const b = await ended(make().teardown);
    expect(b.steps.find((s) => s.id === "pull-back")?.ok).toBe(false);
  });

  it("a pull-back with unconfirmed or skipped people is not ok, and says how many", async () => {
    moveEventMembers.mockResolvedValueOnce({
      status: "done",
      report: {
        moved: ["u1"],
        skipped: [
          { userId: "u2", reason: "missing-permission" },
          { userId: "u3", reason: "not-connected" },
        ],
        unconfirmed: ["u4"],
      },
      considered: 4,
    } as never);
    const outcome = await ended(make().teardown);
    const step = outcome.steps.find((s) => s.id === "pull-back");
    expect(step?.ok).toBe(false);
    expect(step?.note).toContain("Moved 1");
    expect(step?.note).toContain("did not confirm 1");
    expect(step?.note).toContain("1 missing permission");
    // Not connected is quiet: they are not stranded.
    expect(step?.note).not.toContain("not connected");
  });

  it("a throwing hook, a hook that reports a warning, and a hook that never answers", async () => {
    hooks.registerEventEndHook("throws", async () => {
      throw new Error("nope");
    });
    hooks.registerEventEndHook("warns", async () => ["Two nicknames stayed."]);
    hooks.registerEventEndHook("fine", async () => undefined);
    const { teardown } = make();
    const outcome = await ended(teardown);
    const step = outcome.steps.find((s) => s.id === "hooks");
    expect(step?.ok).toBe(false);
    expect(step?.note).toContain('The "throws" step could not be completed');
    expect(step?.note).toContain("Two nicknames stayed.");
    expect(calls).toEqual(expect.arrayContaining(["cleanup", "native"]));
  });

  it("a group channel pass that throws, and one that reports failures", async () => {
    const a = await ended(
      make({
        cleanupGroupChannels: async () => {
          throw new Error("discord down");
        },
      }).teardown,
    );
    expect(a.steps.find((s) => s.id === "group-channels")?.ok).toBe(false);
    expect(calls).toContain("captains");

    rows.set(ID, row());
    calls.length = 0;
    const b = await ended(
      make({
        cleanupGroupChannels: async () =>
          emptyReport({
            removed: 1,
            failures: [{ key: "g_b", name: "Blue", reason: "Missing Access" }],
          }),
      }).teardown,
    );
    const step = b.steps.find((s) => s.id === "group-channels");
    expect(step?.ok).toBe(false);
    expect(step?.note).toContain("Removed 1");
    expect(step?.note).toContain("Blue: Missing Access");
    expect(calls).toContain("native");
  });

  it("people still in a group channel are not a failure: the channel goes once empty", async () => {
    const outcome = await ended(
      make({
        cleanupGroupChannels: async () =>
          emptyReport({ removed: 1, occupied: 1 }),
      }).teardown,
    );
    const step = outcome.steps.find((s) => s.id === "group-channels");
    expect(step?.ok).toBe(true);
    expect(step?.note).toContain("1 group channel(s) still have people");
  });

  it("leaders that cannot be cleared are reported", async () => {
    EventMock.updateOne.mockRejectedValueOnce(new Error("db"));
    const outcome = await ended(make().teardown);
    expect(outcome.steps.find((s) => s.id === "captains")?.ok).toBe(false);
    expect(calls).toContain("native");
  });

  it("an announcement that could not be refreshed is reported, the rest still runs", async () => {
    const outcome = await ended(
      make({ updateAnnouncement: async () => false }).teardown,
    );
    expect(outcome.steps[0]).toMatchObject({ id: "announcement", ok: false });
    expect(calls).toContain("cleanup");
  });

  it("a Discord event that is still linked after the sync is reported, and retried by the scan", async () => {
    rows.set(ID, row({ nativeEventId: "n1" }));
    const stuck = await ended(
      make({
        syncNative: async () => undefined,
      }).teardown,
    );
    // The row returned by the claim still carries the link.
    expect(stuck.steps.find((s) => s.id === "native")?.ok).toBe(false);

    rows.set(ID, row({ nativeEventId: "n1" }));
    const closed = await ended(
      make({
        syncNative: async (e) => {
          e.nativeEventId = null;
        },
      }).teardown,
    );
    expect(closed.steps.find((s) => s.id === "native")).toBeUndefined();
  });

  it("an adopted Discord event is only let go of: the sync runs, and it is never a problem", async () => {
    rows.set(ID, row({ nativeEventId: "n1", nativeAdopted: true }));
    const outcome = await ended(
      make({ syncNative: async () => undefined }).teardown,
    );
    expect(calls).toContain("native");
    expect(outcome.steps.find((s) => s.id === "native")).toBeUndefined();
  });

  it("an event with no Discord event and no pending create does not touch the sync", async () => {
    rows.set(ID, row({ nativeEventId: null }));
    const outcome = await ended(make().teardown);
    expect(calls).not.toContain("native");
    expect(outcome.steps.find((s) => s.id === "native")).toBeUndefined();
  });

  it("an unreachable server with a linked Discord event is a problem, not a silent skip", async () => {
    const { teardown } = make();
    const outcome = await teardown.run(manual({ guild: null }));
    if (outcome.status !== "ended") throw new Error("not ended");
    expect(outcome.steps.find((s) => s.id === "native")).toMatchObject({
      ok: false,
    });
    expect(calls).not.toContain("native");
  });

  it("a create that timed out and is still being looked for is reported until it is cleared", async () => {
    rows.set(
      ID,
      row({ nativeEventId: null, nativeCreateStartedAt: new Date() }),
    );
    const stuck = await ended(
      make({ syncNative: async () => undefined }).teardown,
    );
    expect(stuck.steps.find((s) => s.id === "native")?.ok).toBe(false);

    rows.set(
      ID,
      row({ nativeEventId: null, nativeCreateStartedAt: new Date() }),
    );
    const cleared = await ended(
      make({
        syncNative: async (e) => {
          e.nativeCreateStartedAt = null;
        },
      }).teardown,
    );
    expect(cleared.steps.find((s) => s.id === "native")).toBeUndefined();
  });

  it("an unreachable server skips the Discord steps and says so", async () => {
    const { teardown } = make();
    const outcome = await teardown.run(manual({ guild: null }));
    if (outcome.status !== "ended") throw new Error("not ended");
    expect(outcome.steps.find((s) => s.id === "group-channels")?.ok).toBe(
      false,
    );
    expect(calls).not.toContain("cleanup");
    expect(rows.get(ID)?.state).toBe("ended");
  });
});

describe("leaders are cleared under the group lock, only on an ended row", () => {
  it("one conditional update that matches each group's stored leader, only on an ended row", async () => {
    const { teardown } = make();
    await teardown.run(manual());
    const [filter, update, options] = EventMock.updateOne.mock
      .calls[0] as unknown as [Row, Row, Row];
    expect(filter).toEqual({ _id: ID, guildId: GUILD, state: "ended" });
    expect(update).toEqual({ $set: { "groups.$[g0].captainId": null } });
    expect(options).toEqual({
      arrayFilters: [{ "g0.key": "g_a", "g0.captainId": "cap-1" }],
    });
  });

  it("tells the leads channel (#1199): onLeaderChange fires with source ended and the stored id", async () => {
    const changes: unknown[] = [];
    const off = onLeaderChange((c) => {
      changes.push(c);
    });
    try {
      const { teardown } = make();
      await teardown.run(manual());
    } finally {
      off();
    }
    expect(changes).toEqual([
      {
        eventId: ID,
        guildId: GUILD,
        groupKey: "g_a",
        fromUserId: "cap-1",
        toUserId: null,
        source: "ended",
      },
    ]);
  });

  it("clears nothing, and says nothing, when no group has a leader", async () => {
    rows.set(
      ID,
      row({
        groups: [{ key: "g_a", name: "Red", kind: "team", channelId: "c-red" }],
      }),
    );
    const changes: unknown[] = [];
    const off = onLeaderChange((c) => {
      changes.push(c);
    });
    try {
      await make().teardown.run(manual());
    } finally {
      off();
    }
    expect(EventMock.updateOne).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });

  it("never clears the leaders of an event that does not read ended", async () => {
    const changes: unknown[] = [];
    const off = onLeaderChange((c) => {
      changes.push(c);
    });
    try {
      await clearLeadersOnEnd(GUILD, ID);
    } finally {
      off();
    }
    // The row in the store is still active here (no teardown ran).
    expect(EventMock.updateOne).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });

  it("a write that matched nothing (the leader changed meanwhile) announces nothing", async () => {
    rows.set(ID, row({ state: "ended" }));
    EventMock.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    const changes: unknown[] = [];
    const off = onLeaderChange((c) => {
      changes.push(c);
    });
    try {
      expect(await clearLeadersOnEnd(GUILD, ID)).toBe(0);
    } finally {
      off();
    }
    expect(changes).toEqual([]);
  });

  it("waits for a membership change that holds the group lock", async () => {
    let release!: () => void;
    const held = withGroupLock(
      GUILD,
      ID,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { teardown } = make();
    const run = teardown.run(manual({ pullBack: false }));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).not.toContain("captains");
    release();
    await held;
    await run;
    expect(calls).toContain("captains");
  });

  it("assignments (memberIds) are never written", async () => {
    const { teardown } = make();
    await teardown.run(manual());
    for (const call of EventMock.updateOne.mock.calls as unknown as Array<
      [Row, Row]
    >) {
      expect(JSON.stringify(call[1])).not.toContain("memberIds");
    }
  });
});

describe("the hooks registry", () => {
  const ctx = {
    eventId: ID,
    guildId: GUILD,
    trigger: "manual" as const,
    client,
  };

  it("runs the registered hooks one at a time, in order, with the ids", async () => {
    const order: string[] = [];
    hooks.registerEventEndHook("first", async (c) => {
      order.push(`first:${c.eventId}:${c.guildId}:${c.trigger}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push("first-done");
    });
    hooks.registerEventEndHook("second", async () => {
      order.push("second");
    });
    const results = await hooks.runEventEndHooks(ctx);
    expect(order).toEqual([
      `first:${ID}:${GUILD}:manual`,
      "first-done",
      "second",
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });

  it("an empty list runs nothing and reports nothing", async () => {
    expect(await hooks.runEventEndHooks(ctx)).toEqual([]);
  });

  it("registering a name again replaces the hook; the returned function removes it", async () => {
    const one = jest.fn(async () => undefined);
    const two = jest.fn(async () => undefined);
    hooks.registerEventEndHook("x", one);
    const off = hooks.registerEventEndHook("x", two);
    await hooks.runEventEndHooks(ctx);
    expect(one).not.toHaveBeenCalled();
    expect(two).toHaveBeenCalledTimes(1);
    off();
    expect(hooks.listEventEndHooks()).toEqual([]);
  });

  it("a hook that does not finish in time is reported and the next one runs", async () => {
    const next = jest.fn(async () => undefined);
    hooks.registerEventEndHook("slow", () => new Promise(() => undefined));
    hooks.registerEventEndHook("next", next);
    const results = await hooks.runEventEndHooks(ctx, 20);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.warnings[0]).toContain("did not finish in time");
    expect(next).toHaveBeenCalled();
  });
});

describe("what the host and the audit log are told", () => {
  it("lists what needs attention first, stays inside one flash and carries counts only", async () => {
    moveEventMembers.mockResolvedValueOnce({
      status: "done",
      report: {
        moved: ["u1", "u2"],
        skipped: [{ userId: "u3", reason: "missing-permission" }],
        unconfirmed: [],
      },
      considered: 3,
    } as never);
    const { teardown } = make({
      cleanupGroupChannels: async () =>
        emptyReport({
          removed: 1,
          failures: [
            {
              key: "g_b",
              name: "Blue",
              reason: "x".repeat(400),
            },
          ],
        }),
    });
    const outcome = await teardown.run(manual());
    const summary = summariseEnd(outcome);
    expect(summary.ok).toBe(true);
    expect(summary.message.length).toBeLessThanOrEqual(500);
    expect(summary.message).toMatch(/^The event has ended, but 2 things need/);
    expect(summary.details).toMatchObject({
      outcome: "ended-with-problems",
      problems: 2,
      moved: 2,
      skipped: 1,
      removed: 1,
      failed: 1,
    });
    expect(JSON.stringify(summary.details)).not.toMatch(/u1|u2|u3|Blue/);
  });

  it("a clean end says so and names the grace period", async () => {
    const { teardown } = make();
    const summary = summariseEnd(await teardown.run(manual()));
    expect(summary.message).toMatch(/^The event has ended\./);
    expect(summary.details.outcome).toBe("ended");
    expect(summary.message).toContain("15 minute(s) from now");
  });

  it.each([
    [{ status: "not-found" }, false],
    [{ status: "not-running", state: "scheduled" }, false],
    [{ status: "not-running", state: "cancelled" }, false],
    [{ status: "refused", message: "Events are turned off." }, false],
    [{ status: "failed", message: "x" }, false],
    [{ status: "changed" }, false],
    [{ status: "already-ended", endedAt: null }, true],
  ])("%j", (outcome, ok) => {
    const summary = summariseEnd(outcome as never);
    expect(summary.ok).toBe(ok);
    expect(summary.message.length).toBeGreaterThan(0);
    expect(summary.details.outcome).toBeTruthy();
  });
});
