/**
 * Permissions — replace the allowed-role list per command.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { PermissionsService } from "../../../services/permissions-service.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  requireSessionContext,
  asyncHandler,
} from "./helpers.js";

export function createPermissionsRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Permissions — replace allowed-role list per command (issue #383)
  // ============================================================

  router.post(
    "/permissions/set",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const command = getString(req, "command");
      if (!command) {
        flashRedirect(res, "/admin/permissions", {
          type: "err",
          text: "Missing command name.",
        });
        return;
      }

      // <select multiple> posts an array; a single value posts a string;
      // nothing selected posts no field at all.
      const rawRoleIds = (req.body as Record<string, unknown> | undefined)
        ?.roleIds;
      let roleIds: string[];
      if (Array.isArray(rawRoleIds)) {
        roleIds = rawRoleIds.map(String).filter(Boolean);
      } else if (typeof rawRoleIds === "string" && rawRoleIds) {
        roleIds = rawRoleIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        roleIds = [];
      }

      const permissions = PermissionsService.getInstance(client);
      const before = await permissions
        .getCommandPermissions(session.guildId, command)
        .catch(() => null);

      try {
        if (roleIds.length === 0) {
          await permissions.clearCommandPermissions(session.guildId, command);
        } else {
          await permissions.setCommandPermissions(
            session.guildId,
            command,
            roleIds,
          );
        }
        await recordAudit(session, {
          action: "permissions.set",
          targetId: command,
          details: { before, after: roleIds },
          result: "success",
        });
        flashRedirect(res, "/admin/permissions", {
          type: "ok",
          text:
            roleIds.length === 0
              ? `Cleared restriction on /${command} (now open).`
              : `Set /${command} → ${roleIds.length} role(s).`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Set permissions failed", err);
        await recordAudit(session, {
          action: "permissions.set",
          targetId: command,
          details: { before, attempted: roleIds },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/permissions", {
          type: "err",
          text: `Failed to update /${command}: ${text}`,
        });
      }
    }),
  );

  return router;
}
