/**
 * Role Groups — create, edit, reorder, delete and apply (#1020).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 *
 * Group writes only change the saved *desired* state. Discord is written
 * solely by `/role-groups/apply` and the optional role deletion in
 * `/role-groups/:id/delete`, both through the adoption engine (plan →
 * snapshot → apply), never directly from here.
 */

import { Router } from "express";
import { Client, PermissionsBitField, type Guild } from "discord.js";
import logger from "../../../utils/logger.js";
import { RoleGroupService } from "../../../services/role-group-service.js";
import {
  planAdminFix,
  planRoleDeletion,
  planRoleGroups,
  planIsApplicable,
} from "../../../services/role-group-adoption.js";
import { ROLE_GROUP_SYNC_POLICIES } from "../../../models/role-group.js";
import { ServerAdoptionService } from "../../../services/server-adoption-service.js";
import {
  parseColour,
  roleLockReason,
} from "../../../services/role-group-plan.js";
import { recordAudit } from "../../audit.js";
import {
  asyncHandler,
  flashRedirect,
  getCheckbox,
  getString,
  requireSessionContext,
} from "./helpers.js";

const PAGE = "/admin/role-groups";

function toArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === "string" ? [raw] : [];
}

/** Permission names ticked in the form → decimal bitfield, or null if unknown names. */
export function permissionsFromNames(names: string[]): string | null {
  let bits = 0n;
  for (const name of names) {
    const flag = (PermissionsBitField.Flags as Record<string, bigint>)[name];
    if (flag === undefined) return null;
    bits |= flag;
  }
  return bits.toString();
}

