import { PermissionFlagsBits } from "discord.js";

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
  const hit = bits & FORBIDDEN_MASK;
  if (hit === 0n) return [];
  // Name only the bits actually set, read straight from the flag table, so
  // the result never depends on how a bitfield helper treats Administrator.
  return Object.entries(PermissionFlagsBits)
    .filter(([, flag]) => (hit & flag) === flag)
    .map(([name]) => name);
}
