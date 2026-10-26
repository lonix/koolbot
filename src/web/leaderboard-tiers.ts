/**
 * `leaderboard_roles.tiers` ⇄ tier rows for the Leaderboard Roles admin page
 * (#985).
 *
 * The stored format stays the comma-separated `topN:roleId` string that
 * `LeaderboardRoleService` parses (e.g. `1:111,3:222,10:333`); the page only
 * edits it as rows. Parsing here follows the service's rules — a malformed
 * entry is skipped, and a repeated `topN` keeps the last role — so the editor
 * shows exactly the tiers the service would act on.
 */

import { forbiddenSelfAssignPermissions } from "../utils/role-safety.js";

export interface LeaderboardTier {
  topN: number;
  roleId: string;
}

export interface ParsedTierConfig {
  /** Tiers the service would act on, ascending by `topN`. */
  tiers: LeaderboardTier[];
  /**
   * Entries the service skips (malformed, or shadowed by a later entry with
   * the same `topN`), verbatim, so the page can say they will be dropped.
   */
  ignored: string[];
}

/**
 * Upper bound on a tier's `topN`. The service has none, but a tier wider than
 * this is almost certainly a typo, and every member in range costs a Discord
 * member fetch on each run.
 */
export const MAX_TIER_TOP_N = 1000;

/** The config key the tier editor edits. */
export const TIERS_KEY = "leaderboard_roles.tiers";

/**
 * The stored tier string from a strict `ConfigService.getAll()` snapshot, or
 * undefined when no row is stored (the env / schema default then applies).
 * Used instead of `getString`, which turns a failed read into the default and
 * so would make an outage look like "no tiers".
 */
export function storedTiersFromSnapshot(
  rows: ReadonlyArray<{ key: string; value: unknown }>,
): string | undefined {
  const row = rows.find((r) => r.key === TIERS_KEY);
  if (!row) return undefined;
  return typeof row.value === "string" ? row.value : "";
}

/** Upper bound on the number of tiers the editor accepts. */
export const MAX_TIERS = 25;

/** Same role-id shape `LeaderboardRoleService.parseTiers` accepts. */
const ROLE_ID_RE = /^\d+$/;

export function parseTierConfig(raw: string): ParsedTierConfig {
  const byTopN = new Map<number, { roleId: string; entry: string }>();
  const ignored: string[] = [];
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of entries) {
    const parts = entry.split(":").map((p) => p.trim());
    const topN = Number(parts[0]);
    const roleId = parts[1] ?? "";
    if (
      parts.length !== 2 ||
      !Number.isInteger(topN) ||
      topN <= 0 ||
      !ROLE_ID_RE.test(roleId)
    ) {
      ignored.push(entry);
      continue;
    }
    const previous = byTopN.get(topN);
    if (previous) ignored.push(previous.entry);
    byTopN.set(topN, { roleId, entry });
  }
  const tiers = Array.from(byTopN.entries())
    .map(([topN, { roleId }]) => ({ topN, roleId }))
    .sort((a, b) => a.topN - b.topN);
  return { tiers, ignored };
}

/** Serialise tiers back to the stored `topN:roleId` string, ascending. */
export function serializeTiers(tiers: readonly LeaderboardTier[]): string {
  return [...tiers]
    .sort((a, b) => a.topN - b.topN)
    .map((t) => `${t.topN}:${t.roleId}`)
    .join(",");
}

export type TierRowsResult =
  { ok: true; tiers: LeaderboardTier[] } | { ok: false; error: string };

/** One refused field of the tier editor (#1523). */
export interface TierRowError {
  /** Position of the row in the submitted `topN[]` / `roleId[]` arrays. */
  index: number;
  field: "topN" | "roleId";
  /** What to change, worded for the line under the field. */
  message: string;
  /** The same refusal as one sentence naming the row, for a flash. */
  flat: string;
}

/**
 * Check the editor's submitted rows (parallel `topN[]` / `roleId[]` arrays)
 * and say which field of which row is wrong. A row with both halves blank is
 * an empty slot and is dropped; a half-filled row is an error rather than
 * being silently discarded. Checks the shape only: whether each role exists
 * and sits below the bot's role is a guild lookup the route does afterwards.
 * `tiers` is only meaningful when `errors` is empty.
 */
