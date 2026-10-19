/**
 * The last bot permission check's result, kept in memory for the admin
 * navigation badge (#1217). Rendering a page never triggers a Discord read:
 * the check (`bot-permission-check.ts`) records how many enabled features are
 * affected, and the navigation shows that number. Nothing is stored.
 */

const counts = new Map<string, number>();

/** Record how many missing permissions affect enabled features in a server. */
export function setPermissionIssueCount(guildId: string, count: number): void {
  counts.set(guildId, count);
}

/** The last recorded count over every server (0 when no check has run yet). */
export function getPermissionIssueCount(): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

/** Test hook. */
export function resetPermissionIssueCount(): void {
  counts.clear();
}
