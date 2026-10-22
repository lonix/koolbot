import { parseTierConfig } from "../web/leaderboard-tiers.js";

/**
 * Every setting that names a role the bot hands to members on its own, and
 * every other place that does (#1321). One list, so a role that carries an
 * admin, Moderator or Event host scope can be kept out of all of them by the
 * same rule: the Settings page, the wizard's steps and Apply, the Access step,
 * and the "used by" check when a role is linked to a group.
 *
 * A role a feature hands out must not back a role group: the group's scope
 * would go to everyone the feature qualifies. `__tests__/config/
 * role-grant-drift.test.ts` fails when a role-typed setting is in neither
 * {@link ROLE_GRANTING_SETTINGS} nor {@link ROLE_SETTINGS_NOT_GRANTING}, or a
 * file that adds roles to members is not in {@link ROLE_GRANT_CODE}.
 */

export interface RoleGrantSetting {
  key: string;
  /** How the feature is named to the admin, e.g. "Used by Rules". */
  feature: string;
  /** The role ids a value of this setting names. */
  roleIds: (value: unknown) => string[];
}

const single = (value: unknown): string[] =>
  typeof value === "string" ? [value.trim()].filter(Boolean) : [];

export const ROLE_GRANTING_SETTINGS: readonly RoleGrantSetting[] = [
  { key: "birthdays.role_id", feature: "Birthdays", roleIds: single },
  {
    key: "leaderboard_roles.tiers",
    feature: "Leaderboard Roles",
    roleIds: (value) =>
      typeof value === "string"
        ? parseTierConfig(value).tiers.map((t) => t.roleId)
        : [],
  },
  { key: "rules.role_id", feature: "Rules", roleIds: single },
  {
    key: "moderation.raid.quarantine_role_id",
    feature: "Raid protection",
    roleIds: single,
  },
];

/** Role-typed settings that grant nothing, with the reason. */
export const ROLE_SETTINGS_NOT_GRANTING: Readonly<Record<string, string>> = {
  "quotes.delete_roles":
    "a list of roles allowed to delete quotes; it only gates, the bot grants nothing",
  "tickets.staff_role_id":
    "the role that sees tickets; it only gates, the bot grants nothing",
};

/**
 * Source files that add a role to a member, with how each is kept away from
 * group roles. Reaction roles are stored in their own collection, not in
 * config: the service refuses a group-backed or powerful role when a binding
 * is made, and linking a role to a group refuses one a binding already uses.
 */
export const ROLE_GRANT_CODE: Readonly<Record<string, string>> = {
  "services/birthday-service.ts": "birthdays.role_id",
  "services/leaderboard-role-service.ts": "leaderboard_roles.tiers",
  "services/rules-service.ts": "rules.role_id",
  "services/raid-protection-service.ts": "moderation.raid.quarantine_role_id",
  "services/server-adoption-service.ts":
    "an admin-reviewed adoption plan (member grants), never a feature setting",
  "services/reaction-role-service.ts":
    "reaction role bindings (database, checked when a binding is made)",
};

export function grantSetting(key: string): RoleGrantSetting | undefined {
  return ROLE_GRANTING_SETTINGS.find((s) => s.key === key);
}

/** Role ids a role-granting setting's value names (empty for any other key). */
export function grantedRoleIds(key: string, value: unknown): string[] {
  return grantSetting(key)?.roleIds(value) ?? [];
}
