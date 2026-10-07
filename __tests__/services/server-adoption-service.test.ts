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
    memberRoles: {},
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
  const liveConfig = new Map<string, string | number | boolean | null>();
  const existingChannelByName = new Map<string, string>();
  const staleIds = new Set<string>();
  const recoveries: string[] = [];
  const existingRoleByName = new Map<string, string>();
  const lookups: string[] = [];
  const createdRoleIds = new Set<string>();
  let configIssues: string[] = [];
  const overrideAbsent = new Set<string>();
  let strictAuditFails = false;
  const strictAudits: string[] = [];
  let n = 0;
  const run = (label: string) => {
    calls.push(label);
    if (failOn.has(label)) throw new Error(`boom ${label}`);
  };
  const deps: Deps = {
    gateway: {
      createRole: async (i) => {
        run(`createRole:${i.name}`);
        const id = `role-${++n}`;
        createdRoleIds.add(id);
        return id;
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
      memberHasRole: async (m) => alreadyHolds.has(m),
      findChannel: async (name) => {
        calls.push(`findChannel:${name}`);
        return existingChannelByName.get(name) ?? null;
      },
      setChannelParent: async (ch, parent) => {
        run(`setParent:${ch}:${parent}`);
      },
      findRoleByName: async (name) => {
        lookups.push(name);
        return existingRoleByName.get(name) ?? null;
      },
      readRole: async (id) =>
        (live.roles.get(id) ??
          scanned().roles.find((r) => r.id === id) ??
          (createdRoleIds.has(id) ||
          [...existingRoleByName.values()].includes(id)
            ? {
                id,
                name: "x",
                color: 0,
                permissions: "0",
                position: 1,
                managed: false,
              }
            : null)) as never,
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
      recoverStale: async (guildId) => {
        recoveries.push(guildId);
        let n = 0;
        for (const r of records.values()) {
          if (
            r.guildId === guildId &&
            staleIds.has(r.id) &&
            (r.status === "applying" || r.status === "rolling_back")
          ) {
            r.status = r.status === "applying" ? "partial" : "rollback_partial";
            n++;
          }
        }
        return n;
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
      hasOverride: async (key) => overrideAbsent.has(key) === false,
      read: async (key) =>
        liveConfig.has(key)
          ? liveConfig.get(key)!
          : ((scanned().config[key] ?? null) as never),
      reload: async () => {
        calls.push("reload");
      },
    },
    callApi: async (call) => call(),
    auditStrict: async (_s, e) => {
      if (strictAuditFails) throw new Error("audit store down");
      strictAudits.push(e.action);
    },
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
    overrideAbsent,
    liveConfig,
    existingChannelByName,
    createdRoleIds,
    strictAudits,
    staleIds,
    recoveries,
    existingRoleByName,
    live,
    failStrictAudit: (): void => {
      strictAuditFails = true;
    },
    setConfigIssues: (v: string[]): void => {
      configIssues = v;
    },
    service: new ServerAdoptionService(deps),
  };
}

const opts = {
  actor,
  batchDelayMs: 0,
  revalidate: async (): Promise<string[]> => [],
};

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

  it("applies an additive plan made for the bot itself as a system actor (role group sync, #1021)", async () => {
    const system = {
      sessionId: "system:role-group-sync",
      discordUserId: "bot",
      guildId: "g1",
      role: "admin",
      scopes: [],
    } as never;
    const p = planAdoption(
      scanned({ adminUserId: "bot", adminRoleIds: ["botrole"] }),
      { roles: [{ id: "member", name: "Member", color: 2 }] },
      { approverId: "bot" },
    );
    expect(p.errors).toEqual([]);
    expect(p.plannedBy).toBe("bot");
    const result = await h.service.apply(p, {
      actor: system,
      batchDelayMs: 0,
    });
    expect(result.status).toBe("applied");
    expect(h.calls).toContain("editRole:member:color");
    expect(h.records.get(result.snapshotId)?.appliedBy).toBe("bot");
    // Someone else can't apply a plan made for the bot.
    await expect(
      h.service.apply(p, { actor, batchDelayMs: 0 }),
    ).rejects.toBeInstanceOf(AdoptionPlanError);
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
      ...opts,
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
    expect(h.records.get(applied.snapshotId)!.status).toBe("rollback_partial");
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
    h.liveConfig.set("adoption.snapshot.retention_days", null);
    h.overrideAbsent.add("adoption.snapshot.retention_days");
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
    expect(h.records.get(applied.snapshotId)!.status).toBe("rollback_partial");
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

describe("review hardening, round four", () => {
  it("recovers a dead snapshot's lock before taking a new one", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    const first = await h.service.apply(p, opts);
    const dead = h.records.get(first.snapshotId)!;
    dead.status = "applying";
    h.staleIds.add(dead.id);
    const q = planAdoption(scanned(), { roles: [{ name: "Other" }] });
    const second = await h.service.apply(q, opts);
    expect(second.status).toBe("applied");
    expect(dead.status).toBe("partial");
    expect(h.recoveries).toContain("g1");
  });

  it("refuses to resume when a pending role has since become managed", async () => {
    const h = harness();
    h.failOn.add("editRole:member:color");
    const p = planAdoption(scanned(), {
      roles: [{ id: "member", name: "Member", color: 2 }],
    });
    const first = await h.service.apply(p, opts);
    expect(first.status).toBe("partial");
    h.failOn.clear();
    h.live.roles.set("member", { ...scanned().roles[3], managed: true });
    await expect(
      h.service.apply(p, { ...opts, resumeSnapshotId: first.snapshotId }),
    ).rejects.toThrow(/now managed/);
    expect(h.records.get(first.snapshotId)!.status).toBe("partial");
  });

  it("lets the caller veto a resume with its own live-state check", async () => {
    const h = harness();
    h.failOn.add("editRole:member:color");
    const p = planAdoption(scanned(), {
      roles: [{ id: "member", name: "Member", color: 2 }],
    });
    const first = await h.service.apply(p, opts);
    h.failOn.clear();
    await expect(
      h.service.apply(p, {
        ...opts,
        resumeSnapshotId: first.snapshotId,
        revalidate: async (pending) => [
          `${pending.length} step(s) now feature-bound`,
        ],
      }),
    ).rejects.toThrow(/feature-bound/);
  });

  it("puts back the config prefix when a later config write fails", async () => {
    const h = harness();
    const p = planAdoption(
      scanned({ config: { "adoption.snapshot.retention_days": 90 } }),
      {
        config: {
          "adoption.snapshot.retention_days": 30,
          "core.web_audit.retention_days": 10,
        },
      },
    );
    expect(p.operations).toHaveLength(2);
    h.failOn.add(
      `config:${(p.operations[1] as { key: string }).key}=${(p.operations[1] as { value: unknown }).value}`,
    );
    const r = await h.service.apply(p, opts);
    expect(r.status).toBe("partial");
    // The first write is put back to its prior value (90).
    expect(h.calls).toContain("config:adoption.snapshot.retention_days=90");
    expect(h.records.get(r.snapshotId)!.operations[0].status).toBe("pending");
  });

  it("pages the member revocation and persists progress", async () => {
    const h = harness();
    const ids = Array.from({ length: 130 }, (_, i) => `m${i}`);
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ids }],
    });
    const applied = await h.service.apply(p, opts);
    const updates: number[] = [];
    const update = h.deps.store.update;
    h.deps.store.update = async (id, patch) => {
      if (patch.memberProgress) {
        updates.push(patch.memberProgress["op-1"].granted.length);
      }
      return update(id, patch);
    };
    await new ServerAdoptionService(h.deps).rollback(applied.snapshotId, {
      actor,
    });
    expect(updates.slice(0, 3)).toEqual([80, 30, 0]);
  });

  it("runs a rollback as a background job", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      roles: [{ id: "member", name: "Member", color: 2 }],
    });
    const applied = await h.service.apply(p, opts);
    const job = h.service.startRollback(applied.snapshotId, { actor });
    expect(job.status).toBe("running");
    await new Promise((r) => setTimeout(r, 10));
    expect(h.service.getRollbackJob(job.id)!.status).toBe("done");
    expect(h.service.getRollbackJob(job.id)!.result?.failed).toEqual([]);
  });

  it("puts surviving children back under a recreated category", async () => {
    const h = harness();
    const state = scanned({
      channels: [
        scanned().channels[0],
        { ...scanned().channels[1], parentId: "old-cat" },
      ],
    });
    const p = planAdoption(state, {
      deletions: [{ kind: "channel", id: "old-cat" }],
      approvals: [approval("channel.delete", "old-cat")],
    });
    expect(p.baseline.channels.map((c) => c.id).sort()).toEqual([
      "chat",
      "old-cat",
    ]);
    h.live.channels.set(
      "old-cat",
      p.baseline.channels.find((c) => c.id === "old-cat"),
    );
    h.live.channels.set(
      "chat",
      p.baseline.channels.find((c) => c.id === "chat"),
    );
    const applied = await h.service.apply(p, opts);
    h.calls.length = 0;
    await h.service.rollback(applied.snapshotId, { actor });
    expect(h.calls).toContain("setParent:chat:new-old-cat");
  });
});

