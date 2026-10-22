import { PermissionsBitField, type Guild } from "discord.js";
import logger from "../utils/logger.js";
import {
  capabilityLabel,
  type RoleGroupCapability,
} from "../models/role-group.js";
import { roleLockReason } from "./role-group-plan.js";
import { RoleGroupService, type RoleGroupView } from "./role-group-service.js";

/**
 * The Setup wizard's Access step (#1321): which Discord roles are Admins,
 * Moderators and Event hosts.
 *
 * The step writes through the same role groups the Role groups page uses
 * (`RoleGroupService`), never a second store. It only ever *links existing
 * roles* to groups and changes a group's capabilities; it does not create or
 * edit Discord roles, so nothing here reaches Discord. Nothing is written when
 * a role is picked: the choice waits in the wizard session and is applied only
 * from the review step.
 */

/** The three scopes with a role mapping. Members have no mapping here. */
export const ACCESS_SCOPES = ["admin", "staff", "host"] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

/** Role ids picked for each scope. */
export type AccessSelection = Record<AccessScope, string[]>;

export function emptySelection(): AccessSelection {
  return { admin: [], staff: [], host: [] };
}

/** The scope's capability key, shown as the UI name (`staff` is "Moderator"). */
export function scopeLabel(scope: AccessScope): string {
  return capabilityLabel(scope);
}

export interface AccessRole {
  id: string;
  name: string;
  managed: boolean;
  position: number;
}

const WIZARD_CAPS: readonly RoleGroupCapability[] = ["admin", "staff", "host"];

/** A group the Access step may map: linked, editable, and not a bot group. */
function isMappable(g: RoleGroupView): boolean {
  return (
    g.roleId !== null &&
    !g.unlinked &&
    !g.gateOnly &&
    !g.capabilities.includes("bot")
  );
}

/** The scopes a group's capabilities put its members in. Admin implies the rest. */
export function scopesOf(caps: readonly RoleGroupCapability[]): AccessScope[] {
  if (caps.includes("admin")) return ["admin"];
  const out: AccessScope[] = [];
  if (caps.includes("staff")) out.push("staff");
  if (caps.includes("host")) out.push("host");
  return out;
}

/**
 * Capabilities a set of scopes writes. The admin preset carries `staff` as
 * well (`PERMISSION_PRESETS`), so an admin group reads as staff everywhere.
 */
export function capabilitiesFor(
  scopes: readonly AccessScope[],
): RoleGroupCapability[] {
  const out = new Set<RoleGroupCapability>();
  if (scopes.includes("admin")) {
    out.add("admin");
    out.add("staff");
  }
  if (scopes.includes("staff")) out.add("staff");
  if (scopes.includes("host")) out.add("host");
  return [...out];
}

/** What the saved groups say right now: the pre-fill when the wizard is re-run. */
export function currentMapping(
  groups: readonly RoleGroupView[],
): AccessSelection {
  const out = emptySelection();
  for (const g of groups) {
    if (!isMappable(g) || g.roleId === null) continue;
    for (const scope of scopesOf(g.capabilities)) out[scope].push(g.roleId);
  }
  return out;
}

/**
 * One role in two scopes means the higher one: an admin role is not also listed
 * as a Moderator or Event host, because admin already implies both.
 */
export function normaliseSelection(sel: AccessSelection): AccessSelection {
  const admin = [...new Set(sel.admin)];
  const adminSet = new Set(admin);
  return {
    admin,
    staff: [...new Set(sel.staff)].filter((id) => !adminSet.has(id)),
    host: [...new Set(sel.host)].filter((id) => !adminSet.has(id)),
  };
}

function scopesFor(sel: AccessSelection, roleId: string): AccessScope[] {
  return ACCESS_SCOPES.filter((s) => sel[s].includes(roleId));
}

/** One group write the Access step would make. */
export interface AccessChange {
  kind: "create" | "update";
  roleId: string;
  roleName: string;
  /** The existing group; `null` for a group that doesn't exist yet. */
  groupId: string | null;
  groupName: string;
  scopesBefore: AccessScope[];
  scopesAfter: AccessScope[];
  capabilitiesBefore: RoleGroupCapability[];
  capabilitiesAfter: RoleGroupCapability[];
}

/**
 * The group writes that turn the saved groups into `selection`, and nothing
 * else: a role whose scopes already match is left alone, and a role dropped
 * from every scope keeps its group (it just loses the capability).
 */
