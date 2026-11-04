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
import { PICKER_CREATE_PREFIX } from "../../setting-pickers.js";
import { splitCreateValues } from "../../permissions-create-values.js";
import {
  flashKeepingTail,
  flashRedirect,
  getString,
  idList,
  requireSessionContext,
  asyncHandler,
} from "./helpers.js";

/**
 * What became of the roles a failed save had created, as the tail of a flash
 * (kept whole by `flashKeepingTail`; the ids are capped by `idList`).
 */
function recoveryText(left: {
  removed: readonly string[];
  kept: readonly string[];
  stuck: readonly string[];
}): string {
  const parts: string[] = [];
  if (left.removed.length > 0) {
    parts.push(
      ` The ${left.removed.length === 1 ? "role" : "roles"} created for this save ${left.removed.length === 1 ? "was" : "were"} removed again.`,
    );
  }
  if (left.kept.length > 0) {
    parts.push(
      ` Kept, because something now points at ${left.kept.length === 1 ? "it" : "them"}: ${idList(left.kept)}.`,
    );
  }
  if (left.stuck.length > 0) {
    parts.push(
      ` Could not be removed or checked, so ${left.stuck.length === 1 ? "it" : "they"} may still exist, check in Discord: ${idList(left.stuck)}.`,
    );
  }
  return parts.join("");
}

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
        // A `create:<Name>` value is one role name, and a role name may hold
        // commas: it is never split. Plain ids and group references keep the
        // legacy comma-separated form.
        submitted = rawRoleIds.startsWith(PICKER_CREATE_PREFIX)
          ? [rawRoleIds]
          : rawRoleIds
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
      } else {
        submitted = [];
      }
      // A `create:<Name>` value is a role that does not exist yet (the Picker's
      // create row, #1666). It is taken out first, so it is never read as a role
      // id or a group reference and never stored as it was posted (#1760).
      const typed = splitCreateValues(submitted);
      if (typed.errors.length > 0) {
        flashRedirect(res, "/admin/permissions", {
          type: "err",
          text: `${typed.errors.join(" ")} Nothing was created or saved.`,
        });
        return;
      }
      // The picker offers role groups next to raw roles (#1023); group
      // entries arrive as `group:<id>` / `group:<id>+` tokens.
      const { roleIds: pickedIds, groupRefs } = splitRoleRefs(typed.rest);
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

      // Roles first, then use: the typed names become role ids before the save
      // (the Setup Wizard's order). Closing the tab abandons a create that still
      // waits for the role lock; one that has started is not cut off.
      let roleIds = pickedIds;
      let created: Array<{ id: string; name: string }> = [];
      let cleanup:
        | (() => Promise<{
            removed: string[];
            kept: string[];
            stuck: string[];
          }>)
        | null = null;
      if (typed.names.length > 0) {
        const gone = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) gone.abort();
        };
        res.once("close", onClose);
        if (res.destroyed) onClose();
        // Loaded only here: it pulls in the Discord write code.
        const { resolvePermissionRoles } =
          await import("../../permissions-role-create.js");
        const resolved = await resolvePermissionRoles(
          client,
          session.guildId,
          session.discordUserId,
          typed.names,
          gone.signal,
        );
        if (!resolved.ok) {
          await recordAudit(session, {
            action: "permissions.set",
            targetId: command,
            details: {
              before,
              beforeGroupRefs,
              attempted: pickedIds,
              groupRefs,
              createRoles: typed.names,
              removed: resolved.removed,
              kept: resolved.kept,
              stuck: resolved.stuck,
            },
            result: "failure",
            errorMessage: resolved.error,
          });
          flashRedirect(res, "/admin/permissions", {
            type: "err",
            text: flashKeepingTail(
              `Nothing was saved for /${command}. ${resolved.cause ?? resolved.error}`,
              recoveryText(resolved),
            ),
          });
          return;
        }
        roleIds = [
          ...new Set([...pickedIds, ...resolved.roles.map((r) => r.id)]),
        ];
        created = resolved.roles
          .filter((r) => r.created)
          .map((r) => ({ id: r.id, name: r.name }));
        cleanup = resolved.createdIds.length > 0 ? resolved.cleanup : null;
      }
      const createdDetails = created.length > 0 ? { created } : {};

      let saved = false;
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
        saved = true;
        await recordAudit(session, {
          action: "permissions.set",
          targetId: command,
          details: {
            before,
            beforeGroupRefs,
            after: roleIds,
            groupRefs,
            ...createdDetails,
          },
          result: "success",
        });
        const madeText =
          created.length > 0
            ? ` Created ${created.length === 1 ? "role" : "roles"} ${created
                .slice(0, 2)
                .map((r) => `"${r.name.slice(0, 40)}"`)
                .join(
                  ", ",
                )}${created.length > 2 ? ` and ${created.length - 2} more` : ""}.`
            : "";
        flashRedirect(res, "/admin/permissions", {
          type: "ok",
          text:
            (roleIds.length === 0 && groupRefs.length === 0
              ? `Cleared restriction on /${command} (now open).`
              : `Set /${command} → ${roleIds.length} role(s)${groupRefs.length > 0 ? ` and ${groupRefs.length} group(s)` : ""}.`) +
            madeText,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Set permissions failed", err);
        // A save that failed leaves the roles this request created with nothing
        // that needs them: remove them again, unless something now points at one.
        const left =
          !saved && cleanup
            ? await cleanup().catch(
                (): { removed: string[]; kept: string[]; stuck: string[] } => ({
                  removed: [],
                  kept: [],
                  stuck: created.map((r) => r.id),
                }),
              )
            : { removed: [], kept: [], stuck: [] };
        await recordAudit(session, {
          action: "permissions.set",
          targetId: command,
          details: {
            before,
            beforeGroupRefs,
            attempted: roleIds,
            groupRefs,
            ...createdDetails,
            ...(created.length > 0
              ? {
                  removed: left.removed,
                  kept: left.kept,
                  stuck: left.stuck,
                }
              : {}),
          },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/permissions", {
          type: "err",
          text: flashKeepingTail(
            `Failed to update /${command}: ${text}`,
            recoveryText(left),
          ),
        });
      }
    }),
  );

  return router;
}
