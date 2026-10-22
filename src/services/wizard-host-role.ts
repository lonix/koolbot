import type { Guild } from "discord.js";
import logger from "../utils/logger.js";
import { PERMISSION_PRESETS, type GroupSpec } from "./role-group-plan.js";
import { planIsApplicable, planRoleGroups } from "./role-group-adoption.js";
import type { AdoptionPlan } from "./server-adoption-planner.js";
import type { RoleGroupService, RoleGroupView } from "./role-group-service.js";
import {
  orderWithNewGroups,
  type AccessAuditEntry,
  type AccessChange,
  type AccessContext,
  type AccessRole,
} from "./wizard-access.js";

/**
 * *Create @Event host* on the Setup wizard's Access step (#1365).
 *
 * The role is created only through the adoption engine, never with a direct
 * Discord call: a role group with no role, then the planner's `role.create`,
 * then `startApply`, then `linkCreatedRoles` (which Role groups runs on load).
 * Nothing is written when the option is ticked. Review previews the plan with
 * the new group merged in; Apply recomputes it and refuses on any mismatch,
 * or when the plan holds anything besides that one role.
 */

export const EVENT_HOST_ROLE_NAME = "Event host";
const SYNTHETIC_GROUP_ID = "wizard-event-host-preview";

export type HostCreateState =
  | { available: true }
  | {
      available: false;
      /**
       * `exists`: a role or group for hosts is already there, so the card just
       * offers the picker. The others are said out loud.
       */
      reason: "exists" | "pending" | "permission" | "rank";
      message: string;
    };

/**
 * The new group must rank strictly below every other group. A tie would put
 * it inside another group's "group and above" (everyone handed the host role
 * would gain what those settings give that group) and let the planner place
 * the role by name. Ranks start at 0, so a group at 0 leaves no room.
 */
export function hostRankProblem(groups: readonly GroupSpec[]): string | null {
  if (groups.length === 0) return null;
  if (Math.min(...groups.map((g) => g.rank)) > 0) return null;
  return "A role group already has the lowest rank (0), so the new Event host group can't be ranked below it. Open Role groups and re-save the order, then come back.";
}

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Can the card offer the create? Only when no Event host role exists, in
 * Discord (any role, not just the pickable ones) or among the groups, and the
 * bot may manage roles.
 */
export function hostCreateState(ctx: AccessContext): HostCreateState {
  const roleExists = ctx.roles.some((r) =>
    sameName(r.name, EVENT_HOST_ROLE_NAME),
  );
  const mappedHost = ctx.groups.some(
    (g) =>
      g.roleId !== null &&
      !g.unlinked &&
      !g.gateOnly &&
      g.capabilities.includes("host"),
  );
  if (roleExists || mappedHost) {
    return {
      available: false,
      reason: "exists",
      message: "An Event host role already exists. Pick it above.",
    };
  }
  const named = ctx.groups.find((g) => sameName(g.name, EVENT_HOST_ROLE_NAME));
  if (named) {
    return {
      available: false,
      reason: "pending",
      message: `A role group called "${named.name}" is already waiting for its role. Create or link the role on Role groups, then pick it here.`,
    };
  }
  const rank = hostRankProblem(ctx.groups);
  if (rank) return { available: false, reason: "rank", message: rank };
  if (!ctx.botManageRoles) {
    return {
      available: false,
      reason: "permission",
      message:
        "The bot needs the Manage Roles permission to create a role. Give it that in Discord, or pick an existing role instead.",
    };
  }
  return { available: true };
}

/** The new group: the Event host preset, ranked below every other group. */
export function hostGroupSpec(groups: readonly GroupSpec[]): RoleGroupView {
  const preset = PERMISSION_PRESETS.find((p) => p.key === "event-host");
  const lowest = groups.length ? Math.min(...groups.map((g) => g.rank)) : 1;
  return {
    id: SYNTHETIC_GROUP_ID,
    name: EVENT_HOST_ROLE_NAME,
    roleId: null,
    rank: lowest - 1,
    permissions: preset?.permissions ?? "0",
    capabilities: [...(preset?.capabilities ?? ["host"])],
    colour: null,
    createdByKoolbot: false,
    gateOnly: false,
    hoist: false,
    roleName: null,
    unlinked: false,
    lostRoleId: null,
    recreateRequestedAt: null,
    syncPolicy: null,
    driftSignature: null,
    createdAt: new Date(0),
  };
}

