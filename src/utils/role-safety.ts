import { PermissionFlagsBits } from "discord.js";
import { sanitizeForLog } from "./log-sanitize.js";

/**
 * Permissions no member may self-grant through a reaction, button or select
 * menu (#1145). Binding one of these to a self-assign role would hand server
 * control (Administrator, Manage Server/Roles/Channels/Webhooks), moderation
 * (Kick, Ban, Timeout) or mass pings (Mention @everyone) to anyone who clicks.
 *
 * Deliberately the audit's list rather than the wider rules-acceptance list:
 * cosmetic or helper roles (Manage Messages, Move Members, ...) stay allowed
 * for self-assign so existing servers keep working.
 */
export const SELF_ASSIGN_FORBIDDEN_PERMISSIONS: bigint[] = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.MentionEveryone,
];

const FORBIDDEN_MASK = SELF_ASSIGN_FORBIDDEN_PERMISSIONS.reduce(
  (a, b) => a | b,
  0n,
);

/**
 * Names of the forbidden permissions `role` carries (discord.js permission
 * names, e.g. `ManageGuild`); empty when it is safe to self-assign. A role
 * with no readable permissions counts as safe: this guards an admin's choice,
 * it is not an access check.
 */
export function forbiddenSelfAssignPermissions(role: {
  permissions?: { bitfield: bigint } | null;
}): string[] {
  const bits = role.permissions?.bitfield;
  if (typeof bits !== "bigint") return [];
  return forbiddenSelfAssignNames(bits);
}

/**
 * The same check on a raw permission bitfield (the adoption planner works on
 * decimal strings, not discord.js roles), so the planner and the reaction-role
 * service can never disagree on what is too powerful to self-assign.
 */
export function forbiddenSelfAssignNames(bits: bigint): string[] {
  const hit = bits & FORBIDDEN_MASK;
  if (hit === 0n) return [];
  // Name only the bits actually set, read straight from the flag table, so
  // the result never depends on how a bitfield helper treats Administrator.
  return Object.entries(PermissionFlagsBits)
    .filter(([, flag]) => (hit & flag) === flag)
    .map(([name]) => name);
}

/** A role group and the role that backs it (see `groupBackedRoles`). */
export interface BackingGroup {
  roleId: string;
  groupName: string;
}

/**
 * Why a role that backs a role group must not be handed out by a feature, or
 * null when no group uses it. Any group counts, whatever its scope (admin,
 * Moderators, Event hosts or none): the same rule the Web UI applies when a
 * role is chosen, so grant time never refuses less than configuration time
 * (#1375).
 */
export function groupBackedBlockReason(
  backing: readonly BackingGroup[],
): string | null {
  if (backing.length === 0) return null;
  const names = backing
    .map((b) => `"${sanitizeForLog(b.groupName, 64)}"`)
    .join(", ");
  return `backs the role group ${names}, whose access would go to everyone it is granted to`;
}

/**
 * Why a feature that hands a role to members on its own (a leaderboard tier,
 * the birthday role) must not grant `role`, or null when it may. Covers the
 * forbidden permissions above and a role that backs any role group (admin,
 * Moderators or Event hosts), which the Web UI accepts by bare membership, so
 * handing it out would be a Web UI grant (#1145, #1375). `backing` is what
 * `RoleGroupService.groupBackedRoles` returned for this role. Reaction roles
 * already refuse every group-backed role, so they keep using
 * {@link forbiddenSelfAssignPermissions} alone.
 */
export function automaticGrantBlockReason(
  role: { id: string; permissions?: { bitfield: bigint } | null },
  backing: readonly BackingGroup[] = [],
): string | null {
  const dangerous = forbiddenSelfAssignPermissions(role);
  if (dangerous.length > 0) {
    return `carries powerful permissions (${dangerous.join(", ")})`;
  }
  return groupBackedBlockReason(backing.filter((b) => b.roleId === role.id));
}