export function diffAccess(
  groups: readonly RoleGroupView[],
  roles: readonly AccessRole[],
  selection: AccessSelection,
): AccessChange[] {
  const sel = normaliseSelection(selection);
  const byRole = new Map(
    groups.filter((g) => g.roleId !== null).map((g) => [g.roleId, g]),
  );
  const roleNames = new Map(roles.map((r) => [r.id, r.name]));
  const touched = new Set<string>();
  for (const s of ACCESS_SCOPES) for (const id of sel[s]) touched.add(id);
  for (const g of groups) {
    if (isMappable(g) && g.roleId && scopesOf(g.capabilities).length > 0) {
      touched.add(g.roleId);
    }
  }
  const changes: AccessChange[] = [];
  for (const roleId of touched) {
    const group = byRole.get(roleId) ?? null;
    if (group && !isMappable(group)) continue; // reported by validation
    const after = scopesFor(sel, roleId);
    const before = group ? scopesOf(group.capabilities) : [];
    if (before.join() === after.join()) continue;
    const kept = (group?.capabilities ?? []).filter(
      (c) => !WIZARD_CAPS.includes(c),
    );
    changes.push({
      kind: group ? "update" : "create",
      roleId,
      roleName: roleNames.get(roleId) ?? group?.roleName ?? roleId,
      groupId: group?.id ?? null,
      groupName: group?.name ?? roleNames.get(roleId) ?? roleId,
      scopesBefore: before,
      scopesAfter: after,
      capabilitiesBefore: group ? [...group.capabilities] : [],
      capabilitiesAfter: [...kept, ...capabilitiesFor(after)],
    });
  }
  return changes;
}

export interface AccessViewer {
  /** The applying admin is the owner or holds Administrator. */
  elevated: boolean;
  roleIds: readonly string[];
}

export interface AccessContext {
  groups: RoleGroupView[];
  roles: AccessRole[];
  guildId: string;
  /** Position of the bot's highest role: a role at or above it can't be linked. */
  botHighest: number;
  viewer: AccessViewer;
}

/**
 * Read the groups, the guild's roles, the bot's rank and the applying admin
 * from live sources. Throws when any of them can't be read, so the caller
 * writes nothing rather than deciding from a partial picture.
 */
export async function readAccessContext(
  guild: Guild,
  userId: string,
  service: Pick<RoleGroupService, "list"> = RoleGroupService.getInstance(),
): Promise<AccessContext> {
  const [groups, roleMap, me, member] = await Promise.all([
    service.list(guild.id),
    guild.roles.fetch(),
    guild.members.me ?? guild.members.fetchMe(),
    guild.members.fetch(userId),
  ]);
  return {
    groups,
    guildId: guild.id,
    roles: [...roleMap.values()].map((r) => ({
      id: r.id,
      name: r.name,
      managed: r.managed,
      position: r.position,
    })),
    botHighest: me.roles.highest.position,
    viewer: {
      elevated:
        guild.ownerId === member.id ||
        member.permissions.has(PermissionsBitField.Flags.Administrator),
      roleIds: [...member.roles.cache.keys()],
    },
  };
}

/** Roles that may be picked: not @everyone, not integration-managed, below the bot. */
export function pickableRoles(ctx: AccessContext): AccessRole[] {
  const blocked = new Set(
    ctx.groups
      .filter((g) => g.roleId && !isMappable(g))
      .map((g) => g.roleId as string),
  );
  return ctx.roles
    .filter(
      (r) =>
        roleLockReason(r, ctx.guildId, ctx.botHighest) === null &&
        !blocked.has(r.id),
    )
    .sort((a, b) => b.position - a.position);
}

/**
 * The first problem with a selection, in plain words, or null when it can be
 * applied. Run when the step is saved and again right before the writes.
 */
export function validateSelection(
  ctx: AccessContext,
  selection: AccessSelection,
): string | null {
  const sel = normaliseSelection(selection);
  const roles = new Map(ctx.roles.map((r) => [r.id, r]));
  const byRole = new Map(
    ctx.groups.filter((g) => g.roleId !== null).map((g) => [g.roleId, g]),
  );
  for (const scope of ACCESS_SCOPES) {
    for (const id of sel[scope]) {
      const role = roles.get(id);
      if (!role) {
        return "A role you picked no longer exists in Discord. Reload the page and pick again.";
      }
      const lock = roleLockReason(role, ctx.guildId, ctx.botHighest);
      if (lock === "everyone") return "@everyone can't be mapped to a scope.";
      if (lock === "managed") {
        return `@${role.name} is managed by an integration, so it can't carry a scope. Pick another role.`;
      }
      if (lock === "hierarchy") {
        return `@${role.name} is at or above the bot's own role, so it can't be linked. Move the bot's role higher in Discord, or pick another role.`;
      }
      const group = byRole.get(id);
      if (group?.capabilities.includes("bot")) {
        return `@${role.name} is a bot group; people can't join it, so it can't carry a scope.`;
      }
      if (group && (group.gateOnly || group.unlinked)) {
        return `@${role.name} backs a gate-only or unlinked group on Role groups, so it can't carry a scope here.`;
      }
    }
  }
  // Never let the wizard take away the admin access of the person applying it.
  if (!ctx.viewer.elevated) {
    const mine = new Set(ctx.viewer.roleIds);
    const hadAdmin = currentMapping(ctx.groups).admin.some((id) =>
      mine.has(id),
    );
    if (hadAdmin && !sel.admin.some((id) => mine.has(id))) {
      return "This would remove the admin role you sign in with. Keep one of your own roles under Admins.";
    }
  }
  return null;
}

