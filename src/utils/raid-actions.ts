import { PermissionFlagsBits } from "discord.js";

/**
 * The actions anti-raid can apply to a member (#1045), and the Discord
 * permission a moderator needs to switch `/raidmode on` while that action is
 * configured. `/raidmode on` makes the bot apply the action to every later
 * join, so it must not be a way for a moderator to use a stronger privilege
 * than they hold (the same rule `/ban` applies with Ban Members).
 *
 * The single table behind the command's check, its refusal text, the settings
 * descriptions and the docs (a drift test compares them).
 */
export const RAID_ACTION_PERMISSIONS = {
  timeout: {
    flag: PermissionFlagsBits.ModerateMembers,
    label: "Moderate Members",
  },
  quarantine: { flag: PermissionFlagsBits.ManageRoles, label: "Manage Roles" },
  kick: { flag: PermissionFlagsBits.KickMembers, label: "Kick Members" },
} as const;

export type RaidAction = keyof typeof RAID_ACTION_PERMISSIONS;

/** Order shown in selects and docs: most reversible first. */
export const RAID_ACTIONS = [
  "timeout",
  "quarantine",
  "kick",
] as const satisfies readonly RaidAction[];
