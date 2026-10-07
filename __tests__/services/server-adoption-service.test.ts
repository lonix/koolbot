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
  const live = {
    roles: new Map<string, unknown>(),
    channels: new Map<string, unknown>(),
  };
  const alreadyHolds = new Set<string>();
  const existingRoleByName = new Map<string, string>();
  let configIssues: string[] = [];
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
        return !alreadyHolds.has(m);
      },
      findRoleByName: async (name) => {
        calls.push(`findRole:${name}`);
        return existingRoleByName.get(name) ?? null;
      },
      readRole: async (id) =>
        (live.roles.get(id) ??
          scanned().roles.find((r) => r.id === id) ??
          null) as never,
      readChannel: async (id) =>
        (live.channels.get(id) ??
          scanned().channels.find((c) => c.id === id) ??
          null) as never,
      removeMemberRole: async (m, r) => {
        run(`removeMember:${m}:${r}`);
      },
    },
    store: {
      create: async (rec) => {
        if (
          [...records.values()].some(
            (r) =>
              r.guildId === rec.guildId &&
              (r.status === "applying" || r.status === "rolling_back"),
          )
        ) {
          throw new AdoptionPlanError(
            "Another apply or rollback is already running",
          );
        }
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
      claim: async (id, from, to) => {
        const rec = records.get(id);
        if (!rec || !from.includes(rec.status)) return false;
        if (
          (to === "applying" || to === "rolling_back") &&
          [...records.values()].some(
            (r) =>
              r !== rec &&
              r.guildId === rec.guildId &&
              (r.status === "applying" || r.status === "rolling_back"),
          )
        ) {
          return false;
        }
        rec.status = to;
        return true;
      },
    },
    config: {
      set: async (k, v) => {
        run(`config:${k}=${v}`);
      },
      delete: async (k) => {
        run(`configDelete:${k}`);
      },
      validate: async () => configIssues,
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
    alreadyHolds,
    existingRoleByName,
    live,
    setConfigIssues: (v: string[]): void => {
      configIssues = v;
    },
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

describe("review hardening", () => {
  it("refuses to apply when a touched role or channel changed since planning", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      roles: [{ id: "member", name: "Member", color: 2 }],
    });
    h.live.roles.set("member", { ...scanned().roles[3], color: 99 });
    await expect(h.service.apply(p, opts)).rejects.toThrow(
      /Changed since the plan/,
    );
    expect(h.calls).not.toContain("snapshot.create");

    const q = planAdoption(scanned(), {
      deletions: [{ kind: "channel", id: "old-cat" }],
      approvals: [approval("channel.delete", "old-cat")],
    });
    h.live.channels.set("old-cat", {
      ...scanned().channels[0],
      overwrites: [],
    });
    await expect(h.service.apply(q, opts)).rejects.toThrow(/channel "Old"/);
  });

  it("validates the whole config batch before any write", async () => {
    const h = harness();
    h.setConfigIssues(["quotes.enabled needs voicechannels.enabled"]);
    const p = planAdoption(scanned(), {
      roles: [{ name: "New" }],
      config: { "adoption.snapshot.retention_days": 30 },
    });
    await expect(h.service.apply(p, opts)).rejects.toThrow(/dependencies/);
    expect(h.calls.filter((c) => c.startsWith("createRole"))).toEqual([]);
  });

  it("refuses to roll back a snapshot that is still applying", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    const applied = await h.service.apply(p, opts);
    h.records.get(applied.snapshotId)!.status = "applying";
    await expect(
      h.service.rollback(applied.snapshotId, { actor }),
    ).rejects.toThrow(/still being applied/);
  });

  it("removes the override when the setting had no stored value", async () => {
    const h = harness();
    const p = planAdoption(scanned({ config: {} }), {
      config: { "adoption.snapshot.retention_days": 30 },
    });
    const applied = await h.service.apply(p, opts);
    h.calls.length = 0;
    await h.service.rollback(applied.snapshotId, { actor });
    expect(h.calls).toContain("configDelete:adoption.snapshot.retention_days");
  });

  it("a retried rollback skips reversals that already succeeded", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      roles: [{ id: "member", name: "Member", color: 2 }],
      config: { "adoption.snapshot.retention_days": 30 },
      deletions: [{ kind: "channel", id: "old-cat" }],
      approvals: [approval("channel.delete", "old-cat")],
    });
    const applied = await h.service.apply(p, opts);
    h.calls.length = 0;
    h.failOn.add("editRole:member:color");
    const first = await h.service.rollback(applied.snapshotId, { actor });
    expect(first.failed).toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith("recreateChannel"))).toHaveLength(
      1,
    );

    h.failOn.clear();
    h.calls.length = 0;
    const second = await h.service.rollback(applied.snapshotId, { actor });
    expect(second.failed).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("recreateChannel"))).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("editRole"))).toHaveLength(1);
    expect(h.records.get(applied.snapshotId)!.status).toBe("rolled_back");
  });

  it("restores a deleted role first and puts its overwrites back on the new role", async () => {
    const h = harness();
    const state = scanned({
      channels: [
        {
          ...scanned().channels[1],
          overwrites: [{ id: "member", type: "role", allow: VIEW, deny: "0" }],
        },
      ],
    });
    const p = planAdoption(state, {
      deletions: [{ kind: "role", id: "member" }],
      approvals: [approval("role.delete", "member")],
    });
    h.live.channels.set("chat", state.channels[0]);
    const applied = await h.service.apply(p, opts);
    h.calls.length = 0;
    await h.service.rollback(applied.snapshotId, { actor });
    const writes = h.calls.filter(
      (c) => !c.startsWith("audit:") && c !== "reload",
    );
    expect(writes[0]).toBe("createRole:Member");
    expect(writes).toContain("setOverwrite:chat:role-1");
  });
});

