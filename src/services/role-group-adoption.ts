import type { Guild } from "discord.js";
import logger from "../utils/logger.js";
import { AdoptionSnapshot } from "../models/adoption-snapshot.js";
import {
  planAdoption,
  type AdoptionPlan,
  type DesiredState,
  type PlanIssue,
  type PlanOperation,
  type RoleState,
} from "./server-adoption-planner.js";
import { buildDesiredState } from "./role-group-plan.js";
import { staleDestructiveSteps } from "./channel-claims.js";
import {
  buildAdminFixDesired,
  detectDrift,
  findOutOfGroupAdministrators,
  moveKeepsAdministrator,
  roleNamesToTrack,
  type AdminFixChoice,
  type AdminReport,
  type DriftItem,
} from "./role-group-sync.js";
import {
  RoleGroupService,
  scanGuildRoles,
  type GuildScan,
  type RoleGroupView,
} from "./role-group-service.js";

/**
 * Glue between role groups (#1020) and the adoption engine (#1018): turn the
 * saved groups into a plan for the Web UI to preview, and link the roles an
 * applied plan created back to their groups.
 *
 * Saving a group only stores the *desired* state. Nothing reaches Discord
 * until an admin reviews the plan and applies it, and every apply is
 * snapshotted by the engine and can be rolled back.
 */

export interface GroupPlan {
  groups: RoleGroupView[];
  scan: GuildScan;
  plan: AdoptionPlan;
  /** Problems found outside the planner; the plan can't be applied while any remain. */
  extraErrors: PlanIssue[];
  /** Bot enumeration needs the GuildMembers intent; set when it was unavailable. */
  botScanUnavailable: boolean;
  /** Differences between the groups and their roles (#1021). */
  drift: DriftItem[];
  /** Administrators outside the admin group; `null` = skipped (no admin group). */
  adminReport: AdminReport | null;
  /** An admin group exists but the member list couldn't be read. */
  membersUnavailable: boolean;
}

export function planIsApplicable(p: GroupPlan): boolean {
  return p.plan.errors.length === 0 && p.extraErrors.length === 0;
}

/** Plan the changes needed to make Discord match the saved groups. */
export async function planRoleGroups(
  guild: Guild,
  adminUserId: string,
  /**
   * Plan a groups list that differs from what is saved (the wizard previews a
   * group it has not written yet). The preview is read-only: tracked role
   * names are resolved in memory and nothing is written to the database.
   */
  transform?: (saved: RoleGroupView[]) => RoleGroupView[],
): Promise<GroupPlan> {
  const service = RoleGroupService.getInstance();
  let groups = await service.list(guild.id);
  const needBots = groups.some((g) => g.capabilities.includes("bot"));
  const adminRoleIds = adminGroupRoleIds(groups);
  const needMembers = adminRoleIds.length > 0;
  const scan = await scanGuildRoles(
    guild,
    adminUserId,
    groups,
    needBots,
    needMembers,
  );
  groups = await trackNames(
    guild.id,
    groups,
    scan.scanned.roles,
    transform === undefined,
  );
  if (transform) groups = transform(groups);
  const { desired, issues } = buildDesiredState(groups, scan.scanned);
  const plan = planAdoption(scan.scanned, desired, {
    approverId: adminUserId,
  });
  return {
    groups,
    scan,
    plan,
    extraErrors: issues,
    botScanUnavailable: needBots && scan.botIds === null,
    drift: detectDrift(groups, scan.scanned.roles, guild.id),
    adminReport:
      needMembers && scan.members
        ? findOutOfGroupAdministrators({
            members: scan.members,
            roles: scan.scanned.roles,
            adminGroupRoleIds: adminRoleIds,
            guildId: guild.id,
            ownerId: scan.scanned.ownerId,
            botUserId: scan.scanned.botUserId,
          })
        : null,
    membersUnavailable: needMembers && scan.members === null,
  };
}

/**
 * Groups linked before name tracking existed start tracking the role's current
 * name here, so only a later rename counts as drift (#1021). Best effort.
 */
