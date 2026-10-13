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

// ---------------------------------------------------------------------------
// Role grants the restore will revoke (#1134, review round 1)
// ---------------------------------------------------------------------------

describe("restore revokes role grants", () => {
  const grantSnapshot = (
    progress: unknown,
    over: Partial<Snapshot> = {},
  ): Snapshot =>
    snapshot({
      plan: {
        operations: [
          {
            id: "op-1",
            type: "member.role.add",
            class: "additive",
            roleId: "grantrole",
            memberCount: 1,
            sample: [],
            memberIds: [],
          },
        ],
      } as never,
      operations: [{ opId: "op-1", status: "applied" }],
      memberProgress: { "op-1": progress } as never,
      ...over,
    });

  /** c1 is hidden from everyone and shown only to `grantrole`. */
  const gated = (over: Partial<Scanned> = {}): Scanned =>
    live({
      roles: [...live().roles, role("grantrole", "Granted", 4)],
      channels: [
        channel("c1", [
          { id: GUILD, type: "role", allow: "0", deny: VIEW },
          ow("grantrole", VIEW),
        ]),
      ],
      ...over,
    });

  it("refuses when the admin is among the members granted a role that is their only access", () => {
    const scanned = gated({ adminRoleIds: ["admin-role", "grantrole"] });
    const problems = restoreProblems(
      grantSnapshot({ done: 2, failed: [], granted: ["other", "admin"] }),
      scanned,
      opts,
    );
    expect(problems.join(" ")).toMatch(/remove your own access to "c1"/);
  });

  it("refuses when the bot is among the members granted a role and a feature channel depends on it", () => {
    const scanned = gated({
      botRoleIds: ["koolbot", "grantrole"],
      boundChannelIds: ["c1"],
    });
    const problems = restoreProblems(
      grantSnapshot({ done: 1, failed: [], granted: ["bot"] }),
      scanned,
      opts,
    );
    expect(problems.join(" ")).toMatch(/lock the bot out of "c1"/);
  });

  it("passes when the admin and the bot are in no grant list", () => {
    const scanned = gated({
      adminRoleIds: ["admin-role", "grantrole"],
      botRoleIds: ["koolbot", "grantrole"],
      boundChannelIds: ["c1"],
    });
    expect(
      restoreProblems(
        grantSnapshot({ done: 2, failed: [], granted: ["m1", "m2"] }),
        scanned,
        opts,
      ),
    ).toEqual([]);
  });

  it("passes when the admin holds the role but also has access another way", () => {
    const scanned = gated({
      adminRoleIds: ["admin-role", "grantrole", "plain"],
      channels: [
        channel("c1", [
          { id: GUILD, type: "role", allow: "0", deny: VIEW },
          ow("grantrole", VIEW),
          ow("plain", VIEW),
        ]),
      ],
    });
    expect(
      restoreProblems(
        grantSnapshot({ done: 1, failed: [], granted: ["admin"] }),
        scanned,
        opts,
      ),
    ).toEqual([]);
  });

  it("refuses, failing closed, when the saved grants cannot be read", () => {
    const scanned = gated({ adminRoleIds: ["admin-role", "grantrole"] });
    for (const broken of [
      { done: 1, failed: [], granted: "admin" },
      { done: 1, failed: [], granted: [], inflight: 7 },
    ]) {
      expect(restoreProblems(grantSnapshot(broken), scanned, opts)).toEqual([
        expect.stringMatching(/could not be read/),
      ]);
    }
    expect(
      restoreProblems(
        grantSnapshot({}, { memberProgress: "garbage" as never }),
        scanned,
        opts,
      ),
    ).toEqual([expect.stringMatching(/could not be read/)]);
  });

  it("treats in-flight grants as possibly ours, the conservative reading", () => {
    const scanned = gated({ adminRoleIds: ["admin-role", "grantrole"] });
    expect(
      restoreProblems(
        grantSnapshot({
          done: 0,
          failed: [],
          granted: [],
          inflight: ["admin"],
        }),
        scanned,
        opts,
      ),
    ).toHaveLength(1);
  });

  it("does not revisit a grant whose revoke already finished", () => {
    const scanned = gated({ adminRoleIds: ["admin-role", "grantrole"] });
    expect(
      restoreProblems(
        grantSnapshot(
          { done: 1, failed: [], granted: ["admin"] },
          { status: "rollback_partial", rolledBackOps: ["op-1"] },
        ),
        scanned,
        opts,
      ),
    ).toEqual([]);
  });

  it("maps a role created by the plan to the role that exists now", () => {
    const scanned = gated({
      adminRoleIds: ["admin-role", "grantrole"],
    });
    const snap = grantSnapshot(
      { done: 1, failed: [], granted: ["admin"] },
      {
        createdRoles: [
          { ref: "new:granted", roleId: "grantrole", name: "Granted" },
        ],
        plan: {
          operations: [
            {
              id: "op-1",
              type: "member.role.add",
              class: "additive",
              roleId: "new:granted",
              memberCount: 1,
              sample: [],
              memberIds: [],
            },
          ],
        } as never,
      },
    );
    expect(restoreProblems(snap, scanned, opts)).toHaveLength(1);
  });

  it("never puts member ids in a message", () => {
    const scanned = gated({ adminRoleIds: ["admin-role", "grantrole"] });
    const text = restoreProblems(
      grantSnapshot({ done: 1, failed: [], granted: ["admin", "secret-9"] }),
      scanned,
      opts,
    ).join(" ");
    expect(text).not.toContain("secret-9");
  });
});

