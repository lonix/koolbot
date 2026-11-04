/**
 * The Access step creates the roles an admin typed into a role Picker (#1618):
 * what the step saves, what Review shows and what Apply does. This is the ROLE
 * kind of the pattern the feature steps use for channels (`wizard-create.ts`);
 * the creation itself is `role-create.ts`.
 *
 *  - The step's POST turns a `create:<name>` value (extracted first, before
 *    anything coerces the picks) into a `WizardRoleCreation` in
 *    `WizardState.roleCreations`, beside the picks, never in them. A name that
 *    matches an existing role, ignoring case, selects that role instead, so the
 *    mapping's refusals (managed, above the bot, @everyone, handed out by a
 *    feature) apply to it as to any picked role.
 *  - A role that does not exist yet has no id, so Review and Apply stand in a
 *    placeholder id (`new:<name>`, position 0) for it in the same
 *    `diffAccess` that maps real roles. The fingerprint Review posts is of
 *    that diff. After the roles are created the placeholders are swapped for
 *    the real ids and the diff is made again from them; it is not compared again.
 *  - Permissions and the refusal of powerful roles: a created role carries no
 *    Discord permissions (`role-create.ts`), so it cannot be a role the
 *    wizard refuses for Administrator or other powerful permissions, and the
 *    group that maps it has `permissions: null`, so no sync gives it any. An
 *    existing role selected by name goes through `validateSelection` and the
 *    settings steps' powerful-role refusal exactly as a picked one.
 *  - Apply order is roles, role groups, channels, settings. When anything after
 *    the roles fails, `cleanup` removes the roles this apply created, from a fresh
 *    read of the role groups and the stored settings inside the role lock; one
 *    that is still pointed at is kept and reported.
 *
 * Known limit (the same as the channels', #1748): between the creation and the
 * cleanup another admin's save can point at a role this apply created. The
 * cleanup reads fresh and keeps a role that is then referenced, but a save made
 * after that read and before the delete can still lose its role. The reservation
 * design is tracked in #1748; nothing here widens it.
 */

import { type Client } from "discord.js";
import { canBotCreate } from "../services/bot-create-check.js";
import { CommandManager } from "../services/command-manager.js";
import { ConfigService } from "../services/config-service.js";
import { AdoptionSnapshot } from "../models/adoption-snapshot.js";
import { CommandPermission } from "../models/command-permissions.js";
import { PollSchedule } from "../models/poll-schedule.js";
import { RoleGroupService } from "../services/role-group-service.js";
import {
  ACCESS_SCOPES,
  normaliseSelection,
  type AccessContext,
  type AccessScope,
  type AccessSelection,
} from "../services/wizard-access.js";
import type { WizardRoleCreation } from "../services/wizard-service.js";
import logger from "../utils/logger.js";
import { readWithin, ChannelReadTimeoutError } from "./channel-write-lock.js";
import { cancellableCall } from "./channel-write-rest.js";
import {
  applyRolePlan,
  cleanRoleName,
  planRoles,
  removeCreatedRoles,
  type RolePlanEntry,
  type RoleView,
} from "./role-create.js";
import { withRoleLock } from "./role-write-lock.js";
import { writeRestFor } from "./setting-create-save.js";
import { parsePickerCreateValue } from "./setting-pickers.js";
import { idsIn } from "./wizard-create.js";

const NOT_CHECKED =
  "KoolBot could not check whether it may create roles, so nothing was created. Try again.";
const NOT_SIGNED_IN =
  "The bot isn't signed in to Discord yet, so nothing was created.";
const NOT_READ =
  "KoolBot couldn't read the roles from Discord, so nothing was created. Try again.";
const ADOPTION_BUSY =
  "Another apply or rollback is already running for this server.";

const SNOWFLAKE = /^\d{1,25}$/;

const nameKey = (name: string): string => cleanRoleName(name).toLowerCase();

/** The scopes a role typed under these scopes carries: Admins already implies the others. */
export function highestScopes(scopes: readonly AccessScope[]): AccessScope[] {
  return scopes.includes("admin")
    ? ["admin"]
    : ACCESS_SCOPES.filter((s) => scopes.includes(s));
}

export interface SplitPicks {
  /** The role ids picked, per scope. */
  ids: AccessSelection;
  /** Every `create:` value, with the scope it was typed under. */
  named: Array<{ scope: AccessScope; name: string }>;
  /** Names that did not pass the Picker's own rule (blank, too long). */
  errors: string[];
}