export async function trackNames(
  guildId: string,
  groups: RoleGroupView[],
  roles: readonly RoleState[],
  /** `false` resolves the names in memory only (a read-only preview). */
  persist = true,
): Promise<RoleGroupView[]> {
  const track = roleNamesToTrack(groups, roles, guildId);
  if (track.length === 0) return groups;
  if (persist) {
    try {
      await RoleGroupService.getInstance().trackRoleNames(guildId, track);
    } catch (error) {
      logger.warn("role groups: could not start tracking role names", error);
      return groups;
    }
  }
  const names = new Map(track.map((t) => [t.groupId, t.roleName]));
  return groups.map((g) =>
    names.has(g.id) ? { ...g, roleName: names.get(g.id) ?? null } : g,
  );
}

/** Role ids behind the groups that carry the `admin` capability. */
export function adminGroupRoleIds(groups: readonly RoleGroupView[]): string[] {
  return groups.flatMap((g) =>
    g.capabilities.includes("admin") && g.roleId && !g.unlinked && !g.gateOnly
      ? [g.roleId]
      : [],
  );
}

/**
 * Plan resolving out-of-group administrators (#1021): add the chosen humans
 * to the admin group's role (additive), and/or drop `Administrator` from the
 * chosen other roles (an edit, snapshotted). Nothing is pre-selected by the
 * UI, and unsafe choices (managed or KoolBot's own roles, or one that would
 * lock the invoking admin out) come back as errors.
 */
export async function planAdminFix(
  guild: Guild,
  adminUserId: string,
  choice: AdminFixChoice,
): Promise<{
  plan: AdoptionPlan;
  extraErrors: PlanIssue[];
  report: AdminReport | null;
  /** Members moved into the admin group keep Administrator after the plan. */
  moveKeepsAdmin: boolean;
}> {
  const groups = await RoleGroupService.getInstance().list(guild.id);
  const adminRoles = adminGroupRoleIds(groups);
  const scan = await scanGuildRoles(guild, adminUserId, groups, false, true);
  const report =
    scan.members && adminRoles.length > 0
      ? findOutOfGroupAdministrators({
          members: scan.members,
          roles: scan.scanned.roles,
          adminGroupRoleIds: adminRoles,
          guildId: guild.id,
          ownerId: scan.scanned.ownerId,
          botUserId: scan.scanned.botUserId,
        })
      : null;
  const extraErrors: PlanIssue[] = [];
  let desired: DesiredState = {};
  const needsMembers =
    choice.moveMemberIds.length > 0 || choice.dropRoleIds.length > 0;
  if (adminRoles.length === 0) {
    extraErrors.push({
      code: "no-report",
      message:
        "There is no admin group with a role, so there is nothing to sync.",
    });
  } else if (!report && needsMembers) {
    extraErrors.push({
      code: "no-report",
      message:
        "The member list couldn't be read (the Server Members intent is off).",
    });
  } else {
    const built = buildAdminFixDesired(
      choice,
      report ?? { humans: [], bots: [] },
      adminRoles,
      scan.scanned,
      groups,
    );
    desired = built.desired;
    extraErrors.push(...built.issues);
  }
  const plan = planAdoption(scan.scanned, desired, {
    approverId: adminUserId,
  });
  return {
    plan,
    extraErrors,
    report,
    moveKeepsAdmin: moveKeepsAdministrator(
      choice,
      adminRoles,
      scan.scanned.roles,
    ),
  };
}

/**
 * Plan deleting the Discord role behind a group that is being removed.
 *
 * A role KoolBot created for the group needs no approval. Any other role is a
 * pre-existing one: its deletion is destructive and is only planned with an
 * explicit approval naming it (`approvedBy` is the admin who typed the role's
 * name). The caller fixes `approvedAt` at preview time and reuses it on apply,
 * so the plan id the admin reviewed is the one that runs (#1184).
 */