describe("review hardening, round five", () => {
  const destructive = () =>
    planAdoption(scanned(), {
      deletions: [{ kind: "channel", id: "old-cat" }],
      approvals: [approval("channel.delete", "old-cat")],
    });

  it("rejects a plan edited after planning (content hash mismatch)", async () => {
    const h = harness();
    const p = destructive();
    const tampered = { ...p, operations: p.operations.slice(0, 0) };
    await expect(h.service.apply(tampered, opts)).rejects.toThrow(
      /changed after planning/,
    );
    const extra = destructive().operations[0];
    const withExtraDelete = {
      ...p,
      operations: [
        ...p.operations,
        { ...extra, id: "op-9", channelId: "chat" },
      ],
    } as never;
    await expect(h.service.apply(withExtraDelete, opts)).rejects.toThrow(
      /changed after planning/,
    );
    expect(h.calls).toEqual([]);
  });

  it("requires a live-state check for plans with destructive steps", async () => {
    const h = harness();
    await expect(
      h.service.apply(destructive(), { actor, batchDelayMs: 0 }),
    ).rejects.toThrow(/live-state check/);
  });

  it("runs the live check before a fresh apply and again before the destructive phase", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      roles: [{ name: "New" }],
      deletions: [{ kind: "channel", id: "old-cat" }],
      approvals: [approval("channel.delete", "old-cat")],
    });
    await expect(
      h.service.apply(p, {
        ...opts,
        revalidate: async () => ["admin lost a role"],
      }),
    ).rejects.toThrow(/Live check failed: admin lost a role/);
    expect(h.calls.filter((c) => c.startsWith("createRole"))).toEqual([]);

    const seen: number[] = [];
    let calls = 0;
    const r = await h.service.apply(p, {
      ...opts,
      revalidate: async (ops) => {
        seen.push(ops.length);
        return ++calls === 2 ? ["channel is now feature-bound"] : [];
      },
    });
    expect(seen).toEqual([2, 1]);
    expect(r.status).toBe("partial");
    expect(r.failed[0].error).toMatch(/feature-bound/);
    expect(h.calls.some((c) => c.startsWith("deleteChannel"))).toBe(false);
  });

  it("does not delete anything if its audit intent cannot be stored", async () => {
    const h = harness();
    h.failStrictAudit();
    const r = await h.service.apply(destructive(), opts);
    expect(r.failed[0].error).toMatch(/audit store down/);
    expect(h.calls.some((c) => c.startsWith("deleteChannel"))).toBe(false);
  });

  it("writes an audit intent before each destructive step", async () => {
    const h = harness();
    await h.service.apply(destructive(), opts);
    expect(h.strictAudits).toEqual(["adoption.channel.delete.intent"]);
  });

  it("treats a renamed, moved or re-topiced channel as drift", async () => {
    const h = harness();
    const p = destructive();
    const base = scanned().channels[0];
    for (const change of [
      { name: "renamed" },
      { parentId: "x" },
      { topic: "new" },
      { kind: "text" as const },
    ]) {
      h.live.channels.set("old-cat", { ...base, ...change });
      await expect(h.service.apply(p, opts)).rejects.toThrow(
        /Changed since the plan/,
      );
    }
  });

  it("a delete of something already gone is drift, unless our own earlier attempt began it", async () => {
    const h = harness();
    const p = destructive();
    h.deps.gateway.readChannel = async (id) =>
      id === "old-cat" && h.calls.includes("deleteChannel:old-cat")
        ? null
        : (scanned().channels[0] as never);
    // First attempt: the delete reaches Discord but its result is lost.
    h.deps.gateway.deleteChannel = async (id) => {
      h.calls.push(`deleteChannel:${id}`);
      throw new Error("timeout");
    };
    const first = await new ServerAdoptionService(h.deps).apply(p, opts);
    expect(first.status).toBe("partial");
    // Resume: the channel is gone and our intent is recorded: treated as done.
    const second = await new ServerAdoptionService(h.deps).apply(p, {
      ...opts,
      resumeSnapshotId: first.snapshotId,
    });
    expect(second.status).toBe("applied");

    // A fresh plan against a channel someone else already removed is drift.
    const h2 = harness();
    h2.deps.gateway.readChannel = async (id) =>
      h2.calls.length === 0
        ? (scanned().channels[0] as never)
        : id === "old-cat"
          ? null
          : null;
    h2.deps.store.create = ((create) => async (rec) => {
      h2.calls.push("created");
      return create(rec);
    })(h2.deps.store.create);
    const r = await new ServerAdoptionService(h2.deps).apply(
      destructive(),
      opts,
    );
    expect(r.failed[0].error).toMatch(/no longer exists/);
  });

  it("refuses a rollback when the caller's live check objects", async () => {
    const h = harness();
    const applied = await h.service.apply(
      planAdoption(scanned(), {
        roles: [{ id: "member", name: "Member", color: 2 }],
      }),
      opts,
    );
    await expect(
      h.service.rollback(applied.snapshotId, {
        actor,
        revalidate: async () => ["staff role now needed"],
      }),
    ).rejects.toThrow(/Cannot roll back: staff role now needed/);
    expect(h.records.get(applied.snapshotId)!.status).toBe("applied");
  });

  it("adopts a channel a crashed rollback already recreated", async () => {
    const h = harness();
    const applied = await h.service.apply(destructive(), opts);
    h.deps.gateway.recreateChannel = async () => {
      throw new Error("timeout after creation");
    };
    const first = await h.service.rollback(applied.snapshotId, { actor });
    expect(first.failed).toHaveLength(1);
    expect(h.records.get(applied.snapshotId)!.restoreIntents).toHaveLength(1);
    h.existingChannelByName.set("Old", "new-from-crash");
    const created: string[] = [];
    h.deps.gateway.recreateChannel = async (c) => {
      created.push(c.name);
      return "dup";
    };
    const second = await h.service.rollback(applied.snapshotId, { actor });
    expect(second.failed).toEqual([]);
    expect(created).toEqual([]);
    expect(h.records.get(applied.snapshotId)!.restoredChannels[0].newId).toBe(
      "new-from-crash",
    );
  });

  it("adopts a role a crashed rollback already recreated", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      deletions: [{ kind: "role", id: "member" }],
      approvals: [approval("role.delete", "member")],
    });
    const applied = await h.service.apply(p, opts);
    const create = h.deps.gateway.createRole;
    h.deps.gateway.createRole = async () => {
      throw new Error("timeout after creation");
    };
    await h.service.rollback(applied.snapshotId, { actor });
    h.deps.gateway.createRole = create;
    h.existingRoleByName.set("Member", "role-from-crash");
    h.calls.length = 0;
    const r = await h.service.rollback(applied.snapshotId, { actor });
    expect(r.failed).toEqual([]);
    expect(h.calls.some((c) => c.startsWith("createRole"))).toBe(false);
    expect(h.records.get(applied.snapshotId)!.restoredRoles[0].newId).toBe(
      "role-from-crash",
    );
  });
});

