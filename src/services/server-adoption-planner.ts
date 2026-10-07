import { createHash } from "node:crypto";
import { PermissionsBitField } from "discord.js";
import { defaultConfig } from "./config-schema.js";

/**
 * Pure planner for server adoption (#1018).
 *
 * `planAdoption(scanned, desired)` diffs a desired state against a scanned
 * one and returns an ordered list of typed operations plus warnings and
 * blocking errors. It performs no Discord or database access, so every safety
 * rule is unit-testable. `server-adoption-service.ts` applies a plan.
 *
 * Rules the planner enforces (all reported as blocking errors):
 *
 * - **Non-destructive by nature.** Operations are additive/reversible
 *   (create, add or edit an overwrite or role, write a config key — all
 *   snapshotted) or destructive (delete a pre-existing channel or role,
 *   remove an existing overwrite). A destructive operation needs an explicit
 *   approval record naming its exact target; "apply all" never approves one.
 * - **Never, even with approval:** editing or deleting managed roles or roles
 *   at/above the bot's highest, deleting the bot's own roles, removing the
 *   invoking admin's own access, locking the bot out of a channel a feature
 *   needs, deleting a channel that is in use (voice members present, or bound
 *   to a KoolBot feature), and touching another bot's overwrites unless the
 *   caller opts in.
 * - Things KoolBot created itself (`koolbotCreatedIds`) are deletable
 *   without approval.
 *
 * Planning against a state that already matches yields an empty plan.
 */

export type OperationClass = "additive" | "destructive";

export interface RoleState {
  id: string;
  name: string;
  color: number;
  /** Permission bitfield as a decimal string (Discord's wire format). */
  permissions: string;
  position: number;
  managed: boolean;
}

export interface OverwriteState {
  id: string;
  type: "role" | "member";
  allow: string;
  deny: string;
}

export type ChannelKind = "category" | "text" | "voice" | "other";

export interface ChannelState {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Raw Discord channel type, kept so a rollback can recreate the channel. */
  rawType?: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  overwrites: OverwriteState[];
  /** Members currently connected (voice channels). */
  voiceMemberCount: number;
}

export type ConfigValue = string | number | boolean;

export interface ScannedState {
  guildId: string;
  ownerId: string;
  botUserId: string;
  botRoleIds: string[];
  botHighestRolePosition: number;
  /** The admin running the adoption. */
  adminUserId: string;
  adminRoleIds: string[];
  /** Member ids of other bots in the guild. */
  otherBotIds: string[];
  roles: RoleState[];
  channels: ChannelState[];
  config: Record<string, ConfigValue | undefined>;
  /** Channels currently bound to a KoolBot feature (never deletable). */
  boundChannelIds: string[];
  /** Roles/channels KoolBot created itself: deletable without approval. */
  koolbotCreatedIds: string[];
  /** memberId → role ids. Only needed for member operations. */
  memberRoles?: Record<string, string[]>;
}

export type TargetRef = { id: string } | { roleName: string };

export interface DesiredRole {
  /** Match an existing role by id; otherwise by case-insensitive name. */
  id?: string;
  name: string;
  color?: number;
  permissions?: string;
  position?: number;
}

export interface DesiredOverwrite {
  channelId: string;
  target: TargetRef;
  /** Defaults to "role"; set "member" for a user id. */
  targetType?: "role" | "member";
  allow: string;
  deny: string;
}

export interface DesiredOverwriteRemoval {
  channelId: string;
  targetId: string;
}

export interface DesiredDeletion {
  kind: "channel" | "role";
  id: string;
}

export interface DesiredMemberGrant {
  role: TargetRef;
  memberIds: string[];
}

export interface FeatureChannel {
  channelId: string;
  feature: string;
  /** Permissions the bot needs there; defaults to ViewChannel. */
  permissions?: string;
}

export type ApprovalKind =
  "channel.delete" | "role.delete" | "overwrite.remove";

export interface DestructiveApproval {
  kind: ApprovalKind;
  /** Role/channel id, or `${channelId}:${targetId}` for overwrite.remove. */
  targetId: string;
  approvedBy: string;
  approvedAt: string;
}