describe("review hardening, round two", () => {
  it("rejects plans and snapshots from another server", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    const other = { ...actor, guildId: "g2" } as never;
    await expect(h.service.apply(p, { ...opts, actor: other })).rejects.toThrow(
      /different server/,
    );
    const applied = await h.service.apply(p, opts);
    await expect(
      h.service.rollback(applied.snapshotId, { actor: other }),
    ).rejects.toThrow(/different server/);
    await expect(
      h.service.apply(p, {
        ...opts,
        actor: other,
        resumeSnapshotId: applied.snapshotId,
      }),
    ).rejects.toThrow(/different server/);
  });

  it("marks a resumed snapshot as applying and blocks a concurrent rollback", async () => {
    const h = harness();
    h.failOn.add("config:adoption.snapshot.retention_days=30");
    const p = planAdoption(scanned(), {
      config: { "adoption.snapshot.retention_days": 30 },
    });
    const first = await h.service.apply(p, opts);
    expect(first.status).toBe("partial");
    h.failOn.clear();
    let statusDuringResume = "";
    h.deps.config.set = async () => {
      statusDuringResume = h.records.get(first.snapshotId)!.status;
      await expect(
        h.service.rollback(first.snapshotId, { actor }),
      ).rejects.toThrow(/still being applied/);
    };
    await h.service.apply(p, { ...opts, resumeSnapshotId: first.snapshotId });
    expect(statusDuringResume).toBe("applying");
    await expect(
      h.service.apply(p, { ...opts, resumeSnapshotId: first.snapshotId }),
    ).rejects.toThrow(/cannot be resumed/);
  });

  it("holds the snapshot in rolling_back during a rollback and restores status on failure", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      roles: [{ id: "member", name: "Member", color: 2 }],
    });
    const applied = await h.service.apply(p, opts);
    let during = "";
    h.deps.gateway.editRole = async () => {
      during = h.records.get(applied.snapshotId)!.status;
      throw new Error("nope");
    };
    await h.service.rollback(applied.snapshotId, { actor });
    expect(during).toBe("rolling_back");
    expect(h.records.get(applied.snapshotId)!.status).toBe("applied");
  });

  it("will not delete a channel that has members connected at delete time", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      deletions: [{ kind: "channel", id: "chat" }],
      approvals: [approval("channel.delete", "chat")],
    });
    const base = scanned().channels[1];
    h.deps.gateway.readChannel = async () => ({ ...base, voiceMemberCount: 0 });
    let reads = 0;
    h.deps.gateway.readChannel = async () => ({
      ...base,
      voiceMemberCount: ++reads > 1 ? 2 : 0, // joins after planning
    });
    const r = await new ServerAdoptionService(h.deps).apply(p, opts);
    expect(r.failed[0].error).toMatch(/members connected/);
    expect(h.calls.some((c) => c.startsWith("deleteChannel"))).toBe(false);
  });

  it("recreates a deleted category before the channel inside it", async () => {
    const h = harness();
    const p = planAdoption(
      scanned({
        channels: [
          scanned().channels[0],
          { ...scanned().channels[1], parentId: "old-cat" },
        ],
      }),
      {
        deletions: [
          { kind: "channel", id: "old-cat" },
          { kind: "channel", id: "chat" },
        ],
        approvals: [
          approval("channel.delete", "old-cat"),
          approval("channel.delete", "chat"),
        ],
      },
    );
    h.live.channels.set(
      "old-cat",
      p.baseline.channels.find((c) => c.id === "old-cat"),
    );
    h.live.channels.set(
      "chat",
      p.baseline.channels.find((c) => c.id === "chat"),
    );
    const applied = await h.service.apply(p, opts);
    expect(applied.status).toBe("applied");
    h.calls.length = 0;
    await h.service.rollback(applied.snapshotId, { actor });
    const created = h.calls.filter((c) => c.startsWith("recreateChannel"));
    expect(created).toEqual(["recreateChannel:Old", "recreateChannel:chat"]);
  });

  it("revokes grants from a member operation that failed part-way, and only real grants", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ["a", "b", "c"] }],
    });
    h.failMembers.add("c");
    h.alreadyHolds.add("b"); // gained the role after the scan
    const applied = await h.service.apply(p, opts);
    expect(applied.status).toBe("partial");
    expect(
      h.records.get(applied.snapshotId)!.memberProgress["op-1"].granted,
    ).toEqual(["a"]);
    h.calls.length = 0;
    await h.service.rollback(applied.snapshotId, { actor });
    expect(h.calls.filter((c) => c.startsWith("removeMember"))).toEqual([
      "removeMember:a:member",
    ]);
  });
});

