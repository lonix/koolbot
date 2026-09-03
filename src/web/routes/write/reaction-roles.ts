/**
 * Reaction roles — single mappings and one-of-set groups.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { ReactionRoleService } from "../../../services/reaction-role-service.js";
import type { ReactionRoleMode } from "../../../models/reaction-role-config.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  getCheckbox,
  requireSessionContext,
  asyncHandler,
} from "./helpers.js";

export function createReactionRolesRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Reaction Roles (issue #384)
  // ============================================================

  router.post(
    "/reaction-roles/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const name = getString(req, "name");
      const emoji = getString(req, "emoji");

      if (!name || !emoji) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name and emoji are both required.",
        });
        return;
      }
      // Discord caps role names at 100 chars. Validate here so we surface a
      // clean flash instead of letting the Discord API reject the create
      // mid-rollback.
      if (name.length > 100) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name must be 100 characters or fewer.",
        });
        return;
      }
      // Emoji input is either a single Unicode codepoint cluster or a custom
      // emoji markup like `<:name:id>` / `<a:name:id>`. 100 chars is well past
      // any legitimate input and matches the form's `maxlength`.
      if (emoji.length > 100) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Emoji input must be 100 characters or fewer.",
        });
        return;
      }

      const createChannel = getCheckbox(req, "createChannel");
      // Assignment mode (#814): toggle (default) / sticky. Anything else falls
      // back to toggle so a bad form value can't reach the DB enum. (unique is
      // offered on the role-group form, not the single-role form.)
      const modeRaw = getString(req, "mode");
      const mode: ReactionRoleMode = modeRaw === "sticky" ? modeRaw : "toggle";

      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.createReactionRole(
          session.guildId,
          name,
          emoji,
          { createChannel, mode },
        );
        await recordAudit(session, {
          action: "reactionrole.create",
          targetId: result.roleId ?? null,
          details: {
            roleName: name,
            emoji,
            createChannel,
            mode,
            categoryId: result.categoryId,
            channelId: result.channelId,
            messageId: result.messageId,
          },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Create reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.create",
          details: { roleName: name, emoji },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to create reaction role: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/bind",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const roleId = getString(req, "roleId");
      const emoji = getString(req, "emoji");
      const messageId = getString(req, "messageId");

      if (!roleId || !emoji) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role ID and emoji are both required.",
        });
        return;
      }
      if (emoji.length > 100) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Emoji input must be 100 characters or fewer.",
        });
        return;
      }

      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.bindReactionRole(
          session.guildId,
          roleId,
          emoji,
          messageId ? { messageId } : {},
        );
        await recordAudit(session, {
          action: "reactionrole.bind",
          targetId: result.roleId ?? roleId,
          details: {
            roleId,
            emoji,
            messageId: result.messageId ?? messageId,
          },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Bind reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.bind",
          targetId: roleId,
          details: { roleId, emoji, messageId },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to bind reaction role: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/remove-mapping",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const messageId = getString(req, "messageId");
      const emoji = getString(req, "emoji");

      if (!messageId || !emoji) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Message ID and emoji are both required.",
        });
        return;
      }

      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.removeReactionRoleMapping(
          session.guildId,
          messageId,
          emoji,
        );
        await recordAudit(session, {
          action: "reactionrole.remove_mapping",
          targetId: messageId,
          details: { messageId, emoji },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Remove reaction role mapping failed", err);
        await recordAudit(session, {
          action: "reactionrole.remove_mapping",
          targetId: messageId,
          details: { messageId, emoji },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to remove mapping: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/archive",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const mappingId = getString(req, "mappingId");
      if (!mappingId) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Mapping id is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.archiveReactionRole(
          session.guildId,
          mappingId,
        );
        await recordAudit(session, {
          action: "reactionrole.archive",
          targetId: mappingId,
          details: { mappingId },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Archive reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.archive",
          targetId: mappingId,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to archive reaction role: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/unarchive",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const mappingId = getString(req, "mappingId");
      if (!mappingId) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Mapping id is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.unarchiveReactionRole(
          session.guildId,
          mappingId,
        );
        await recordAudit(session, {
          action: "reactionrole.unarchive",
          targetId: mappingId,
          details: { mappingId },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Unarchive reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.unarchive",
          targetId: mappingId,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to unarchive reaction role: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const mappingId = getString(req, "mappingId");
      if (!mappingId) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Mapping id is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.deleteReactionRole(
          session.guildId,
          mappingId,
        );
        await recordAudit(session, {
          action: "reactionrole.delete",
          targetId: mappingId,
          details: { mappingId },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.delete",
          targetId: mappingId,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to delete reaction role: ${text}`,
        });
      }
    }),
  );

  // Create a one-of-set role group (#814): one shared message with several
  // role options. The form posts parallel roleName[]/emoji[] arrays.
  router.post(
    "/reaction-roles/group/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const groupName = getString(req, "groupName");

      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const toArray = (raw: unknown): string[] =>
        Array.isArray(raw)
          ? raw.map(String)
          : typeof raw === "string"
            ? [raw]
            : [];
      const roleNames = toArray(body["roleName"]);
      const emojis = toArray(body["emoji"]);

      // Pair positionally and drop rows where either half is blank.
      const entries: Array<{ roleName: string; emoji: string }> = [];
      for (let i = 0; i < Math.max(roleNames.length, emojis.length); i++) {
        const roleName = (roleNames[i] ?? "").trim();
        const emoji = (emojis[i] ?? "").trim();
        if (roleName && emoji) {
          entries.push({ roleName, emoji });
        }
      }

      const modeRaw = getString(req, "mode");
      const mode: ReactionRoleMode =
        modeRaw === "sticky" || modeRaw === "toggle" ? modeRaw : "unique";

      if (!groupName) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Group name is required.",
        });
        return;
      }
      if (entries.length < 2) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "A role group needs at least two role/emoji options.",
        });
        return;
      }

      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.createReactionRoleGroup(
          session.guildId,
          groupName,
          entries,
          mode,
        );
        await recordAudit(session, {
          action: "reactionrole.group.create",
          targetId: result.groupId ?? null,
          details: {
            groupName,
            mode,
            count: entries.length,
            roleIds: result.roleIds,
            messageId: result.messageId,
          },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Create reaction role group failed", err);
        await recordAudit(session, {
          action: "reactionrole.group.create",
          details: { groupName, mode, count: entries.length },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to create role group: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/group/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const groupId = getString(req, "groupId");
      if (!groupId) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Group id is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.deleteReactionRoleGroup(
          session.guildId,
          groupId,
        );
        await recordAudit(session, {
          action: "reactionrole.group.delete",
          targetId: groupId,
          details: { groupId },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete reaction role group failed", err);
        await recordAudit(session, {
          action: "reactionrole.group.delete",
          targetId: groupId,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to delete role group: ${text}`,
        });
      }
    }),
  );

  return router;
}
