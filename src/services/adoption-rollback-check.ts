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
import {
  pendingDependentRepairs,
  remainingReversibleIds,
} from "./adoption-rollback-selection.js";
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
 * Role grants a restore revokes are modelled for the two people who matter for
 * lockout, the acting admin and the bot (see `revokedRoleIds`).
 *
 * Not covered, because the planner cannot express them: recreating a deleted
 * channel or role, and restoring settings. Those do not take access away from
 * the admin or the bot in the way the checked steps can; the check only ever
 * refuses, it never approves them.
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
  return buildRestore(snapshot, scanned, options).desired;
}

/**
 * What the engine will write on the roles and overwrites, whether or not the
 * value already matches the live server. The planner drops a desired entry
 * that already matches, so these are passed separately to its capability and
 * hierarchy checks (`rollbackEditedRoleIds`, `forceManageRoles`).
 */
interface RestoreTouches {
  roleEditIds: string[];
  writesRoles: boolean;
}

function buildRestore(
  snapshot: AdoptionSnapshotRecord,
  scanned: ScannedState,
  options: RestoreCheckOptions,
): {
  desired: Required<
    Pick<
      DesiredState,
      "roles" | "overwrites" | "overwriteRemovals" | "deletions" | "approvals"
    >
  >;
  touches: RestoreTouches;
} {
  const touches: RestoreTouches = { roleEditIds: [], writesRoles: false };
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
    // The engine writes (setOverwrite) or removes (removeOverwrite) here
    // unconditionally; only an overwrite.remove with nothing saved is a no-op.
    if (prior || op.type === "overwrite.set") touches.writesRoles = true;
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
      touches.roleEditIds.push(roleId);
      touches.writesRoles = true;
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

  // A role creation that was interrupted (started, never recorded as finished)
  // is only promoted to applied by the engine's reconcile, which runs *after*
  // this check. With "delete created roles" ticked it may then delete the role
  // it finds, so judge every live role that could be that role now: same name,
  // colour and permissions as the planned one. Conservative on purpose: a
  // lookalike that is not ours is judged too (and may refuse), never skipped.
  if (options.deleteCreatedRoles) {
    const recorded = new Map(
      snapshot.operations.map((r) => [r.opId, r] as const),
    );
    const sameBits = (a: string, b: string): boolean => {
      try {
        return BigInt(a) === BigInt(b);
      } catch {
        return false;
      }
    };
    for (const op of plan.operations) {
      if (op.type !== "role.create" || remaining.has(op.id)) continue;
      if (snapshot.rolledBackOps.includes(op.id)) continue;
      const record = recorded.get(op.id);
      if (!record || record.status === "applied" || !record.startedAt) continue;
      if (snapshot.createdRoles.some((r) => r.ref === op.ref)) continue;
      const name = op.name.trim().toLowerCase();
      for (const live of scanned.roles) {
        if (
          live.name.trim().toLowerCase() === name &&
          live.color === op.color &&
          sameBits(live.permissions, op.permissions) &&
          !desired.deletions.some((d) => d.id === live.id)
        ) {
          desired.deletions.push({ kind: "role", id: live.id });
          approve("role.delete", live.id);
        }
      }
    }
  }

  // Follow-up repairs an earlier, partly finished restore still owes: the
  // engine puts the saved overwrite back on every surviving channel for each
  // role it recreated, unless that repair is already recorded as done. Same
  // definition as the confirm page (`pendingDependentRepairs`). Re-parenting
  // children of a recreated category is not modelled: the planner has no
  // channel moves, and a move only changes access through permission sync.
  const pending = pendingDependentRepairs({
    restoredRoleOldIds: snapshot.restoredRoles.map((r) => r.oldId),
    restoredChannelOldIds: snapshot.restoredChannels.map((c) => c.oldId),
    baselineChannels: baseline.channels.map((c) => ({
      id: c.id,
      parentId: c.parentId,
      roleOverwriteIds: c.overwrites
        .filter((o) => o.type === "role")
        .map((o) => o.id),
    })),
    deletedChannelIds: plan.operations.flatMap((o) =>
      o.type === "channel.delete" ? [o.channelId] : [],
    ),
    rolledBackOps: snapshot.rolledBackOps,
  });
  for (const key of pending) {
    if (key.startsWith("parent:")) continue;
    const cut = key.indexOf(":");
    const channelId = key.slice(0, cut);
    const oldRoleId = key.slice(cut + 1);
    const prior = baseline.channels
      .find((c) => c.id === channelId)
      ?.overwrites.find((o) => o.id === oldRoleId);
    const live = mapChannel(channelId);
    if (!prior || !liveChannels.has(live)) continue;
    touches.writesRoles = true;
    desired.overwrites.push({
      channelId: live,
      target: { id: mapRole(oldRoleId) },
      targetType: "role",
      allow: prior.allow,
      deny: prior.deny,
    });
  }
  return { desired, touches };
}