/**
 * Splits what the Access form posted into role ids and names to create. The
 * `create:` values are taken out FIRST: nothing that reads ids (the snowflake
 * filter) ever sees them, and a value that is neither an id nor a `create:`
 * value is dropped as it always was.
 */
export function splitPicks(raw: Record<AccessScope, unknown>): SplitPicks {
  const ids: AccessSelection = { admin: [], staff: [], host: [] };
  const named: SplitPicks["named"] = [];
  const errors: string[] = [];
  for (const scope of ACCESS_SCOPES) {
    const value = raw[scope];
    const list = Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value];
    for (const item of list.map(String)) {
      const parsed = parsePickerCreateValue(item);
      if (parsed) {
        if (parsed.ok) named.push({ scope, name: parsed.name });
        else if (!errors.includes(parsed.error)) errors.push(parsed.error);
      } else if (SNOWFLAKE.test(item) && !ids[scope].includes(item)) {
        ids[scope].push(item);
      }
    }
  }
  return { ids, named, errors };
}

export type ResolvedPicks =
  | {
      ok: true;
      /** The picks with every name that matched an existing role turned into its id. */
      selection: AccessSelection;
      creations: WizardRoleCreation[];
    }
  | { ok: false; error: string };

/**
 * De-duplicates the typed names (case-insensitively, across scopes: one role
 * with the highest scope), plans them against the live roles, and turns a name
 * that matches an existing role into that role's id. A name two roles share is
 * refused. Nothing is written.
 */
export function resolvePicks(
  picks: SplitPicks,
  roles: readonly RoleView[],
): ResolvedPicks {
  const byName = new Map<string, { name: string; scopes: AccessScope[] }>();
  for (const { scope, name } of picks.named) {
    const k = nameKey(name);
    const got = byName.get(k);
    if (got) {
      if (!got.scopes.includes(scope)) got.scopes.push(scope);
    } else byName.set(k, { name: cleanRoleName(name), scopes: [scope] });
  }
  const unique = [...byName.values()];
  const plan = planRoles(
    unique.map((u): RolePlanEntry => ({ name: u.name })),
    roles,
  );
  if (!plan.ok) return { ok: false, error: plan.errors.join(" ") };
  const selection: AccessSelection = {
    admin: [...picks.ids.admin],
    staff: [...picks.ids.staff],
    host: [...picks.ids.host],
  };
  const creations: WizardRoleCreation[] = [];
  plan.entries.forEach((entry, i) => {
    const scopes = unique[i].scopes;
    if (entry.action === "existing") {
      for (const scope of scopes) {
        selection[scope].push(entry.existingId as string);
      }
    } else {
      creations.push({ name: entry.name, scopes: highestScopes(scopes) });
    }
  });
  return { ok: true, selection: normaliseSelection(selection), creations };
}

// ---- placeholders for Review and Apply -------------------------------------

/** The id Review and Apply give a role that does not exist yet; never a snowflake. */
export const placeholderId = (name: string): string => `new:${nameKey(name)}`;

/** The picks with a placeholder id added under each scope a creation carries. */
export function selectionWithNew(
  selection: AccessSelection,
  creations: readonly WizardRoleCreation[],
): AccessSelection {
  const out: AccessSelection = {
    admin: [...selection.admin],
    staff: [...selection.staff],
    host: [...selection.host],
  };
  for (const c of creations) {
    for (const scope of c.scopes) out[scope].push(placeholderId(c.name));
  }
  return normaliseSelection(out);
}

/** The context with a role (position 0, below everything) standing in for each creation. */
export function contextWithNew(
  ctx: AccessContext,
  creations: readonly WizardRoleCreation[],
): AccessContext {
  return {
    ...ctx,
    roles: [
      ...ctx.roles,
      ...creations.map((c) => ({
        id: placeholderId(c.name),
        name: c.name,
        managed: false,
        position: 0,
      })),
    ],
  };
}

/** The picks with each placeholder replaced by the id of the role created for it. */
export function swapPlaceholders(
  selection: AccessSelection,
  ids: ReadonlyMap<string, string>,
): AccessSelection {
  const swap = (list: string[]): string[] =>
    list.map((id) => ids.get(id) ?? id);
  return normaliseSelection({
    admin: swap(selection.admin),
    staff: swap(selection.staff),
    host: swap(selection.host),
  });
}

