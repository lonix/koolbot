import { PermissionsBitField } from "discord.js";
import type {
  DesiredMemberGrant,
  DesiredRole,
  DesiredState,
  PlanIssue,
  ScannedState,
} from "./server-adoption-planner.js";
import {
  ROLE_GROUP_CAPABILITIES,
  type RoleGroupCapability,
  type RoleGroupSyncPolicy,
} from "../models/role-group.js";

/**
 * Pure helpers for role groups (#1020): validation, permission presets and the
 * translation from "the groups an admin defined" to the `DesiredState` the
 * adoption engine (#1018) plans against. No Discord or database access, so the
 * rules are unit-testable on their own.
 */

/** The fields of a group the plan depends on. */
export interface GroupSpec {
  id: string;
  name: string;
  roleId: string | null;
  rank: number;
  permissions: string | null;
  capabilities: readonly RoleGroupCapability[];
  colour: number | null;
  createdByKoolbot: boolean;
  gateOnly: boolean;
  /** Expected role name (#1021); `null`/absent = not tracked. */
  roleName?: string | null;
  /** The role was deleted in Discord (#1021); the plan never recreates it. */
  unlinked?: boolean;
  /** Per-group sync policy override (#1021); `null`/absent = global setting. */
  syncPolicy?: RoleGroupSyncPolicy | null;
}

const F = PermissionsBitField.Flags;
const bits = (...flags: bigint[]): string =>
  flags.reduce((a, b) => a | b, 0n).toString();

/**
 * Starting points for a group's permission set. Presets only pre-fill the
 * form; the admin can edit the result before saving.
 */
export const PERMISSION_PRESETS: ReadonlyArray<{
  key: string;
  label: string;
  permissions: string;
  capabilities: readonly RoleGroupCapability[];
}> = [
  {
    key: "admin",
    label: "Admin",
    permissions: bits(F.Administrator),
    capabilities: ["admin", "staff"],
  },
  {
    key: "moderator",
    label: "Moderator",
    permissions: bits(
      F.ModerateMembers,
      F.ManageMessages,
      F.MoveMembers,
      F.KickMembers,
    ),
    capabilities: ["staff"],
  },
  {
    key: "helper",
    label: "Helper",
    permissions: bits(F.ManageMessages, F.MoveMembers),
    capabilities: ["staff"],
  },
  {
    key: "vip",
    label: "VIP (cosmetic only)",
    permissions: "0",
    capabilities: [],
  },
  {
    key: "bot",
    label: "Bots (cosmetic only)",
    permissions: "0",
    capabilities: ["bot"],
  },
];

export const MAX_GROUPS_PER_GUILD = 50;
export const MAX_NAME_LENGTH = 100;

export function isCapability(value: unknown): value is RoleGroupCapability {
  return (ROLE_GROUP_CAPABILITIES as readonly unknown[]).includes(value);
}

/** A Discord permission bitfield: a non-negative decimal integer string. */
export function isValidPermissions(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return false;
  return BigInt(value) <= PermissionsBitField.All;
}

export interface GroupInput {
  name: string;
  rank?: number;
  permissions?: string | null;
  capabilities?: readonly string[];
  colour?: number | null;
  hoist?: boolean;
  gateOnly?: boolean;
}

/**
 * Validate a create/edit payload. Returns the first problem in plain
 * language, or null. `existing` are the guild's other groups (the one being
 * edited excluded) and drive the duplicate-name check.
 */
export function validateGroupInput(
  input: GroupInput,
  existing: ReadonlyArray<Pick<GroupSpec, "name">>,
): string | null {
  const name = input.name.trim();
  if (!name) return "A group needs a name.";
  if (name.length > MAX_NAME_LENGTH) {
    return `A group name can be at most ${MAX_NAME_LENGTH} characters (Discord's role-name limit).`;
  }
  if (existing.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
    return `A group called "${name}" already exists.`;
  }
  if (existing.length >= MAX_GROUPS_PER_GUILD) {
    return `At most ${MAX_GROUPS_PER_GUILD} groups are supported.`;
  }
  if (
    input.permissions !== undefined &&
    input.permissions !== null &&
    !isValidPermissions(input.permissions)
  ) {
    return "Permissions must be a valid Discord permission bitfield.";
  }
  for (const cap of input.capabilities ?? []) {
    if (!isCapability(cap)) return `Unknown capability "${cap}".`;
  }
  const caps = input.capabilities ?? [];
  if (input.gateOnly && caps.length > 0) {
    return "A gate-only group (a managed role such as Server Booster) can't carry capabilities.";
  }
  if (caps.includes("bot") && caps.some((c) => c !== "bot")) {
    return "The bot capability can't be combined with other capabilities: humans can't join a bot group.";
  }
  if (
    input.colour !== undefined &&
    input.colour !== null &&
    (!Number.isInteger(input.colour) ||
      input.colour < 0 ||
      input.colour > 0xffffff)
  ) {
    return "Colour must be between #000000 and #FFFFFF.";
  }
  if (
    input.rank !== undefined &&
    (!Number.isInteger(input.rank) || input.rank < 0 || input.rank > 10_000)
  ) {
    return "Rank must be a whole number between 0 and 10000.";
  }
  return null;
}

