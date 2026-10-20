/**
 * Moderation cases — open a case against a kick or ban, record the outcome
 * when its review comes due, and run the due-review pass on demand (#908).
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 *
 * Every decision is recorded with `recordAudit`: it is the answer to "who let
 * them back in?" if the case itself is later pruned.
 */

import { Router } from "express";
import { Client } from "discord.js";
import { ModerationCaseService } from "../../../services/moderation-case-service.js";
import { ModerationCaseReviewService } from "../../../services/moderation-case-review-service.js";
import { recordAudit } from "../../audit.js";
import {
  CASE_DECISIONS,
  auditCaseFailure,
  decideCase,
  parseReviewDate,
} from "../../moderation-case-actions.js";
import {
  TEXT_LIMITS,
  asyncHandler,
  firstLengthError,
  flashRedirect,
  getString,
  requireSessionContext,
} from "./helpers.js";

const MODERATION_PAGE = "/admin/moderation";
export function createModerationRouter(client: Client): Router {
  const router = Router();
  const cases = (): ModerationCaseService =>
    ModerationCaseService.getInstance(client);

  router.post(
    "/moderation/cases/open",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const entryId = getString(req, "entry_id");
      const note = getString(req, "note");
      const review = parseReviewDate((name) => getString(req, name), "review");

      if (!(await cases().isEnabled())) {
        flashRedirect(res, MODERATION_PAGE, {
          type: "err",
          text: "Moderation cases are turned off.",
        });
        return;
      }
      const lengthError = firstLengthError([
        { label: "Note", value: note, max: TEXT_LIMITS.caseNote },
      ]);
      if (lengthError || !review.ok) {
        flashRedirect(res, MODERATION_PAGE, {
          type: "err",
          text: lengthError ?? (review.ok ? "" : review.reason),
        });
        return;
      }

      try {
        const created = await cases().openCase({
          guildId: session.guildId,
          entryId,
          openedByUserId: session.discordUserId,
          reviewAt: review.date,
          note: note || null,
        });
        await recordAudit(session, {
          action: "moderation.case.open",
          targetId: String(created._id),
          details: {
            caseNumber: created.caseNumber,
            entryId,
            reviewAt: review.date?.toISOString() ?? null,
          },
          result: "success",
        });
        flashRedirect(res, MODERATION_PAGE, {
          type: "ok",
          text: `Opened case #${created.caseNumber}.`,
        });
      } catch (err) {
        await failure(res, session, "moderation.case.open", entryId, err);
      }
    }),
  );

  for (const decision of CASE_DECISIONS) {
    router.post(
      `/moderation/cases/:id/${decision}`,
      asyncHandler(async (req, res) => {
        const session = requireSessionContext(req);
        const result = await decideCase({
          client,
          session,
          caseId: String(req.params.id),
          decision,
          get: (name) => getString(req, name),
          audit: recordAudit,
        });
        flashRedirect(res, MODERATION_PAGE, result);
      }),
    );
  }

  router.post(
    "/moderation/cases/run-review",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      try {
        const summary =
          await ModerationCaseReviewService.getInstance(client).runNow();
        await recordAudit(session, {
          action: "moderation.case.run_review",
          details: { ...(summary ?? {}) },
          result: "success",
        });
        flashRedirect(res, MODERATION_PAGE, {
          type: "ok",
          text: summary
            ? `Review pass done: ${summary.flipped} case${summary.flipped === 1 ? "" : "s"} moved into review.`
            : "Moderation cases are turned off.",
        });
      } catch (err) {
        await failure(res, session, "moderation.case.run_review", null, err);
      }
    }),
  );

  return router;
}

/** Audit and flash a failed case operation. Expected refusals are not errors. */
async function failure(
  res: Parameters<typeof flashRedirect>[0],
  session: ReturnType<typeof requireSessionContext>,
  action: string,
  targetId: string | null,
  err: unknown,
): Promise<void> {
  flashRedirect(
    res,
    MODERATION_PAGE,
    await auditCaseFailure(recordAudit, session, action, targetId, err),
  );
}