export async function planRoleDeletion(
  guild: Guild,
  adminUserId: string,
  group: RoleGroupView,
  approved: boolean,
  approvedAt: string = new Date().toISOString(),
): Promise<{ plan: AdoptionPlan; extraErrors: PlanIssue[] }> {
  const extraErrors: PlanIssue[] = [];
  const roleId = group.roleId;
  const saved = await RoleGroupService.getInstance().list(guild.id);
  // The delete route removes the group right after starting the job, and the
  // engine's live check runs later. Plan with the group the caller captured, so
  // a KoolBot-created role keeps its no-approval exemption (it comes from the
  // group's `createdByKoolbot`) instead of vanishing with the saved row.
  const groups = saved.some((g) => g.id === group.id)
    ? saved
    : [...saved, group];
  const scan = await scanGuildRoles(guild, adminUserId, groups, false);
  if (!roleId) {
    extraErrors.push({
      code: "no-role",
      message: "This group has no Discord role to delete.",
    });
  } else {
    const uses = await RoleGroupService.getInstance().featureUsesOfRole(
      guild.id,
      roleId,
    );
    if (uses.length > 0) {
      extraErrors.push({
        code: "role-in-use",
        message: `The role is still used by ${uses.join(", ")}. Change that first.`,
        targetId: roleId,
      });
    }
  }
  const plan = planAdoption(
    scan.scanned,
    {
      deletions: roleId ? [{ kind: "role", id: roleId }] : [],
      approvals:
        roleId && approved
          ? [
              {
                kind: "role.delete",
                targetId: roleId,
                approvedBy: adminUserId,
                approvedAt,
              },
            ]
          : [],
    },
    { approverId: adminUserId },
  );
  return { plan, extraErrors };
}

/**
 * The live-state check the engine requires before it runs the destructive
 * role delete (#1097). It re-plans the same deletion from a fresh scan and
 * refuses if the fresh plan has blocking problems (the role is now managed,
 * above the bot, or in use by a feature) or no longer contains the pending
 * delete. The engine runs it before applying and again before the destructive
 * phase.
 */
export function roleDeletionRevalidator(
  guild: Guild,
  adminUserId: string,
  group: RoleGroupView,
  approved: boolean,
  approvedAt?: string,
): (pending: PlanOperation[]) => Promise<string[]> {
  return async (pending) => {
    const fresh = await planRoleDeletion(
      guild,
      adminUserId,
      group,
      approved,
      approvedAt,
    );
    const problems = [...fresh.plan.errors, ...fresh.extraErrors].map(
      (e) => e.message,
    );
    problems.push(...staleDestructiveSteps(pending, fresh.plan.operations));
    return problems;
  };
}

/**
 * Link groups whose role the engine has since created. Looks through the
 * guild's recent applied snapshots for a created role matching the group's
 * name; it is idempotent and safe to call on every page load, which also
 * covers an admin closing the tab before an apply finished.
 */
export async function linkCreatedRoles(guildId: string): Promise<number> {
  const service = RoleGroupService.getInstance();
  const pending = (await service.list(guildId)).filter(
    (g) => g.roleId === null && !g.gateOnly && !g.unlinked,
  );
  if (pending.length === 0) return 0;
  let linked = 0;
  try {
    const snapshots = await AdoptionSnapshot.find({
      guildId,
      status: { $in: ["applied", "partial"] },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    for (const group of pending) {
      const key = group.name.trim().toLowerCase();
      for (const snap of snapshots) {
        // A role an earlier apply created, before this group existed, can't be
        // the one asked for: the role may be long gone, and linking it would
        // keep the group from the role its own apply is creating.
        if (
          group.createdAt &&
          snap.createdAt &&
          new Date(snap.createdAt as Date) < new Date(group.createdAt)
        ) {
          continue;
        }
        // A role created before a recreate was requested can't be the one
        // that was asked for (it is the one that was deleted, #1021).
        if (
          group.recreateRequestedAt &&
          new Date(snap.createdAt as Date) < group.recreateRequestedAt
        ) {
          continue;
        }
        const created = (
          snap.createdRoles as Array<{ roleId: string; name: string }>
        ).find(
          (r) =>
            r.name.trim().toLowerCase() === key &&
            r.roleId !== group.lostRoleId,
        );
        if (created) {
          await service.linkRole(
            guildId,
            group.id,
            created.roleId,
            true,
            created.name,
          );
          linked += 1;
          break;
        }
      }
    }
  } catch (error) {
    logger.warn("role groups: linking created roles failed", error);
  }
  return linked;
}
