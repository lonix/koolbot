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
  checkCaseFields,
  decideCase,
} from "../../moderation-case-actions.js";
import {
  asyncHandler,
  flashRedirect,
  getRawString,
  getString,
  refuseForm,
  requireSessionContext,
} from "./helpers.js";
import {
  moderationCaseDecideForm,
  moderationCaseOpenForm,
} from "../../admin-views.js";

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
      const checked = checkCaseFields((name) => getString(req, name), "review");
      const review = checked.review;

      if (!(await cases().isEnabled())) {
        flashRedirect(res, MODERATION_PAGE, {
          type: "err",
          text: "Moderation cases are turned off.",
        });
        return;
      }
      if (checked.reason !== null || !review.ok) {
        // A refusal is drawn in the row's own form. A row that is gone from
        // the page (or an `_at` date, which has no control) answers the flash.
        await refuseForm(req, res, {
          page: MODERATION_PAGE,
          formId: moderationCaseOpenForm(entryId),
          errors: checked.errors,
          values: {
            review_in_days: getRawString(req, "review_in_days"),
            note: getRawString(req, "note"),
          },
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
        const caseId = String(req.params.id);
        const checked = checkCaseFields(
          (name) => getString(req, name),
          "next_review",
        );
        // "Decide later" needs a new review date, and an empty days box is a
        // valid answer to the other decisions: the date check is this one's.
        const errors: Record<string, string> = { ...checked.errors };
        let reason = checked.reason;
        if (
          decision === "extend" &&
          checked.review.ok &&
          !checked.review.date
        ) {
          errors.next_review_in_days =
            "Deciding later needs a new review date.";
          reason ??= errors.next_review_in_days;
        }
        if (reason !== null) {
          // Cases switched off, or the switch unreadable, outrank a bad field:
          // `decideCase` words those and audits them.
          const on = await cases()
            .isEnabledStrict()
            .catch(() => false);
          if (on) {
            await recordAudit(session, {
              action: `moderation.case.${decision}`,
              targetId: caseId,
              result: "failure",
              errorMessage: reason,
            });
            if (
              await refuseForm(req, res, {
                page: MODERATION_PAGE,
                formId: moderationCaseDecideForm(caseId),
                errors,
                values: {
                  next_review_in_days: getRawString(req, "next_review_in_days"),
                  note: getRawString(req, "note"),
                },
              })
            ) {
              return;
            }
          }
        }
        const result = await decideCase({
          client,
          session,
          caseId,
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
            ? `Check done: ${summary.flipped} ${summary.flipped === 1 ? "case now needs" : "cases now need"} a decision.`
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
