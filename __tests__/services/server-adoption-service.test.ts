import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PermissionsBitField } from "discord.js";

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
type Deps =
  import("../../src/services/server-adoption-service.js").AdoptionDeps;
type Record_ =
  import("../../src/services/server-adoption-service.js").AdoptionSnapshotRecord;
const { planAdoption } =
  await import("../../src/services/server-adoption-planner.js");
type Scanned =
  import("../../src/services/server-adoption-planner.js").ScannedState;

const VIEW = PermissionsBitField.Flags.ViewChannel.toString();
const actor = {
  sessionId: "s",
  discordUserId: "admin",
  guildId: "g1",
  role: "admin",
} as never;

function scanned(over: Partial<Scanned> = {}): Scanned {
  return {
    guildId: "g1",
    ownerId: "owner",
    botUserId: "bot",
    botRoleIds: ["botrole"],
    botHighestRolePosition: 10,
    adminUserId: "admin",
    adminRoleIds: ["staff"],
    otherBotIds: [],
    roles: [
      {
        id: "g1",
        name: "@everyone",
        color: 0,
        permissions: VIEW,
        position: 0,
        managed: false,
      },
      {
        id: "botrole",
        name: "KoolBot",
        color: 0,
        permissions: PermissionsBitField.Flags.Administrator.toString(),
        position: 10,
        managed: true,
      },
      {
        id: "staff",
        name: "Staff",
        color: 0,
        permissions: "0",
        position: 5,
        managed: false,
      },
      {
        id: "member",
        name: "Member",
        color: 1,
        permissions: "0",
        position: 3,
        managed: false,
      },
    ],
    channels: [
      {
        id: "old-cat",
        name: "Old",
        kind: "category",
        rawType: 4,
        parentId: null,
        position: 1,
        topic: null,
        overwrites: [{ id: "member", type: "role", allow: VIEW, deny: "0" }],
        voiceMemberCount: 0,
      },
      {
        id: "chat",
        name: "chat",
        kind: "text",
        rawType: 0,
        parentId: null,
        position: 2,
        topic: "hi",
        overwrites: [],
        voiceMemberCount: 0,
      },
    ],
    config: { "adoption.snapshot.retention_days": 90 },
    boundChannelIds: [],
    koolbotCreatedIds: [],
    ...over,
  };
}

