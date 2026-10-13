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
import { rollbackRevalidator } from "../../../services/adoption-rollback-check.js";
import {
  DESTRUCTIVE_RESTORE_NOTE,
  MongoAdoptionStore,
  ServerAdoptionService,
} from "../../../services/server-adoption-service.js";
import { ADOPTION_STALE_AFTER_MS } from "../../../models/adoption-snapshot.js";
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

/** How often a running restore is looked at while waiting to audit it. */
const AUDIT_POLL_MS = 1000;

export function createAdoptionHistoryRouter(client: Client): Router {
  const router = Router();

  /**
   * Audit a restore once its job has ended, so the trail shows the real
   * outcome: the engine's second live-state check, or a failed step, can still
   * end it after the request has been answered. Never throws.
   */
  async function auditWhenDone(
    engine: Awaited<ReturnType<typeof ServerAdoptionService.getInstance>>,
    jobId: string,
    session: Parameters<typeof recordAudit>[0],
    snapshotId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      for (;;) {
        const job = engine.getRollbackJob(jobId);
        if (!job) return; // no longer tracked: nothing to report
        if (job.status !== "running") {
          const failedSteps = job.result?.failed.length ?? 0;
          const failure =
            job.status === "failed"
              ? (job.error ?? "The restore failed.")
              : failedSteps > 0
                ? `${failedSteps} step(s) failed.`
                : null;
          await recordAudit(session, {
            action: "adopt.rollback",
            targetId: snapshotId,
            details,
            result: failure === null ? "success" : "failure",
            errorMessage: failure,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, AUDIT_POLL_MS));
      }
    } catch (error) {
      logger.warn("adoption history: could not audit the restore", error);
    }
  }

  /**
   * Release the lock of an apply or rollback whose bot died (no heartbeat for
   * `ADOPTION_STALE_AFTER_MS`), using the engine's own store. Without it a
   * snapshot stuck in `rolling_back` would stay unrestorable from the UI.
   */
  async function recoverStale(guildId: string): Promise<void> {
    try {
      await new MongoAdoptionStore().recoverStale(
        guildId,
        ADOPTION_STALE_AFTER_MS,
      );
    } catch (error) {
      logger.warn("adoption history: stale recovery failed", error);
    }
  }

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
      await recoverStale(session.guildId);
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
      await recoverStale(session.guildId);
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
      await recoverStale(session.guildId);
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
        // Live-state safety check (#1134). Run here first so a refusal is
        // shown at once; the engine runs it again after claiming the snapshot,
        // before its first write.
        const store = new MongoAdoptionStore();
        const revalidate = rollbackRevalidator(guild, () => store.get(id), {
          actorId: session.discordUserId,
          deleteCreatedRoles,
        });
        let problems: string[];
        try {
          problems = await revalidate();
        } catch (error) {
          // Fail closed: if the live server can't be read, don't restore.
          logger.warn("adoption history: restore check failed", error);
          problems = ["the live server state could not be read"];
        }
        if (problems.length > 0) {
          const text = `Restore refused, nothing was changed: ${problems.join(" ")}`;
          await recordAudit(session, {
            action: "adopt.rollback",
            targetId: id,
            details: { planId: snapshot.planId, deleteCreatedRoles, problems },
            result: "failure",
            errorMessage: text,
          });
          flashRedirect(res, HISTORY_PATH, { type: "err", text });
          return;
        }
        const job = engine.startRollback(id, {
          actor: session,
          deleteCreatedRoles,
          revalidate,
        });
        // The engine re-checks and may refuse after this response, so the audit
        // entry is written when the job ends, with its real outcome.
        void auditWhenDone(engine, job.id, session, id, {
          planId: snapshot.planId,
          deleteCreatedRoles,
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