export function checkTierRows(
  topNs: readonly string[],
  roleIds: readonly string[],
): { tiers: LeaderboardTier[]; errors: TierRowError[] } {
  const tiers: LeaderboardTier[] = [];
  const errors: TierRowError[] = [];
  const seenTopN = new Set<number>();
  const seenRole = new Set<string>();
  const filled: number[] = [];
  const count = Math.max(topNs.length, roleIds.length);
  for (let i = 0; i < count; i++) {
    const topNRaw = (topNs[i] ?? "").trim();
    const roleId = (roleIds[i] ?? "").trim();
    if (!topNRaw && !roleId) continue;
    filled.push(i);
    const row = `Row ${i + 1}`;
    const fail = (
      field: TierRowError["field"],
      message: string,
      flat: string,
    ): void => {
      errors.push({ index: i, field, message, flat });
    };
    const before = errors.length;
    const topN = Number(topNRaw);
    if (!topNRaw) {
      fail("topN", "Enter a Top N.", `${row}: enter a Top N.`);
    } else if (!/^\d+$/.test(topNRaw)) {
      fail(
        "topN",
        "Use a whole number greater than 0.",
        `${row}: Top N must be a whole number greater than 0.`,
      );
    } else if (topN < 1 || topN > MAX_TIER_TOP_N) {
      fail(
        "topN",
        `Use 1 to ${MAX_TIER_TOP_N}.`,
        `${row}: Top N must be between 1 and ${MAX_TIER_TOP_N}.`,
      );
    } else if (seenTopN.has(topN)) {
      fail(
        "topN",
        "Another tier has this Top N. Each Top N must be unique.",
        `Top ${topN} is used by more than one tier. Each Top N must be unique.`,
      );
    }
    if (!roleId) {
      fail("roleId", "Pick a role.", `${row}: pick a role.`);
    } else if (!ROLE_ID_RE.test(roleId)) {
      fail(
        "roleId",
        "Pick a role from the list.",
        `${row}: that is not a valid role.`,
      );
    } else if (seenRole.has(roleId)) {
      // The service tracks holders per role, so two tiers sharing a role would
      // grant and revoke it against each other on every run.
      fail(
        "roleId",
        "Another tier uses this role. Each tier needs its own role.",
        `${row}: that role is already used by another tier. Each tier needs its own role.`,
      );
    }
    if (errors.length === before) {
      seenTopN.add(topN);
      seenRole.add(roleId);
      tiers.push({ topN, roleId });
    }
  }
  if (errors.length === 0 && tiers.length > MAX_TIERS) {
    errors.push({
      index: filled[MAX_TIERS],
      field: "topN",
      message: `At most ${MAX_TIERS} tiers are supported. Clear this row.`,
      flat: `At most ${MAX_TIERS} tiers are supported.`,
    });
  }
  return { tiers: tiers.sort((a, b) => a.topN - b.topN), errors };
}

/**
 * {@link checkTierRows} as one result: the first refusal as a sentence, or
 * the valid tiers ascending by `topN`.
 */
export function validateTierRows(
  topNs: readonly string[],
  roleIds: readonly string[],
): TierRowsResult {
  const { tiers, errors } = checkTierRows(topNs, roleIds);
  return errors.length > 0
    ? { ok: false, error: errors[0].flat }
    : { ok: true, tiers };
}

/** The parts of a Discord role the assignability check reads. */
export interface TierRoleInfo {
  id: string;
  name: string;
  managed: boolean;
  position: number;
  /** Read for the powerful-permissions check; absent counts as safe. */
  permissions?: { bitfield: bigint } | null;
}

/** Why the bot cannot hand out a role as a tier reward. */
export type TierRoleIssue =
  "missing" | "everyone" | "managed" | "hierarchy" | "privileged";

/**
 * Why the bot cannot hand out `role` as a tier reward, or null when nothing
 * rules it out. `role` is null when the id no longer resolves in the guild;
 * `botHighestPosition` is null when the bot's own member could not be read,
 * in which case the hierarchy check is skipped rather than guessed — callers
 * that report assignability must treat that as unknown, not as fine.
 *
 * A role carrying Administrator or another permission from
 * `SELF_ASSIGN_FORBIDDEN_PERMISSIONS` is "privileged" (#1145): the grant is
 * automatic, so it would hand those permissions to whoever ranks. A caller
 * that must tolerate a role the tiers already held passes `allowPrivileged`.
 */
export function tierRoleIssue(
  role: TierRoleInfo | null,
  guildId: string,
  botHighestPosition: number | null,
  options: { allowPrivileged?: boolean } = {},
): TierRoleIssue | null {
  if (!role) return "missing";
  if (role.id === guildId) return "everyone";
  if (role.managed) return "managed";
  if (botHighestPosition !== null && role.position >= botHighestPosition) {
    return "hierarchy";
  }
  if (
    !options.allowPrivileged &&
    forbiddenSelfAssignPermissions(role).length > 0
  ) {
    return "privileged";
  }
  return null;
}

/** Operator-facing sentence for a {@link TierRoleIssue}. */
export function describeTierRoleIssue(
  issue: TierRoleIssue,
  roleName: string,
  permissions: readonly string[] = [],
): string {
  switch (issue) {
    case "missing":
      return "that role no longer exists";
    case "everyone":
      return "@everyone cannot be a tier role";
    case "managed":
      return `@${roleName} is managed by an integration and cannot be assigned`;
    case "hierarchy":
      return `@${roleName} sits at or above the bot's highest role, so the bot cannot assign it`;
    case "privileged":
      return `@${roleName} has powerful permissions${permissions.length > 0 ? ` (${permissions.join(", ")})` : ""}, so it cannot be a tier role: every member who ranks would receive them. Remove those permissions from the role or pick a different one`;
  }
}

/** {@link tierRoleIssue} as a sentence, or null when nothing rules it out. */
export function tierRoleProblem(
  role: TierRoleInfo | null,
  guildId: string,
  botHighestPosition: number | null,
  options: { allowPrivileged?: boolean } = {},
): string | null {
  const issue = tierRoleIssue(role, guildId, botHighestPosition, options);
  if (!issue) return null;
  return describeTierRoleIssue(
    issue,
    role?.name ?? "",
    role ? forbiddenSelfAssignPermissions(role) : [],
  );
}
