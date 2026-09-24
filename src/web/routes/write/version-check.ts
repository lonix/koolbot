/**
 * Dashboard "Check now" for the update check (#1029).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import { VersionCheckService } from "../../../services/version-check-service.js";
import { recordAudit } from "../../audit.js";
import {
  asyncHandler,
  flashRedirect,
  requireSessionContext,
} from "./helpers.js";

export function createVersionCheckRouter(client: Client): Router {
  const router = Router();

  router.post(
    "/version/check",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const snapshot = await VersionCheckService.getInstance(client).checkNow();
      await recordAudit(session, {
        action: "version.check",
        details: {
          status: snapshot.status,
          latest: snapshot.latest?.version ?? null,
        },
        result: snapshot.status === "error" ? "failure" : "success",
        errorMessage: snapshot.lastError,
      });
      const flash = ((): { type: "ok" | "warn" | "err"; text: string } => {
        switch (snapshot.status) {
          case "disabled":
            return {
              type: "warn",
              text: "The update check is off (core.updatecheck.enabled).",
            };
          case "error":
            return {
              type: "err",
              text: `Couldn't check for updates: ${snapshot.lastError ?? "unknown error"}`,
            };
          case "update-available":
            return {
              type: "warn",
              text: `Update available: ${snapshot.latest?.version ?? "?"} (${snapshot.updateKind ?? "?"}).`,
            };
          case "up-to-date":
            return { type: "ok", text: "KoolBot is up to date." };
          default:
            return { type: "ok", text: "Update check complete." };
        }
      })();
      flashRedirect(res, "/admin/", flash);
    }),
  );

  return router;
}
