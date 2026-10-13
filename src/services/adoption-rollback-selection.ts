/**
 * Which operations of a snapshot a rollback reverts. One definition, shared by
 * the engine (`ServerAdoptionService.rollback`) and the history page's confirm
 * view, so the page can't promise a revert the engine won't do.
 */

export interface OperationOutcome {
  opId: string;
  status: string;
}

/**
 * Operations a rollback may revert: those that were applied, plus a member
 * operation that failed part-way but still has persisted grants to revoke.
 * `grantedCount` is the number of persisted grants for an operation.
 */
export function appliedOperationIds(
  operations: readonly OperationOutcome[],
  grantedCount: (opId: string) => number,
): Set<string> {
  return new Set(
    operations
      .filter((r) => r.status === "applied" || grantedCount(r.opId) > 0)
      .map((r) => r.opId),
  );
}

/** What is still left to revert: reversible and not already rolled back. */
export function remainingReversibleIds(
  operations: readonly OperationOutcome[],
  grantedCount: (opId: string) => number,
  rolledBackOps: readonly string[],
): string[] {
  const done = new Set(rolledBackOps);
  return [...appliedOperationIds(operations, grantedCount)].filter(
    (id) => !done.has(id),
  );
}

export interface BaselineChannelRefs {
  id: string;
  parentId: string | null;
  /** Ids of the role overwrites the channel had before the apply. */
  roleOverwriteIds: readonly string[];
}

/**
 * Follow-up repairs a rollback retries after the plan's own steps, recorded in
 * `rolledBackOps` under synthetic keys: `${channelId}:${oldRoleId}` (an
 * overwrite naming a recreated role) and `parent:${childId}` (a child of a
 * recreated category). Mirrors the two loops at the end of
 * `ServerAdoptionService.rollback`; they only exist once an earlier rollback
 * recreated a role or category. Returns the keys still pending.
 */
export function pendingDependentRepairs(input: {
  restoredRoleOldIds: readonly string[];
  restoredChannelOldIds: readonly string[];
  baselineChannels: readonly BaselineChannelRefs[];
  deletedChannelIds: readonly string[];
  rolledBackOps: readonly string[];
}): string[] {
  const done = new Set(input.rolledBackOps);
  const deleted = new Set(input.deletedChannelIds);
  const pending: string[] = [];
  for (const oldId of input.restoredRoleOldIds) {
    for (const channel of input.baselineChannels) {
      if (deleted.has(channel.id)) continue;
      const key = `${channel.id}:${oldId}`;
      if (channel.roleOverwriteIds.includes(oldId) && !done.has(key)) {
        pending.push(key);
      }
    }
  }
  for (const oldId of input.restoredChannelOldIds) {
    for (const child of input.baselineChannels) {
      if (child.parentId !== oldId || deleted.has(child.id)) continue;
      const key = `parent:${child.id}`;
      if (!done.has(key)) pending.push(key);
    }
  }
  return pending;
}
