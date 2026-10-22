/**
 * Unit tests for *Create @Event host* on the wizard's Access step (#1365).
 *
 * The role is created only through the adoption engine. What these pin is
 * what an admin would otherwise learn by finding a stray group or a second
 * "Event host" role: the offer appears only when no such role exists, the plan
 * Review previews is the plan that runs, anything else in the plan stops it,
 * and every way the job can fail to start removes the group again.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";
import {
  EVENT_HOST_ROLE_NAME,
  groupsAfterAccess,
  hostCreateState,
  hostGroupSpec,
  hostPlanProblems,
  startHostRole,
  type HostRoleDeps,
} from "../../src/services/wizard-host-role.js";
import {
  diffAccess,
  type AccessChange,
  type AccessContext,
  type AccessRole,
} from "../../src/services/wizard-access.js";
import { buildDesiredState } from "../../src/services/role-group-plan.js";
import {
  planAdoption,
  type ScannedState,
} from "../../src/services/server-adoption-planner.js";
import type { GroupPlan } from "../../src/services/role-group-adoption.js";
import type { RoleGroupView } from "../../src/services/role-group-service.js";

const GUILD = "g1";
const role = (
  id: string,
  name: string,
  position: number,
  managed = false,
): AccessRole => ({ id, name, managed, position });

const group = (over: Partial<RoleGroupView>): RoleGroupView =>
  ({
    id: "grp",
    name: "grp",
    roleId: null,
    rank: 1,
    permissions: null,
    capabilities: [],
    colour: null,
    hoist: false,
    createdByKoolbot: false,
    gateOnly: false,
    roleName: null,
    unlinked: false,
    lostRoleId: null,
    recreateRequestedAt: null,
    syncPolicy: null,
    driftSignature: null,
    createdAt: new Date(0),
    ...over,
  }) as RoleGroupView;

const roles = [
  role(GUILD, "@everyone", 0),
  role("mod", "Moderator", 5),
  role("admin", "Admins", 8),
];

function ctx(
  groups: RoleGroupView[],
  over: Partial<AccessContext> = {},
): AccessContext {
  return {
    groups,
    roles,
    guildId: GUILD,
    featureUses: new Map(),
    botHighest: 10,
    botManageRoles: true,
    ...over,
  } as AccessContext;
}

function scanned(
  roleList: AccessRole[] = roles,
  botCanManage = true,
): ScannedState {
  return {
    guildId: GUILD,
    ownerId: "o",
    botUserId: "bot",
    botRoleIds: ["botrole"],
    botHighestRolePosition: 10,
    adminUserId: "a",
    adminRoleIds: [],
    otherBotIds: [],
    roles: [
      ...roleList.map((r) => ({
        ...r,
        permissions: "0",
        color: 0,
        hoist: false,
        mentionable: false,
      })),
      {
        id: "botrole",
        name: "KoolBot",
        managed: true,
        position: 10,
        permissions: botCanManage
          ? PermissionFlagsBits.ManageRoles.toString()
          : "0",
        color: 0,
        hoist: false,
        mentionable: false,
      },
    ],
    channels: [],
    config: {},
    boundChannelIds: [],
    koolbotCreatedIds: [],
  } as unknown as ScannedState;
}

/** What `planRoleGroups` computes, from a given groups list. */
function built(
  groups: RoleGroupView[],
  state: ScannedState = scanned(),
): GroupPlan {
  const { desired, issues } = buildDesiredState(groups, state);
  const plan = planAdoption(state, desired, { approverId: "a" });
  return { plan, extraErrors: issues } as unknown as GroupPlan;
}

const preview = (
  saved: RoleGroupView[],
  changes: AccessChange[] = [],
): RoleGroupView[] => {
  const after = groupsAfterAccess(saved, roles, changes);
  return [...after, hostGroupSpec(after)];
};

describe("hostCreateState", () => {
  it("offers the create when no host role or group exists", () => {
    expect(hostCreateState(ctx([]))).toEqual({ available: true });
  });

  it("does not offer it when a role is already called Event host, even one that can't be picked", () => {
    const state = hostCreateState(
      ctx([], { roles: [...roles, role("eh", "event HOST", 99)] }),
    );
    expect(state).toMatchObject({ available: false, reason: "exists" });
  });

  it("does not offer it when a linked group already carries host", () => {
    const state = hostCreateState(
      ctx([group({ roleId: "mod", name: "Hosts", capabilities: ["host"] })]),
    );
    expect(state).toMatchObject({ available: false, reason: "exists" });
  });

  it("points to Role groups for a group still waiting for its role", () => {
    const state = hostCreateState(
      ctx([group({ name: "Event host", roleId: null })]),
    );
    expect(state).toMatchObject({ available: false, reason: "pending" });
    expect((state as { message: string }).message).toContain("Role groups");
  });

  it("refuses clearly when the bot can't manage roles", () => {
    const state = hostCreateState(ctx([], { botManageRoles: false }));
    expect(state).toMatchObject({ available: false, reason: "permission" });
    expect((state as { message: string }).message).toContain("Manage Roles");
  });
});