/** Parse "#RRGGBB" / "RRGGBB" to a number; "" → null; garbage → undefined. */
export function parseColour(raw: string): number | null | undefined {
  const text = raw.trim().replace(/^#/, "");
  if (text === "") return null;
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return undefined;
  return Number.parseInt(text, 16);
}

export function formatColour(colour: number | null): string {
  return colour === null ? "" : `#${colour.toString(16).padStart(6, "0")}`;
}

/** Why a role can't back an editable group, or null when it can. */
export function roleLockReason(
  role: { id: string; managed: boolean; position: number },
  guildId: string,
  botHighest: number,
): "everyone" | "managed" | "hierarchy" | null {
  if (role.id === guildId) return "everyone";
  if (role.managed) return "managed";
  if (role.position >= botHighest) return "hierarchy";
  return null;
}

export interface DesiredFromGroups {
  desired: DesiredState;
  /** Problems the planner can't see (e.g. no room under the bot's role). */
  issues: PlanIssue[];
}

/**
 * Translate groups into the engine's desired state.
 *
 * - A linked role is only edited where the admin set a value (`permissions` /
 *   `colour` not null) and it differs from the role; nothing else is touched
 *   and nobody is added to or removed from it.
 * - A group without a role yields a role create, named after the group.
 * - Role positions follow `rank`: a higher rank sits above a lower one. Roles
 *   already in the right order are left where they are; the others (and new
 *   roles) are placed just above the group below them. If the ordered stack
 *   doesn't fit under the bot's own role, that is reported instead of
 *   silently squeezing it in.
 * - Gate-only groups (managed roles) are never edited or created.
 * - Humans never join a `bot` group; a `bot` group instead plans a grant of
 *   its role to the bots that don't hold it yet.
 * - An *unlinked* group (its role was deleted in Discord, #1021) is skipped:
 *   it is never silently recreated; an admin re-links it or requests a new
 *   role first.
 * - A tracked role name (`roleName`) is restored when the role was renamed.
 */
export function buildDesiredState(
  groups: readonly GroupSpec[],
  scanned: ScannedState,
): DesiredFromGroups {
  const issues: PlanIssue[] = [];
  const byId = new Map(scanned.roles.map((r) => [r.id, r]));
  const editable = groups
    .filter((g) => !g.gateOnly)
    .slice()
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  const roles: DesiredRole[] = [];
  let floor = 0; // position of the group role below; @everyone is 0
  for (const g of editable) {
    if (g.unlinked) continue;
    const existing = g.roleId ? byId.get(g.roleId) : undefined;
    if (g.roleId && !existing) {
      issues.push({
        code: "group-role-missing",
        message: `The role behind "${g.name}" no longer exists in Discord. Re-link or recreate it.`,
        targetId: g.id,
      });
      continue;
    }
    if (existing && (existing.managed || existing.id === scanned.guildId)) {
      continue; // locked; the planner reports it if an edit were attempted
    }
    const desired: DesiredRole = existing
      ? { id: existing.id, name: g.roleName ?? existing.name }
      : { name: g.name };
    if (g.permissions !== null && g.permissions !== existing?.permissions) {
      desired.permissions = g.permissions;
    }
    if (g.colour !== null && g.colour !== existing?.color) {
      desired.color = g.colour;
    }
    if (existing) {
      if (existing.position > floor) {
        floor = existing.position;
      } else {
        desired.position = floor + 1;
        floor += 1;
      }
    } else {
      desired.position = floor + 1;
      floor += 1;
    }
    // Only emit a role the engine has something to do for.
    const changes =
      existing === undefined ||
      desired.name !== existing.name ||
      desired.permissions !== undefined ||
      desired.color !== undefined ||
      desired.position !== undefined;
    if (changes) roles.push(desired);
  }
  if (floor >= scanned.botHighestRolePosition && roles.length > 0) {
    issues.push({
      code: "groups-do-not-fit",
      message:
        "The groups, in rank order, don't fit below the bot's own role. Move the bot's role higher in Discord's role list, or use fewer groups.",
    });
  }

  const memberGrants: DesiredMemberGrant[] = [];
  for (const g of groups) {
    if (!g.capabilities.includes("bot") || !g.roleId) continue;
    const missing = scanned.otherBotIds.filter(
      (id) => !(scanned.memberRoles?.[id] ?? []).includes(g.roleId as string),
    );
    if (missing.length > 0) {
      memberGrants.push({ role: { id: g.roleId }, memberIds: missing });
    }
  }

  return {
    desired: {
      roles,
      ...(memberGrants.length ? { memberGrants } : {}),
    },
    issues,
  };
}
