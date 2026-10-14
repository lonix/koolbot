import type { RoleGroupView } from "./role-group-service.js";

/**
 * Group references for role-based settings (#1023).
 *
 * Features that keep a list of allowed roles (command permissions,
 * `quotes.delete_roles`) can also name role groups. A reference is stored next
 * to the raw role ids as a token:
 *
 * - `group:<groupId>`   the members of that group
 * - `group:<groupId>+`  that group and every group ranked above it
 *
 * Tokens resolve to role ids at check time, so a group that is re-linked,
 * re-ranked or re-synced takes effect without editing the feature. A group
 * that has no role (unlinked) resolves to nothing; the list stays restricted.
 */

export const GROUP_REF_PREFIX = "group:";

/**
 * Role-list settings that resolve group references (#1023). Their Web UI
 * pickers (Settings, wizard, feature pages) offer groups; every other role
 * setting stays raw roles, because nothing would resolve a group token there.
 */
export const ROLE_GROUP_SETTING_KEYS = ["quotes.delete_roles"] as const;

export interface GroupRef {
  groupId: string;
  andAbove: boolean;
}

export function makeGroupRef(groupId: string, andAbove: boolean): string {
  return `${GROUP_REF_PREFIX}${groupId}${andAbove ? "+" : ""}`;
}

export function parseGroupRef(value: string): GroupRef | null {
  const raw = value.trim();
  if (!raw.startsWith(GROUP_REF_PREFIX)) return null;
  let id = raw.slice(GROUP_REF_PREFIX.length);
  const andAbove = id.endsWith("+");
  if (andAbove) id = id.slice(0, -1);
  return id ? { groupId: id, andAbove } : null;
}

export function isGroupRef(value: string): boolean {
  return parseGroupRef(value) !== null;
}

/** Split a mixed list into plain role ids and group references. */
export function splitRoleRefs(values: readonly string[]): {
  roleIds: string[];
  groupRefs: string[];
} {
  const roleIds: string[] = [];
  const groupRefs: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    (isGroupRef(t) ? groupRefs : roleIds).push(t);
  }
  return { roleIds, groupRefs };
}

/** Split a comma-separated setting value (see {@link splitRoleRefs}). */
export function splitRoleSetting(csv: string): {
  roleIds: string[];
  groupRefs: string[];
} {
  return splitRoleRefs(csv.split(","));
}

/**
 * Role ids the references stand for, given the guild's groups. Unknown
 * (deleted) groups and groups without a role contribute nothing.
 */
export function resolveGroupRefs(
  groups: readonly RoleGroupView[],
  refs: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const ref of refs) {
    const parsed = parseGroupRef(ref);
    if (!parsed) continue;
    const base = groups.find((g) => g.id === parsed.groupId);
    if (!base) continue;
    const matched = parsed.andAbove
      ? groups.filter((g) => g.rank >= base.rank)
      : [base];
    for (const g of matched) if (g.roleId) out.add(g.roleId);
  }
  return [...out];
}

function isStaffGroup(g: RoleGroupView): boolean {
  return g.capabilities.includes("staff") || g.capabilities.includes("admin");
}

/** Role ids of every group carrying `staff` or `admin` (the staff capability). */
export function staffRoleIds(groups: readonly RoleGroupView[]): string[] {
  return groups.flatMap((g) => (g.roleId && isStaffGroup(g) ? [g.roleId] : []));
}

/** Is any group a staff or admin one (so the staff default applies)? */
export function hasStaffGroup(groups: readonly RoleGroupView[]): boolean {
  return groups.some(isStaffGroup);
}