export interface DesiredState {
  roles?: DesiredRole[];
  overwrites?: DesiredOverwrite[];
  overwriteRemovals?: DesiredOverwriteRemoval[];
  deletions?: DesiredDeletion[];
  memberGrants?: DesiredMemberGrant[];
  config?: Record<string, ConfigValue>;
  featureChannels?: FeatureChannel[];
  approvals?: DestructiveApproval[];
}

export interface PlanOptions {
  /** Allow touching overwrites that belong to other bots. Default false. */
  allowOtherBotOverwrites?: boolean;
  /**
   * The authenticated admin applying the plan. A destructive approval only
   * counts when `approvedBy` is this user; defaults to the scanned
   * `adminUserId`.
   */
  approverId?: string;
}

interface OpBase {
  id: string;
  class: OperationClass;
  summary: string;
  targetId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface RoleCreateOp extends OpBase {
  type: "role.create";
  /** `new:<lowercase name>` — what later operations use to refer to it. */
  ref: string;
  name: string;
  color: number;
  permissions: string;
  position: number | null;
}
export interface RoleEditOp extends OpBase {
  type: "role.edit";
  roleId: string;
  changes: Partial<
    Pick<RoleState, "name" | "color" | "permissions" | "position">
  >;
}
export interface OverwriteSetOp extends OpBase {
  type: "overwrite.set";
  channelId: string;
  /** A role id, member id, or a `new:` ref resolved at apply time. */
  overwriteTargetId: string;
  overwriteTargetType: "role" | "member";
  allow: string;
  deny: string;
}
export interface MemberRoleAddOp extends OpBase {
  type: "member.role.add";
  roleId: string;
  memberCount: number;
  sample: string[];
  memberIds: string[];
}
export interface ConfigSetOp extends OpBase {
  type: "config.set";
  key: string;
  value: ConfigValue;
  previous: ConfigValue | null;
}
export interface OverwriteRemoveOp extends OpBase {
  type: "overwrite.remove";
  channelId: string;
  overwriteTargetId: string;
  approval?: DestructiveApproval;
}
export interface ChannelDeleteOp extends OpBase {
  type: "channel.delete";
  channelId: string;
  approval?: DestructiveApproval;
}
export interface RoleDeleteOp extends OpBase {
  type: "role.delete";
  roleId: string;
  approval?: DestructiveApproval;
}

export type PlanOperation =
  | RoleCreateOp
  | RoleEditOp
  | OverwriteSetOp
  | MemberRoleAddOp
  | ConfigSetOp
  | OverwriteRemoveOp
  | ChannelDeleteOp
  | RoleDeleteOp;

export interface PlanIssue {
  code: string;
  message: string;
  targetId?: string;
}

/** Prior state of everything the plan touches; the snapshot is built from it. */
export interface PlanBaseline {
  roles: RoleState[];
  channels: ChannelState[];
  config: Record<string, ConfigValue | null>;
}

export interface AdoptionPlan {
  /** Content hash: the same inputs always yield the same id. */
  id: string;
  guildId: string;
  operations: PlanOperation[];
  warnings: PlanIssue[];
  errors: PlanIssue[];
  baseline: PlanBaseline;
}

export const PHASE_ORDER: Record<PlanOperation["type"], number> = {
  "role.create": 0,
  "role.edit": 1,
  "overwrite.set": 2, // categories before channels, see `phaseOf`
  "member.role.add": 4,
  "config.set": 5,
  "overwrite.remove": 6,
  "channel.delete": 6,
  "role.delete": 6,
};

const { ViewChannel, Administrator } = PermissionsBitField.Flags;
const ALL_PERMISSIONS = PermissionsBitField.All;

/** Readable names for a permission bitfield, for the diff view. */
export function permissionNames(bits: string): string[] {
  try {
    return new PermissionsBitField(BigInt(bits)).toArray();
  } catch {
    return [];
  }
}

export function isApplicable(plan: AdoptionPlan): boolean {
  return plan.errors.length === 0;
}

function big(value: string | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

/** Effective permissions of a member in a channel (Discord's algorithm). */
export function effectivePermissions(opts: {
  userId: string;
  roleIds: string[];
  ownerId: string;
  everyoneId: string;
  rolePermissions: Map<string, bigint>;
  overwrites?: OverwriteState[];
}): bigint {
  if (opts.userId === opts.ownerId) return ALL_PERMISSIONS;
  let perms = opts.rolePermissions.get(opts.everyoneId) ?? 0n;
  for (const id of opts.roleIds) perms |= opts.rolePermissions.get(id) ?? 0n;
  if ((perms & Administrator) === Administrator) return ALL_PERMISSIONS;
  const overwrites = opts.overwrites;
  if (!overwrites) return perms;
  const roleSet = new Set(opts.roleIds);
  const everyone = overwrites.find((o) => o.id === opts.everyoneId);
  if (everyone) perms = (perms & ~big(everyone.deny)) | big(everyone.allow);
  let deny = 0n;
  let allow = 0n;
  for (const o of overwrites) {
    if (o.type === "role" && roleSet.has(o.id)) {
      deny |= big(o.deny);
      allow |= big(o.allow);
    }
  }
  perms = (perms & ~deny) | allow;
  const member = overwrites.find(
    (o) => o.type === "member" && o.id === opts.userId,
  );
  if (member) perms = (perms & ~big(member.deny)) | big(member.allow);
  return perms;
}

function sameOverwrite(
  a: OverwriteState,
  allow: string,
  deny: string,
): boolean {
  return big(a.allow) === big(allow) && big(a.deny) === big(deny);
}

function refFor(name: string): string {
  return `new:${name.trim().toLowerCase()}`;
}

interface SimRole {
  id: string;
  permissions: bigint;
}

/** What the guild looks like once the planned operations have run. */
function simulate(
  scanned: ScannedState,
  ops: PlanOperation[],
): {
  rolePermissions: Map<string, bigint>;
  channels: Map<string, OverwriteState[]>;
  removedRoles: Set<string>;
} {
  const roles = new Map<string, SimRole>(
    scanned.roles.map((r) => [
      r.id,
      { id: r.id, permissions: big(r.permissions) },
    ]),
  );
  const channels = new Map<string, OverwriteState[]>(
    scanned.channels.map((c) => [c.id, c.overwrites.map((o) => ({ ...o }))]),
  );
  const removedRoles = new Set<string>();
  for (const op of ops) {
    if (op.type === "role.create") {
      roles.set(op.ref, { id: op.ref, permissions: big(op.permissions) });
    } else if (
      op.type === "role.edit" &&
      op.changes.permissions !== undefined
    ) {
      const r = roles.get(op.roleId);
      if (r) r.permissions = big(op.changes.permissions);
    } else if (op.type === "role.delete") {
      roles.delete(op.roleId);
      removedRoles.add(op.roleId);
    } else if (op.type === "overwrite.set") {
      const list = channels.get(op.channelId);
      if (!list) continue;
      const i = list.findIndex((o) => o.id === op.overwriteTargetId);
      const next = {
        id: op.overwriteTargetId,
        type: op.overwriteTargetType,
        allow: op.allow,
        deny: op.deny,
      };
      if (i >= 0) list[i] = next;
      else list.push(next);
    } else if (op.type === "overwrite.remove") {
      const list = channels.get(op.channelId);
      if (!list) continue;
      channels.set(
        op.channelId,
        list.filter((o) => o.id !== op.overwriteTargetId),
      );
    } else if (op.type === "channel.delete") {
      channels.delete(op.channelId);
    }
  }
  const rolePermissions = new Map<string, bigint>(
    [...roles.values()].map((r) => [r.id, r.permissions]),
  );
  return { rolePermissions, channels, removedRoles };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

function sameConfig(a: ConfigValue | undefined, b: ConfigValue): boolean {
  return a !== undefined && String(a) === String(b);
}

function approvalFor(
  desired: DesiredState,
  kind: ApprovalKind,
  targetId: string,
  approverId: string,
): DestructiveApproval | undefined {
  return (desired.approvals ?? []).find(
    (a) =>
      a.kind === kind &&
      a.targetId === targetId &&
      a.approvedBy === approverId &&
      !Number.isNaN(Date.parse(a.approvedAt)),
  );
}

export function planAdoption(
  scanned: ScannedState,
  desired: DesiredState,
  options: PlanOptions = {},
): AdoptionPlan {
  const warnings: PlanIssue[] = [];
  const errors: PlanIssue[] = [];
  const ops: PlanOperation[] = [];
  const everyoneId = scanned.guildId;

  const rolesById = new Map(scanned.roles.map((r) => [r.id, r]));
  const rolesByName = new Map<string, RoleState>();
  for (const r of scanned.roles) {
    const key = r.name.trim().toLowerCase();
    if (!rolesByName.has(key)) rolesByName.set(key, r);
  }
  const channelsById = new Map(scanned.channels.map((c) => [c.id, c]));
  const botRoleSet = new Set(scanned.botRoleIds);
  const otherBots = new Set(scanned.otherBotIds);
  const createdByUs = new Set(scanned.koolbotCreatedIds);
  const boundChannels = new Set(scanned.boundChannelIds);
  const creating = new Set<string>();

  const botBase = effectivePermissions({
    userId: scanned.botUserId,
    roleIds: scanned.botRoleIds,
    ownerId: scanned.ownerId,
    everyoneId,
    rolePermissions: new Map(
      scanned.roles.map((r) => [r.id, big(r.permissions)]),
    ),
  });

  const touchedRoles = new Set<string>();
  const touchedChannels = new Set<string>();
  const baselineConfig: Record<string, ConfigValue | null> = {};

  const err = (code: string, message: string, targetId?: string): number =>
    errors.push({ code, message, targetId });
  const warn = (code: string, message: string, targetId?: string): number =>
    warnings.push({ code, message, targetId });

  const isOtherBotTarget = (id: string): boolean => {
    if (otherBots.has(id)) return true;
    const role = rolesById.get(id);
    return !!role && role.managed && !botRoleSet.has(id);
  };

  const roleLimitProblem = (role: RoleState, verb: string): string | null => {
    if (role.id === everyoneId) return null;
    if (role.managed)
      return `Cannot ${verb} "${role.name}": it is a managed (bot/integration) role.`;
    if (role.position >= scanned.botHighestRolePosition)
      return `Cannot ${verb} "${role.name}": it sits at or above the bot's highest role.`;
    return null;
  };

  const resolveRole = (
    ref: TargetRef,
  ): { id: string; existing: RoleState | null } | null => {
    if ("id" in ref) {
      const role = rolesById.get(ref.id);
      if (role) return { id: ref.id, existing: role };
      return creating.has(ref.id) ? { id: ref.id, existing: null } : null;
    }
    const found = rolesByName.get(ref.roleName.trim().toLowerCase());
    if (found) return { id: found.id, existing: found };
    const r = refFor(ref.roleName);
    return creating.has(r) ? { id: r, existing: null } : null;
  };

  // ---- roles ---------------------------------------------------------
  for (const want of desired.roles ?? []) {
    const existing =
      (want.id && rolesById.get(want.id)) ||
      rolesByName.get(want.name.trim().toLowerCase()) ||
      null;
    if (!existing) {
      const permissions = want.permissions ?? "0";
      if (
        want.position !== undefined &&
        want.position >= scanned.botHighestRolePosition
      )
        err(
          "role-position",
          `Cannot create "${want.name}" at or above the bot's highest role.`,
        );
      const missing = big(permissions) & ~botBase;
      if (missing !== 0n)
        err(
          "bot-lacks-permission",
          `The bot cannot grant permissions it does not hold (role "${want.name}").`,
        );
      const ref = refFor(want.name);
      creating.add(ref);
      ops.push({
        id: "",
        type: "role.create",
        class: "additive",
        ref,
        name: want.name,
        color: want.color ?? 0,
        permissions,
        position: want.position ?? null,
        summary: `Create role "${want.name}"`,
        targetId: ref,
        before: null,
        after: {
          name: want.name,
          color: want.color ?? 0,
          permissions,
          position: want.position ?? null,
        },
      });
      continue;
    }
    const changes: RoleEditOp["changes"] = {};
    if (want.name.trim() !== existing.name.trim() && want.id)
      changes.name = want.name;
    if (want.color !== undefined && want.color !== existing.color)
      changes.color = want.color;
    if (
      want.permissions !== undefined &&
      big(want.permissions) !== big(existing.permissions)
    )
      changes.permissions = want.permissions;
    if (want.position !== undefined && want.position !== existing.position)
      changes.position = want.position;
    if (Object.keys(changes).length === 0) continue;

    const problem = roleLimitProblem(existing, "edit");
    if (problem) err("role-protected", problem, existing.id);
    if (
      changes.position !== undefined &&
      changes.position >= scanned.botHighestRolePosition
    )
      err(
        "role-position",
        `Cannot move "${existing.name}" to or above the bot's highest role.`,
        existing.id,
      );
    if (changes.permissions !== undefined) {
      const added =
        big(changes.permissions) & ~big(existing.permissions) & ~botBase;
      if (added !== 0n)
        err(
          "bot-lacks-permission",
          `The bot cannot grant permissions it does not hold (role "${existing.name}").`,
          existing.id,
        );
    }
    touchedRoles.add(existing.id);
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(changes) as Array<keyof typeof changes>)
      before[k] = existing[k];
    ops.push({
      id: "",
      type: "role.edit",
      class: "additive",
      roleId: existing.id,
      changes,
      summary: `Edit role "${existing.name}"`,
      targetId: existing.id,
      before,
      after: { ...changes },
    });
  }

  // ---- overwrites ----------------------------------------------------
  for (const want of desired.overwrites ?? []) {
    const channel = channelsById.get(want.channelId);
    if (!channel) {
      err(
        "unknown-channel",
        `Channel ${want.channelId} was not found.`,
        want.channelId,
      );
      continue;
    }
    let targetId: string;
    let targetType: "role" | "member" = want.targetType ?? "role";
    if ("roleName" in want.target) {
      const resolved = resolveRole(want.target);
      if (!resolved) {
        err(
          "unknown-role",
          `Role "${want.target.roleName}" does not exist and is not planned.`,
        );
        continue;
      }
      targetId = resolved.id;
      targetType = "role";
    } else {
      targetId = want.target.id;
    }
    const existing = channel.overwrites.find((o) => o.id === targetId);
    if (
      existing
        ? sameOverwrite(existing, want.allow, want.deny)
        : big(want.allow) === 0n && big(want.deny) === 0n
    )
      continue;
    if (big(want.allow) & big(want.deny))
      warn(
        "overwrite-conflict",
        `Allow and deny overlap on "${channel.name}"; Discord resolves this as allow.`,
        channel.id,
      );
    if (isOtherBotTarget(targetId) && !options.allowOtherBotOverwrites) {
      err(
        "other-bot-overwrite",
        `"${channel.name}" has an overwrite that belongs to another bot; it is preserved unless you opt in.`,
        channel.id,
      );
      continue;
    }
    touchedChannels.add(channel.id);
    ops.push({
      id: "",
      type: "overwrite.set",
      class: "additive",
      channelId: channel.id,
      overwriteTargetId: targetId,
      overwriteTargetType: targetType,
      allow: want.allow,
      deny: want.deny,
      summary: `${existing ? "Edit" : "Add"} overwrite on "${channel.name}"`,
      targetId: channel.id,
      before: existing ? { allow: existing.allow, deny: existing.deny } : null,
      after: { allow: want.allow, deny: want.deny },
    });
  }

  // ---- member grants -------------------------------------------------
  for (const grant of desired.memberGrants ?? []) {
    const resolved = resolveRole(grant.role);
    if (!resolved) {
      err(
        "unknown-role",
        "A member grant refers to a role that does not exist and is not planned.",
      );
      continue;
    }
    if (resolved.existing) {
      const problem = roleLimitProblem(resolved.existing, "grant");
      if (problem) {
        err("role-protected", problem, resolved.id);
        continue;
      }
    }
    const holders = scanned.memberRoles;
    const missing = grant.memberIds.filter(
      (id) => !holders || !(holders[id] ?? []).includes(resolved.id),
    );
    if (missing.length === 0) continue;
    ops.push({
      id: "",
      type: "member.role.add",
      class: "additive",
      roleId: resolved.id,
      memberCount: missing.length,
      sample: missing.slice(0, 5),
      memberIds: missing,
      summary: `Grant a role to ${missing.length} member(s)`,
      targetId: resolved.id,
      before: null,
      after: { members: missing.length },
    });
  }

  // ---- config --------------------------------------------------------
  for (const [key, value] of Object.entries(desired.config ?? {})) {
    if (!(key in defaultConfig)) {
      err("unknown-config-key", `"${key}" is not a KoolBot setting.`, key);
      continue;
    }
    const current = scanned.config[key];
    if (sameConfig(current, value)) continue;
    baselineConfig[key] = current ?? null;
    ops.push({
      id: "",
      type: "config.set",
      class: "additive",
      key,
      value,
      previous: current ?? null,
      summary: `Set ${key}`,
      targetId: key,
      before: { value: current ?? null },
      after: { value },
    });
  }

  // ---- destructive ---------------------------------------------------
  const requireApproval = (
    kind: ApprovalKind,
    targetId: string,
    label: string,
  ): { ok: boolean; approval?: DestructiveApproval } => {
    if (createdByUs.has(targetId.split(":").pop() ?? targetId))
      return { ok: true };
    const approval = approvalFor(
      desired,
      kind,
      targetId,
      options.approverId ?? scanned.adminUserId,
    );
    if (!approval) {
      err(
        "approval-required",
        `${label} is destructive and needs an explicit admin approval for this exact target.`,
        targetId,
      );
      return { ok: false };
    }
    return { ok: true, approval };
  };

  for (const del of desired.deletions ?? []) {
    if (del.kind === "channel") {
      const channel = channelsById.get(del.id);
      if (!channel) continue; // already gone: idempotent
      if (boundChannels.has(channel.id)) {
        err(
          "channel-in-use",
          `"${channel.name}" is bound to a KoolBot feature and can't be deleted.`,
          channel.id,
        );
        continue;
      }
      if (channel.voiceMemberCount > 0) {
        err(
          "channel-in-use",
          `"${channel.name}" has members connected and can't be deleted.`,
          channel.id,
        );
        continue;
      }
      if (
        (desired.featureChannels ?? []).some((f) => f.channelId === channel.id)
      ) {
        err(
          "channel-in-use",
          `"${channel.name}" is needed by a feature and can't be deleted.`,
          channel.id,
        );
        continue;
      }
      const gate = requireApproval(
        "channel.delete",
        channel.id,
        `Deleting "${channel.name}"`,
      );
      if (!gate.ok) continue;
      touchedChannels.add(channel.id);
      ops.push({
        id: "",
        type: "channel.delete",
        class: "destructive",
        channelId: channel.id,
        approval: gate.approval,
        summary: `Delete ${channel.kind} "${channel.name}"`,
        targetId: channel.id,
        before: { name: channel.name, kind: channel.kind },
        after: null,
      });
    } else {
      const role = rolesById.get(del.id);
      if (!role) continue;
      if (role.id === everyoneId) {
        err("role-protected", "The @everyone role can't be deleted.", role.id);
        continue;
      }
      if (botRoleSet.has(role.id)) {
        err(
          "role-protected",
          `"${role.name}" is one of the bot's own roles and can't be deleted.`,
          role.id,
        );
        continue;
      }
      const problem = roleLimitProblem(role, "delete");
      if (problem) {
        err("role-protected", problem, role.id);
        continue;
      }
      const gate = requireApproval(
        "role.delete",
        role.id,
        `Deleting role "${role.name}"`,
      );
      if (!gate.ok) continue;
      touchedRoles.add(role.id);
      // Deleting a role also deletes its channel overwrites; snapshot them so
      // a rollback can put them back on the recreated role.
      for (const c of scanned.channels) {
        if (c.overwrites.some((o) => o.id === role.id))
          touchedChannels.add(c.id);
      }
      ops.push({
        id: "",
        type: "role.delete",
        class: "destructive",
        roleId: role.id,
        approval: gate.approval,
        summary: `Delete role "${role.name}"`,
        targetId: role.id,
        before: { name: role.name, permissions: role.permissions },
        after: null,
      });
    }
  }

  for (const rem of desired.overwriteRemovals ?? []) {
    const channel = channelsById.get(rem.channelId);
    const existing = channel?.overwrites.find((o) => o.id === rem.targetId);
    if (!channel || !existing) continue; // nothing to remove: idempotent
    if (isOtherBotTarget(rem.targetId) && !options.allowOtherBotOverwrites) {
      err(
        "other-bot-overwrite",
        `"${channel.name}" has an overwrite that belongs to another bot; it is preserved unless you opt in.`,
        channel.id,
      );
      continue;
    }
    const key = `${channel.id}:${rem.targetId}`;
    const gate = requireApproval(
      "overwrite.remove",
      key,
      `Removing an overwrite on "${channel.name}"`,
    );
    if (!gate.ok) continue;
    touchedChannels.add(channel.id);
    ops.push({
      id: "",
      type: "overwrite.remove",
      class: "destructive",
      channelId: channel.id,
      overwriteTargetId: rem.targetId,
      approval: gate.approval,
      summary: `Remove overwrite on "${channel.name}"`,
      targetId: channel.id,
      before: { allow: existing.allow, deny: existing.deny },
      after: null,
    });
  }

  // ---- ordering ------------------------------------------------------
  const phaseOf = (op: PlanOperation): number => {
    if (op.type === "overwrite.set") {
      return channelsById.get(op.channelId)?.kind === "category" ? 2 : 3;
    }
    return PHASE_ORDER[op.type];
  };
  const ordered = ops
    .map((op, index) => ({ op, index }))
    .sort((a, b) => phaseOf(a.op) - phaseOf(b.op) || a.index - b.index)
    .map(({ op }, i) => ({ ...op, id: `op-${i + 1}` }) as PlanOperation);

  // ---- admin / bot access (simulated after-state) ----------------------
  if (ordered.length > 0) {
    const before = simulate(scanned, []);
    const after = simulate(scanned, ordered);
    const adminRoles = scanned.adminRoleIds.filter(
      (id) => !after.removedRoles.has(id),
    );
    const botRoles = scanned.botRoleIds.filter(
      (id) => !after.removedRoles.has(id),
    );
    const check = (
      userId: string,
      roleIdsBefore: string[],
      roleIdsAfter: string[],
      channelId: string,
      perms: bigint,
    ): { had: boolean; has: boolean } => {
      const args = { userId, ownerId: scanned.ownerId, everyoneId };
      const had =
        (effectivePermissions({
          ...args,
          roleIds: roleIdsBefore,
          rolePermissions: before.rolePermissions,
          overwrites: before.channels.get(channelId),
        }) &
          perms) ===
        perms;
      const has =
        (effectivePermissions({
          ...args,
          roleIds: roleIdsAfter,
          rolePermissions: after.rolePermissions,
          overwrites: after.channels.get(channelId),
        }) &
          perms) ===
        perms;
      return { had, has };
    };

    for (const channel of scanned.channels) {
      if (!after.channels.has(channel.id)) continue; // deleted
      const a = check(
        scanned.adminUserId,
        scanned.adminRoleIds,
        adminRoles,
        channel.id,
        ViewChannel,
      );
      if (a.had && !a.has)
        err(
          "admin-access-lost",
          `This change would remove your own access to "${channel.name}".`,
          channel.id,
        );
    }
    // An admin who held Administrator and no longer would is locked out wholesale.
    const adminBefore = effectivePermissions({
      userId: scanned.adminUserId,
      roleIds: scanned.adminRoleIds,
      ownerId: scanned.ownerId,
      everyoneId,
      rolePermissions: before.rolePermissions,
    });
    const adminAfter = effectivePermissions({
      userId: scanned.adminUserId,
      roleIds: adminRoles,
      ownerId: scanned.ownerId,
      everyoneId,
      rolePermissions: after.rolePermissions,
    });
    if (
      (adminBefore & Administrator) === Administrator &&
      (adminAfter & Administrator) !== Administrator
    )
      err(
        "admin-access-lost",
        "This change would remove your own Administrator permission.",
      );

    for (const feature of desired.featureChannels ?? []) {
      const channel = channelsById.get(feature.channelId);
      if (!channel) continue;
      const needed = feature.permissions
        ? big(feature.permissions)
        : ViewChannel;
      if (!after.channels.has(channel.id)) continue;
      const b = check(
        scanned.botUserId,
        scanned.botRoleIds,
        botRoles,
        channel.id,
        needed,
      );
      if (b.had && !b.has)
        err(
          "bot-lockout",
          `This change would lock the bot out of "${channel.name}", which the ${feature.feature} feature needs.`,
          channel.id,
        );
      else if (!b.had && !b.has && touchedChannels.has(channel.id))
        warn(
          "bot-already-locked-out",
          `The bot already lacks access to "${channel.name}", which the ${feature.feature} feature needs.`,
          channel.id,
        );
    }
  }

  const baseline: PlanBaseline = {
    roles: scanned.roles.filter((r) => touchedRoles.has(r.id)),
    channels: scanned.channels.filter((c) => touchedChannels.has(c.id)),
    config: baselineConfig,
  };

  const id = createHash("sha256")
    .update(canonical({ g: scanned.guildId, ops: ordered, baseline }))
    .digest("hex")
    .slice(0, 24);

  return {
    id,
    guildId: scanned.guildId,
    operations: ordered,
    warnings,
    errors,
    baseline,
  };
}
