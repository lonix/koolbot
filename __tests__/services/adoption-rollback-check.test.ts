/**
 * The live-state safety check for restoring a snapshot (#1134), at engine
 * level: a fresh scan of the server, a saved snapshot, and the planner's own
 * checks deciding. Nothing here mocks the planner.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { PermissionsBitField } from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { restoreProblems, buildRestoreDesired } =
  await import("../../src/services/adoption-rollback-check.js");
type Scanned =
  import("../../src/services/server-adoption-planner.js").ScannedState;
type Snapshot =
  import("../../src/services/server-adoption-service.js").AdoptionSnapshotRecord;

const F = PermissionsBitField.Flags;
const VIEW = F.ViewChannel.toString();
const MANAGE_ROLES = F.ManageRoles.toString();
const BOTH = (F.ViewChannel | F.ManageRoles).toString();
const GUILD = "g1";
const opts = {
  actorId: "admin",
  deleteCreatedRoles: false,
  approvedAt: "2026-10-13T10:00:00Z",
};

const role = (
  id: string,
  name: string,
  position: number,
  permissions = "0",
  managed = false,
) => ({ id, name, color: 0, permissions, position, managed });

const channel = (
  id: string,
  overwrites: Scanned["channels"][number]["overwrites"] = [],
) => ({
  id,
  name: id,
  kind: "text" as const,
  rawType: 0,
  parentId: null,
  position: 0,
  topic: null,
  overwrites,
  voiceMemberCount: 0,
});

const ow = (id: string, allow = "0", deny = "0") => ({
  id,
  type: "role" as const,
  allow,
  deny,
});

/**
 * A live server: the admin is an ordinary member (no Administrator) who sees
 * channels through `admin-role`; the bot sees them through `koolbot`.
 */
function live(over: Partial<Scanned> = {}): Scanned {
  return {
    guildId: GUILD,
    ownerId: "owner",
    botUserId: "bot",
    botRoleIds: ["koolbot"],
    botHighestRolePosition: 20,
    adminUserId: "admin",
    adminRoleIds: ["admin-role"],
    otherBotIds: [],
    roles: [
      role(GUILD, "@everyone", 0, VIEW),
      role("koolbot", "KoolBot", 20, BOTH, true),
      role("admin-role", "Admin", 10, "0"),
      role("carl", "Other bot", 8, "0", true),
      role("high", "Above the bot", 30, "0"),
      role("plain", "Plain", 5, "0"),
    ],
    channels: [],
    config: {},
    memberRoles: {},
    boundChannelIds: [],
    koolbotCreatedIds: [],
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "snap-1",
    planId: "plan-1",
    guildId: GUILD,
    appliedBy: "admin",
    status: "applied",
    plan: { operations: [], warnings: [], errors: [] } as never,
    baseline: { absentRoleNames: [], roles: [], channels: [], config: {} },
    operations: [],
    createdRoles: [],
    restoredChannels: [],
    restoredRoles: [],
    restoreIntents: [],
    configOverrides: {},
    rolledBackOps: [],
    memberProgress: {},
    rolledBackBy: null,
    ...over,
  } as Snapshot;
}

/** A plan that set an overwrite; the baseline says what was there before. */
function overwriteSnapshot(
  channelId: string,
  target: string,
  prior: { allow: string; deny: string } | null,
  over: Partial<Snapshot> = {},
): Snapshot {
  return snapshot({
    plan: {
      operations: [
        {
          id: "op-1",
          type: "overwrite.set",
          class: "additive",
          channelId,
          overwriteTargetId: target,
          overwriteTargetType: "role",
          allow: VIEW,
          deny: "0",
        },
      ],
    } as never,
    baseline: {
      absentRoleNames: [],
      roles: [],
      channels: [
        channel(channelId, prior ? [ow(target, prior.allow, prior.deny)] : []),
      ],
      config: {},
    } as never,
    operations: [{ opId: "op-1", status: "applied" }],
    ...over,
  });
}

function roleEditSnapshot(roleId: string, over: Partial<Snapshot> = {}) {
  return snapshot({
    plan: {
      operations: [
        {
          id: "op-1",
          type: "role.edit",
          class: "additive",
          roleId,
          changes: { permissions: VIEW },
        },
      ],
    } as never,
    baseline: {
      absentRoleNames: [],
      roles: [role(roleId, "x", 5, "0")],
      channels: [],
      config: {},
    } as never,
    operations: [{ opId: "op-1", status: "applied" }],
    ...over,
  });
}