describe("review hardening, round six", () => {
  it("refuses to apply when a touched setting changed since planning", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      config: { "adoption.snapshot.retention_days": 30 },
    });
    h.liveConfig.set("adoption.snapshot.retention_days", 7);
    await expect(h.service.apply(p, opts)).rejects.toThrow(
      /setting adoption.snapshot.retention_days/,
    );
    expect(h.calls).not.toContain("snapshot.create");
  });

  it("keeps failed grants as maybe-ours so a timed-out grant is still revoked on rollback", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ["a", "b"] }],
    });
    h.failMembers.add("b"); // times out, but did reach Discord
    const first = await h.service.apply(p, opts);
    expect(first.status).toBe("partial");
    expect(
      h.records.get(first.snapshotId)!.memberProgress["op-1"].inflight,
    ).toEqual(["b"]);
    h.failMembers.clear();
    h.alreadyHolds.add("b"); // the earlier grant had landed
    await h.service.apply(p, { ...opts, resumeSnapshotId: first.snapshotId });
    expect(
      h.records.get(first.snapshotId)!.memberProgress["op-1"].granted,
    ).toEqual(["a", "b"]);
  });

  it("only reconciles against things created after our write began", async () => {
    const h = harness();
    const seen: Date[] = [];
    h.deps.gateway.findRoleByName = async (_n, after) => {
      seen.push(after);
      return null;
    };
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    h.failOn.add("createRole:New");
    const first = await h.service.apply(p, opts);
    h.failOn.clear();
    await h.service.apply(p, { ...opts, resumeSnapshotId: first.snapshotId });
    const reconcile = seen.filter((d) => d.getTime() > 0);
    expect(reconcile).toHaveLength(1);
    expect(reconcile[0].getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("review hardening, round eight", () => {
  it("refuses a resume when the role being granted gained permissions meanwhile", async () => {
    const h = harness();
    h.failMembers.add("a");
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ["a"] }],
    });
    const first = await h.service.apply(p, opts);
    expect(first.status).toBe("partial");
    h.failMembers.clear();
    h.live.roles.set("member", {
      ...scanned().roles[3],
      permissions: PermissionsBitField.Flags.Administrator.toString(),
    });
    await expect(
      h.service.apply(p, { ...opts, resumeSnapshotId: first.snapshotId }),
    ).rejects.toThrow(/changed since it was planned/);
  });

  it("refuses a fresh apply when the role being granted changed since planning", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ["a"] }],
    });
    h.live.roles.set("member", { ...scanned().roles[3], position: 9 });
    await expect(h.service.apply(p, opts)).rejects.toThrow(
      /Changed since the plan/,
    );
  });
});