/**
 * Roles the restore will revoke from the acting admin or the bot: for every
 * step still to be reverted that granted a role to members, whether the admin
 * or the bot is among the members it granted. Only these two matter for
 * lockout, so only these two are looked for; the member ids are tested for
 * membership here and never copied anywhere.
 *
 * `inflight` ids count too: reconcile may promote them to granted at restore
 * time, so assuming they are ours is the conservative reading. Returns `null`
 * when the saved grant data cannot be read, which the caller treats as unsafe.
 */
export function revokedRoleIds(
  snapshot: AdoptionSnapshotRecord,
  scanned: ScannedState,
  options: RestoreCheckOptions,
): { admin: string[]; bot: string[]; all: string[] } | null {
  // Anything that is not the shape the engine reads (`state.granted.length`)
  // is unreadable: refuse rather than treat it as "no grants".
  const progressAll: unknown = snapshot.memberProgress ?? {};
  if (!isPlainObject(progressAll)) return null;
  const mapRole = (id: string): string =>
    snapshot.restoredRoles.find((r) => r.oldId === id)?.newId ??
    snapshot.createdRoles.find((r) => r.ref === id)?.roleId ??
    id;
  const admin = new Set<string>();
  const bot = new Set<string>();
  const all = new Set<string>();
  for (const op of snapshot.plan.operations) {
    if (op.type !== "member.role.add") continue;
    // An operation whose revoke already finished is not revisited.
    if (snapshot.rolledBackOps.includes(op.id)) continue;
    if (!(op.id in progressAll)) continue; // nothing was granted
    const progress: unknown = progressAll[op.id];
    if (!isPlainObject(progress)) return null;
    const granted: unknown = progress.granted;
    const inflight: unknown = progress.inflight ?? [];
    if (!Array.isArray(granted) || !Array.isArray(inflight)) return null;
    if (granted.length + inflight.length === 0) continue; // nothing to revoke
    const ids = new Set<unknown>([...granted, ...inflight]);
    const roleId = mapRole(op.roleId);
    all.add(roleId);
    if (ids.has(options.actorId)) admin.add(roleId);
    if (ids.has(scanned.botUserId)) bot.add(roleId);
  }
  return { admin: [...admin], bot: [...bot], all: [...all] };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Problems that make restoring this snapshot unsafe right now, as readable
 * messages. Empty means the check passed. Pure: pass in a fresh scan.
 */
export function restoreProblems(
  snapshot: AdoptionSnapshotRecord,
  scanned: ScannedState,
  options: RestoreCheckOptions,
): string[] {
  const revoked = revokedRoleIds(snapshot, scanned, options);
  if (revoked === null) {
    // Fail closed: if who was granted what can't be read, safety can't be shown.
    return [
      "the saved role grants could not be read, so the restore can't be checked",
    ];
  }
  const { desired, touches } = buildRestore(snapshot, scanned, options);
  const plan = planAdoption(scanned, desired, {
    approverId: options.actorId,
    rollbackEditedRoleIds: touches.roleEditIds,
    forceManageRoles: touches.writesRoles,
    revokedAdminRoleIds: revoked.admin,
    revokedBotRoleIds: revoked.bot,
    revokedGrantRoleIds: revoked.all,
  });
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