export function createRoleGroupsRouter(client: Client): Router {
  const router = Router();
  const groups = (): RoleGroupService => RoleGroupService.getInstance();

  async function fetchGuild(guildId: string): Promise<Guild | null> {
    try {
      return await client.guilds.fetch(guildId);
    } catch (error) {
      logger.warn("role groups: guild fetch failed", error);
      return null;
    }
  }

  router.post(
    "/role-groups/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const roleId = getString(req, "roleId");
      const colour = parseColour(getString(req, "colour"));
      if (colour === undefined) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Colour must look like #RRGGBB.",
        });
        return;
      }
      const capabilities = toArray(body["capability"]);
      let name = getString(req, "name");
      let gateOnly = false;
      let roleName: string | null = null;
      let permissions: string | null = null;

      if (roleId) {
        const guild = await fetchGuild(session.guildId);
        const me = guild
          ? (guild.members.me ??
            (await guild.members.fetchMe().catch(() => null)))
          : null;
        const role = guild
          ? (await guild.roles.fetch().catch(() => null))?.get(roleId)
          : undefined;
        if (!guild || !me || !role) {
          flashRedirect(res, PAGE, {
            type: "err",
            text: "That role couldn't be read from Discord. Reload and try again.",
          });
          return;
        }
        const lock = roleLockReason(
          {
            id: role.id,
            managed: role.managed,
            position: role.position,
          },
          guild.id,
          me.roles.highest.position,
        );
        if (lock === "everyone" || lock === "hierarchy") {
          flashRedirect(res, PAGE, {
            type: "err",
            text:
              lock === "everyone"
                ? "@everyone can't be a group."
                : "That role is at or above the bot's own role, so it can't be linked.",
          });
          return;
        }
        gateOnly = lock === "managed";
        roleName = role.name;
        name ||= role.name;
      }
      if (!gateOnly && (!roleId || getCheckbox(req, "editPermissions"))) {
        permissions = permissionsFromNames(toArray(body["perm"]));
        if (permissions === null) {
          flashRedirect(res, PAGE, {
            type: "err",
            text: "Unknown permission in the form.",
          });
          return;
        }
      }
      const result = await groups().create(session.guildId, {
        name,
        roleId: roleId || null,
        roleName,
        capabilities,
        permissions,
        colour: gateOnly ? null : colour,
        gateOnly,
      });
      await recordAudit(session, {
        action: "role-groups.create",
        targetId: result.ok ? result.group.id : null,
        details: { name, roleId: roleId || null, capabilities, gateOnly },
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      flashRedirect(
        res,
        PAGE,
        result.ok
          ? {
              type: "ok",
              text: `Group "${result.group.name}" saved. Review the plan below to apply it to Discord.`,
            }
          : { type: "err", text: result.error },
      );
    }),
  );

  router.post(
    "/role-groups/reorder",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const groupId = getString(req, "groupId");
      const direction = getString(req, "direction");
      const list = await groups().list(session.guildId);
      const i = list.findIndex((g) => g.id === groupId);
      const j = direction === "up" ? i - 1 : direction === "down" ? i + 1 : -1;
      if (i < 0 || j < 0 || j >= list.length) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "That move isn't possible. Reload and try again.",
        });
        return;
      }
      const ids = list.map((g) => g.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      const result = await groups().reorder(session.guildId, ids);
      await recordAudit(session, {
        action: "role-groups.reorder",
        targetId: groupId,
        details: { direction },
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      flashRedirect(
        res,
        PAGE,
        result.ok
          ? { type: "ok", text: "Order saved. Review the plan to apply it." }
          : { type: "err", text: result.error },
      );
    }),
  );

  router.post(
    "/role-groups/:id/edit",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const current = await groups().get(session.guildId, id);
      if (!current) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "That group no longer exists.",
        });
        return;
      }
      const colour = parseColour(getString(req, "colour"));
      if (colour === undefined) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Colour must look like #RRGGBB.",
        });
        return;
      }
      let permissions: string | null | undefined;
      if (!current.gateOnly) {
        permissions =
          getCheckbox(req, "editPermissions") || current.roleId === null
            ? permissionsFromNames(toArray(body["perm"]))
            : null;
        if (permissions === null && getCheckbox(req, "editPermissions")) {
          flashRedirect(res, PAGE, {
            type: "err",
            text: "Unknown permission in the form.",
          });
          return;
        }
      }
      const policyRaw = getString(req, "syncPolicy");
      if (
        policyRaw !== "" &&
        !(ROLE_GROUP_SYNC_POLICIES as readonly string[]).includes(policyRaw)
      ) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Unknown sync policy.",
        });
        return;
      }
      const result = await groups().update(session.guildId, id, {
        name: getString(req, "name"),
        capabilities: toArray(body["capability"]),
        permissions,
        colour: current.gateOnly ? undefined : colour,
      });
      if (result.ok) {
        await groups().setSyncPolicy(
          session.guildId,
          id,
          policyRaw === ""
            ? null
            : (policyRaw as (typeof ROLE_GROUP_SYNC_POLICIES)[number]),
        );
      }
      await recordAudit(session, {
        action: "role-groups.edit",
        targetId: id,
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      flashRedirect(
        res,
        PAGE,
        result.ok
          ? { type: "ok", text: "Group saved. Review the plan to apply it." }
          : { type: "err", text: result.error },
      );
    }),
  );

  // A group whose role was deleted in Discord (#1021): re-link it to another
  // role, or ask for a new one (created by the next plan). Never automatic.
  router.post(
    "/role-groups/:id/relink",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const mode = getString(req, "mode");
      const group = await groups().get(session.guildId, id);
      if (!group?.unlinked) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "That group isn't unlinked.",
        });
        return;
      }
      let ok = false;
      let text: string;
      if (mode === "recreate" && !group.gateOnly) {
        ok = await groups().requestRecreate(session.guildId, id);
        text = ok
          ? "A new role will be created for this group. Review the plan below and apply it."
          : "That group can't be recreated.";
      } else if (mode === "link") {
        const roleId = getString(req, "roleId");
        const guild = await fetchGuild(session.guildId);
        const me = guild
          ? (guild.members.me ??
            (await guild.members.fetchMe().catch(() => null)))
          : null;
        const role = guild
          ? (await guild.roles.fetch().catch(() => null))?.get(roleId)
          : undefined;
        if (!guild || !me || !role) {
          flashRedirect(res, PAGE, {
            type: "err",
            text: "That role couldn't be read from Discord. Reload and try again.",
          });
          return;
        }
        const lock = roleLockReason(
          { id: role.id, managed: role.managed, position: role.position },
          guild.id,
          me.roles.highest.position,
        );
        if (
          lock === "everyone" ||
          lock === "hierarchy" ||
          (lock === "managed") !== group.gateOnly
        ) {
          text =
            lock === "managed"
              ? "That role is managed by an integration; only a gate-only group can use it."
              : group.gateOnly
                ? "A gate-only group needs an integration-managed role."
                : "That role is locked (@everyone, or at or above the bot's role).";
        } else {
          const result = await groups().relinkTo(
            session.guildId,
            id,
            role.id,
            role.name,
          );
          ok = result.ok;
          text = result.ok
            ? `Group "${group.name}" is linked to @${role.name}. Review the plan below.`
            : result.error;
        }
      } else {
        text = "Unknown action.";
      }
      await recordAudit(session, {
        action: "role-groups.relink",
        targetId: id,
        details: { mode },
        result: ok ? "success" : "failure",
        errorMessage: ok ? null : text,
      });
      flashRedirect(res, PAGE, { type: ok ? "ok" : "err", text });
    }),
  );

  router.post(
    "/role-groups/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const group = await groups().get(session.guildId, id);
      if (!group) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "That group no longer exists.",
        });
        return;
      }
      const deleteRole = getString(req, "roleAction") === "delete";
      let jobId: string | null = null;
      if (deleteRole) {
        const approved = getCheckbox(req, "approveRoleDelete");
        if (!group.createdByKoolbot && !approved) {
          flashRedirect(res, PAGE, {
            type: "err",
            text: "Deleting a role that already existed needs your explicit approval. Tick the approval box, or keep the role.",
          });
          return;
        }
        const guild = await fetchGuild(session.guildId);
        if (!guild) {
          flashRedirect(res, PAGE, {
            type: "err",
            text: "Discord couldn't be reached, so nothing was deleted.",
          });
          return;
        }
        const { plan, extraErrors } = await planRoleDeletion(
          guild,
          session.discordUserId,
          group,
          approved,
        );
        const blocked = [...plan.errors, ...extraErrors];
        if (blocked.length > 0) {
          flashRedirect(res, PAGE, {
            type: "err",
            text: `The role can't be deleted: ${blocked.map((e) => e.message).join(" ")} The group was kept.`,
          });
          return;
        }
        const engine = await ServerAdoptionService.getInstance(client, guild);
        jobId = engine.startApply(plan, { actor: session }).id;
      }
      await groups().remove(session.guildId, id);
      await recordAudit(session, {
        action: "role-groups.delete",
        targetId: id,
        details: { name: group.name, roleId: group.roleId, deleteRole },
        result: "success",
      });
      const text = deleteRole
        ? `Group "${group.name}" removed; its Discord role is being deleted.`
        : `Group "${group.name}" removed. Its Discord role was kept.`;
      const target = jobId ? `${PAGE}?job=${encodeURIComponent(jobId)}` : PAGE;
      if (jobId) {
        res.redirect(303, target);
      } else {
        flashRedirect(res, PAGE, { type: "ok", text });
      }
    }),
  );

  router.post(
    "/role-groups/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const planId = getString(req, "planId");
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Discord couldn't be reached, so nothing was applied.",
        });
        return;
      }
      const built = await planRoleGroups(guild, session.discordUserId);
      if (built.plan.id !== planId) {
        flashRedirect(res, PAGE, {
          type: "warn",
          text: "The server or the groups changed since you previewed the plan. Review the updated plan and apply again.",
        });
        return;
      }
      if (!planIsApplicable(built) || built.plan.operations.length === 0) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "This plan can't be applied. Resolve the listed problems first.",
        });
        return;
      }
      const engine = await ServerAdoptionService.getInstance(client, guild);
      try {
        const job = engine.startApply(built.plan, { actor: session });
        await recordAudit(session, {
          action: "role-groups.apply",
          targetId: built.plan.id,
          details: { operations: built.plan.operations.length },
          result: "success",
        });
        res.redirect(303, `${PAGE}?job=${encodeURIComponent(job.id)}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown error";
        logger.error("role groups: apply failed to start", error);
        await recordAudit(session, {
          action: "role-groups.apply",
          targetId: built.plan.id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, PAGE, { type: "err", text });
      }
    }),
  );

  // Apply a previewed fix for administrators outside the admin group (#1021).
  router.post(
    "/role-groups/admin-fix/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const choice = {
        moveMemberIds: toArray(body["move"]),
        dropRoleIds: toArray(body["drop"]),
      };
      const planId = getString(req, "planId");
      const guild = await fetchGuild(session.guildId);
      if (!guild) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "Discord couldn't be reached, so nothing was applied.",
        });
        return;
      }
      const built = await planAdminFix(guild, session.discordUserId, choice);
      if (built.plan.id !== planId) {
        flashRedirect(res, PAGE, {
          type: "warn",
          text: "The server changed since you previewed the plan. Preview it again.",
        });
        return;
      }
      if (
        built.plan.errors.length > 0 ||
        built.extraErrors.length > 0 ||
        built.plan.operations.length === 0
      ) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "This plan can't be applied. Resolve the listed problems first.",
        });
        return;
      }
      const engine = await ServerAdoptionService.getInstance(client, guild);
      try {
        const job = engine.startApply(built.plan, { actor: session });
        await recordAudit(session, {
          action: "role-groups.admin-fix",
          targetId: built.plan.id,
          details: {
            moved: choice.moveMemberIds.length,
            dropped: choice.dropRoleIds.length,
            operations: built.plan.operations.length,
          },
          result: "success",
        });
        res.redirect(303, `${PAGE}?job=${encodeURIComponent(job.id)}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown error";
        logger.error("role groups: admin fix failed to start", error);
        await recordAudit(session, {
          action: "role-groups.admin-fix",
          targetId: built.plan.id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, PAGE, { type: "err", text });
      }
    }),
  );

  return router;
}