describe("restore safety check", () => {
  it("passes a clean restore (nothing the restore does takes access away)", () => {
    // The plan added a view overwrite for `plain`; restoring removes it. The
    // admin and the bot see the channel through other means.
    const scanned = live({
      channels: [channel("c1", [ow("plain", VIEW), ow("admin-role", VIEW)])],
    });
    expect(
      restoreProblems(overwriteSnapshot("c1", "plain", null), scanned, opts),
    ).toEqual([]);
  });

  it("refuses when the restore would remove the admin's own access, and names the channel", () => {
    // The plan allowed `admin-role` on c1 over a saved deny; the admin has
    // relied on that since. Restoring puts the deny back.
    const scanned = live({
      channels: [channel("c1", [ow("admin-role", VIEW)])],
    });
    const problems = restoreProblems(
      overwriteSnapshot("c1", "admin-role", { allow: "0", deny: VIEW }),
      scanned,
      opts,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/remove your own access to "c1"/);
  });

  it("checks the current admin, not the one who applied", () => {
    const scanned = live({
      adminUserId: "someone-else",
      adminRoleIds: ["plain"],
      channels: [channel("c1", [ow("admin-role", VIEW)])],
    });
    // `someone-else` does not hold admin-role, so the restore is fine for them.
    expect(
      restoreProblems(
        overwriteSnapshot("c1", "admin-role", { allow: "0", deny: VIEW }),
        scanned,
        { ...opts, actorId: "someone-else" },
      ),
    ).toEqual([]);
  });

  it("refuses when the restore would lock the bot out of a channel a feature uses", () => {
    const scanned = live({
      channels: [channel("c1", [ow("koolbot", VIEW)])],
      boundChannelIds: ["c1"],
    });
    const problems = restoreProblems(
      overwriteSnapshot("c1", "koolbot", { allow: "0", deny: VIEW }),
      scanned,
      opts,
    );
    expect(problems.join(" ")).toMatch(/lock the bot out of "c1"/);
  });

  it("refuses to edit a managed role", () => {
    const problems = restoreProblems(
      roleEditSnapshot("carl"),
      live({
        roles: live().roles.map((r) =>
          r.id === "carl" ? { ...r, permissions: VIEW } : r,
        ),
      }),
      opts,
    );
    expect(problems.join(" ")).toMatch(/Other bot/);
  });

  it("refuses to edit a role at or above the bot's highest role", () => {
    const problems = restoreProblems(
      roleEditSnapshot("high"),
      live({
        roles: live().roles.map((r) =>
          r.id === "high" ? { ...r, permissions: VIEW } : r,
        ),
      }),
      opts,
    );
    expect(problems.join(" ")).toMatch(/Above the bot/);
  });

  it("refuses when the bot has lost Manage Roles, which every restore step needs", () => {
    const scanned = live({
      roles: live().roles.map((r) =>
        r.id === "koolbot" ? { ...r, permissions: VIEW } : r,
      ),
      channels: [channel("c1", [ow("plain", VIEW)])],
    });
    expect(
      restoreProblems(overwriteSnapshot("c1", "plain", null), scanned, opts),
    ).toEqual([expect.stringMatching(/Manage Roles/)]);
    expect(MANAGE_ROLES).toBeTruthy();
  });

  it("restores a role edit when the role is an ordinary one", () => {
    const scanned = live({
      roles: live().roles.map((r) =>
        r.id === "plain" ? { ...r, permissions: VIEW } : r,
      ),
    });
    expect(restoreProblems(roleEditSnapshot("plain"), scanned, opts)).toEqual(
      [],
    );
  });

  describe("created roles", () => {
    const created = {
      createdRoles: [{ ref: "new:staff", roleId: "made", name: "Staff" }],
      plan: {
        operations: [
          {
            id: "op-1",
            type: "role.create",
            class: "additive",
            ref: "new:staff",
            name: "Staff",
            color: 0,
            permissions: "0",
            position: null,
          },
        ],
      } as never,
      operations: [{ opId: "op-1", status: "applied" }],
    } as Partial<Snapshot>;
    // The admin sees c1 only through the created role.
    const scanned = (): Scanned =>
      live({
        adminRoleIds: ["admin-role", "made"],
        roles: [...live().roles, role("made", "Staff", 4)],
        channels: [
          channel("c1", [
            { id: GUILD, type: "role", allow: "0", deny: VIEW },
            ow("made", VIEW),
          ]),
        ],
      });

    it("leaves created roles alone by default, so access is kept", () => {
      expect(restoreProblems(snapshot(created), scanned(), opts)).toEqual([]);
    });

    it("refuses deleting a created role the admin relies on when that is chosen", () => {
      const problems = restoreProblems(snapshot(created), scanned(), {
        ...opts,
        deleteCreatedRoles: true,
      });
      expect(problems.join(" ")).toMatch(/remove your own access to "c1"/);
    });
  });

  describe("partly rolled-back snapshots", () => {
    const unsafe = (over: Partial<Snapshot> = {}) =>
      overwriteSnapshot("c1", "admin-role", { allow: "0", deny: VIEW }, over);
    const scanned = (allow: boolean) =>
      live({
        channels: [
          channel("c1", [allow ? ow("admin-role", VIEW) : ow("admin-role")]),
        ],
      });

    it("checks only what is still to be reverted: a step already rolled back is part of the live state", () => {
      // Step 1 was restored earlier (the deny is back, the admin lost access
      // through that, or someone re-granted since): it is not re-planned.
      expect(
        restoreProblems(
          unsafe({ status: "rollback_partial", rolledBackOps: ["op-1"] }),
          scanned(true),
          opts,
        ),
      ).toEqual([]);
    });

    it("still refuses an unfinished step that would lock the admin out", () => {
      expect(
        restoreProblems(
          unsafe({ status: "rollback_partial", rolledBackOps: [] }),
          scanned(true),
          opts,
        ),
      ).toHaveLength(1);
    });

    it("ignores steps that failed or were skipped when applied: they changed nothing", () => {
      expect(
        restoreProblems(
          unsafe({ operations: [{ opId: "op-1", status: "failed" }] }),
          scanned(true),
          opts,
        ),
      ).toEqual([]);
    });
  });

  describe("ids recreated by an earlier restore", () => {
    it("maps the saved role and channel ids to the ones that exist now", () => {
      // The plan deleted channel `old-c` and role `old-r`; an earlier restore
      // recreated them as `new-c` and `new-r`. The overwrite the plan changed
      // (on the recreated channel, for the recreated role) is checked there.
      const snap = overwriteSnapshot("old-c", "old-r", null, {
        restoredChannels: [{ oldId: "old-c", newId: "new-c" }],
        restoredRoles: [{ oldId: "old-r", newId: "new-r" }],
      });
      const scanned = live({
        roles: [...live().roles, role("new-r", "Recreated", 4)],
        channels: [channel("new-c", [ow("new-r", VIEW)])],
      });
      const desired = buildRestoreDesired(snap, scanned, opts);
      expect(desired.overwriteRemovals).toEqual([
        { channelId: "new-c", targetId: "new-r" },
      ]);
      expect(restoreProblems(snap, scanned, opts)).toEqual([]);
    });

    it("skips a channel that no longer exists instead of failing", () => {
      expect(
        restoreProblems(
          overwriteSnapshot("gone", "plain", null),
          live({ channels: [] }),
          opts,
        ),
      ).toEqual([]);
    });
  });

  it("ignores planner errors that are not about safety (a restore is not a new plan)", () => {
    // `plain` is gone from the server: the planner calls that "unknown role",
    // which is not a reason to refuse.
    expect(
      restoreProblems(
        overwriteSnapshot("c1", "missing-role", {
          allow: "0",
          deny: VIEW,
        }),
        live({ channels: [channel("c1")] }),
        opts,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Through the real engine: a refused restore writes nothing.
// ---------------------------------------------------------------------------

const { ServerAdoptionService, AdoptionPlanError } =
  await import("../../src/services/server-adoption-service.js");
const { planAdoption } =
  await import("../../src/services/server-adoption-planner.js");

type Deps =
  import("../../src/services/server-adoption-service.js").AdoptionDeps;

describe("restore through the engine", () => {
  const actor = {
    sessionId: "s",
    discordUserId: "admin",
    guildId: GUILD,
    role: "admin",
  } as never;
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  /** A one-channel server whose admin may only see c1 because of the plan. */
  function world() {
    const channels = new Map([
      ["c1", channel("c1", [ow("admin-role", "0", VIEW)])],
    ]);
    const writes: string[] = [];
    const records = new Map<string, Snapshot>();
    const scan = (): Scanned =>
      live({ channels: clone([...channels.values()]) });
    const deps: Deps = {
      gateway: {
        createRole: async () => "x",
        editRole: async () => undefined,
        deleteRole: async () => undefined,
        setOverwrite: async (ch, o) => {
          const c = channels.get(ch)!;
          c.overwrites = [...c.overwrites.filter((x) => x.id !== o.id), o];
          writes.push(`setOverwrite:${ch}:${o.id}`);
        },
        removeOverwrite: async (ch, t) => {
          const c = channels.get(ch)!;
          c.overwrites = c.overwrites.filter((x) => x.id !== t);
          writes.push(`removeOverwrite:${ch}:${t}`);
        },
        deleteChannel: async () => undefined,
        recreateChannel: async (c) => c.id,
        addMemberRole: async () => true,
        removeMemberRole: async () => undefined,
        memberHasRole: async () => false,
        readRole: async (id) =>
          clone(live().roles.find((r) => r.id === id) ?? null),
        readChannel: async (id) => clone(channels.get(id) ?? null),
        setChannelParent: async () => undefined,
        findChannel: async () => null,
        findRoleByName: async () => null,
      },
      store: {
        create: async (rec) => {
          const full = { ...rec, id: "snap-1", rolledBackBy: null } as Snapshot;
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
        read: async () => null,
        hasOverride: async () => false,
        reload: async () => undefined,
      },
      callApi: async (call) => call(),
      audit: async () => undefined,
      auditStrict: async () => undefined,
      sleep: async () => undefined,
    };
    return {
      channels,
      writes,
      records,
      scan,
      service: new ServerAdoptionService(deps),
    };
  }

  async function applied(w: ReturnType<typeof world>) {
    const plan = planAdoption(
      w.scan(),
      {
        overwrites: [
          {
            channelId: "c1",
            target: { id: "admin-role" },
            allow: VIEW,
            deny: "0",
          },
        ],
      },
      { approverId: "admin" },
    );
    expect(plan.errors).toEqual([]);
    const result = await w.service.apply(plan, {
      actor,
      batchDelayMs: 0,
      revalidate: async () => [],
    });
    expect(result.status).toBe("applied");
    return result.snapshotId;
  }

  const check = (w: ReturnType<typeof world>, id: string) => async () =>
    restoreProblems(w.records.get(id)!, w.scan(), opts);

  it("refuses before any write when the restore would lock the admin out", async () => {
    const w = world();
    const id = await applied(w);
    const writesAfterApply = [...w.writes];
    const before = clone([...w.channels.values()]);
    await expect(
      w.service.rollback(id, { actor, revalidate: check(w, id) }),
    ).rejects.toThrow(/Cannot roll back: .*remove your own access to "c1"/);
    expect(w.writes).toEqual(writesAfterApply);
    expect([...w.channels.values()]).toEqual(before);
    // The snapshot is released, not left claimed.
    expect(w.records.get(id)!.status).toBe("applied");
    await expect(
      w.service.rollback(id, { actor, revalidate: check(w, id) }),
    ).rejects.toBeInstanceOf(AdoptionPlanError);
  });

  it("restores once the check passes (the admin gained access another way)", async () => {
    const w = world();
    const id = await applied(w);
    // Someone gave a role the admin holds explicit access since the apply.
    w.channels.get("c1")!.overwrites.push({
      id: "plain",
      type: "role",
      allow: VIEW,
      deny: "0",
    });
    const scanNow = w.scan();
    scanNow.adminRoleIds = ["admin-role", "plain"];
    const result = await w.service.rollback(id, {
      actor,
      revalidate: async () =>
        restoreProblems(w.records.get(id)!, scanNow, opts),
    });
    expect(result.failed).toEqual([]);
    expect(w.records.get(id)!.status).toBe("rolled_back");
    expect(w.channels.get("c1")!.overwrites).toContainEqual(
      expect.objectContaining({ id: "admin-role", deny: VIEW }),
    );
  });
});