/**
 * Where new groups go in the rank order: below the groups whose Discord role
 * sits higher, above those whose role sits lower. Ranks that match the roles'
 * real order mean the next Role groups plan has no position to move. `ordered`
 * is the current order, highest first; the result is the same list with each
 * new group inserted.
 */
export function orderWithNewGroups(
  ordered: readonly string[],
  positionOf: ReadonlyMap<string, number>,
  created: ReadonlyArray<{ id: string; position: number }>,
): string[] {
  const out = [...ordered];
  const positions = new Map(positionOf);
  for (const c of [...created].sort((a, b) => b.position - a.position)) {
    positions.set(c.id, c.position);
    const at = out.findIndex((id) => {
      const p = positions.get(id);
      return p !== undefined && p < c.position;
    });
    out.splice(at < 0 ? out.length : at, 0, c.id);
  }
  return out;
}

// ---- gaps ---------------------------------------------------------------

export interface AccessGap {
  feature: string;
  scope: AccessScope;
  message: string;
}

/**
 * A switched-on feature with nobody mapped to run it. The owner and anyone
 * with Administrator can always do everything, so "nobody" means no mapped
 * role carries the scope or `admin`: it says nobody *else* can yet.
 */
export function accessGaps(
  enabled: ReadonlySet<string>,
  selection: AccessSelection,
): AccessGap[] {
  const sel = normaliseSelection(selection);
  const covered = (scope: AccessScope): boolean =>
    sel[scope].length > 0 || sel.admin.length > 0;
  const gaps: AccessGap[] = [];
  if (enabled.has("events") && !covered("host")) {
    gaps.push({
      feature: "events",
      scope: "host",
      message: "Events is on and nobody can host yet.",
    });
  }
  if (enabled.has("moderation") && !covered("staff")) {
    gaps.push({
      feature: "moderation",
      scope: "staff",
      message: "Moderation is on and nobody can moderate yet.",
    });
  }
  return gaps;
}

// ---- apply --------------------------------------------------------------

type GroupWriter = Pick<
  RoleGroupService,
  "list" | "create" | "update" | "remove" | "reorder"
>;

export interface AccessAuditEntry {
  action: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  result: "success" | "failure";
  errorMessage?: string | null;
}

export interface AccessDeps {
  groups: GroupWriter;
  audit: (entry: AccessAuditEntry) => Promise<void>;
}

/** How to put one write back. */
export type AccessUndo =
  | { type: "remove"; groupId: string; groupName: string }
  | {
      type: "restore";
      groupId: string;
      groupName: string;
      capabilities: RoleGroupCapability[];
    }
  | { type: "reorder"; ids: string[] };

export type AccessApplyResult =
  | { ok: true; applied: AccessChange[]; undo: AccessUndo[] }
  | {
      ok: false;
      error: string;
      /** Writes that were made and then undone. */
      rolledBack: number;
      /** Writes that could not be undone and are live. */
      stuck: string[];
    };

