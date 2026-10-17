import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { ServerAdoptionService, AdoptionPlanError } =
  await import("../../src/services/server-adoption-service.js");
const { buildEventAdoptionPlan, classifyScheduledEvent } =
  await import("../../src/services/event-adoption.js");
type Deps =
  import("../../src/services/server-adoption-service.js").AdoptionDeps;
type Record_ =
  import("../../src/services/server-adoption-service.js").AdoptionSnapshotRecord;
type Native =
  import("../../src/services/server-adoption-service.js").AdoptionNativeEvent;
type Info =
  import("../../src/services/server-scan-service.js").ScheduledEventInfo;

const actor = {
  sessionId: "s",
  discordUserId: "admin",
  guildId: "g1",
  role: "admin",
} as never;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function info(over: Partial<Info> = {}): Info {
  return {
    id: "100",
    name: "Movie night",
    startsAt: "2026-10-20T19:00:00.000Z",
    endsAt: "2026-10-20T21:30:00.000Z",
    status: "1",
    channelId: null,
    description: "Popcorn",
    creatorId: "member1",
    creatorIsBot: false,
    entityType: "external",
    recurring: false,
    ...over,
  };
}

function plan(ids: string[] = ["100"], infos: Info[] = [info()]) {
  const ctx = {
    eventsEnabled: true,
    botUserId: "bot1",
    canManageEvents: true,
    linkedNativeIds: new Set<string>(),
    openUnlinked: [],
    now: new Date("2026-10-17T12:00:00Z"),
  };
  return buildEventAdoptionPlan({
    guildId: "g1",
    adminUserId: "admin",
    candidates: infos.map((i) => classifyScheduledEvent(i, ctx)),
    selectedIds: ids,
    eventsEnabled: true,
    announcementConfigured: true,
  });
}

function harness() {
  const calls: string[] = [];
  const records = new Map<string, Record_>();
  /** KoolBot rows by adoption reference, and which native events they link. */
  const rows = new Map<string, { id: string; native: string }>();
  const natives = new Map<string, Native>([
    [
      "100",
      {
        id: "100",
        name: "Movie night",
        description: "Popcorn",
        startsAt: "2026-10-20T19:00:00.000Z",
        endsAt: "2026-10-20T21:30:00.000Z",
        status: "1",
      },
    ],
  ]);
  const failRemove = { value: null as string | null };
  const failAdopt = { value: null as string | null };
  const unexpected = (what: string) => async (): Promise<never> => {
    calls.push(`gateway:${what}`);
    throw new Error(`unexpected gateway call ${what}`);
  };
  const deps: Deps = {
    gateway: new Proxy(
      {},
      { get: (_t, name) => unexpected(String(name)) },
    ) as never,
    events: {
      adopt: async (i) => {
        calls.push(`adopt:${i.nativeEventId}:${i.ref}`);
        if (failAdopt.value) throw new Error(failAdopt.value);
        const existing = rows.get(i.ref);
        if (existing) return existing.id;
        if ([...rows.values()].some((r) => r.native === i.nativeEventId)) {
          throw new Error("That event is already a KoolBot event.");
        }
        const id = `row-${rows.size + 1}`;
        rows.set(i.ref, { id, native: i.nativeEventId });
        return id;
      },
      findByRef: async (ref) => rows.get(ref)?.id ?? null,
      remove: async (ref) => {
        calls.push(`remove:${ref}`);
        if (failRemove.value) throw new Error(failRemove.value);
        rows.delete(ref);
      },
      readNative: async (id) => natives.get(id) ?? null,
    },
    store: {
      create: async (rec) => {
        calls.push("snapshot.create");
        const full = {
          ...rec,
          id: `snap-${records.size + 1}`,
          rolledBackBy: null,
        } as Record_;
        records.set(full.id, full);
        return clone(full);
      },
      get: async (id) => (records.has(id) ? clone(records.get(id)!) : null),
      update: async (id, patch) => {
        Object.assign(records.get(id)!, clone(patch));
      },
      recoverStale: async () => 0,
      claim: async (id, from, to) => {
        const rec = records.get(id);
        if (!rec || !from.includes(rec.status)) return false;
        rec.status = to;
        return true;
      },
    },
    config: {
      set: async () => undefined,
      delete: async () => undefined,
      validate: async () => [],
      hasOverride: async () => false,
      read: async () => null,
      reload: async () => {
        calls.push("reload");
      },
    },
    callApi: async (call) => call(),
    auditStrict: async () => undefined,
    audit: async (_s, e) => {
      calls.push(`audit:${e.action}:${e.result}`);
    },
    sleep: async () => {},
  };
  return {
    deps,
    calls,
    records,
    rows,
    natives,
    failRemove,
    failAdopt,
    service: new ServerAdoptionService(deps),
  };
}

const opts = { actor, batchDelayMs: 0 };