describe("review hardening, round nine", () => {
  it("stops the config phase after the first config failure", async () => {
    const h = harness();
    const p = planAdoption(
      scanned({ config: { "adoption.snapshot.retention_days": 90 } }),
      {
        config: {
          "adoption.snapshot.retention_days": 30,
          "core.web_audit.retention_days": 10,
          "core.command_audit.retention_days": 10,
        },
      },
    );
    expect(p.operations).toHaveLength(3);
    const second = p.operations[1] as { key: string; value: unknown };
    h.failOn.add(`config:${second.key}=${second.value}`);
    const r = await h.service.apply(p, opts);
    expect(r.status).toBe("partial");
    const third = p.operations[2] as { key: string; value: unknown };
    expect(h.calls).not.toContain(`config:${third.key}=${third.value}`);
    expect(r.skipped).toEqual(["op-3"]);
  });

  it("records approval and exact target in the destructive intent row", async () => {
    const h = harness();
    const rows: Array<{
      targetId?: string | null;
      details?: Record<string, unknown>;
    }> = [];
    h.deps.auditStrict = async (_s, e) => {
      rows.push(e);
    };
    const state = scanned({
      channels: [
        {
          ...scanned().channels[1],
          overwrites: [{ id: "member", type: "role", allow: VIEW, deny: "0" }],
        },
      ],
    });
    const p = planAdoption(state, {
      overwriteRemovals: [{ channelId: "chat", targetId: "member" }],
      approvals: [approval("overwrite.remove", "chat:member")],
    });
    h.live.channels.set("chat", state.channels[0]);
    await new ServerAdoptionService(h.deps).apply(p, opts);
    expect(rows[0].targetId).toBe("chat:member");
    expect(rows[0].details?.approval).toMatchObject({ approvedBy: "admin" });
    expect(rows[0].details?.summary).toMatch(/Remove overwrite/);
  });

  it("rolls back what a crashed apply did, even though its record never said applied", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      roles: [{ name: "New" }],
      deletions: [{ kind: "channel", id: "old-cat" }],
      approvals: [approval("channel.delete", "old-cat")],
    });
    const applied = await h.service.apply(p, opts);
    // Simulate a crash: the writes happened, but nothing was recorded as done.
    const rec = h.records.get(applied.snapshotId)!;
    rec.status = "partial";
    rec.createdRoles = [];
    for (const r of rec.operations) {
      r.status = "pending";
      r.startedAt = new Date().toISOString() as never;
    }
    h.existingRoleByName.set("New", "role-from-crash");
    h.deps.gateway.readChannel = async () => null; // the channel is gone
    h.calls.length = 0;
    const r = await new ServerAdoptionService(h.deps).rollback(
      applied.snapshotId,
      {
        actor,
        deleteCreatedRoles: true,
      },
    );
    expect(r.failed).toEqual([]);
    expect(h.calls).toContain("recreateChannel:Old");
    expect(h.calls).toContain("deleteRole:role-from-crash");
  });

  it("revokes members from an interrupted page when rolling back", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ["a", "b"] }],
    });
    const applied = await h.service.apply(p, opts);
    const rec = h.records.get(applied.snapshotId)!;
    rec.status = "partial";
    rec.operations[0].status = "failed";
    rec.memberProgress["op-1"] = {
      done: 0,
      failed: [],
      granted: [],
      inflight: ["a", "b"],
    };
    h.alreadyHolds.add("a");
    h.alreadyHolds.add("b");
    h.calls.length = 0;
    await new ServerAdoptionService(h.deps).rollback(applied.snapshotId, {
      actor,
    });
    expect(h.calls.filter((c) => c.startsWith("removeMember"))).toEqual([
      "removeMember:a:member",
      "removeMember:b:member",
    ]);
  });
});

