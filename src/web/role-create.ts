/**
 * Create the roles an admin typed into a role Picker (#1618), as a plan that is
 * shown first and an apply that must match it: the role kind of what
 * `channel-create.ts` does for channels, with the same shape and the same
 * failure wording, so the wizard handles both alike.
 *
 *  1. `planRoles(entries, liveRoles)` validates each typed name and says, per
 *     entry, whether it would create a role or select one that already exists.
 *     It is pure: it writes nothing and returns a `planId`.
 *  2. `applyRolePlan(deps, entries, reviewedPlanId)` takes the per-server role
 *     lock (`role-write-lock.ts`), reads the live roles again, plans again, and
 *     writes only if the new plan has the `planId` Review showed.
 *  3. Roles are created one at a time. When one fails, every role this call
 *     already created is deleted again; the result names the ids it removed and
 *     any it could not remove (`stuck`).
 *
 * Rules, each in one place:
 *  - Names: trimmed, 1 to 100 characters (Discord's limit). A name that matches
 *    an existing role, ignoring case, is selected, not created; two roles with
 *    the name is a refusal (the admin picks one from the list). Every role
 *    counts, including @everyone and managed ones, so the mapping's own refusals
 *    (`validateSelection`) apply to the role that is selected.
 *  - Permissions: a created role gets NO permissions, hoist off and not
 *    mentionable. `permissions: "0"` is sent explicitly: a role created without
 *    the field gets @everyone's permissions. Nobody is added to it. The one place
 *    to change that is `ROLE_BODY`.
 *  - Limit: Discord allows 250 roles per server.
 *
 * The bot-permission check (Manage Roles, `canBotCreate`) is the caller's. Like
 * `applyChannelPlan`, a create that timed out is in neither `removed` nor `stuck`
 * (whether it exists is unknown; the error says to check Discord), and a failure
 * `makeDiscordApiCall` wrapped is classified by its cause. Writes use the write
 * REST client and `cancellableCall`: a create is never retried.
 */

import { createHash } from "node:crypto";
import { DiscordAPIError, RateLimitError, Routes, type REST } from "discord.js";
import { cleanName } from "./channel-manager.js";
import { readWithin } from "./channel-write-lock.js";
import { unwrapWriteError } from "./channel-create.js";
import { describeWriteFailure, rateLimitWaitMs } from "./channel-write-rest.js";
import { ROLE_LOCK_BUSY_MESSAGE, withRoleLock } from "./role-write-lock.js";
import logger from "../utils/logger.js";

export const ROLE_LIMITS = { nameMax: 100, guildRoles: 250 } as const;

/** The body of every created role: no permissions, no hoist, not mentionable. */
const ROLE_BODY = {
  permissions: "0",
  hoist: false,
  mentionable: false,
} as const;

export interface RoleView {
  id: string;
  name: string;
}

export interface RolePlanEntry {
  name: string;
}

export interface PlannedRole {
  /** The name as Discord will have it (an existing role keeps its own). */
  name: string;
  action: "create" | "existing";
  /** Set when `action` is `existing`. */
  existingId?: string;
}

export type RolePlan =
  | { ok: true; entries: PlannedRole[]; planId: string }
  | { ok: false; errors: string[] };

export function cleanRoleName(raw: unknown): string {
  return cleanName(raw);
}

const key = (name: string): string => cleanRoleName(name).toLowerCase();

