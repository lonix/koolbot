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