describe("hostGroupSpec", () => {
  it("is the Event host preset: no permissions, host capability, no role yet", () => {
    const spec = hostGroupSpec([]);
    expect(spec).toMatchObject({
      name: EVENT_HOST_ROLE_NAME,
      roleId: null,
      permissions: "0",
      capabilities: ["host"],
    });
  });

  it("ranks below every other group, never below zero", () => {
    expect(hostGroupSpec([group({ rank: 4 }), group({ rank: 2 })]).rank).toBe(
      1,
    );
    expect(hostGroupSpec([group({ rank: 0 })]).rank).toBe(0);
  });
});

describe("the previewed plan is the plan that runs", () => {
  it("creates one role: no permissions, just above @everyone", () => {
    const plan = built(preview([])).plan;
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({
      type: "role.create",
      name: EVENT_HOST_ROLE_NAME,
      permissions: "0",
      position: 1,
    });
  });

  it("has the same plan id before and after the group is saved", () => {
    const existing = [
      group({ id: "a", name: "Admins", roleId: "admin", rank: 5 }),
    ];
    const changes = diffAccess(existing, roles, {
      admin: [],
      staff: ["mod"],
      host: [],
    });
    expect(changes).toHaveLength(1);
    const previewed = built(preview(existing, changes)).plan;

    // What is saved once Access has written its group and the host group is
    // saved: other ids, other absolute ranks, the same order.
    const saved = [
      group({
        id: "db-3",
        name: EVENT_HOST_ROLE_NAME,
        rank: 0,
        permissions: "0",
        capabilities: ["host"],
      }),
      group({
        id: "db-2",
        name: "Moderator",
        roleId: "mod",
        roleName: "Moderator",
        rank: 3,
        capabilities: ["staff"],
      }),
      group({ id: "a", name: "Admins", roleId: "admin", rank: 9 }),
    ];
    const after = built(saved).plan;
    expect(after.id).toBe(previewed.id);
    expect(after.operations).toHaveLength(1);
  });
});

describe("hostPlanProblems", () => {
  it("is clean for a plan that creates only the Event host role", () => {
    expect(hostPlanProblems(built(preview([])))).toEqual([]);
  });

  it("says when the bot can't manage roles", () => {
    const problems = hostPlanProblems(
      built(preview([]), scanned(roles, false)),
    );
    expect(problems.join(" ")).toContain("Manage Roles");
  });

  it("refuses a plan that also changes something the wizard did not cause", () => {
    // A group with a permission set its role doesn't have: drift on another group.
    const drifted = group({
      id: "d",
      name: "Moderator",
      roleId: "mod",
      permissions: PermissionFlagsBits.ManageRoles.toString(),
      rank: 5,
    });
    const problems = hostPlanProblems(built(preview([drifted])));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("other pending role changes");
    expect(problems[0]).toContain("Role groups");
  });

  it("refuses a plan that does not create the role at all", () => {
    expect(hostPlanProblems(built([]))).toEqual([
      "The plan does not create the Event host role.",
    ]);
  });
});

