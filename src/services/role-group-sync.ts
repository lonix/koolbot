import { createHash } from "node:crypto";
import { PermissionsBitField } from "discord.js";
import {
  ROLE_GROUP_SYNC_POLICIES,
  type RoleGroupSyncPolicy,
} from "../models/role-group.js";
import { effectivePermissions, type GroupSpec } from "./role-group-plan.js";
import type {
  DesiredState,
  PlanIssue,
  RoleState,
  ScannedState,
} from "./server-adoption-planner.js";

/**
 * Pure rules for keeping role groups and their Discord roles in sync (#1021,
 * part of the server-adoption epic #1017). No Discord or database access, so
 * every rule is unit-testable on its own.
 *
 * - **Drift** is a difference between what the admin defined and what Discord
 *   holds. A value the admin never set (a `null` permission set, no tracked
 *   role name) is "leave alone" and can never drift.
 * - **Policy** decides what happens to drift: `enforce` re-applies the
 *   definition through the adoption engine, `adopt` makes the definition
 *   follow Discord, `flag` only reports it.
 * - The **admin group** carries `Administrator`. Members who hold it through
 *   some other role are reported, bots separately.
 */

const ADMINISTRATOR = PermissionsBitField.Flags.Administrator;

export const DEFAULT_SYNC_POLICY: RoleGroupSyncPolicy = "flag";

/** The group's own policy, else the global one, else flag-only. */
export function resolvePolicy(
  group: Pick<GroupSpec, "syncPolicy">,
  globalPolicy: string,
): RoleGroupSyncPolicy {
  const own = group.syncPolicy;
  if (own && (ROLE_GROUP_SYNC_POLICIES as readonly string[]).includes(own)) {
    return own;
  }
  return (ROLE_GROUP_SYNC_POLICIES as readonly string[]).includes(globalPolicy)
    ? (globalPolicy as RoleGroupSyncPolicy)
    : DEFAULT_SYNC_POLICY;
}

export type DriftKind =
  "permissions" | "name" | "position" | "deleted" | "admin-permission";

export interface DriftItem {
  groupId: string;
  groupName: string;
  kind: DriftKind;
  /** Plain-language description for the page and the Discord log. */
  detail: string;
}