const approval = (
  kind: "channel.delete" | "role.delete" | "overwrite.remove",
  targetId: string,
) => ({
  kind,
  targetId,
  approvedBy: "admin",
  approvedAt: "2026-10-01T10:00:00Z",
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function harness() {
  const calls: string[] = [];
  const records = new Map<string, Record_>();
  const failOn = new Set<string>();
  const failMembers = new Set<string>();
  let n = 0;
  const run = (label: string) => {
    calls.push(label);
    if (failOn.has(label)) throw new Error(`boom ${label}`);
  };
  const deps: Deps = {
    gateway: {
      createRole: async (i) => {
        run(`createRole:${i.name}`);
        return `role-${++n}`;
      },
      editRole: async (id, c) => {
        run(`editRole:${id}:${Object.keys(c).join(",")}`);
      },
      deleteRole: async (id) => {
        run(`deleteRole:${id}`);
      },
      setOverwrite: async (ch, o) => {
        run(`setOverwrite:${ch}:${o.id}`);
      },
      removeOverwrite: async (ch, t) => {
        run(`removeOverwrite:${ch}:${t}`);
      },
      deleteChannel: async (id) => {
        run(`deleteChannel:${id}`);
      },
      recreateChannel: async (c) => {
        run(`recreateChannel:${c.name}`);
        return `new-${c.id}`;
      },
      addMemberRole: async (m, r) => {
        run(`addMember:${m}:${r}`);
        if (failMembers.has(m)) throw new Error("no");
      },
      removeMemberRole: async (m, r) => {
        run(`removeMember:${m}:${r}`);
      },
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
    },
    config: {
      set: async (k, v) => {
        run(`config:${k}=${v}`);
      },
      reload: async () => {
        calls.push("reload");
      },
    },
    callApi: async (call) => call(),
    audit: async (_s, e) => {
      calls.push(`audit:${e.action}:${e.result}`);
    },
    sleep: async () => {},
  };
  return {
    deps,
    calls,
    records,
    failOn,
    failMembers,
    service: new ServerAdoptionService(deps),
  };
}

const opts = { actor, batchDelayMs: 0 };

describe("ServerAdoptionService.apply", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  const plan = () =>
    planAdoption(scanned(), {
      roles: [
        { name: "New", color: 7 },
        { id: "member", name: "Member", color: 2 },
      ],
      overwrites: [
        {
          channelId: "chat",
          target: { roleName: "New" },
          allow: VIEW,
          deny: "0",
        },
      ],
      config: { "adoption.snapshot.retention_days": 30 },
      deletions: [{ kind: "channel", id: "old-cat" }],
      approvals: [approval("channel.delete", "old-cat")],
    });

  it("takes the snapshot before the first Discord write, runs in order, audits each, reloads last", async () => {
    const result = await h.service.apply(plan(), opts);
    expect(result.status).toBe("applied");
    expect(h.calls[0]).toBe("snapshot.create");
    const writes = h.calls.filter(
      (c) => !c.startsWith("audit:") && c !== "snapshot.create",
    );
    expect(writes).toEqual([
      "createRole:New",
      "editRole:member:color",
      "setOverwrite:chat:role-1", // "new:" ref resolved to the created role
      "config:adoption.snapshot.retention_days=30",
      "deleteChannel:old-cat",
      "reload",
    ]);
    expect(h.calls.filter((c) => c.startsWith("audit:"))).toHaveLength(5);
    expect(h.records.get(result.snapshotId)!.baseline.channels[0].id).toBe(
      "old-cat",
    );
  });

  it("refuses a plan that has blocking errors", async () => {
    const bad = planAdoption(scanned(), {
      deletions: [{ kind: "channel", id: "chat" }],
    });
    await expect(h.service.apply(bad, opts)).rejects.toBeInstanceOf(
      AdoptionPlanError,
    );
    expect(h.calls).toEqual([]);
  });

  it("records a partial failure, skips destructive steps, and resumes", async () => {
    h.failOn.add("config:adoption.snapshot.retention_days=30");
    const p = plan();
    const first = await h.service.apply(p, opts);
    expect(first.status).toBe("partial");
    expect(first.failed.map((f) => f.opId)).toEqual(["op-4"]);
    expect(first.skipped).toEqual(["op-5"]);
    expect(h.calls).not.toContain("deleteChannel:old-cat");
    expect(first.applied).toEqual(["op-1", "op-2", "op-3"]);

    h.failOn.clear();
    h.calls.length = 0;
    const second = await h.service.apply(p, {
      ...opts,
      resumeSnapshotId: first.snapshotId,
    });
    expect(second.status).toBe("applied");
    expect(
      h.calls.filter((c) => !c.startsWith("audit:") && c !== "reload"),
    ).toEqual([
      "config:adoption.snapshot.retention_days=30",
      "deleteChannel:old-cat",
    ]);
  });

  it("fails dependent steps when a role they need was never created", async () => {
    h.failOn.add("createRole:New");
    const r = await h.service.apply(plan(), opts);
    expect(r.failed.map((f) => f.opId)).toEqual(["op-1", "op-3"]);
    expect(r.failed[1].error).toMatch(/not been created/);
    expect(r.skipped).toEqual(["op-5"]);
  });

  it("rejects resuming with a snapshot from a different plan", async () => {
    const r = await h.service.apply(plan(), opts);
    const other = planAdoption(scanned(), { roles: [{ name: "Other" }] });
    await expect(
      h.service.apply(other, { ...opts, resumeSnapshotId: r.snapshotId }),
    ).rejects.toThrow(/different plan/);
  });

  it("pauses between batches", async () => {
    const sleep = jest.fn(async () => {});
    h.deps.sleep = sleep;
    await new ServerAdoptionService(h.deps).apply(plan(), {
      actor,
      batchSize: 2,
      batchDelayMs: 500,
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("runs destructive operations only after every additive one", async () => {
    const result = await h.service.apply(plan(), opts);
    const order = h.calls.filter((c) =>
      /^(createRole|editRole|setOverwrite|config|deleteChannel)/.test(c),
    );
    expect(order.at(-1)).toBe("deleteChannel:old-cat");
    expect(result.skipped).toEqual([]);
  });
});

describe("member operations", () => {
  it("pages through thousands of members, persists progress, and retries failures on resume", async () => {
    const h = harness();
    const ids = Array.from({ length: 3000 }, (_, i) => `m${i}`);
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ids }],
    });
    expect(p.operations[0]).toMatchObject({ memberCount: 3000 });
    h.failMembers.add("m1500");
    const first = await h.service.apply(p, { ...opts, memberPageSize: 100 });
    expect(first.status).toBe("partial");
    expect(h.calls.filter((c) => c.startsWith("addMember:"))).toHaveLength(
      3000,
    );
    const saved = h.records.get(first.snapshotId)!.memberProgress["op-1"];
    expect(saved.done).toBe(3000);
    expect(saved.failed).toEqual(["m1500"]);

    h.failMembers.clear();
    h.calls.length = 0;
    const second = await h.service.apply(p, {
      ...opts,
      resumeSnapshotId: first.snapshotId,
    });
    expect(second.status).toBe("applied");
    expect(h.calls.filter((c) => c.startsWith("addMember:"))).toEqual([
      "addMember:m1500:member",
    ]);
  });

  it("runs as a background job that reports progress", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    const job = h.service.startApply(p, opts);
    expect(job.status).toBe("running");
    await new Promise((r) => setTimeout(r, 10));
    const done = h.service.getJob(job.id)!;
    expect(done.status).toBe("done");
    expect(done.result?.status).toBe("applied");
    expect(done.progress.completed).toBe(1);
  });
});