describe("startHostRole", () => {
  function setup(over: Partial<HostRoleDeps> = {}) {
    let saved: RoleGroupView[] = [
      group({ id: "a", name: "Admins", roleId: "admin", rank: 5 }),
    ];
    const audit = jest.fn(async () => undefined);
    const groups = {
      list: jest.fn(async () => [...saved]),
      create: jest.fn(
        async (
          _g: string,
          input: { name: string; rank?: number; capabilities?: string[] },
        ) => {
          const g = group({
            id: "new-host",
            name: input.name,
            rank: input.rank ?? 1,
            permissions: "0",
            capabilities: (input.capabilities ?? []) as never,
          });
          saved = [...saved, g];
          return { ok: true as const, group: g };
        },
      ),
      remove: jest.fn(async (_g: string, id: string) => {
        const before = saved.length;
        saved = saved.filter((g) => g.id !== id);
        return saved.length < before;
      }),
    };
    const start = jest.fn(async () => ({ id: "job-1" }));
    const deps = {
      groups,
      audit,
      plan: async () => built(saved),
      start,
      ...over,
    } as unknown as HostRoleDeps;
    const reviewedId = built(preview(saved)).plan.id;
    return { deps, groups, audit, start, reviewedId, saved: () => saved };
  }

  it("saves the group, starts the job and audits both", async () => {
    const { deps, groups, audit, start, reviewedId } = setup();
    const res = await startHostRole(deps, GUILD, reviewedId);
    expect(res).toEqual({ ok: true, jobId: "job-1", groupId: "new-host" });
    expect(groups.create).toHaveBeenCalledWith(
      GUILD,
      expect.objectContaining({
        name: EVENT_HOST_ROLE_NAME,
        roleId: null,
        permissions: "0",
        capabilities: ["host"],
      }),
    );
    expect(start).toHaveBeenCalledTimes(1);
    const actions = audit.mock.calls.map(
      (c) => (c as unknown as [{ action: string }])[0].action,
    );
    expect(actions).toEqual([
      "wizard.access.host-group",
      "wizard.access.host-role",
    ]);
  });

  it("removes the group and starts nothing when the plan is not the one reviewed", async () => {
    const { deps, groups, start, saved } = setup();
    const res = await startHostRole(deps, GUILD, "not-the-reviewed-plan");
    expect(res).toMatchObject({ ok: false, groupStuck: false });
    expect((res as { error: string }).error).toContain("changed since");
    expect(groups.remove).toHaveBeenCalledWith(GUILD, "new-host");
    expect(start).not.toHaveBeenCalled();
    expect(saved().map((g) => g.id)).toEqual(["a"]);
  });

  it("removes the group when the job cannot start", async () => {
    const { deps, groups, audit, reviewedId, saved } = setup({
      start: jest.fn(async () => {
        throw new Error("another apply is running");
      }),
    } as Partial<HostRoleDeps>);
    const res = await startHostRole(deps, GUILD, reviewedId);
    expect(res).toMatchObject({ ok: false, groupStuck: false });
    expect((res as { error: string }).error).toContain(
      "another apply is running",
    );
    expect(groups.remove).toHaveBeenCalledWith(GUILD, "new-host");
    expect(saved().map((g) => g.id)).toEqual(["a"]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "wizard.access.host-role",
        result: "failure",
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "wizard.access.host-group.rollback",
        result: "success",
      }),
    );
  });

  it("says so when the group could not be removed again", async () => {
    const { deps, audit, reviewedId } = setup({
      start: jest.fn(async () => {
        throw new Error("boom");
      }),
    } as Partial<HostRoleDeps>);
    (deps.groups.remove as jest.Mock<() => Promise<boolean>>).mockResolvedValue(
      false,
    );
    const res = await startHostRole(deps, GUILD, reviewedId);
    expect(res).toMatchObject({ ok: false, groupStuck: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "wizard.access.host-group.rollback",
        result: "failure",
      }),
    );
  });

  it("removes the group and starts nothing when the saved plan holds more than the role, even if its id matches", async () => {
    const drifted = built([
      group({
        id: "d",
        name: "Moderator",
        roleId: "mod",
        permissions: PermissionFlagsBits.ManageRoles.toString(),
        rank: 5,
      }),
      group({
        id: "new-host",
        name: EVENT_HOST_ROLE_NAME,
        rank: 0,
        permissions: "0",
        capabilities: ["host"],
      }),
    ]);
    const { deps, groups, start } = setup({
      plan: async () => drifted,
    } as Partial<HostRoleDeps>);
    const res = await startHostRole(deps, GUILD, drifted.plan.id);
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toContain(
      "other pending role changes",
    );
    expect(groups.remove).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("removes the group when the server can't be read for the plan", async () => {
    const { deps, groups, start, reviewedId } = setup({
      plan: async () => {
        throw new Error("discord down");
      },
    } as Partial<HostRoleDeps>);
    const res = await startHostRole(deps, GUILD, reviewedId);
    expect(res).toMatchObject({ ok: false });
    expect(groups.remove).toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts nothing when the group can't be saved", async () => {
    const { deps, start, audit, reviewedId } = setup();
    (deps.groups.create as jest.Mock<() => Promise<unknown>>).mockResolvedValue(
      { ok: false, error: "A group called x already exists." },
    );
    const res = await startHostRole(deps, GUILD, reviewedId);
    expect(res).toMatchObject({ ok: false, groupStuck: false });
    expect(start).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "wizard.access.host-group",
        result: "failure",
      }),
    );
  });
});

describe("a group whose role was never created is not mapped", () => {
  it("is left out of the current mapping", async () => {
    const { currentMapping } =
      await import("../../src/services/wizard-access.js");
    const pending = group({
      name: EVENT_HOST_ROLE_NAME,
      roleId: null,
      capabilities: ["host"],
    });
    expect(currentMapping([pending]).host).toEqual([]);
  });
});
