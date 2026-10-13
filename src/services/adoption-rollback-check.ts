import type { Guild } from "discord.js";
import { ServerScanService } from "./server-scan-service.js";
import {
  planAdoption,
  type DesiredRole,
  type DesiredState,
  type OverwriteState,
  type PlanOperation,
  type ScannedState,
} from "./server-adoption-planner.js";
import { remainingReversibleIds } from "./adoption-rollback-selection.js";
import type { AdoptionSnapshotRecord } from "./server-adoption-service.js";

/**
 * Live-state safety check for restoring an adoption snapshot (#1134).
 *
 * A snapshot can be up to `adoption.snapshot.retention_days` old, so putting
 * its saved role permissions and channel overwrites back could take away
 * access that was granted since the apply, and lock out the admin who clicks
 * Restore or the bot (the epic's rule, #1017). This builds the state a restore
 * would produce and hands it to the adoption planner against a *fresh* scan,
 * so the planner's own checks decide: the same admin-access, bot-lockout,
 * managed-role and above-the-bot-role rules the apply side uses, not a copy.
 * Nothing is written.
 *
 * What it compares: the live server now (a fresh scan, with the current
 * session user as the admin) against the server after the remaining reversible
 * operations are undone.
 *
 * Not covered, because the planner cannot express them: recreating a deleted
 * channel or role, revoking member role grants, and restoring settings. Those
 * do not take access away from the admin or the bot in the way the checked
 * steps can; the check only ever refuses, it never approves them.
 */

/** Planner error codes that mean "this restore is unsafe for the admin or the bot". */
export const SAFETY_CODES: ReadonlySet<string> = new Set([
  "admin-access-lost",
  "bot-lockout",
  "bot-lacks-permission",
  "role-protected",
  "role-position",
]);

export interface RestoreCheckOptions {
  /** The admin who clicked Restore; their access must survive. */
  actorId: string;
  /** The restore will also delete roles the plan created. */
  deleteCreatedRoles: boolean;
  /** Stamp for the approvals the planner needs for removals. */
  approvedAt: string;
}

/**
 * The desired end state of a restore, in the planner's vocabulary: prior role
 * values, prior overwrites (or their removal), and removal of created roles.
 * Ids saved in the snapshot are remapped to what exists now.
 */
export function buildRestoreDesired(
  snapshot: AdoptionSnapshotRecord,
  scanned: ScannedState,
  options: RestoreCheckOptions,
): DesiredState {
  const { plan, baseline } = snapshot;
  const remaining = new Set(
    remainingReversibleIds(
      snapshot.operations,
      (opId) => snapshot.memberProgress[opId]?.granted.length ?? 0,
      snapshot.rolledBackOps,
    ),
  );
  const mapChannel = (id: string): string =>
    snapshot.restoredChannels.find((c) => c.oldId === id)?.newId ?? id;
  const mapRole = (id: string): string =>
    snapshot.restoredRoles.find((r) => r.oldId === id)?.newId ??
    snapshot.createdRoles.find((r) => r.ref === id)?.roleId ??
    id;
  const liveRoles = new Map(scanned.roles.map((r) => [r.id, r]));
  const liveChannels = new Map(scanned.channels.map((c) => [c.id, c]));
  const priorOverwrite = (
    channelId: string,
    targetId: string,
  ): OverwriteState | undefined => {
    const found = baseline.channels
      .find((c) => c.id === channelId)
      ?.overwrites.find((o) => o.id === targetId);
    return found
      ? { ...found, id: found.type === "role" ? mapRole(found.id) : found.id }
      : undefined;
  };

  const desired: Required<
    Pick<
      DesiredState,
      "roles" | "overwrites" | "overwriteRemovals" | "deletions" | "approvals"
    >
  > = {
    roles: [],
    overwrites: [],
    overwriteRemovals: [],
    deletions: [],
    approvals: [],
  };
  const approve = (kind: "overwrite.remove" | "role.delete", id: string) =>
    desired.approvals.push({
      kind,
      targetId: id,
      approvedBy: options.actorId,
      approvedAt: options.approvedAt,
    });

  const restoreOverwrite = (
    op: Extract<PlanOperation, { type: "overwrite.set" | "overwrite.remove" }>,
  ): void => {
    const channelId = mapChannel(op.channelId);
    if (!liveChannels.has(channelId)) return; // gone: nothing to restore on
    const prior = priorOverwrite(op.channelId, op.overwriteTargetId);
    if (prior) {
      desired.overwrites.push({
        channelId,
        target: { id: prior.id },
        targetType: prior.type,
        allow: prior.allow,
        deny: prior.deny,
      });
    } else if (op.type === "overwrite.set") {
      // The plan added this overwrite; a restore removes it again.
      const targetId = mapRole(op.overwriteTargetId);
      desired.overwriteRemovals.push({ channelId, targetId });
      approve("overwrite.remove", `${channelId}:${targetId}`);
    }
  };

  for (const op of plan.operations) {
    if (!remaining.has(op.id)) continue;
    if (op.type === "role.edit") {
      const roleId = mapRole(op.roleId);
      const prior = baseline.roles.find((r) => r.id === op.roleId);
      const live = liveRoles.get(roleId);
      if (!prior || !live) continue;
      const want: DesiredRole = { id: roleId, name: live.name };
      if (op.changes.name !== undefined) want.name = prior.name;
      if (op.changes.color !== undefined) want.color = prior.color;
      if (op.changes.permissions !== undefined)
        want.permissions = prior.permissions;
      if (op.changes.position !== undefined) want.position = prior.position;
      desired.roles.push(want);
    } else if (op.type === "overwrite.set" || op.type === "overwrite.remove") {
      restoreOverwrite(op);
    } else if (op.type === "role.create" && options.deleteCreatedRoles) {
      const created = snapshot.createdRoles.find((r) => r.ref === op.ref);
      if (created && liveRoles.has(created.roleId)) {
        desired.deletions.push({ kind: "role", id: created.roleId });
        approve("role.delete", created.roleId);
      }
    }
  }
  return desired;
}

/**
 * Problems that make restoring this snapshot unsafe right now, as readable
 * messages. Empty means the check passed. Pure: pass in a fresh scan.
 */
export function restoreProblems(
  snapshot: AdoptionSnapshotRecord,
  scanned: ScannedState,
  options: RestoreCheckOptions,
): string[] {
  const desired = buildRestoreDesired(snapshot, scanned, options);
  const plan = planAdoption(scanned, desired, { approverId: options.actorId });
  return [
    ...new Set(
      plan.errors.filter((e) => SAFETY_CODES.has(e.code)).map((e) => e.message),
    ),
  ];
}

/**
 * The `RollbackOptions.revalidate` for a restore: scans the live guild with the
 * acting admin and runs `restoreProblems`. Re-run by the engine after it has
 * claimed the snapshot and before its first write.
 */
export function rollbackRevalidator(
  guild: Guild,
  load: () => Promise<AdoptionSnapshotRecord | null>,
  options: Omit<RestoreCheckOptions, "approvedAt">,
): () => Promise<string[]> {
  return async () => {
    const snapshot = await load();
    if (!snapshot) return ["the snapshot no longer exists"];
    const scan = await ServerScanService.getInstance(guild.client).scanGuild(
      guild,
      { adminUserId: options.actorId },
    );
    return restoreProblems(snapshot, scan.scanned, {
      ...options,
      approvedAt: new Date().toISOString(),
    });
  };
}
