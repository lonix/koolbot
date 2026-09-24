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

/**
 * Validate the editor's submitted rows (parallel `topN[]` / `roleId[]`
 * arrays). A row with both halves blank is an empty slot and is dropped; a
 * half-filled row is an error rather than being silently discarded. Checks
 * the shape only — whether each role exists and sits below the bot's role is
 * a guild lookup the route does afterwards.
 */
export function validateTierRows(
  topNs: readonly string[],
  roleIds: readonly string[],
): TierRowsResult {
  const tiers: LeaderboardTier[] = [];
  const seenTopN = new Set<number>();
  const seenRole = new Set<string>();
  const count = Math.max(topNs.length, roleIds.length);
  for (let i = 0; i < count; i++) {
    const topNRaw = (topNs[i] ?? "").trim();
    const roleId = (roleIds[i] ?? "").trim();
    if (!topNRaw && !roleId) continue;
    const row = `Row ${i + 1}`;
    if (!topNRaw) return { ok: false, error: `${row}: enter a Top N.` };
    if (!roleId) return { ok: false, error: `${row}: pick a role.` };
    if (!/^\d+$/.test(topNRaw)) {
      return {
        ok: false,
        error: `${row}: Top N must be a whole number greater than 0.`,
      };
    }
    const topN = Number(topNRaw);
    if (topN < 1 || topN > MAX_TIER_TOP_N) {
      return {
        ok: false,
        error: `${row}: Top N must be between 1 and ${MAX_TIER_TOP_N}.`,
      };
    }
    if (!ROLE_ID_RE.test(roleId)) {
      return { ok: false, error: `${row}: that is not a valid role.` };
    }
    if (seenTopN.has(topN)) {
      return {
        ok: false,
        error: `Top ${topN} is used by more than one tier. Each Top N must be unique.`,
      };
    }
    // The service tracks holders per role, so two tiers sharing a role would
    // grant and revoke it against each other on every run.
    if (seenRole.has(roleId)) {
      return {
        ok: false,
        error: `${row}: that role is already used by another tier. Each tier needs its own role.`,
      };
    }
    seenTopN.add(topN);
    seenRole.add(roleId);
    tiers.push({ topN, roleId });
  }
  if (tiers.length > MAX_TIERS) {
    return { ok: false, error: `At most ${MAX_TIERS} tiers are supported.` };
  }
  return { ok: true, tiers: tiers.sort((a, b) => a.topN - b.topN) };
}

/** The parts of a Discord role the assignability check reads. */
export interface TierRoleInfo {
  id: string;
  name: string;
  managed: boolean;
  position: number;
}

/**
 * Why the bot cannot hand out `role` as a tier reward, or null when it can.
 * `role` is null when the id no longer resolves in the guild;
 * `botHighestPosition` is null when the bot's own member could not be read,
 * in which case the hierarchy check is skipped rather than guessed.
 */
export function tierRoleProblem(
  role: TierRoleInfo | null,
  guildId: string,
  botHighestPosition: number | null,
): string | null {
  if (!role) return "that role no longer exists";
  if (role.id === guildId) return "@everyone cannot be a tier role";
  if (role.managed) {
    return `@${role.name} is managed by an integration and cannot be assigned`;
  }
  if (botHighestPosition !== null && role.position >= botHighestPosition) {
    return `@${role.name} sits at or above the bot's highest role, so the bot cannot assign it`;
  }
  return null;
}
