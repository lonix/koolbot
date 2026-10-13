/**
 * Adoption history and rollback (#1025).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf`.
 *
 * Nothing here writes to Discord directly: Restore hands the snapshot to the
 * adoption engine's `startRollback`, which reverts only the steps that were
 * applied, from the state saved before the apply.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import {
  DESTRUCTIVE_RESTORE_NOTE,
  ServerAdoptionService,
} from "../../../services/server-adoption-service.js";
import {
  canRollback,
  getSnapshotDetail,
  listSnapshots,
} from "../../../services/adoption-snapshot-history.js";
import { recordAudit } from "../../audit.js";
import { getDisplayedRemainingMs } from "../../admin-layout.js";
import type { FlashMessage } from "../../admin-views.js";
import {
  HISTORY_PATH,
  renderAdoptionHistoryPage,
  renderRestoreConfirmPage,
} from "../../adoption-history-view.js";
import {
  asyncHandler,
  flashRedirect,
  getCheckbox,
  getCsrfFromReq,
  navStatusForPage,
  requireSessionContext,
} from "./helpers.js";

function readFlash(req: {
  query: Record<string, unknown>;
}): FlashMessage | null {
  const type = String(req.query.flash ?? "");
  const text = String(req.query.msg ?? "");
  if (!text || (type !== "ok" && type !== "warn" && type !== "err"))
    return null;
  return { type, text: text.slice(0, 500) };
}

export function createAdoptionHistoryRouter(client: Client): Router {
  const router = Router();

  async function pageBase(
    req: Parameters<typeof requireSessionContext>[0],
  ): Promise<{
    csrfToken: string;
    remainingMs: number;
    navFeatureStatus: Awaited<ReturnType<typeof navStatusForPage>>;
  }> {
    const session = requireSessionContext(req);
    return {
      csrfToken: getCsrfFromReq(req),
      remainingMs: getDisplayedRemainingMs(session),
      navFeatureStatus: await navStatusForPage(),
    };
  }

  router.get(
    "/adopt/history",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const base = await pageBase(req);
      const pageNo = Math.min(
        10_000,
        Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1),
      );
      const listed = await listSnapshots(session.guildId, pageNo).catch(
        (error: unknown) => {
          logger.warn("adoption history: list failed", error);
          return null;
        },
      );
      const job = String(req.query.job ?? "");
      res.type("text/html").send(
        renderAdoptionHistoryPage({
          ...base,
          snapshots: listed?.snapshots ?? null,
          page: pageNo,
          hasMore: listed?.hasMore ?? false,
          flash: readFlash(req),
          jobId: /^[0-9a-f-]{36}$/i.test(job) ? job : null,
        }),
      );
    }),
  );

  router.get(
    "/adopt/history/job/:id",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const guild = await client.guilds.fetch(session.guildId);
      const engine = await ServerAdoptionService.getInstance(client, guild);
      const job = engine.getRollbackJob(String(req.params.id));
      res.setHeader("Cache-Control", "no-store");
      if (!job) {
        res.status(404).json({
          status: "unknown",
          text: "This restore is no longer tracked. Reload the page to see the current state.",
        });
        return;
      }
      const result = job.result;
      const text =
        job.status === "running"
          ? "Restoring…"
          : job.status === "failed"
            ? `Restore failed: ${job.error ?? "unknown error"}`
            : result && result.failed.length > 0
              ? `Restored ${result.restored.length} step(s); ${result.failed.length} failed: ${result.failed.map((f) => f.error).join("; ")}. Run Restore again to retry the rest.`
              : `Restored ${result?.restored.length ?? 0} step(s).`;
      res.json({ status: job.status, text });
    }),
  );

  router.get(
    "/adopt/history/:id/restore",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const base = await pageBase(req);
      const snapshot = await getSnapshotDetail(
        session.guildId,
        String(req.params.id),
      ).catch((error: unknown) => {
        logger.warn("adoption history: detail failed", error);
        return null;
      });
      if (!snapshot) {
        flashRedirect(res, HISTORY_PATH, {
          type: "warn",
          text: "That snapshot wasn't found for this server.",
        });
        return;
      }
      res.type("text/html").send(
        renderRestoreConfirmPage({
          ...base,
          snapshot,
          destructiveNote: DESTRUCTIVE_RESTORE_NOTE,
        }),
      );
    }),
  );

  router.post(
    "/adopt/history/:id/restore",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const snapshot = await getSnapshotDetail(session.guildId, id).catch(
        () => null,
      );
      if (!snapshot) {
        flashRedirect(res, HISTORY_PATH, {
          type: "warn",
          text: "That snapshot wasn't found for this server.",
        });
        return;
      }
      if (!canRollback(snapshot.status)) {
        flashRedirect(res, HISTORY_PATH, {
          type: "warn",
          text: "That snapshot can't be restored in its current state.",
        });
        return;
      }
      const deleteCreatedRoles = getCheckbox(req, "deleteCreatedRoles");
      try {
        const guild = await client.guilds.fetch(session.guildId);
        const engine = await ServerAdoptionService.getInstance(client, guild);
        const job = engine.startRollback(id, {
          actor: session,
          deleteCreatedRoles,
        });
        await recordAudit(session, {
          action: "adopt.rollback",
          targetId: id,
          details: { planId: snapshot.planId, deleteCreatedRoles },
          result: "success",
        });
        res.redirect(303, `${HISTORY_PATH}?job=${encodeURIComponent(job.id)}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : "Unknown error";
        logger.error("adoption history: restore failed to start", error);
        await recordAudit(session, {
          action: "adopt.rollback",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, HISTORY_PATH, { type: "err", text });
      }
    }),
  );

  return router;
}