export interface AccessRollbackResult {
  restored: number;
  stuck: string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Undo writes, newest first. A group the apply created is removed, one it
 * changed gets its old capabilities back, and the rank order is restored last
 * (it needs exactly the groups that existed before). Every undo is audited;
 * one that fails is reported, never swallowed.
 */
export async function rollbackAccess(
  deps: AccessDeps,
  guildId: string,
  undo: readonly AccessUndo[],
): Promise<AccessRollbackResult> {
  const stuck: string[] = [];
  let restored = 0;
  const ordered = [
    ...[...undo].reverse().filter((u) => u.type !== "reorder"),
    ...undo.filter((u) => u.type === "reorder"),
  ];
  for (const step of ordered) {
    const label =
      step.type === "reorder" ? "the group order" : `"${step.groupName}"`;
    try {
      if (step.type === "remove") {
        if (!(await deps.groups.remove(guildId, step.groupId))) {
          throw new Error("the group was already gone");
        }
      } else if (step.type === "restore") {
        const res = await deps.groups.update(guildId, step.groupId, {
          name: step.groupName,
          capabilities: step.capabilities,
        });
        if (!res.ok) throw new Error(res.error);
      } else {
        const res = await deps.groups.reorder(guildId, step.ids);
        if (!res.ok) throw new Error(res.error);
      }
      restored += 1;
      await deps.audit({
        action: "wizard.access.rollback",
        targetId: step.type === "reorder" ? null : step.groupId,
        details: { step: step.type, label },
        result: "success",
      });
    } catch (error) {
      logger.error(`wizard access: could not undo ${label}`, error);
      stuck.push(label);
      await deps.audit({
        action: "wizard.access.rollback",
        targetId: step.type === "reorder" ? null : step.groupId,
        details: { step: step.type, label },
        result: "failure",
        errorMessage: messageOf(error),
      });
    }
  }
  return { restored, stuck };
}

/**
 * Write the changes, one group at a time, each with its own audit entry. The
 * first write that fails undoes the ones before it and the result says so:
 * the mapping is either all there or none of it, never reported as saved
 * while half of it is.
 */
export async function applyAccessChanges(
  deps: AccessDeps,
  ctx: AccessContext,
  changes: readonly AccessChange[],
): Promise<AccessApplyResult> {
  const undo: AccessUndo[] = [];
  const applied: AccessChange[] = [];
  const created: Array<{ id: string; position: number }> = [];
  const positions = new Map(ctx.roles.map((r) => [r.id, r.position]));
  const originalOrder = ctx.groups.map((g) => g.id);
  const fail = async (error: string): Promise<AccessApplyResult> => {
    const back = await rollbackAccess(deps, ctx.guildId, undo);
    return {
      ok: false,
      error,
      rolledBack: back.restored,
      stuck: back.stuck,
    };
  };

  for (const change of changes) {
    const details = {
      kind: change.kind,
      roleId: change.roleId,
      roleName: change.roleName,
      scopes: change.scopesAfter,
      capabilities: change.capabilitiesAfter,
    };
    try {
      if (change.kind === "create") {
        const res = await deps.groups.create(ctx.guildId, {
          name: change.groupName,
          roleId: change.roleId,
          roleName: change.roleName,
          capabilities: change.capabilitiesAfter,
          permissions: null,
        });
        if (!res.ok) throw new Error(res.error);
        undo.push({
          type: "remove",
          groupId: res.group.id,
          groupName: res.group.name,
        });
        created.push({
          id: res.group.id,
          position: positions.get(change.roleId) ?? 0,
        });
        await deps.audit({
          action: "wizard.access.group",
          targetId: res.group.id,
          details,
          result: "success",
        });
      } else {
        const res = await deps.groups.update(
          ctx.guildId,
          change.groupId as string,
          {
            name: change.groupName,
            capabilities: change.capabilitiesAfter,
          },
        );
        if (!res.ok) throw new Error(res.error);
        undo.push({
          type: "restore",
          groupId: change.groupId as string,
          groupName: change.groupName,
          capabilities: change.capabilitiesBefore,
        });
        await deps.audit({
          action: "wizard.access.group",
          targetId: change.groupId,
          details,
          result: "success",
        });
      }
      applied.push(change);
    } catch (error) {
      logger.error("wizard access: group write failed", error);
      const text = messageOf(error);
      await deps.audit({
        action: "wizard.access.group",
        targetId: change.groupId,
        details,
        result: "failure",
        errorMessage: text,
      });
      return fail(
        `The group for @${change.roleName} could not be saved (${text}).`,
      );
    }
  }

  if (created.length > 0) {
    try {
      // New groups were put on top; move them to where their roles sit.
      const nowIds = (await deps.groups.list(ctx.guildId)).map((g) => g.id);
      const fresh = new Set(created.map((c) => c.id));
      const wanted = orderWithNewGroups(
        nowIds.filter((id) => !fresh.has(id)),
        new Map(
          ctx.groups.flatMap((g) =>
            g.roleId && positions.has(g.roleId)
              ? [[g.id, positions.get(g.roleId) as number] as const]
              : [],
          ),
        ),
        created,
      );
      if (wanted.join() !== nowIds.join()) {
        // Recorded before the write, so a reorder that fails halfway is undone too.
        undo.push({ type: "reorder", ids: originalOrder });
        const res = await deps.groups.reorder(ctx.guildId, wanted);
        if (!res.ok) throw new Error(res.error);
        await deps.audit({
          action: "wizard.access.reorder",
          details: { ids: wanted },
          result: "success",
        });
      }
    } catch (error) {
      logger.error("wizard access: ordering the new groups failed", error);
      const text = messageOf(error);
      await deps.audit({
        action: "wizard.access.reorder",
        result: "failure",
        errorMessage: text,
      });
      return fail(`The new groups could not be ranked (${text}).`);
    }
  }
  return { ok: true, applied, undo };
}