describe("review hardening, round ten", () => {
  it("records a grant whose first attempt landed but timed out and was retried as a no-op", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ["a"] }],
    });
    // Confirmed absent beforehand, then the (retried) add reports "already held".
    h.deps.gateway.memberHasRole = async () => false;
    h.deps.gateway.addMemberRole = async () => false;
    const r = await new ServerAdoptionService(h.deps).apply(p, opts);
    expect(r.status).toBe("applied");
    expect(h.records.get(r.snapshotId)!.memberProgress["op-1"].granted).toEqual(
      ["a"],
    );
  });

  it("does not claim a member whose pre-check failed unless the add changed something", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ["a", "b"] }],
    });
    h.deps.gateway.memberHasRole = async () => {
      throw new Error("lookup failed");
    };
    h.deps.gateway.addMemberRole = async (m) => m === "b"; // a already held it
    const r = await new ServerAdoptionService(h.deps).apply(p, opts);
    expect(h.records.get(r.snapshotId)!.memberProgress["op-1"].granted).toEqual(
      ["b"],
    );
  });
});

describe("review hardening, round twelve", () => {
  it("refuses to apply when a role it would create now exists", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    h.existingRoleByName.set("New", "someone-elses");
    await expect(h.service.apply(p, opts)).rejects.toThrow(
      /role "New" now exists/,
    );
    expect(h.calls.some((c) => c.startsWith("createRole"))).toBe(false);
  });

  it("creates roles and recreates channels and roles with a single attempt", async () => {
    const h = harness();
    const once: string[] = [];
    h.deps.callApi = async (call, name, opts2) => {
      if (opts2?.once) once.push(name);
      return call();
    };
    const p = planAdoption(scanned(), {
      roles: [{ name: "New" }],
      deletions: [{ kind: "channel", id: "old-cat" }],
      approvals: [approval("channel.delete", "old-cat")],
    });
    const applied = await new ServerAdoptionService(h.deps).apply(p, opts);
    await new ServerAdoptionService(h.deps).rollback(applied.snapshotId, {
      actor,
    });
    expect(once).toEqual(["create role New", "recreate channel Old"]);
  });

  it("claims the snapshot before reconciling, and puts its status back if rollback is refused", async () => {
    const h = harness();
    const applied = await h.service.apply(
      planAdoption(scanned(), {
        roles: [{ id: "member", name: "Member", color: 2 }],
      }),
      opts,
    );
    const order: string[] = [];
    const claim = h.deps.store.claim;
    h.deps.store.claim = async (...args) => {
      order.push("claim");
      return claim(...args);
    };
    await expect(
      new ServerAdoptionService(h.deps).rollback(applied.snapshotId, {
        actor,
        revalidate: async () => {
          order.push("revalidate");
          return ["not now"];
        },
      }),
    ).rejects.toThrow(/Cannot roll back: not now/);
    expect(order).toEqual(["claim", "revalidate"]);
    expect(h.records.get(applied.snapshotId)!.status).toBe("applied");
  });

  it("treats an already-deleted adoption-created role as rolled back", async () => {
    const h = harness();
    const applied = await h.service.apply(
      planAdoption(scanned(), { roles: [{ name: "New" }] }),
      opts,
    );
    h.deps.gateway.readRole = async () => null; // a timed-out delete already went through
    h.calls.length = 0;
    const r = await new ServerAdoptionService(h.deps).rollback(
      applied.snapshotId,
      {
        actor,
        deleteCreatedRoles: true,
      },
    );
    expect(r.failed).toEqual([]);
    expect(h.calls.some((c) => c.startsWith("deleteRole"))).toBe(false);
  });

  it("drops finished jobs after their polling window", async () => {
    const h = harness();
    const p = planAdoption(scanned(), { roles: [{ name: "New" }] });
    const first = h.service.startApply(p, opts);
    await new Promise((r) => setTimeout(r, 10));
    first.finishedAt = Date.now() - 2 * 60 * 60 * 1000;
    h.service.startApply(
      planAdoption(scanned(), { roles: [{ name: "Other" }] }),
      opts,
    );
    expect(h.service.getJob(first.id)).toBeUndefined();
  });
});

