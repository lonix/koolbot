import type { Guild } from "discord.js";
import logger from "../utils/logger.js";
import { AdoptionSnapshot } from "../models/adoption-snapshot.js";
import {
  planAdoption,
  type AdoptionPlan,
  type PlanIssue,
} from "./server-adoption-planner.js";
import { buildDesiredState } from "./role-group-plan.js";
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
}

export function planIsApplicable(p: GroupPlan): boolean {
  return p.plan.errors.length === 0 && p.extraErrors.length === 0;
}

/** Plan the changes needed to make Discord match the saved groups. */
export async function planRoleGroups(
  guild: Guild,
  adminUserId: string,
): Promise<GroupPlan> {
  const groups = await RoleGroupService.getInstance().list(guild.id);
  const needBots = groups.some((g) => g.capabilities.includes("bot"));
  const scan = await scanGuildRoles(guild, adminUserId, groups, needBots);
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
  };
}

/**
 * Plan deleting the Discord role behind a group that is being removed.
 *
 * A role KoolBot created for the group needs no approval. Any other role is a
 * pre-existing one: its deletion is destructive and is only planned with an
 * explicit approval naming it (`approvedBy` is the admin who ticked the box).
 */
export async function planRoleDeletion(
  guild: Guild,
  adminUserId: string,
  group: RoleGroupView,
  approved: boolean,
): Promise<{ plan: AdoptionPlan; extraErrors: PlanIssue[] }> {
  const extraErrors: PlanIssue[] = [];
  const roleId = group.roleId;
  const groups = await RoleGroupService.getInstance().list(guild.id);
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
                approvedAt: new Date().toISOString(),
              },
            ]
          : [],
    },
    { approverId: adminUserId },
  );
  return { plan, extraErrors };
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
    (g) => g.roleId === null && !g.gateOnly,
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
        const created = (
          snap.createdRoles as Array<{ roleId: string; name: string }>
        ).find((r) => r.name.trim().toLowerCase() === key);
        if (created) {
          await service.linkRole(guildId, group.id, created.roleId, true);
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
