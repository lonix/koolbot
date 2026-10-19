/**
 * Parsing of `leaderboard_roles.tiers` ("1:roleId,3:roleId,10:roleId") the way
 * `LeaderboardRoleService` reads it: malformed entries are skipped, and a
 * repeated Top N keeps its last role. Kept in a module of its own so the bot
 * permission check (#1217) reads exactly the tiers the service acts on.
 */

export interface ParsedTier {
  topN: number;
  roleId: string;
}

/**
 * @param onSkip called with a short reason for each skipped entry (the service
 *   logs it; the permission check ignores it).
 */
export function parseLeaderboardTiers(
  raw: string,
  onSkip: (message: string) => void = () => undefined,
): ParsedTier[] {
  if (!raw || raw.trim().length === 0) return [];

  const tiers: Map<number, string> = new Map();
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s);

  for (const entry of entries) {
    const parts = entry.split(":").map((p) => p.trim());
    if (parts.length !== 2) {
      onSkip(`Skipping malformed leaderboard tier entry: "${entry}"`);
      continue;
    }
    const topN = Number(parts[0]);
    const roleId = parts[1];
    if (!Number.isInteger(topN) || topN <= 0) {
      onSkip(
        `Skipping tier with invalid topN (must be positive integer): "${entry}"`,
      );
      continue;
    }
    if (!roleId || !/^\d+$/.test(roleId)) {
      onSkip(`Skipping tier with invalid Discord role ID: "${entry}"`);
      continue;
    }
    tiers.set(topN, roleId);
  }

  return Array.from(tiers.entries())
    .map(([topN, roleId]) => ({ topN, roleId }))
    .sort((a, b) => a.topN - b.topN);
}