/**
 * The saved groups as they will be once the Access step's writes are made:
 * capabilities changed, new groups added and ranked where their roles sit.
 * The host plan is built from this, so it matches the plan computed after
 * those writes.
 */
export function groupsAfterAccess(
  groups: readonly RoleGroupView[],
  roles: readonly AccessRole[],
  changes: readonly AccessChange[],
): RoleGroupView[] {
  const updates = new Map(
    changes.filter((c) => c.kind === "update").map((c) => [c.groupId, c]),
  );
  const existing = groups.map((g) => {
    const change = updates.get(g.id);
    return change ? { ...g, capabilities: [...change.capabilitiesAfter] } : g;
  });
  const created = changes.filter((c) => c.kind === "create");
  if (created.length === 0) return existing;
  const positions = new Map(roles.map((r) => [r.id, r.position]));
  const fresh = created.map((c) => ({
    id: `wizard-access-preview-${c.roleId}`,
    position: positions.get(c.roleId) ?? 0,
  }));
  const order = orderWithNewGroups(
    existing.map((g) => g.id),
    new Map(
      existing.flatMap((g) =>
        g.roleId && positions.has(g.roleId)
          ? [[g.id, positions.get(g.roleId) as number] as const]
          : [],
      ),
    ),
    fresh,
  );
  const added = created.map((c): RoleGroupView => ({
    id: `wizard-access-preview-${c.roleId}`,
    name: c.groupName,
    roleId: c.roleId,
    roleName: c.roleName,
    rank: 0,
    permissions: null,
    capabilities: [...c.capabilitiesAfter],
    colour: null,
    hoist: false,
    createdByKoolbot: false,
    gateOnly: false,
    unlinked: false,
    lostRoleId: null,
    recreateRequestedAt: null,
    syncPolicy: null,
    driftSignature: null,
    createdAt: new Date(0),
  }));
  const byId = new Map([...existing, ...added].map((g) => [g.id, g]));
  return order.map((id, i) => ({
    ...(byId.get(id) as RoleGroupView),
    rank: order.length - i,
  }));
}

/**
 * Problems with a plan that is meant to create the Event host role and
 * nothing else: the plan's own errors first, then any operation that is not
 * that one `role.create` (drift or reorders on other groups, which the admin
 * never reviewed here and which belong on Role groups).
 */
export function hostPlanProblems(
  built: Awaited<ReturnType<typeof planRoleGroups>>,
): string[] {
  const problems = [...built.plan.errors, ...built.extraErrors].map(
    (e) => e.message,
  );
  if (!planIsApplicable(built) && problems.length === 0) {
    problems.push("The plan can't be applied.");
  }
  const ops = built.plan.operations;
  const isHostCreate = (o: AdoptionPlan["operations"][number]): boolean =>
    o.type === "role.create" && sameName(o.name, EVENT_HOST_ROLE_NAME);
  const others = ops.filter((o) => !isHostCreate(o));
  if (others.length > 0) {
    problems.push(
      `The server has other pending role changes (${others
        .slice(0, 3)
        .map((o) => o.summary)
        .join(
          "; ",
        )}${others.length > 3 ? "; …" : ""}). Review and apply them on Role groups first, then come back.`,
    );
  }
  if (!ops.some(isHostCreate) && problems.length === 0) {
    problems.push("The plan does not create the Event host role.");
  }
  return problems;
}

export interface HostReview {
  /** The plan id Apply must still produce; `null` when there is no plan. */
  planId: string | null;
  /** What the engine would do, one line each. */
  operations: string[];
  /** Why it can't be applied; Apply is blocked while any remain. */
  problems: string[];
}

/** The Review step's preview of creating the role. Writes nothing. */
export async function reviewHostRole(
  guild: Guild,
  adminUserId: string,
  ctx: AccessContext,
  changes: readonly AccessChange[],
): Promise<HostReview> {
  const state = hostCreateState(ctx);
  if (!state.available) {
    return { planId: null, operations: [], problems: [state.message] };
  }
  const built = await planRoleGroups(guild, adminUserId, (saved) => {
    const after = groupsAfterAccess(saved, ctx.roles, changes);
    return [...after, hostGroupSpec(after)];
  });
  return {
    planId: built.plan.id,
    operations: built.plan.operations.map((o) => o.summary),
    problems: hostPlanProblems(built),
  };
}