describe("review hardening, round thirteen", () => {
  it("a dead rollback can only be continued as a rollback, never resumed as an apply", async () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      roles: [{ id: "member", name: "Member", color: 2 }],
    });
    const applied = await h.service.apply(p, opts);
    const rec = h.records.get(applied.snapshotId)!;
    rec.status = "rolling_back";
    h.staleIds.add(rec.id);
    // Another admin's apply for the same server triggers stale recovery.
    await h.deps.store.recoverStale("g1", 0);
    expect(rec.status).toBe("rollback_partial");
    await expect(
      h.service.apply(p, { ...opts, resumeSnapshotId: applied.snapshotId }),
    ).rejects.toThrow(/cannot be resumed/);
    const r = await h.service.rollback(applied.snapshotId, { actor });
    expect(r.failed).toEqual([]);
    expect(rec.status).toBe("rolled_back");
  });

  it("audits the config operations it skips", async () => {
    const h = harness();
    const audits: string[] = [];
    h.deps.audit = async (_s, e) => {
      audits.push(`${e.action}:${e.result}`);
    };
    const p = planAdoption(
      scanned({ config: { "adoption.snapshot.retention_days": 90 } }),
      {
        config: {
          "adoption.snapshot.retention_days": 30,
          "core.web_audit.retention_days": 10,
        },
      },
    );
    const first = p.operations[0] as { key: string; value: unknown };
    h.failOn.add(`config:${first.key}=${first.value}`);
    await new ServerAdoptionService(h.deps).apply(p, opts);
    expect(
      audits.filter((a) => a === "adoption.config.set:failure"),
    ).toHaveLength(2);
  });
});