/** The typed names of a refused save, as creations to draw (one per name, scopes joined). Not validated: they were not saved. */
export function draftCreations(
  named: ReadonlyArray<{ scope: AccessScope; name: string }>,
): WizardRoleCreation[] {
  const byName = new Map<string, WizardRoleCreation>();
  for (const { scope, name } of named) {
    const k = nameKey(name);
    const got = byName.get(k);
    if (got) {
      if (!got.scopes.includes(scope)) got.scopes.push(scope);
    } else byName.set(k, { name: cleanRoleName(name), scopes: [scope] });
  }
  return [...byName.values()];
}

/** The names to draw as pending in each scope's Picker. */
export function pendingNames(
  creations: readonly WizardRoleCreation[],
): Record<AccessScope, string[]> {
  const out: Record<AccessScope, string[]> = { admin: [], staff: [], host: [] };
  for (const c of creations) {
    for (const scope of c.scopes) out[scope].push(c.name);
  }
  return out;
}

// ---- Review ------------------------------------------------------------------

export interface RoleToCreate {
  name: string;
  scopes: AccessScope[];
}

export interface WizardRoleReview {
  /** The roles Apply would create, for `renderRoleCreateReview`. */
  roles: RoleToCreate[];
  /** The plan Apply must reproduce; null when nothing is planned or it has a problem. */
  planId: string | null;
  /** Why Apply cannot go ahead; empty when it can. */
  problems: string[];
}

const NONE: WizardRoleReview = { roles: [], planId: null, problems: [] };

/**
 * What Review shows for the planned roles, planned from the roles the caller
 * just read (`ctx.roles`), with nothing written. The permission is checked here
 * too, so a bot that cannot create blocks Apply with the reason.
 */
export async function reviewWizardRoles(
  client: Client,
  guildId: string,
  ctx: AccessContext,
  creations: readonly WizardRoleCreation[],
): Promise<WizardRoleReview> {
  if (creations.length === 0) return NONE;
  const refuse = (problem: string): WizardRoleReview => ({
    ...NONE,
    problems: [problem],
  });
  const can = await canBotCreate(client, guildId, { kind: "role" });
  if (can.ok === false) return refuse(can.reason);
  if (can.ok !== true) return refuse(NOT_CHECKED);
  const plan = planRoles(
    creations.map((c) => ({ name: c.name })),
    ctx.roles,
  );
  if (!plan.ok) return refuse(plan.errors.join(" "));
  const exists = plan.entries.find((e) => e.action === "existing");
  if (exists) {
    return refuse(
      `A role called "${exists.name}" exists now. Go back to Access and pick it from the list.`,
    );
  }
  return {
    roles: creations.map((c) => ({ name: c.name, scopes: c.scopes })),
    planId: plan.planId,
    problems: [],
  };
}

// ---- Apply -------------------------------------------------------------------

/** What became of the roles one apply created, once something after the creation failed. */
export interface RoleCleanup {
  /** Deleted again. */
  removed: string[];
  /** Left in place because a role group or a saved setting points at them. */
  kept: string[];
  /** Could not be deleted, or could not be decided: they may still exist. */
  stuck: string[];
}

export interface CreatedRole {
  /** The placeholder id the creation stood in for. */
  placeholder: string;
  id: string;
  /** The name Discord has. */
  name: string;
  position: number;
}

export type WizardRoleApply =
  | {
      ok: true;
      created: CreatedRole[];
      /**
       * After a failure that came later (and after the role groups were put
       * back): decide per created role, inside the role lock and from a fresh
       * read of the role groups and the stored settings. A role that any of them
       * points at is kept and reported; the rest are deleted. A read that fails
       * keeps every role and says so.
       */
      cleanup: () => Promise<RoleCleanup>;
    }
  | {
      ok: false;
      error: string;
      /** Only why a create failed; absent when none was attempted (a refusal). */
      cause?: string;
      removed?: string[];
      /** Created, then kept: a role group or a saved setting points at them. */
      kept?: string[];
      stuck?: string[];
    };

/**
 * The ids a role group or a stored setting points at, read fresh and bounded
 * (each read goes through `readWithin`). Throws when either cannot be read.
 * Call it inside the role lock.
 */