// ---------------------------------------------------------------------------
// Follow-up repairs owed by an earlier, partly finished restore (#1134)
// ---------------------------------------------------------------------------

describe("pending dependent repairs", () => {
  /**
   * The plan deleted role `old-r`; an earlier restore recreated it as `new-r`
   * and finished that step, but stopped before putting c1's saved overwrite for
   * the role back (a deny on view).
   */
  const earlier = (rolledBackOps: string[]): Snapshot =>
    snapshot({
      status: "rollback_partial",
      plan: {
        operations: [
          {
            id: "op-1",
            type: "role.delete",
            class: "destructive",
            roleId: "old-r",
          },
        ],
      } as never,
      operations: [{ opId: "op-1", status: "applied" }],
      baseline: {
        absentRoleNames: [],
        roles: [role("old-r", "Old", 4)],
        channels: [channel("c1", [ow("old-r", "0", VIEW)])],
        config: {},
      } as never,
      restoredRoles: [{ oldId: "old-r", newId: "new-r" }],
      rolledBackOps,
    });
  const world = (adminRoles: string[]): Scanned =>
    live({
      adminRoleIds: adminRoles,
      roles: [...live().roles, role("new-r", "Old", 4)],
      channels: [
        channel("c1", [
          { id: GUILD, type: "role", allow: "0", deny: VIEW },
          ow("new-r", VIEW),
          ow("admin-role", VIEW),
        ]),
      ],
    });

  it("refuses when the pending repair would lock the admin out", () => {
    // The admin sees c1 only through the recreated role's allow; the repair
    // writes the saved deny back onto it.
    const scanned = live({
      adminRoleIds: ["admin-role", "new-r"],
      roles: [...live().roles, role("new-r", "Old", 4)],
      channels: [
        channel("c1", [
          { id: GUILD, type: "role", allow: "0", deny: VIEW },
          ow("new-r", VIEW),
        ]),
      ],
    });
    const problems = restoreProblems(earlier(["op-1"]), scanned, opts);
    expect(problems.join(" ")).toMatch(/remove your own access to "c1"/);
  });

  it("passes when that repair is already recorded as done", () => {
    const scanned = world(["admin-role", "new-r"]);
    expect(
      restoreProblems(earlier(["op-1", "c1:old-r"]), scanned, opts),
    ).toEqual([]);
  });

  it("passes when the repair does not touch the admin's access", () => {
    // The admin does not hold the recreated role and sees c1 through admin-role.
    expect(
      restoreProblems(earlier(["op-1"]), world(["admin-role"]), opts),
    ).toEqual([]);
  });

  it("uses the same pending definition as the confirm page", () => {
    const desired = buildRestoreDesired(
      earlier(["op-1"]),
      world(["admin-role"]),
      opts,
    );
    expect(desired.overwrites).toEqual([
      {
        channelId: "c1",
        target: { id: "new-r" },
        targetType: "role",
        allow: "0",
        deny: VIEW,
      },
    ]);
  });

  it("does not model re-parenting under a recreated category (the planner has no channel moves)", () => {
    const snap = earlier(["op-1"]);
    snap.restoredRoles = [];
    snap.restoredChannels = [{ oldId: "old-cat", newId: "new-cat" }];
    snap.baseline = {
      absentRoleNames: [],
      roles: [],
      channels: [{ ...channel("c2"), parentId: "old-cat" }],
      config: {},
    } as never;
    const desired = buildRestoreDesired(snap, world(["admin-role"]), opts);
    expect(desired.overwrites).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Grant data shape and grant-only restores (#1134, review round 3)
// ---------------------------------------------------------------------------

describe("restore of persisted role grants", () => {
  const grantOnly = (
    roleId: string,
    progress: unknown,
    over: Partial<Snapshot> = {},
  ): Snapshot =>
    snapshot({
      plan: {
        operations: [
          {
            id: "op-1",
            type: "member.role.add",
            class: "additive",
            roleId,
            memberCount: 1,
            sample: [],
            memberIds: [],
          },
        ],
      } as never,
      operations: [{ opId: "op-1", status: "applied" }],
      memberProgress: { "op-1": progress } as never,
      ...over,
    });
  const unrelated = { done: 1, failed: [], granted: ["some-member"] };
  const unreadable = [expect.stringMatching(/could not be read/)];

  describe("fails closed on malformed grant data", () => {
    it("rejects an array where the map should be", () => {
      expect(
        restoreProblems(
          grantOnly("plain", unrelated, { memberProgress: [] as never }),
          live(),
          opts,
        ),
      ).toEqual(unreadable);
    });

    it("rejects a record that is a string, an array or null", () => {
      for (const bad of ["corrupt", [], null, 7]) {
        expect(restoreProblems(grantOnly("plain", bad), live(), opts)).toEqual(
          unreadable,
        );
      }
    });

    it("rejects a record whose granted list is missing or not an array", () => {
      for (const bad of [{ done: 1 }, { granted: "x" }, { granted: {} }]) {
        expect(restoreProblems(grantOnly("plain", bad), live(), opts)).toEqual(
          unreadable,
        );
      }
    });

    it("still accepts a well-formed record, and one with nothing granted", () => {
      expect(
        restoreProblems(grantOnly("plain", unrelated), live(), opts),
      ).toEqual([]);
      expect(
        restoreProblems(
          grantOnly("plain", { done: 0, failed: [], granted: [] }),
          live(),
          opts,
        ),
      ).toEqual([]);
    });

    it("does not look at records of operations the engine will not revisit", () => {
      expect(
        restoreProblems(
          grantOnly("plain", "corrupt", {
            status: "rollback_partial",
            rolledBackOps: ["op-1"],
          }),
          live(),
          opts,
        ),
      ).toEqual([]);
    });
  });

  describe("a grant-only restore is judged like a role change", () => {
    it("passes for a grant on an unrelated member when everything is in order", () => {
      expect(
        restoreProblems(grantOnly("plain", unrelated), live(), opts),
      ).toEqual([]);
    });

    it("refuses when the bot has lost Manage Roles", () => {
      const scanned = live({
        roles: live().roles.map((r) =>
          r.id === "koolbot" ? { ...r, permissions: VIEW } : r,
        ),
      });
      expect(
        restoreProblems(grantOnly("plain", unrelated), scanned, opts),
      ).toEqual([expect.stringMatching(/Manage Roles/)]);
    });

    it("refuses when the granted role now sits above the bot", () => {
      expect(
        restoreProblems(grantOnly("high", unrelated), live(), opts).join(" "),
      ).toMatch(/Above the bot.*at or above the bot's highest role/);
    });

    it("refuses when the granted role is managed", () => {
      expect(
        restoreProblems(grantOnly("carl", unrelated), live(), opts).join(" "),
      ).toMatch(/Other bot.*managed/);
    });

    it("ignores a granted role that no longer exists", () => {
      expect(
        restoreProblems(grantOnly("deleted-role", unrelated), live(), opts),
      ).toEqual([]);
    });

    it("also covers in-flight grants, which the restore may treat as ours", () => {
      expect(
        restoreProblems(
          grantOnly("high", {
            done: 0,
            failed: [],
            granted: [],
            inflight: ["m"],
          }),
          live(),
          opts,
        ),
      ).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Interrupted role creations (#1134, review round 4)
// ---------------------------------------------------------------------------

describe("interrupted role creation with 'delete created roles'", () => {
  /**
   * The plan started creating "Staff", but the record never says it finished.
   * The engine's reconcile (after this check) may find the role and delete it.
   */
  const interrupted = (
    over: { startedAt?: Date | null; status?: string } = {},
  ): Snapshot =>
    snapshot({
      status: "partial",
      plan: {
        operations: [
          {
            id: "op-1",
            type: "role.create",
            class: "additive",
            ref: "new:staff",
            name: "Staff",
            color: 7,
            permissions: "0",
            position: null,
          },
        ],
      } as never,
      operations: [
        {
          opId: "op-1",
          status: over.status ?? "pending",
          startedAt: over.startedAt === undefined ? new Date() : over.startedAt,
        },
      ] as never,
    });
  const deleting = { ...opts, deleteCreatedRoles: true };
  /** The role exists on the server, as it would after a lost completion record. */
  const withRole = (adminHolds: boolean, over: Partial<Scanned> = {}) =>
    live({
      adminRoleIds: adminHolds ? ["admin-role", "found"] : ["admin-role"],
      roles: [...live().roles, { ...role("found", "Staff", 4), color: 7 }],
      channels: [
        channel("c1", [
          { id: GUILD, type: "role", allow: "0", deny: VIEW },
          ow("found", VIEW),
          ow("admin-role", VIEW),
        ]),
      ],
      ...over,
    });
  /** Same, but the admin's only way in is the found role. */
  const onlyThroughRole = () =>
    withRole(true, {
      channels: [
        channel("c1", [
          { id: GUILD, type: "role", allow: "0", deny: VIEW },
          ow("found", VIEW),
        ]),
      ],
    });

  it("refuses when the admin relies on the role the reconcile may find and delete", () => {
    const problems = restoreProblems(
      interrupted(),
      onlyThroughRole(),
      deleting,
    );
    expect(problems.join(" ")).toMatch(/remove your own access to "c1"/);
  });

  it("also covers an operation recorded as failed after it started", () => {
    expect(
      restoreProblems(
        interrupted({ status: "failed" }),
        onlyThroughRole(),
        deleting,
      ),
    ).toHaveLength(1);
  });

  it("passes when nobody relies on the role", () => {
    expect(restoreProblems(interrupted(), withRole(false), deleting)).toEqual(
      [],
    );
  });

  it("is unaffected when deleting created roles is not selected", () => {
    expect(restoreProblems(interrupted(), onlyThroughRole(), opts)).toEqual([]);
  });

  it("ignores a creation that never started, and roles that do not match", () => {
    expect(
      restoreProblems(
        interrupted({ startedAt: null }),
        onlyThroughRole(),
        deleting,
      ),
    ).toEqual([]);
    const other = withRole(true, {
      roles: [
        ...live().roles,
        { ...role("found", "Another name", 4), color: 7 },
      ],
      channels: [
        channel("c1", [
          { id: GUILD, type: "role", allow: "0", deny: VIEW },
          ow("found", VIEW),
        ]),
      ],
    });
    expect(restoreProblems(interrupted(), other, deleting)).toEqual([]);
  });

  it("applies the role limits to the role it might delete", () => {
    const managed = withRole(false, {
      roles: [
        ...live().roles,
        { ...role("found", "Staff", 4, "0", true), color: 7 },
      ],
    });
    expect(restoreProblems(interrupted(), managed, deleting).join(" ")).toMatch(
      /Staff.*managed/,
    );
  });
});

// ---------------------------------------------------------------------------
// Writes the engine makes even when the value already matches (#1134, round 5)
// ---------------------------------------------------------------------------

describe("restore writes that are no-ops in the plan", () => {
  const botWithoutManageRoles = (over: Partial<Scanned> = {}): Scanned =>
    live({
      roles: live().roles.map((r) =>
        r.id === "koolbot" ? { ...r, permissions: VIEW } : r,
      ),
      ...over,
    });

  it("still needs Manage Roles when a role already has the saved permissions", () => {
    // `plain` already has "0", the saved value, so the planner has nothing to
    // change, but the engine calls editRole anyway.
    expect(
      restoreProblems(roleEditSnapshot("plain"), botWithoutManageRoles(), opts),
    ).toEqual([expect.stringMatching(/Manage Roles/)]);
  });

  it("still applies the role limits to a role that already matches", () => {
    const managed = restoreProblems(
      roleEditSnapshot("carl"),
      live(),
      opts,
    ).join(" ");
    expect(managed).toMatch(/Other bot.*managed/);
    const high = restoreProblems(roleEditSnapshot("high"), live(), opts).join(
      " ",
    );
    expect(high).toMatch(/Above the bot.*at or above the bot's highest role/);
  });

  it("still needs Manage Roles when an overwrite already has the saved value", () => {
    const scanned = botWithoutManageRoles({
      channels: [channel("c1", [ow("plain", "0", VIEW)])],
    });
    expect(
      restoreProblems(
        overwriteSnapshot("c1", "plain", { allow: "0", deny: VIEW }),
        scanned,
        opts,
      ),
    ).toEqual([expect.stringMatching(/Manage Roles/)]);
  });

  it("still needs Manage Roles to remove an overwrite that is already gone", () => {
    // The plan added an overwrite for `plain`; it is not there any more, but
    // the engine still calls removeOverwrite.
    expect(
      restoreProblems(
        overwriteSnapshot("c1", "plain", null),
        botWithoutManageRoles({ channels: [channel("c1")] }),
        opts,
      ),
    ).toEqual([expect.stringMatching(/Manage Roles/)]);
  });

  it("passes when every write is a no-op and the bot is able to make it", () => {
    expect(restoreProblems(roleEditSnapshot("plain"), live(), opts)).toEqual(
      [],
    );
    expect(
      restoreProblems(
        overwriteSnapshot("c1", "plain", { allow: "0", deny: VIEW }),
        live({ channels: [channel("c1", [ow("plain", "0", VIEW)])] }),
        opts,
      ),
    ).toEqual([]);
  });

  it("does not ask for Manage Roles when the restore writes nothing", () => {
    // A restore of settings only (no role or overwrite step) needs no role
    // permission.
    expect(restoreProblems(snapshot(), botWithoutManageRoles(), opts)).toEqual(
      [],
    );
  });
});

describe("grants on a role that no longer exists", () => {
  it("is skipped even when the bot lacks Manage Roles, as documented", () => {
    const snap = snapshot({
      plan: {
        operations: [
          {
            id: "op-1",
            type: "member.role.add",
            class: "additive",
            roleId: "deleted-role",
            memberCount: 1,
            sample: [],
            memberIds: [],
          },
        ],
      } as never,
      operations: [{ opId: "op-1", status: "applied" }],
      memberProgress: {
        "op-1": { done: 1, failed: [], granted: ["m1"] },
      } as never,
    });
    const noManageRoles = live({
      roles: live().roles.map((r) =>
        r.id === "koolbot" ? { ...r, permissions: VIEW } : r,
      ),
    });
    expect(restoreProblems(snap, noManageRoles, opts)).toEqual([]);
    // With the role present the same restore does need Manage Roles.
    const present = {
      ...noManageRoles,
      roles: [...noManageRoles.roles, role("deleted-role", "Back", 4)],
    };
    expect(restoreProblems(snap, present, opts)).toEqual([
      expect.stringMatching(/Manage Roles/),
    ]);
  });
});