describe("review hardening, round fourteen", () => {
  it("looks a crashed role up by the colour and permissions it was created with", async () => {
    const h = harness();
    const seen: Array<{ color: number; permissions: string } | undefined> = [];
    h.deps.gateway.findRoleByName = async (_n, _after, expect) => {
      seen.push(expect);
      return null;
    };
    const p = planAdoption(scanned(), {
      roles: [{ name: "New", color: 7, permissions: VIEW }],
    });
    h.failOn.add("createRole:New");
    const first = await new ServerAdoptionService(h.deps).apply(p, opts);
    h.failOn.clear();
    await new ServerAdoptionService(h.deps).apply(p, {
      ...opts,
      resumeSnapshotId: first.snapshotId,
    });
    expect(seen.filter(Boolean)).toEqual([{ color: 7, permissions: VIEW }]);
  });
});

describe("review hardening, round fifteen", () => {
  it("a rollback of an interrupted create also requires the colour and permissions to match", async () => {
    const h = harness();
    const seen: Array<{ color: number; permissions: string } | undefined> = [];
    h.deps.gateway.findRoleByName = async (_n, _a, expect) => {
      seen.push(expect);
      return null;
    };
    const p = planAdoption(scanned(), {
      roles: [{ name: "New", color: 5, permissions: VIEW }],
    });
    const applied = await h.service.apply(p, opts);
    const rec = h.records.get(applied.snapshotId)!;
    rec.status = "partial";
    rec.operations[0].status = "pending";
    rec.operations[0].startedAt = new Date().toISOString() as never;
    await new ServerAdoptionService(h.deps).rollback(applied.snapshotId, {
      actor,
    });
    expect(seen.filter(Boolean)).toContainEqual({
      color: 5,
      permissions: VIEW,
    });
  });
});

describe("review hardening, round sixteen", () => {
  it("restores 'no override' for a setting that only had a default, not today's default as an override", async () => {
    const h = harness();
    h.overrideAbsent.add("adoption.snapshot.retention_days");
    // The scan sees the effective default (90) even though nothing is stored.
    const p = planAdoption(
      scanned({ config: { "adoption.snapshot.retention_days": 90 } }),
      {
        config: { "adoption.snapshot.retention_days": 30 },
      },
    );
    const applied = await h.service.apply(p, opts);
    expect(h.records.get(applied.snapshotId)!.configOverrides).toEqual({
      "adoption.snapshot.retention_days": false,
    });
    h.calls.length = 0;
    await h.service.rollback(applied.snapshotId, { actor });
    expect(h.calls).toContain("configDelete:adoption.snapshot.retention_days");
    expect(h.calls).not.toContain("config:adoption.snapshot.retention_days=90");
  });

  it("puts a stored override back to its previous value", async () => {
    const h = harness();
    const p = planAdoption(
      scanned({ config: { "adoption.snapshot.retention_days": 90 } }),
      {
        config: { "adoption.snapshot.retention_days": 30 },
      },
    );
    const applied = await h.service.apply(p, opts);
    h.calls.length = 0;
    await h.service.rollback(applied.snapshotId, { actor });
    expect(h.calls).toContain("config:adoption.snapshot.retention_days=90");
  });

  it("refuses a destructive background apply without a live check before starting a job", () => {
    const h = harness();
    const p = planAdoption(scanned(), {
      deletions: [{ kind: "channel", id: "old-cat" }],
      approvals: [approval("channel.delete", "old-cat")],
    });
    expect(() => h.service.startApply(p, { actor, batchDelayMs: 0 })).toThrow(
      /live-state check/,
    );
  });
});