async function readReferenced(guildId: string): Promise<Set<string>> {
  const service = RoleGroupService.getInstance();
  // `featureRoleUses` is the list of every role a feature hands out or binds
  // (role-grants.ts, leaderboard tiers, reaction-role bindings), used as it is;
  // `idsIn` only sees plain id lists in the settings.
  // Stores of a role id outside the settings: the per-command role lists
  // (`CommandPermission.roleIds`, Command permissions) and the role a poll
  // schedule pings (`PollSchedule.roleIdToPing`). Role groups, reaction-role
  // bindings and leaderboard tiers are covered above.
  const [rows, groups, uses, perms, pings] = await Promise.all([
    readWithin(() => ConfigService.getInstance().getAll()),
    readWithin(() => service.list(guildId)),
    readWithin(() => service.featureRoleUses(guildId)),
    readWithin(() =>
      CommandPermission.find({ guildId }).select("roleIds").lean().exec(),
    ),
    readWithin(() =>
      PollSchedule.find({ guildId }).select("roleIdToPing").lean().exec(),
    ),
  ]);
  return new Set([
    ...rows.flatMap((r) => idsIn(r.value)),
    ...groups.flatMap((g) => (g.roleId ? [g.roleId] : [])),
    ...uses.keys(),
    ...perms.flatMap((p) => p.roleIds ?? []),
    ...pings.flatMap((p) => (p.roleIdToPing ? [p.roleIdToPing] : [])),
  ]);
}

/**
 * Creates the planned roles in one go, for the plan Review showed. The
 * permission, the live roles and the plan id are checked again inside the role
 * lock; nothing is created unless they all agree, and one failure removes what
 * the same call had created. `signal` abandons the apply while it still waits
 * for the lock (a closed request).
 */
export async function applyWizardRoles(
  client: Client,
  guildId: string,
  actorId: string,
  creations: readonly WizardRoleCreation[],
  reviewedPlanId: string,
  signal?: AbortSignal,
): Promise<WizardRoleApply> {
  const can = await canBotCreate(client, guildId, { kind: "role" });
  if (can.ok === false) return { ok: false, error: can.reason };
  if (can.ok !== true) return { ok: false, error: NOT_CHECKED };
  if (!client.token) return { ok: false, error: NOT_SIGNED_IN };
  try {
    const guild = await readWithin(() => client.guilds.fetch(guildId));
    const manager = CommandManager.getInstance(client);
    const deps = {
      guildId,
      rest: writeRestFor(client.token),
      call: <T>(
        fn: (signal: AbortSignal) => Promise<T>,
        opName: string,
        retryOnTimeout: boolean,
      ): Promise<T> => cancellableCall(manager, fn, opName, retryOnTimeout),
      listRoles: async (): Promise<RoleView[]> =>
        [...(await guild.roles.fetch()).values()].map((r) => ({
          id: r.id,
          name: r.name,
        })),
      busyReason: async (): Promise<string | null> =>
        (await AdoptionSnapshot.exists({ guildId, active: true }))
          ? ADOPTION_BUSY
          : null,
      reason: `KoolBot web UI, setup wizard, by ${actorId}`,
      signal,
      // A partial failure keeps a created role something now points at.
      referenced: (): Promise<Set<string>> => readReferenced(guildId),
    };
    const applied = await applyRolePlan(
      deps,
      creations.map((c) => ({ name: c.name })),
      reviewedPlanId,
    );
    if (!applied.ok) {
      return {
        ok: false,
        error: applied.error,
        cause: applied.cause,
        removed: applied.removed,
        kept: applied.kept,
        stuck: applied.stuck,
      };
    }
    const created: CreatedRole[] = creations.map((c, i) => ({
      placeholder: placeholderId(c.name),
      id: applied.roles[i].id,
      name: applied.roles[i].name,
      position: applied.roles[i].position,
    }));
    const createdIds = created.map((c) => c.id);
    return {
      ok: true,
      created,
      cleanup: async (): Promise<RoleCleanup> => {
        const everyStuck = (): RoleCleanup => ({
          removed: [],
          kept: [],
          stuck: [...createdIds],
        });
        // No signal: a cleanup that has started is never cut short by the
        // closed request. The reads and the deletes sit inside the lock.
        const held = await withRoleLock(guildId, async () => {
          let referenced: Set<string>;
          try {
            referenced = await readReferenced(guildId);
          } catch (error) {
            logger.warn("wizard: role cleanup could not read", error);
            return everyStuck();
          }
          const kept = createdIds.filter((id) => referenced.has(id));
          const gone = await removeCreatedRoles(
            deps,
            createdIds.filter((id) => !referenced.has(id)),
          );
          return { removed: gone.removed, kept, stuck: gone.stuck };
        });
        return held.ok ? held.value : everyStuck();
      },
    };
  } catch (error) {
    logger.warn("wizard: creating roles failed", error);
    return {
      ok: false,
      error:
        error instanceof ChannelReadTimeoutError ? error.message : NOT_READ,
    };
  }
}