function big(value: string | null | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

const hasAdministrator = (permissions: string | null | undefined): boolean =>
  (big(permissions) & ADMINISTRATOR) === ADMINISTRATOR;

/** Groups ordered the way `buildDesiredState` stacks them: lowest rank first. */
function byRank<T extends Pick<GroupSpec, "rank" | "name">>(list: T[]): T[] {
  return list
    .slice()
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

/**
 * Editable groups whose role is still in Discord, in rank order (low to
 * high). Gate-only (managed) roles and @everyone are never part of the order.
 */
function orderedLive(
  groups: readonly GroupSpec[],
  byId: Map<string, RoleState>,
  guildId: string,
): Array<{ group: GroupSpec; role: RoleState }> {
  const live: Array<{ group: GroupSpec; role: RoleState }> = [];
  for (const group of byRank(groups.filter((g) => !g.gateOnly))) {
    if (group.unlinked || !group.roleId) continue;
    const role = byId.get(group.roleId);
    if (!role || role.managed || role.id === guildId) continue;
    live.push({ group, role });
  }
  return live;
}

/**
 * Compare every linked group with its role.
 *
 * - `deleted`: the role id is gone from Discord (also for gate-only groups).
 * - `permissions`: the group defines a permission set and the role differs.
 * - `name`: the group tracks an expected role name and the role was renamed.
 * - `position`: relative order. Absolute positions shift whenever anyone adds
 *   a role, so only "a higher-ranked group's role sits below a lower-ranked
 *   one" counts.
 * - `admin-permission`: an `admin` group whose role lacks `Administrator`
 *   although the definition doesn't account for that.
 */
export function detectDrift(
  groups: readonly GroupSpec[],
  roles: readonly RoleState[],
  guildId: string,
): DriftItem[] {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const items: DriftItem[] = [];
  const add = (g: GroupSpec, kind: DriftKind, detail: string): void => {
    items.push({ groupId: g.id, groupName: g.name, kind, detail });
  };

  for (const g of groups) {
    if (g.unlinked || !g.roleId) continue;
    const role = byId.get(g.roleId);
    if (!role) {
      add(g, "deleted", "The Discord role was deleted.");
      continue;
    }
    if (g.gateOnly || role.managed || role.id === guildId) continue;
    const wanted = effectivePermissions(g, role.permissions);
    const permissionsDrift =
      wanted !== null && big(wanted) !== big(role.permissions);
    if (permissionsDrift) {
      add(
        g,
        "permissions",
        `Permissions in Discord differ from the group (${role.permissions} instead of ${g.permissions}).`,
      );
    }
    if (g.roleName && g.roleName.trim() !== role.name.trim()) {
      add(
        g,
        "name",
        `The role was renamed to "${role.name}" (expected "${g.roleName}").`,
      );
    }
    if (
      g.capabilities.includes("admin") &&
      !hasAdministrator(role.permissions)
    ) {
      add(g, "admin-permission", "The admin group's role lacks Administrator.");
    }
  }

  let floor = 0;
  for (const { group, role } of orderedLive(groups, byId, guildId)) {
    if (role.position > floor) {
      floor = role.position;
    } else {
      add(
        group,
        "position",
        `The role sits below a lower-ranked group's role (position ${role.position}).`,
      );
    }
  }
  return items;
}

/** Stable fingerprint of a drift set; a log is sent only when it changes. */
export function driftSignature(items: readonly DriftItem[]): string | null {
  if (items.length === 0) return null;
  const text = items
    .map((i) => `${i.groupId}|${i.kind}|${i.detail}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface AdoptUpdate {
  groupId: string;
  set: { permissions?: string; roleName?: string; rank?: number };
}

/**
 * What *adopt* writes into the group definitions so they follow Discord.
 * `admin-permission` is never adopted: whether the admin group may lose
 * `Administrator` is the admin's decision, so it stays flagged.
 */
export function adoptUpdates(
  groups: readonly GroupSpec[],
  roles: readonly RoleState[],
  items: readonly DriftItem[],
  guildId: string,
): AdoptUpdate[] {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const updates = new Map<string, AdoptUpdate>();
  const touch = (groupId: string): AdoptUpdate => {
    let u = updates.get(groupId);
    if (!u) {
      u = { groupId, set: {} };
      updates.set(groupId, u);
    }
    return u;
  };
  const groupById = new Map(groups.map((g) => [g.id, g]));
  for (const item of items) {
    const g = groupById.get(item.groupId);
    const role = g?.roleId ? byId.get(g.roleId) : undefined;
    if (!g || !role) continue;
    if (item.kind === "permissions")
      touch(g.id).set.permissions = role.permissions;
    if (item.kind === "name") touch(g.id).set.roleName = role.name;
  }
  if (items.some((i) => i.kind === "position")) {
    // Hand the existing rank values out again in Discord's order, so the
    // ranks of groups outside the order (gate-only) keep their meaning.
    const live = orderedLive(groups, byId, guildId);
    const ranks = live.map((l) => l.group.rank).sort((a, b) => a - b);
    const distinct = new Set(ranks).size === ranks.length;
    const byPosition = live
      .slice()
      .sort((a, b) => a.role.position - b.role.position);
    byPosition.forEach(({ group }, i) => {
      // Equal ranks can't express an order; space them out instead.
      const rank = distinct ? ranks[i] : i + 1;
      if (rank !== group.rank) touch(group.id).set.rank = rank;
    });
  }
  return [...updates.values()];
}

// ---- admin group ↔ Administrator ------------------------------------------

export interface ScannedMember {
  id: string;
  /** Display name, for the report only. */
  name: string;
  bot: boolean;
  roleIds: string[];
}

export interface AdminHolder {
  id: string;
  name: string;
  /** The roles through which the member holds Administrator. */
  viaRoleIds: string[];
  /** KoolBot itself. */
  self?: boolean;
}

export interface AdminReport {
  /** Humans holding Administrator outside the admin group. */
  humans: AdminHolder[];
  /** Bots holding Administrator (KoolBot included), shown separately. */
  bots: AdminHolder[];
}

/**
 * Who holds `Administrator` without being in the admin group.
 *
 * Returns `null` when no admin group has a role: sync then has nothing to
 * enforce, the guild owner counts as admin on their own, and flagging every
 * administrator would be noise. Bots never count as out-of-group
 * administrators; they are listed apart so a bot role with `Administrator`
 * doesn't show as permanent drift.
 */
export function findOutOfGroupAdministrators(input: {
  members: readonly ScannedMember[];
  roles: readonly RoleState[];
  adminGroupRoleIds: readonly string[];
  guildId: string;
  ownerId: string;
  botUserId: string;
}): AdminReport | null {
  if (input.adminGroupRoleIds.length === 0) return null;
  const inGroup = new Set(input.adminGroupRoleIds);
  const adminRoles = new Set(
    input.roles
      .filter((r) => r.id !== input.guildId && hasAdministrator(r.permissions))
      .map((r) => r.id),
  );
  const report: AdminReport = { humans: [], bots: [] };
  for (const m of input.members) {
    const via = m.roleIds.filter((id) => adminRoles.has(id));
    if (via.length === 0) continue;
    if (m.bot) {
      report.bots.push({
        id: m.id,
        name: m.name,
        viaRoleIds: via,
        ...(m.id === input.botUserId ? { self: true } : {}),
      });
      continue;
    }
    if (m.id === input.ownerId) continue;
    if (m.roleIds.some((id) => inGroup.has(id))) continue;
    report.humans.push({ id: m.id, name: m.name, viaRoleIds: via });
  }
  return report;
}

export interface AdminFixChoice {
  /** Human members to add to the admin group's role. */
  moveMemberIds: readonly string[];
  /** Other roles to drop `Administrator` from. Never pre-selected. */
  dropRoleIds: readonly string[];
  /**
   * Give the admin group's role the `Administrator` permission. Its own
   * opt-in: linking an existing role never changes its permissions on its
   * own, and this widens access for everyone holding the role.
   */
  grantAdministrator?: boolean;
}

/**
 * The desired state for resolving the admin group <-> `Administrator` gap
 * (#1021). Each part is an explicit choice, previewed before it is applied:
 *
 * - add humans who hold Administrator elsewhere to the admin group (additive),
 * - give the admin group's role Administrator (an edit; snapshotted),
 * - drop Administrator from another role (an edit; snapshotted).
 *
 * Anything unsafe is returned as an issue and blocks the plan:
 *
 * - managed roles and roles at or above the bot (also refused by the planner),
 * - KoolBot's own roles,
 * - a drop that would leave the invoking admin without `Administrator`.
 */
/**
 * Whether being added to the admin group's role leaves a member holding
 * Administrator once the plan is applied: only when that role already has the
 * bit or this plan grants it.
 */
export function moveKeepsAdministrator(
  choice: Pick<AdminFixChoice, "grantAdministrator">,
  adminGroupRoleIds: readonly string[],
  roles: readonly RoleState[],
): boolean {
  if (choice.grantAdministrator) return adminGroupRoleIds.length > 0;
  const first = roles.find((r) => r.id === adminGroupRoleIds[0]);
  return first !== undefined && hasAdministrator(first.permissions);
}

export function buildAdminFixDesired(
  choice: AdminFixChoice,
  report: AdminReport,
  adminGroupRoleIds: readonly string[],
  scanned: ScannedState,
  groups: readonly GroupSpec[] = [],
): { desired: DesiredState; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  const byId = new Map(scanned.roles.map((r) => [r.id, r]));
  const known = new Set(report.humans.map((h) => h.id));
  const memberIds = [...new Set(choice.moveMemberIds)].filter((id) =>
    known.has(id),
  );
  if (memberIds.length !== new Set(choice.moveMemberIds).size) {
    issues.push({
      code: "not-reported",
      message:
        "Some selected members are not out-of-group administrators any more. Reload the page.",
    });
  }

  const roles: NonNullable<DesiredState["roles"]> = [];
  /** Permissions after the plan, for the lockout check. */
  const after = new Map(scanned.roles.map((r) => [r.id, r.permissions]));

  if (choice.grantAdministrator) {
    for (const id of adminGroupRoleIds) {
      const role = byId.get(id);
      if (!role) {
        issues.push({
          code: "unknown-role",
          message: "The admin group's role no longer exists.",
          targetId: id,
        });
        continue;
      }
      if (hasAdministrator(role.permissions)) continue;
      const permissions = (big(role.permissions) | ADMINISTRATOR).toString();
      roles.push({ id, name: role.name, permissions });
      after.set(id, permissions);
    }
  }

  let dropped = 0;
  for (const id of new Set(choice.dropRoleIds)) {
    const role = byId.get(id);
    if (!role || id === scanned.guildId) {
      issues.push({
        code: "unknown-role",
        message: "A selected role no longer exists.",
        targetId: id,
      });
      continue;
    }
    if (scanned.botRoleIds.includes(id)) {
      issues.push({
        code: "own-role",
        message: `"${role.name}" is KoolBot's own role. KoolBot never removes Administrator from itself.`,
        targetId: id,
      });
      continue;
    }
    if (role.managed) {
      issues.push({
        code: "role-protected",
        message: `"${role.name}" is managed by an integration or bot and can't be edited.`,
        targetId: id,
      });
      continue;
    }
    if (adminGroupRoleIds.includes(id)) {
      issues.push({
        code: "admin-group-role",
        message: `"${role.name}" is the admin group's own role; it keeps Administrator.`,
        targetId: id,
      });
      continue;
    }
    // Bots are never touched: a role a bot holds Administrator through stays.
    const botHolders = report.bots.filter((b) => b.viaRoleIds.includes(id));
    if (botHolders.length > 0) {
      issues.push({
        code: "bot-role",
        message: `"${role.name}" also gives Administrator to ${botHolders
          .map((b) => b.name)
          .join(
            ", ",
          )}. Bots are never changed here; reduce the bot's permissions separately.`,
        targetId: id,
      });
      continue;
    }
    // A group that defines Administrator for this role would see the drop as
    // drift and put it back (enforce) or keep proposing it (flag).
    const definer = groups.find(
      (g) =>
        g.roleId === id &&
        !g.capabilities.includes("admin") &&
        g.permissions !== null &&
        hasAdministrator(g.permissions),
    );
    if (definer) {
      issues.push({
        code: "group-defines-administrator",
        message: `The group "${definer.name}" defines Administrator for "${role.name}". Edit the group first, or the sync would restore it.`,
        targetId: id,
      });
      continue;
    }
    if (!hasAdministrator(role.permissions)) continue;
    const permissions = (big(role.permissions) & ~ADMINISTRATOR).toString();
    roles.push({ id, name: role.name, permissions });
    after.set(id, permissions);
    dropped += 1;
  }

  // The invoking admin must keep Administrator once the plan is applied.
  if (dropped > 0 && scanned.adminUserId !== scanned.ownerId) {
    const heldRoles = new Set(scanned.adminRoleIds);
    if (memberIds.includes(scanned.adminUserId) && adminGroupRoleIds[0]) {
      heldRoles.add(adminGroupRoleIds[0]);
    }
    const keeps = [...heldRoles].some((id) => hasAdministrator(after.get(id)));
    if (!keeps) {
      issues.push({
        code: "admin-lockout",
        message:
          "This would remove your own Administrator access. Add yourself to the admin group first, or keep that role.",
      });
    }
  }

  const desired: DesiredState = {
    ...(roles.length ? { roles } : {}),
    ...(memberIds.length && adminGroupRoleIds[0]
      ? {
          memberGrants: [{ role: { id: adminGroupRoleIds[0] }, memberIds }],
        }
      : {}),
  };
  return { desired, issues };
}

/**
 * Role names to start tracking for drift: groups linked before name tracking
 * existed (or whose name was never recorded) take the role's current name, so
 * only a *later* rename counts as drift.
 */
export function roleNamesToTrack(
  groups: readonly GroupSpec[],
  roles: readonly RoleState[],
  guildId: string,
): Array<{ groupId: string; roleName: string }> {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const out: Array<{ groupId: string; roleName: string }> = [];
  for (const g of groups) {
    if (g.gateOnly || g.unlinked || !g.roleId || g.roleName) continue;
    const role = byId.get(g.roleId);
    if (!role || role.managed || role.id === guildId) continue;
    out.push({ groupId: g.id, roleName: role.name });
  }
  return out;
}