/** Validate the entries against the live roles. Pure: nothing is written. */
export function planRoles(
  entries: readonly RolePlanEntry[],
  liveRoles: readonly RoleView[],
): RolePlan {
  const errors: string[] = [];
  const planned: PlannedRole[] = [];
  const seen = new Set<string>();
  let creating = 0;
  for (const entry of entries) {
    const name = cleanRoleName(entry.name);
    if (name.length === 0) {
      errors.push("The name cannot be blank.");
      continue;
    }
    if (name.length > ROLE_LIMITS.nameMax) {
      errors.push(`The name can be at most ${ROLE_LIMITS.nameMax} characters.`);
      continue;
    }
    if (seen.has(key(name))) {
      errors.push(`The role "${name.slice(0, 40)}" appears more than once.`);
      continue;
    }
    seen.add(key(name));
    const found = liveRoles.filter((r) => key(r.name) === key(name));
    if (found.length > 1) {
      errors.push(
        `Two roles are called "${name.slice(0, 40)}". Pick the one you mean from the list.`,
      );
      continue;
    }
    if (found.length === 1) {
      planned.push({
        name: found[0].name,
        action: "existing",
        existingId: found[0].id,
      });
    } else {
      creating += 1;
      planned.push({ name, action: "create" });
    }
  }
  if (
    errors.length === 0 &&
    creating > 0 &&
    liveRoles.length + creating > ROLE_LIMITS.guildRoles
  ) {
    errors.push(
      `This server has ${liveRoles.length} roles; Discord's limit is ${ROLE_LIMITS.guildRoles}.`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  const planId = createHash("sha256")
    .update(JSON.stringify(planned))
    .digest("hex")
    .slice(0, 16);
  return { ok: true, entries: planned, planId };
}

export interface RoleCreateDeps {
  guildId: string;
  /** The write-REST client (`createWriteRest`). */
  rest: Pick<REST, "post" | "delete">;
  /** `cancellableCall` bound to the CommandManager. */
  call: <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    opName: string,
    retryOnTimeout: boolean,
  ) => Promise<T>;
  /** The live roles, read fresh, @everyone included. */
  listRoles: () => Promise<RoleView[]>;
  /** The audit-log reason Discord records. */
  reason: string;
  /**
   * A read made inside the lock, after the roles were read: why something else
   * is creating roles right now (an adoption apply), or null. A reason refuses
   * the apply with nothing created.
   */
  busyReason?: () => Promise<string | null>;
  /**
   * The ids anything now points at (role groups, stored settings), read fresh.
   * After a failed create, a role this call made that is in this set is KEPT
   * and reported, not deleted: another save may have adopted it while a later
   * create was pending. Read inside the lock, bounded. When it cannot be read,
   * nothing is deleted and every created role is reported as possibly still
   * there. Absent: every created role is removed.
   */
  referenced?: () => Promise<ReadonlySet<string>>;
  /**
   * Abandons the apply while it still waits for the lock (a closed request).
   * An apply that has started is never cut off by it.
   */
  signal?: AbortSignal;
}

export interface AppliedRole {
  id: string;
  name: string;
  /** Discord's position for the new role; 0 for a role that already existed. */
  position: number;
  /** False when the name already existed and was selected. */
  created: boolean;
}

export type RoleApplyResult =
  | { ok: true; roles: AppliedRole[] }
  | {
      ok: false;
      error: string;
      /** Roles this call created and deleted again. */
      removed: string[];
      /** Roles this call created and kept, because something now points at them. */
      kept?: string[];
      /** Roles this call created and could not delete: they still exist. */
      stuck: string[];
      /** Why the failed create failed, without the account of the roles. */
      cause?: string;
    };

const NOT_READ =
  "KoolBot couldn't read the roles from Discord, so nothing was created. Try again.";
const CHANGED =
  "The roles on the server changed since Review, so nothing was created. Review the changes again.";

export async function applyRolePlan(
  deps: RoleCreateDeps,
  entries: readonly RolePlanEntry[],
  reviewedPlanId: string,
): Promise<RoleApplyResult> {
  const held = await withRoleLock(
    deps.guildId,
    () => applyLocked(deps, entries, reviewedPlanId),
    deps.signal,
  );
  if (held.ok) return held.value;
  return {
    ok: false,
    error: ROLE_LOCK_BUSY_MESSAGE,
    removed: [],
    stuck: [],
  };
}

async function applyLocked(
  deps: RoleCreateDeps,
  entries: readonly RolePlanEntry[],
  reviewedPlanId: string,
): Promise<RoleApplyResult> {
  const nothing = (error: string): RoleApplyResult => ({
    ok: false,
    error,
    removed: [],
    stuck: [],
  });
  let live: RoleView[];
  let busy: string | null = null;
  try {
    live = await readWithin(() => deps.listRoles());
    if (deps.busyReason) busy = await readWithin(() => deps.busyReason!());
  } catch (error) {
    logger.warn("role create: could not read the roles", error);
    return nothing(NOT_READ);
  }
  if (busy) return nothing(`${busy} Nothing was created. Try again later.`);
  const plan = planRoles(entries, live);
  if (!plan.ok) return nothing(plan.errors.join(" "));
  if (plan.planId !== reviewedPlanId) return nothing(CHANGED);

  const done: AppliedRole[] = [];
  const createdIds: string[] = [];
  for (const entry of plan.entries) {
    if (entry.action === "existing") {
      done.push({
        id: entry.existingId as string,
        name: entry.name,
        position: 0,
        created: false,
      });
      continue;
    }
    try {
      // A create is not idempotent: never retry it after a timeout.
      const created = (await deps.call(
        (signal) =>
          deps.rest.post(Routes.guildRoles(deps.guildId), {
            body: { name: entry.name, ...ROLE_BODY },
            reason: deps.reason,
            signal,
          }),
        "create role",
        false,
      )) as { id: string; name: string; position?: number };
      createdIds.push(created.id);
      done.push({
        id: created.id,
        name: created.name,
        position: created.position ?? 0,
        created: true,
      });
    } catch (error) {
      const { removed, kept, stuck } = await cleanUp(deps, createdIds);
      return {
        ok: false,
        error: failureMessage(error, createdIds.length, removed, kept, stuck),
        removed,
        kept,
        stuck,
        cause: failureCause(error, createdIds.length),
      };
    }
  }
  return { ok: true, roles: done };
}

function failureCause(error: unknown, createdBefore: number): string {
  const root = unwrapWriteError(error);
  // The shared rate-limit text talks about channel renames; a role create gets
  // its own words, for the first role as for a later one.
  if (root instanceof RateLimitError) {
    const seconds = Math.max(1, Math.ceil(rateLimitWaitMs(root) / 1000));
    const wait =
      seconds < 60
        ? `${seconds} seconds`
        : `${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? "" : "s"}`;
    return createdBefore === 0
      ? `Discord is limiting changes right now, so the request to create the role was cancelled and nothing was created. Try again in about ${wait}.`
      : `Discord is limiting changes right now, so the request to create the next role was cancelled.`;
  }
  return describeWriteFailure(root);
}

function failureMessage(
  error: unknown,
  createdBefore: number,
  removed: readonly string[],
  kept: readonly string[],
  stuck: readonly string[],
): string {
  const cause = failureCause(error, createdBefore);
  if (createdBefore === 0) return cause;
  if (kept.length > 0 || stuck.length > 0) {
    const keptText =
      kept.length > 0
        ? ` Kept, because a role group or a saved setting now points at ${kept.length === 1 ? "it" : "them"}: ${kept.join(", ")}.`
        : "";
    const stuckText =
      stuck.length > 0
        ? ` These roles were created earlier in this request and could not be removed again or checked, so they may still exist: ${stuck.join(", ")}. Check them in Discord before trying again.`
        : "";
    return `${cause}${keptText}${stuckText}`;
  }
  return `${cause} The ${removed.length === 1 ? "role" : "roles"} created earlier in this request ${removed.length === 1 ? "was" : "were"} removed again.`;
}

/**
 * What a failed create does with the roles the same call made earlier: delete
 * those nothing points at (`deps.referenced`), keep the rest.
 */
async function cleanUp(
  deps: RoleCreateDeps,
  ids: readonly string[],
): Promise<{ removed: string[]; kept: string[]; stuck: string[] }> {
  if (ids.length === 0 || !deps.referenced) {
    return { ...(await removeAgain(deps, ids)), kept: [] };
  }
  let referenced: ReadonlySet<string>;
  try {
    referenced = await readWithin(() => deps.referenced!());
  } catch (error) {
    logger.warn("role create: could not read the references", error);
    return { removed: [], kept: [], stuck: [...ids] };
  }
  const kept = ids.filter((id) => referenced.has(id));
  const gone = await removeAgain(
    deps,
    ids.filter((id) => !referenced.has(id)),
  );
  return { ...gone, kept };
}

/**
 * Delete roles one apply created, newest first. A role already gone counts as
 * removed. For a caller whose own later work failed after `applyRolePlan` had
 * succeeded (the wizard's apply); the helper uses it for its own failures. It
 * takes no lock: it deletes only the ids it is given, which this caller created
 * a moment ago. A role that anything now points at is the caller's to keep (see
 * the known limit in `wizard-role-create.ts`, #1748).
 */
export async function removeCreatedRoles(
  deps: Pick<RoleCreateDeps, "guildId" | "rest" | "call" | "reason">,
  ids: readonly string[],
): Promise<{ removed: string[]; stuck: string[] }> {
  return removeAgain(deps, ids);
}

async function removeAgain(
  deps: Pick<RoleCreateDeps, "guildId" | "rest" | "call" | "reason">,
  ids: readonly string[],
): Promise<{ removed: string[]; stuck: string[] }> {
  const removed: string[] = [];
  const stuck: string[] = [];
  for (const id of [...ids].reverse()) {
    try {
      await deps.call(
        (signal) =>
          deps.rest.delete(Routes.guildRole(deps.guildId, id), {
            reason: deps.reason,
            signal,
          }),
        "remove created role",
        true,
      );
      removed.push(id);
    } catch (error) {
      const cause = unwrapWriteError(error);
      if (cause instanceof DiscordAPIError && cause.status === 404) {
        removed.push(id);
      } else {
        logger.error("role create: could not remove a created role", error);
        stuck.push(id);
      }
    }
  }
  return { removed, stuck };
}
