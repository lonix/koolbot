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
import { ADMIN_ONLY_COMMAND } from "../../../services/command-registry.js";
import { RoleGroupService } from "../../../services/role-group-service.js";
import {
  parseGroupRef,
  splitRoleRefs,
} from "../../../services/role-group-access.js";
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

      if (command === ADMIN_ONLY_COMMAND) {
        flashRedirect(res, "/admin/permissions", {
          type: "err",
          text: "/config is always Administrator-only; its roles cannot be changed.",
        });
        return;
      }

      // <select multiple> posts an array; a single value posts a string;
      // nothing selected posts no field at all.
      const rawRoleIds = (req.body as Record<string, unknown> | undefined)
        ?.roleIds;
      let submitted: string[];
      if (Array.isArray(rawRoleIds)) {
        submitted = rawRoleIds.map(String).filter(Boolean);
      } else if (typeof rawRoleIds === "string" && rawRoleIds) {
        submitted = rawRoleIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        submitted = [];
      }
      // The picker offers role groups next to raw roles (#1023); group
      // entries arrive as `group:<id>` / `group:<id>+` tokens.
      const { roleIds, groupRefs } = splitRoleRefs(submitted);
      if (groupRefs.length > 0) {
        const groups = await RoleGroupService.getInstance()
          .list(session.guildId)
          .catch(() => null);
        const unknown = groupRefs.find(
          (ref) => !groups?.some((g) => g.id === parseGroupRef(ref)?.groupId),
        );
        if (unknown !== undefined) {
          flashRedirect(res, "/admin/permissions", {
            type: "err",
            text: groups
              ? "One of the selected role groups no longer exists. Reload the page and try again."
              : "Could not read the role groups, so nothing was saved. Try again.",
          });
          return;
        }
      }

      const permissions = PermissionsService.getInstance(client);
      const before = await permissions
        .getCommandPermissions(session.guildId, command)
        .catch(() => null);
      // Snapshot the groups too, so the audit record shows the whole previous
      // restriction when a group-based one is replaced or cleared (#1023).
      const beforeGroupRefs = await permissions
        .getCommandGroupRefs(session.guildId, command)
        .catch(() => null);

      try {
        if (roleIds.length === 0 && groupRefs.length === 0) {
          await permissions.clearCommandPermissions(session.guildId, command);
        } else {
          await permissions.setCommandPermissions(
            session.guildId,
            command,
            roleIds,
            groupRefs,
          );
        }
        await recordAudit(session, {
          action: "permissions.set",
          targetId: command,
          details: {
            before,
            beforeGroupRefs,
            after: roleIds,
            groupRefs,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/permissions", {
          type: "ok",
          text:
            roleIds.length === 0 && groupRefs.length === 0
              ? `Cleared restriction on /${command} (now open).`
              : `Set /${command} → ${roleIds.length} role(s)${groupRefs.length > 0 ? ` and ${groupRefs.length} group(s)` : ""}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Set permissions failed", err);
        await recordAudit(session, {
          action: "permissions.set",
          targetId: command,
          details: {
            before,
            beforeGroupRefs,
            attempted: roleIds,
            groupRefs,
          },
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
