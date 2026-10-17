/**
 * Role Groups — create, edit, reorder, delete and apply (#1020).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 *
 * Group writes only change the saved *desired* state. Discord is written
 * solely by `/role-groups/apply` and the optional role deletion in
 * `/role-groups/:id/delete-role/apply` (after a previewed plan and a typed
 * role name), both through the adoption engine (plan → snapshot → apply),
 * never directly from here.
 */

import { Router } from "express";
import { Client, PermissionsBitField, type Guild } from "discord.js";
import logger from "../../../utils/logger.js";
import { RoleGroupService } from "../../../services/role-group-service.js";
import {
  planAdminFix,
  planRoleDeletion,
  roleDeletionRevalidator,
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
import { ROLE_DELETE_REVIEW_MINUTES } from "../../role-groups-views.js";
import { verifyRoleDeleteReview } from "../../review-token.js";
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
      let group = await groups().get(session.guildId, id);
      if (group && !group.unlinked && group.roleId) {
        // The role may have been deleted while the sync is switched off:
        // that is a fact, so record it and carry on.
        const guild = await fetchGuild(session.guildId);
        const roles = guild
          ? await guild.roles.fetch().catch(() => null)
          : null;
        if (roles && !roles.has(group.roleId)) {
          await groups().markUnlinked(session.guildId, id, group.roleId);
          group = await groups().get(session.guildId, id);
        }
      }
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

  // Removes the group and keeps its Discord role. Deleting the role as well
  // is a reviewed step of its own (`/role-groups/:id/delete-role`, #1184).
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
      if (getString(req, "roleAction") === "delete") {
        // Never delete a role from a single POST: send the admin to the
        // preview, which asks for the role name.
        flashRedirect(res, PAGE, {
          type: "warn",
          text: "Deleting the Discord role needs a review first. Use “Review deleting the group and its Discord role” on the group.",
        });
        return;
      }
      await groups().remove(session.guildId, id);
      await recordAudit(session, {
        action: "role-groups.delete",
        targetId: id,
        details: { name: group.name, roleId: group.roleId, deleteRole: false },
        result: "success",
      });
      flashRedirect(res, PAGE, {
        type: "ok",
        text: `Group "${group.name}" removed. Its Discord role was kept.`,
      });
    }),
  );

  // Applies the previewed deletion of a group's Discord role (#1184): the plan
  // id must match what the admin reviewed, and the role's name must be typed.
  router.post(
    "/role-groups/:id/delete-role/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      // Everything the request carries is read here, before the first await.
      const planId = getString(req, "planId");
      const approvedAt = getString(req, "approvedAt");
      const typedName = getString(req, "confirmName").trim();
      const reviewToken = getString(req, "reviewToken");
      const sessionId = session.sessionId;
      // The stamp is only trusted if the server issued it for this session,
      // group and plan: a role KoolBot created has no approval in its plan, so
      // the plan id alone would not notice a refreshed timestamp.
      if (
        !verifyRoleDeleteReview(reviewToken, sessionId, id, planId, approvedAt)
      ) {
        flashRedirect(res, PAGE, {
          type: "warn",
          text: "That review can't be verified. Open the review again and confirm.",
        });
        return;
      }
      const stamp = Date.parse(approvedAt);
      const age = Date.now() - stamp;
      if (
        Number.isNaN(stamp) ||
        new Date(stamp).toISOString() !== approvedAt ||
        age < -60_000 ||
        age > ROLE_DELETE_REVIEW_MINUTES * 60_000
      ) {
        flashRedirect(res, PAGE, {
          type: "warn",
          text: "That review expired. Open the review again and confirm.",
        });
        return;
      }
      const group = await groups().get(session.guildId, id);
      if (!group) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "That group no longer exists.",
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
      // A role KoolBot created needs no approval; the typed name below is the
      // approval for any other.
      const approved = !group.createdByKoolbot;
      const { plan, extraErrors } = await planRoleDeletion(
        guild,
        session.discordUserId,
        group,
        approved,
        approvedAt,
      );
      if (plan.id !== planId) {
        flashRedirect(res, PAGE, {
          type: "warn",
          text: "The server or the group changed since you reviewed the deletion. Open the review again.",
        });
        return;
      }
      const blocked = [...plan.errors, ...extraErrors];
      if (blocked.length > 0) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: `The role can't be deleted: ${blocked.map((e) => e.message).join(" ")} The group was kept.`,
        });
        return;
      }
      const step = plan.operations.find((o) => o.type === "role.delete");
      const roleName = step?.before?.["name"];
      if (!step || typeof roleName !== "string") {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "There is no Discord role to delete any more. The group was kept.",
        });
        return;
      }
      if (typedName !== roleName) {
        flashRedirect(res, PAGE, {
          type: "err",
          text: "The name you typed doesn't match the role, so nothing was deleted.",
        });
        return;
      }
      const engine = await ServerAdoptionService.getInstance(client, guild);
      let jobId: string;
      try {
        jobId = engine.startApply(plan, {
          actor: session,
          // Required for the destructive role delete: the engine re-checks
          // the live server before running it (#1097).
          revalidate: roleDeletionRevalidator(
            guild,
            session.discordUserId,
            group,
            approved,
            approvedAt,
          ),
        }).id;
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown error";
        logger.error("role groups: role delete failed to start", error);
        await recordAudit(session, {
          action: "role-groups.delete",
          targetId: id,
          details: { name: group.name, roleId: group.roleId, deleteRole: true },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, PAGE, {
          type: "err",
          text: `The role can't be deleted: ${text} The group was kept.`,
        });
        return;
      }
      await groups().remove(session.guildId, id);
      await recordAudit(session, {
        action: "role-groups.delete",
        targetId: id,
        details: { name: group.name, roleId: group.roleId, deleteRole: true },
        result: "success",
      });
      res.redirect(303, `${PAGE}?job=${encodeURIComponent(jobId)}`);
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
        grantAdministrator: getString(req, "grant") === "1",
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
            grantAdministrator: choice.grantAdministrator,
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