describe("event.adopt steps in the adoption engine (#1034)", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("saves the snapshot first, then writes one row per event, and touches nothing on Discord", async () => {
    const result = await h.service.apply(plan(), opts);
    expect(result.status).toBe("applied");
    expect(h.calls[0]).toBe("snapshot.create");
    expect(h.calls.filter((c) => !c.startsWith("audit:"))).toEqual([
      "snapshot.create",
      "adopt:100:snap-1:op-1",
      "reload",
    ]);
    expect(h.calls.some((c) => c.startsWith("gateway:"))).toBe(false);
    const record = h.records.get(result.snapshotId)!;
    expect(record.operations[0]).toMatchObject({
      opId: "op-1",
      status: "applied",
      resultId: "row-1",
    });
    expect(record.baseline.events?.map((e) => e.id)).toEqual(["100"]);
  });

  it("refuses when the native event changed, was deleted or already started since the preview", async () => {
    const p = plan();
    h.natives.set("100", { ...h.natives.get("100")!, name: "Renamed" });
    await expect(h.service.apply(p, opts)).rejects.toBeInstanceOf(
      AdoptionPlanError,
    );
    h.natives.set("100", {
      ...h.natives.get("100")!,
      name: "Movie night",
      status: "2",
    });
    await expect(h.service.apply(p, opts)).rejects.toThrow(/Changed since/);
    h.natives.delete("100");
    await expect(h.service.apply(p, opts)).rejects.toThrow(/Movie night/);
    expect(h.calls).toEqual([]);
    expect(h.rows.size).toBe(0);
  });

  it("adopting the same event twice fails the second step and leaves one row", async () => {
    await h.service.apply(plan(), opts);
    const second = await h.service.apply(plan(), opts);
    expect(second.status).toBe("partial");
    expect(second.failed[0].error).toMatch(/already a KoolBot event/);
    expect(h.rows.size).toBe(1);
  });

  it("a failed step can be resumed once the problem is gone", async () => {
    h.failAdopt.value = "database unavailable";
    const p = plan();
    const first = await h.service.apply(p, opts);
    expect(first.status).toBe("partial");
    h.failAdopt.value = null;
    const resumed = await h.service.apply(p, {
      ...opts,
      resumeSnapshotId: first.snapshotId,
    });
    expect(resumed.status).toBe("applied");
    expect(h.rows.size).toBe(1);
  });

  it("rolls back by removing only the KoolBot rows it created; no Discord writes", async () => {
    // A row somebody else made for another event stays.
    h.rows.set("other:op-1", { id: "row-x", native: "999" });
    const applied = await h.service.apply(plan(), opts);
    h.calls.length = 0;
    const result = await h.service.rollback(applied.snapshotId, { actor });
    expect(result.failed).toEqual([]);
    expect(result.restored).toEqual(["op-1"]);
    expect(h.calls.filter((c) => !c.startsWith("audit:"))).toEqual([
      "remove:snap-1:op-1",
      "reload",
    ]);
    expect([...h.rows.keys()]).toEqual(["other:op-1"]);
    expect(h.records.get(applied.snapshotId)!.status).toBe("rolled_back");
    // The native event was never part of it.
    expect(h.natives.get("100")?.status).toBe("1");
  });

  it("a rollback that cannot remove a row stops partway and can be retried", async () => {
    const applied = await h.service.apply(plan(), opts);
    h.failRemove.value = "The event's temporary voice channel is in use.";
    const first = await h.service.rollback(applied.snapshotId, { actor });
    expect(first.failed[0].error).toMatch(/in use/);
    expect(h.records.get(applied.snapshotId)!.status).toBe("rollback_partial");
    expect(h.rows.size).toBe(1);
    h.failRemove.value = null;
    const retry = await h.service.rollback(applied.snapshotId, { actor });
    expect(retry.failed).toEqual([]);
    expect(h.rows.size).toBe(0);
    expect(h.records.get(applied.snapshotId)!.status).toBe("rolled_back");
  });

  it("a step that wrote its row but crashed before recording it is still rolled back", async () => {
    const applied = await h.service.apply(plan(), opts);
    // Simulate the crash: the row exists, the record says pending.
    const record = h.records.get(applied.snapshotId)!;
    record.operations[0].status = "pending";
    record.status = "partial";
    const result = await h.service.rollback(applied.snapshotId, { actor });
    expect(result.restored).toEqual(["op-1"]);
    expect(h.rows.size).toBe(0);
  });

  it("does not remove anything for a step that never ran", async () => {
    h.failAdopt.value = "boom";
    const applied = await h.service.apply(plan(), opts);
    h.calls.length = 0;
    const result = await h.service.rollback(applied.snapshotId, { actor });
    expect(result.restored).toEqual([]);
    expect(h.calls.some((c) => c.startsWith("remove:"))).toBe(false);
  });

  it("the restore safety check has nothing to object to for an event-only snapshot", async () => {
    const { restoreProblems } =
      await import("../../src/services/adoption-rollback-check.js");
    const applied = await h.service.apply(plan(), opts);
    const snapshot = h.records.get(applied.snapshotId)!;
    const scanned = {
      guildId: "g1",
      ownerId: "owner",
      botUserId: "bot",
      botRoleIds: [],
      botHighestRolePosition: 1,
      adminUserId: "admin",
      adminRoleIds: [],
      otherBotIds: [],
      roles: [],
      channels: [],
      config: {},
      boundChannelIds: [],
      koolbotCreatedIds: [],
    };
    expect(
      restoreProblems(snapshot, scanned as never, {
        actorId: "admin",
        deleteCreatedRoles: false,
        approvedAt: "2026-10-17T12:00:00Z",
      }),
    ).toEqual([]);
  });

  it("fails clearly when the engine has no event port", async () => {
    const bare = harness();
    delete (bare.deps as { events?: unknown }).events;
    await expect(bare.service.apply(plan(), opts)).rejects.toThrow(
      /not available/,
    );
  });
});