describe("review hardening, round three", () => {
  it("only the admin the plan was made for can apply it", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    expect(p.plannedBy).toBe("admin");
    const someoneElse = { ...actor, discordUserId: "other-admin" } as never;
    await expect(
      h.service.apply(p, { ...opts, actor: someoneElse }),
    ).rejects.toThrow(/Only the admin the plan was made for/);
    expect(h.calls).toEqual([]);
  });

  it("refuses a second apply or rollback while one is running for the server", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    const q = planAdoption(scanned(), { roles: [{ name: "Other" }] });
    let nested: Promise<unknown> | null = null;
    const create = h.deps.gateway.createRole;
    h.deps.gateway.createRole = async (input) => {
      nested = h.service.apply(q, opts);
      await expect(nested).rejects.toThrow(/already running/);
      return create(input);
    };
    const r = await new ServerAdoptionService(h.deps).apply(p, opts);
    expect(r.status).toBe("applied");
    expect(nested).not.toBeNull();
  });

  it("adopts a role created by a run that died before recording it", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    h.failOn.add("createRole:New");
    const first = await h.service.apply(p, opts);
    expect(first.status).toBe("partial");
    expect(
      h.records.get(first.snapshotId)!.operations[0].startedAt,
    ).toBeTruthy();
    // The create actually reached Discord before the process died.
    h.failOn.clear();
    h.existingRoleByName.set("New", "role-from-crash");
    h.calls.length = 0;
    const second = await h.service.apply(p, {
      ...opts,
      resumeSnapshotId: first.snapshotId,
    });
    expect(second.status).toBe("applied");
    expect(h.calls.some((c) => c.startsWith("createRole"))).toBe(false);
    expect(h.records.get(first.snapshotId)!.createdRoles[0].roleId).toBe(
      "role-from-crash",
    );
  });

  it("counts members from an interrupted page as ours, so rollback revokes them", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ["a", "b"] }],
    });
    h.failOn.add("persist-crash");
    const applied = await h.service.apply(p, opts);
    // Simulate a crash mid-page: both were granted on Discord, nothing recorded.
    const rec = h.records.get(applied.snapshotId)!;
    rec.status = "partial";
    rec.operations[0].status = "pending";
    rec.memberProgress["op-1"] = {
      done: 0,
      failed: [],
      granted: [],
      inflight: ["a", "b"],
    };
    h.alreadyHolds.add("a");
    h.alreadyHolds.add("b");
    await h.service.apply(p, { ...opts, resumeSnapshotId: applied.snapshotId });
    expect(
      h.records.get(applied.snapshotId)!.memberProgress["op-1"].granted,
    ).toEqual(["a", "b"]);
  });
});
