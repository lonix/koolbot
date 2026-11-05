/**
 * Roles typed into the Command permissions Picker (#1760): a `create:<Name>`
 * value is a role that does not exist yet. The save creates it first, then
 * stores its id with the other roles (roles, then use, as the Setup Wizard's
 * Apply does), and removes it again when the save then fails.
 *
 *  - Names: read by `permissions-create-values.ts` (`parsePickerCreateValue`: trimmed, 1 to 100 characters),
 *    de-duplicated ignoring case, planned with `planRoles` against the live
 *    roles. A name that matches an existing role, ignoring case, selects that
 *    role (nothing is created); two roles with the name is a refusal.
 *  - Creation: `applyRolePlan` under the per-server role lock, with the plan
 *    made here re-checked inside the lock (`permissions: "0"`, bounded reads).
 *    A role someone else created with that name in between refuses the save
 *    with nothing created or stored.
 *  - Undo: `cleanup` is `cleanupCreatedRoles`: inside the lock, from a fresh
 *    read of what points at the roles, so a role something now points at is
 *    kept and reported. Only roles THIS request created are ever removed; a
 *    role that was selected by name is never touched.
 *
 * The permission check (Manage Roles) is made only when a role must be created.
 * Selecting roles that already exist needs nothing from Discord but the read.
 */

import { type Client } from "discord.js";
import { canBotCreate } from "../services/bot-create-check.js";
import { readWithin, ChannelReadTimeoutError } from "./channel-write-lock.js";
import {
  applyRolePlan,
  planRoles,
  ROLE_PLAN_CHANGED,
  type AppliedRole,
  type RoleView,
} from "./role-create.js";
import {
  cleanupCreatedRoles,
  roleCreateDeps,
  type RoleCleanup,
} from "./wizard-role-create.js";
import logger from "../utils/logger.js";

const NOT_CHECKED =
  "KoolBot could not check whether it may create roles, so nothing was created or saved. Try again.";
const NOT_SIGNED_IN =
  "The bot isn't signed in to Discord yet, so nothing was created or saved.";
const NOT_READ =
  "KoolBot couldn't read the roles from Discord, so nothing was created or saved. Try again.";
const CHANGED =
  "A role on the server changed while this was being saved, so nothing was created or saved. Try again.";

export type PermissionRoles =
  | {
      ok: true;
      /** One per typed name, in typed order. */
      roles: AppliedRole[];
      /** The ids this request created (never a role selected by name). */
      createdIds: string[];
      /** Removes `createdIds` again, reference-aware; call it when the save fails. */
      cleanup: () => Promise<RoleCleanup>;
    }
  | {
      ok: false;
      error: string;
      /**
       * Why a create failed, without the account of the roles (`removed`,
       * `kept`, `stuck`), which the caller words once. Absent for a refusal.
       */
      cause?: string;
      /** Created by this request and removed again (a later create failed). */
      removed: string[];
      /** Created, then kept: something now points at them. */
      kept: string[];
      /** Created and could not be removed or checked: they may still exist. */
      stuck: string[];
    };

/**
 * Resolves the typed names to role ids: selects the ones that exist and
 * creates the rest under the role lock. Writes nothing to the database.
 */
export async function resolvePermissionRoles(
  client: Client,
  guildId: string,
  actorId: string,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<PermissionRoles> {
  const refuse = (error: string): PermissionRoles => ({
    ok: false,
    error,
    removed: [],
    kept: [],
    stuck: [],
  });
  const entries = names.map((name) => ({ name }));
  try {
    const guild = await readWithin(() => client.guilds.fetch(guildId));
    const live: RoleView[] = [
      ...(await readWithin(() => guild.roles.fetch())).values(),
    ].map((r) => ({ id: r.id, name: r.name }));
    const plan = planRoles(entries, live);
    if (!plan.ok) return refuse(`${plan.errors.join(" ")} Nothing was saved.`);

    if (plan.entries.every((e) => e.action === "existing")) {
      return {
        ok: true,
        roles: plan.entries.map((e) => ({
          id: e.existingId as string,
          name: e.name,
          position: 0,
          created: false,
        })),
        createdIds: [],
        cleanup: async () => ({ removed: [], kept: [], stuck: [] }),
      };
    }

    const can = await canBotCreate(client, guildId, { kind: "role" });
    if (can.ok === false) return refuse(`${can.reason} Nothing was saved.`);
    if (can.ok !== true) return refuse(NOT_CHECKED);
    if (!client.token) return refuse(NOT_SIGNED_IN);

    const deps = roleCreateDeps(
      client,
      guild,
      guildId,
      `KoolBot web UI, command permissions, by ${actorId}`,
      signal,
    );
    const applied = await applyRolePlan(deps, entries, plan.planId);
    if (!applied.ok) {
      return {
        ok: false,
        error: applied.error === ROLE_PLAN_CHANGED ? CHANGED : applied.error,
        cause: applied.cause,
        removed: applied.removed,
        kept: applied.kept ?? [],
        stuck: applied.stuck,
      };
    }
    const createdIds = applied.roles.filter((r) => r.created).map((r) => r.id);
    return {
      ok: true,
      roles: applied.roles,
      createdIds,
      cleanup: () => cleanupCreatedRoles(deps, createdIds),
    };
  } catch (error) {
    logger.warn("command permissions: creating roles failed", error);
    return refuse(
      error instanceof ChannelReadTimeoutError ? error.message : NOT_READ,
    );
  }
}
