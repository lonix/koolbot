/**
 * Weekly digest — send now.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { DigestService } from "../../../services/digest-service.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  requireSessionContext,
  asyncHandler,
} from "./helpers.js";

export function createDigestRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Weekly Digest — send now (issue #539)
  // ============================================================

  router.post(
    "/digest/send-now",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const service = DigestService.getInstance(client);
      try {
        const summary = await service.runNow();
        if (!summary) {
          // runNow returns null only when the feature is disabled or
          // GUILD_ID is unset. Concurrent invocations don't return null —
          // they coalesce onto the in-flight run via `inFlight`.
          await recordAudit(session, {
            action: "digest.send-now",
            result: "failure",
            errorMessage: "digest disabled or GUILD_ID unset",
          });
          flashRedirect(res, "/admin/digest", {
            type: "warn",
            text: "Digest did not run — it is disabled or GUILD_ID is not configured.",
          });
          return;
        }
        await recordAudit(session, {
          action: "digest.send-now",
          details: {
            qualifying: summary.qualifying,
            sent: summary.sent,
            skippedOptOut: summary.skippedOptOut,
            skippedDmsClosed: summary.skippedDmsClosed,
            failed: summary.failed,
          },
          result: summary.failed > 0 ? "failure" : "success",
          errorMessage:
            summary.failed > 0 ? `${summary.failed} delivery error(s)` : null,
        });
        flashRedirect(res, "/admin/digest", {
          type: summary.failed > 0 ? "warn" : "ok",
          text: `Digest sent. ${summary.sent} delivered · ${summary.skippedOptOut} opted out · ${summary.skippedDmsClosed} DMs closed · ${summary.failed} failed.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("digest send-now failed", err);
        await recordAudit(session, {
          action: "digest.send-now",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/digest", {
          type: "err",
          text: `Digest send failed: ${text}`,
        });
      }
    }),
  );

  return router;
}