describe("grants before gating overwrites", () => {
  const desired = {
    memberGrants: [{ role: { id: "member" }, memberIds: ["m1", "m2"] }],
    overwrites: [
      { channelId: "chat", target: { id: "g1" }, allow: "0", deny: VIEW },
      { channelId: "chat", target: { id: "staff" }, allow: VIEW, deny: "0" },
    ],
  };

  it("orders grants first only when asked, and tags the gating overwrites", () => {
    const def = planAdoption(scanned(), desired);
    expect(def.operations.map((o) => o.type)).toEqual([
      "overwrite.set",
      "overwrite.set",
      "member.role.add",
    ]);
    const gated = planAdoption(scanned(), desired, {
      grantsBeforeOverwrites: true,
    });
    expect(gated.operations.map((o) => o.type)).toEqual([
      "member.role.add",
      "overwrite.set",
      "overwrite.set",
    ]);
    expect(gated.operations[1]).toMatchObject({ afterGrants: true });
    expect(gated.operations[2]).toMatchObject({ afterGrants: true });
  });

  it("skips the gate when a grant failed, and applies it on resume", async () => {
    const h = harness();
    const p = planAdoption(scanned(), desired, {
      grantsBeforeOverwrites: true,
    });
    h.failMembers.add("m2");
    const first = await h.service.apply(p, opts);
    expect(first.status).toBe("partial");
    expect(first.skipped).toEqual(["op-2", "op-3"]);

    h.failMembers.clear();
    const second = await h.service.apply(p, {
      ...opts,
      resumeSnapshotId: first.snapshotId,
    });
    expect(second.status).toBe("applied");
    expect(second.applied).toEqual(expect.arrayContaining(["op-2", "op-3"]));
  });

  it("applies every role allow before the @everyone deny, and skips the deny when an allow failed", async () => {
    const h = harness();
    const both = {
      overwrites: [
        { channelId: "chat", target: { id: "g1" }, allow: "0", deny: VIEW },
        { channelId: "chat", target: { id: "staff" }, allow: VIEW, deny: "0" },
      ],
    };
    const p = planAdoption(scanned(), both, { grantsBeforeOverwrites: true });
    expect(
      p.operations.map(
        (o) => (o as { overwriteTargetId: string }).overwriteTargetId,
      ),
    ).toEqual(["staff", "g1"]);
    h.failOn.add("setOverwrite:chat:staff");
    const r = await h.service.apply(p, opts);
    expect(r.skipped).toEqual(["op-2"]);
    expect(h.calls).not.toContain("setOverwrite:chat:g1");
  });

  it("links a created role into config as a plan step and rolls it back", async () => {
    const h = harness();
    h.overrideAbsent.add("rules.role_id");
    const p = planAdoption(
      scanned(),
      {
        roles: [{ name: "Rules accepted" }],
        config: { "rules.role_id": "new:rules accepted" },
      },
      { grantsBeforeOverwrites: true },
    );
    expect(p.operations.find((o) => o.type === "config.set")).toMatchObject({
      valueIsRoleRef: true,
    });
    const applied = await h.service.apply(p, opts);
    expect(applied.status).toBe("applied");
    expect(h.calls).toContain("config:rules.role_id=role-1");
    await h.service.rollback(applied.snapshotId, { actor });
    expect(h.calls).toContain("configDelete:rules.role_id");
    // The link is undone before the role itself is rolled back.
    expect(
      h.calls.indexOf("audit:adoption.rollback.config.set:success"),
    ).toBeLessThan(
      h.calls.indexOf("audit:adoption.rollback.role.create:success"),
    );
  });

describe("a channel-claims sync plan through the real engine (#1022)", () => {
  const sync = async () => {
    const { buildClaimsDesiredState } =
      await import("../../src/services/channel-claims.js");
    const chat = {
      ...scanned().channels[1],
      parentId: "old-cat",
      overwrites: [
        { id: "staff", type: "role" as const, allow: VIEW, deny: "0" },
      ],
    };
    const state = scanned({
      channels: [scanned().channels[0], chat],
    });
    const built = buildClaimsDesiredState(
      [{ channelId: "chat", action: "sync", approveReplace: true }],
      {
        scanned: state,
        groups: [],
        integrationRoleIds: new Set(),
        syncedToParent: new Map([["chat", false]]),
        membersIntent: true,
        suggestedPrefix: null,
        // Stamped at preview time, well before the apply.
        approvedAt: "2026-10-01T10:00:00Z",
      },
    );
    const p = planAdoption(state, built.desired, { approverId: "admin" });
    return { p, state, chat };
  };

  it("applies the category's overwrite first and removes the channel's own one last", async () => {
    const h = harness();
    const { p, chat } = await sync();
    expect(p.errors).toEqual([]);
    h.live.channels.set("chat", chat);
    const r = await h.service.apply(p, opts);
    expect(r.status).toBe("applied");
    const writes = h.calls.filter((c) => /^(set|remove)Overwrite/.test(c));
    expect(writes).toEqual([
      "setOverwrite:chat:member",
      "removeOverwrite:chat:staff",
    ]);
  });

  it("is refused without the live-state check the destructive step needs", async () => {
    const h = harness();
    const { p } = await sync();
    expect(() => h.service.startApply(p, { actor, batchDelayMs: 0 })).toThrow(
      /live-state check/,
    );
  });

  it("is refused when the live check finds the channel changed", async () => {
    const h = harness();
    const { p, chat } = await sync();
    h.live.channels.set("chat", chat);
    await expect(
      h.service.apply(p, {
        ...opts,
        revalidate: async () => ["the channel's permissions changed"],
      }),
    ).rejects.toThrow(/Live check failed/);
    expect(h.calls.some((c) => c.startsWith("removeOverwrite"))).toBe(false);
  });
});