describe("ServerAdoptionService.rollback", () => {
  it("restores roles, overwrites, config, deleted channels and member grants", async () => {
    const h = harness();
    const p = planAdoption(
      scanned({ config: { "adoption.snapshot.retention_days": 90 } }),
      {
        roles: [{ name: "New" }, { id: "member", name: "Member", color: 2 }],
        overwrites: [
          {
            channelId: "chat",
            target: { roleName: "New" },
            allow: VIEW,
            deny: "0",
          },
          {
            channelId: "old-cat",
            target: { id: "member" },
            allow: "0",
            deny: VIEW,
          },
        ],
        memberGrants: [{ role: { roleName: "New" }, memberIds: ["a", "b"] }],
        config: { "adoption.snapshot.retention_days": 30 },
        deletions: [{ kind: "channel", id: "old-cat" }],
        approvals: [approval("channel.delete", "old-cat")],
      },
    );
    expect(p.errors).toEqual([]);
    const applied = await h.service.apply(p, opts);
    expect(applied.status).toBe("applied");
    h.calls.length = 0;

    const result = await h.service.rollback(applied.snapshotId, {
      actor,
      deleteCreatedRoles: true,
    });
    expect(result.failed).toEqual([]);
    expect(
      h.calls.filter((c) => !c.startsWith("audit:") && c !== "reload"),
    ).toEqual([
      "recreateChannel:Old",
      "config:adoption.snapshot.retention_days=90",
      "removeMember:a:role-1",
      "removeMember:b:role-1",
      "removeOverwrite:chat:role-1",
      "setOverwrite:new-old-cat:member",
      "editRole:member:color",
      "deleteRole:role-1",
    ]);
    expect(result.notes[0]).toMatch(/Messages, pins, threads, webhooks/);
    expect(h.records.get(applied.snapshotId)!.status).toBe("rolled_back");
    expect(h.records.get(applied.snapshotId)!.rolledBackBy).toBe("admin");
  });

  it("keeps roles the plan created unless asked to delete them", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    const applied = await h.service.apply(p, opts);
    h.calls.length = 0;
    await h.service.rollback(applied.snapshotId, { actor });
    expect(h.calls.some((c) => c.startsWith("deleteRole"))).toBe(false);
  });

  it("only reverts operations that were applied, and refuses a second rollback", async () => {
    const h = harness();
    h.failOn.add("config:adoption.snapshot.retention_days=30");
    const p = planAdoption(scanned(), {
      roles: [{ id: "member", name: "Member", color: 2 }],
      config: { "adoption.snapshot.retention_days": 30 },
    });
    const applied = await h.service.apply(p, opts);
    h.failOn.clear();
    h.calls.length = 0;
    await h.service.rollback(applied.snapshotId, { actor });
    expect(h.calls.filter((c) => c.startsWith("config:"))).toEqual([]);
    await expect(
      h.service.rollback(applied.snapshotId, { actor }),
    ).rejects.toThrow(/already rolled back/);
    await expect(h.service.rollback("nope", { actor })).rejects.toBeInstanceOf(
      AdoptionPlanError,
    );
  });

  it("stays open for retry when a rollback step fails", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      roles: [{ id: "member", name: "Member", color: 2 }],
    });
    const applied = await h.service.apply(p, opts);
    h.failOn.add("editRole:member:color");
    const r = await h.service.rollback(applied.snapshotId, { actor });
    expect(r.failed).toHaveLength(1);
    expect(h.records.get(applied.snapshotId)!.status).toBe("applied");
  });
});