export interface HostRoleDeps {
  groups: Pick<RoleGroupService, "list" | "create" | "remove">;
  audit: (entry: AccessAuditEntry) => Promise<void>;
  /** Plan from the saved groups only. */
  plan: () => ReturnType<typeof planRoleGroups>;
  /** Start the engine's background job; throws when it can't start. */
  start: (
    plan: AdoptionPlan,
  ) => Promise<{ id: string; started?: Promise<void> }>;
}

export type HostRoleResult =
  | { ok: true; jobId: string; groupId: string }
  | {
      ok: false;
      error: string;
      /** The group could not be removed again and is still saved. */
      groupStuck: boolean;
    };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Save the group, plan again from what is saved, and start the engine's job
 * only if that plan is the one Review showed. Whatever stops it removes the
 * group again, so a group is never left behind for a role that was not
 * started. The job runs in the background: this reports that it started, and
 * its outcome is shown on Role groups.
 */
export async function startHostRole(
  deps: HostRoleDeps,
  guildId: string,
  reviewedPlanId: string,
): Promise<HostRoleResult> {
  const undo = async (
    groupId: string,
    error: string,
  ): Promise<HostRoleResult> => {
    let groupStuck = false;
    try {
      if (!(await deps.groups.remove(guildId, groupId))) {
        throw new Error("the group was already gone");
      }
      await deps.audit({
        action: "wizard.access.host-group.rollback",
        targetId: groupId,
        result: "success",
      });
    } catch (removeError) {
      groupStuck = true;
      logger.error(
        "wizard access: could not remove the host group",
        removeError,
      );
      await deps.audit({
        action: "wizard.access.host-group.rollback",
        targetId: groupId,
        result: "failure",
        errorMessage: messageOf(removeError),
      });
    }
    return { ok: false, error, groupStuck };
  };

  const saved = await deps.groups.list(guildId);
  const rankProblem = hostRankProblem(saved);
  if (rankProblem) return { ok: false, error: rankProblem, groupStuck: false };
  const spec = hostGroupSpec(saved);
  const details = { name: spec.name, capabilities: spec.capabilities };
  let groupId: string;
  try {
    const res = await deps.groups.create(guildId, {
      name: spec.name,
      roleId: null,
      capabilities: spec.capabilities,
      permissions: spec.permissions,
      rank: spec.rank,
    });
    if (!res.ok) throw new Error(res.error);
    groupId = res.group.id;
  } catch (error) {
    await deps.audit({
      action: "wizard.access.host-group",
      details,
      result: "failure",
      errorMessage: messageOf(error),
    });
    return {
      ok: false,
      error: `The Event host group could not be saved (${messageOf(error)}).`,
      groupStuck: false,
    };
  }
  await deps.audit({
    action: "wizard.access.host-group",
    targetId: groupId,
    details,
    result: "success",
  });

  let plan: AdoptionPlan;
  try {
    const built = await deps.plan();
    const problems = hostPlanProblems(built);
    if (problems.length > 0) {
      return undo(
        groupId,
        `The Event host role can't be created. ${problems[0]}`,
      );
    }
    if (built.plan.id !== reviewedPlanId) {
      return undo(
        groupId,
        "The server changed since you opened Review, so the Event host role was not created.",
      );
    }
    plan = built.plan;
  } catch (error) {
    return undo(
      groupId,
      `The server could not be read, so the Event host role was not created (${messageOf(error)}).`,
    );
  }

  try {
    const job = await deps.start(plan);
    // startApply returns at once; the busy-server lock and the live checks run
    // inside the job. Wait until it is committed (past them, before the first
    // Discord write) so a refusal there removes the group instead of leaving
    // it behind for a role that was never started.
    await job.started;
    await deps.audit({
      action: "wizard.access.host-role",
      targetId: plan.id,
      details: { jobId: job.id, operations: plan.operations.length },
      result: "success",
    });
    return { ok: true, jobId: job.id, groupId };
  } catch (error) {
    logger.error("wizard access: the Event host job could not start", error);
    await deps.audit({
      action: "wizard.access.host-role",
      targetId: plan.id,
      result: "failure",
      errorMessage: messageOf(error),
    });
    return undo(
      groupId,
      `The Event host role could not be created (${messageOf(error)}).`,
    );
  }
}
