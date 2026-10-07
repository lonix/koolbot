import type { Client } from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";
import { RoleGroupService } from "../services/role-group-service.js";
import {
  linkCreatedRoles,
  planAdminFix,
  planRoleGroups,
  type GroupPlan,
} from "../services/role-group-adoption.js";
import { roleLockReason } from "../services/role-group-plan.js";
import type {
  AdminFixPageProps,
  RoleGroupRoleOption,
  RoleGroupRow,
  RoleGroupsPageProps,
} from "./role-groups-views.js";

type PageData = Pick<
  RoleGroupsPageProps,
  | "groups"
  | "roleOptions"
  | "plan"
  | "extraErrors"
  | "planUnavailable"
  | "botScanUnavailable"
  | "botsMissing"
  | "adminReport"
  | "membersUnavailable"
  | "roleNames"
  | "globalPolicy"
>;

/**
 * Load everything the Role Groups page shows. Never throws for a Discord
 * outage: the group list still renders (from the database) with a notice in
 * place of the plan, so groups stay editable.
 */
export async function loadRoleGroupsPage(
  client: Client,
  guildId: string,
  adminUserId: string,
): Promise<PageData> {
  await linkCreatedRoles(guildId);
  const service = RoleGroupService.getInstance();
  const globalPolicy = await ConfigService.getInstance()
    .getString("adoption.role_groups.sync_policy", "flag")
    .catch(() => "flag");
  let built: GroupPlan | null = null;
  let unavailable: string | null = null;
  try {
    const guild = await client.guilds.fetch(guildId);
    built = await planRoleGroups(guild, adminUserId);
  } catch (error) {
    logger.warn("role groups: could not read the server", error);
    unavailable =
      "The server's roles couldn't be read from Discord, so no plan is shown. Groups can still be edited; reload to try again.";
  }

  if (!built) {
    const groups = await service.list(guildId);
    return {
      groups: groups.map((g) => ({
        ...g,
        roleName: null,
        roleMissing: false,
        memberCount: null,
        roleLock: null,
        drift: [],
      })),
      roleOptions: [],
      plan: null,
      extraErrors: [],
      planUnavailable: unavailable,
      botScanUnavailable: false,
      botsMissing: 0,
      adminReport: null,
      membersUnavailable: false,
      roleNames: {},
      globalPolicy,
    };
  }

  const { scanned } = built.scan;
  const byId = new Map(scanned.roles.map((r) => [r.id, r]));
  const lockOf = (id: string): RoleGroupRow["roleLock"] => {
    const role = byId.get(id);
    return role
      ? roleLockReason(role, scanned.guildId, scanned.botHighestRolePosition)
      : null;
  };
  const taken = new Set(
    built.groups.flatMap((g) => (g.roleId ? [g.roleId] : [])),
  );
  const groups: RoleGroupRow[] = built.groups.map((g) => {
    const role = g.roleId ? byId.get(g.roleId) : undefined;
    return {
      ...g,
      roleName: role?.name ?? null,
      roleMissing: g.roleId !== null && !role,
      memberCount: g.roleId
        ? (built.scan.memberCounts.get(g.roleId) ?? null)
        : null,
      roleLock: g.roleId && role && !g.gateOnly ? lockOf(g.roleId) : null,
      drift: built.drift.filter((d) => d.groupId === g.id),
    };
  });
  const roleOptions: RoleGroupRoleOption[] = scanned.roles
    .slice()
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id,
      name: r.name,
      memberCount: built.scan.memberCounts.get(r.id) ?? null,
      lock: lockOf(r.id),
      taken: taken.has(r.id),
    }));
  const botRoleIds = built.groups
    .filter((g) => g.capabilities.includes("bot") && g.roleId)
    .map((g) => g.roleId as string);
  const botsMissing =
    built.scan.botIds === null || botRoleIds.length === 0
      ? 0
      : built.scan.botIds.filter((id) =>
          botRoleIds.some(
            (r) => !(scanned.memberRoles?.[id] ?? []).includes(r),
          ),
        ).length;

  return {
    groups,
    roleOptions,
    plan: built.plan,
    extraErrors: built.extraErrors,
    planUnavailable: null,
    botScanUnavailable: built.botScanUnavailable,
    botsMissing,
    adminReport: built.adminReport,
    membersUnavailable: built.membersUnavailable,
    roleNames: Object.fromEntries(scanned.roles.map((r) => [r.id, r.name])),
    globalPolicy,
  };
}

/**
 * Plan for the "administrators outside the admin group" fix (#1021), plus the
 * members who would lose Administrator without being moved. Throws when the
 * server can't be read; the route shows that as an error.
 */
export async function loadAdminFixPreview(
  client: Client,
  guildId: string,
  adminUserId: string,
  moveIds: string[],
  dropIds: string[],
): Promise<
  Pick<
    AdminFixPageProps,
    "plan" | "extraErrors" | "moveIds" | "dropIds" | "losing"
  >
> {
  const guild = await client.guilds.fetch(guildId);
  const built = await planAdminFix(guild, adminUserId, {
    moveMemberIds: moveIds,
    dropRoleIds: dropIds,
  });
  const dropped = new Set(dropIds);
  const moved = new Set(moveIds);
  const losing = (built.report?.humans ?? [])
    .filter(
      (h) =>
        !moved.has(h.id) &&
        h.viaRoleIds.length > 0 &&
        h.viaRoleIds.every((r) => dropped.has(r)),
    )
    .map((h) => h.name);
  return {
    plan: built.plan,
    extraErrors: built.extraErrors,
    moveIds,
    dropIds,
    losing,
  };
}
