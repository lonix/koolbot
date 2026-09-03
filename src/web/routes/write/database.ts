/**
 * Database — dbtrunk (voice-tracking truncation).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import { VoiceChannelTruncationService } from "../../../services/voice-channel-truncation.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  requireSessionContext,
  asyncHandler,
} from "./helpers.js";

export function createDatabaseRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Database — dbtrunk (issue #384)
  // ============================================================

  router.post(
    "/database/run-cleanup",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const service = VoiceChannelTruncationService.getInstance(client);
      try {
        const stats = await service.runCleanup();
        const skipped = stats.skipped === true;
        const hasErrors = stats.errors.length > 0 && !skipped;
        await recordAudit(session, {
          action: "dbtrunk.run",
          details: {
            sessionsRemoved: stats.sessionsRemoved,
            dataAggregated: stats.dataAggregated,
            executionTime: stats.executionTime,
            errors: hasErrors ? stats.errors.length : 0,
            skipped,
          },
          result: hasErrors ? "failure" : "success",
          errorMessage: hasErrors ? stats.errors.slice(0, 3).join("; ") : null,
        });
        if (skipped) {
          flashRedirect(res, "/admin/database", {
            type: "warn",
            text: "Cleanup skipped: 24-hour minimum interval not met since the last run.",
          });
          return;
        }
        if (hasErrors) {
          flashRedirect(res, "/admin/database", {
            type: "err",
            text: `Cleanup finished with errors: ${stats.errors.slice(0, 3).join("; ")}`,
          });
          return;
        }
        flashRedirect(res, "/admin/database", {
          type: "ok",
          text: `Cleanup complete. Removed ${stats.sessionsRemoved} sessions across ${stats.dataAggregated} users in ${stats.executionTime}ms.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("dbtrunk run failed", err);
        await recordAudit(session, {
          action: "dbtrunk.run",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/database", {
          type: "err",
          text: `Cleanup failed: ${text}`,
        });
      }
    }),
  );

  return router;
}
