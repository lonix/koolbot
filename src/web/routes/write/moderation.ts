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
import logger from "../../../utils/logger.js";
import {
  ModerationCaseError,
  ModerationCaseService,
  MAX_REVIEW_DAYS,
  type ModerationCaseDecision,
} from "../../../services/moderation-case-service.js";
import { ModerationCaseReviewService } from "../../../services/moderation-case-review-service.js";
import { recordAudit } from "../../audit.js";
import {
  TEXT_LIMITS,
  asyncHandler,
  firstLengthError,
  flashRedirect,
  getString,
  parseIntInRange,
  requireSessionContext,
} from "./helpers.js";

const MODERATION_PAGE = "/admin/moderation";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DECISIONS: ModerationCaseDecision[] = [
  "uphold",
  "extend",
  "permanent",
  "readmit",
];

const DECISION_PAST_TENSE: Record<ModerationCaseDecision, string> = {
  uphold: "upheld",
  extend: "extended",
  permanent: "made permanent",
  readmit: "readmitted",
};

type ReviewDate =
  { ok: true; date: Date | null } | { ok: false; reason: string };

/**
 * Read the review date from the form: either `<prefix>_in_days` (a number of
 * days from now) or `<prefix>_at` (a `YYYY-MM-DD` date). Both empty means "no
 * review date"; whether that is allowed is the service's call.
 */
function parseReviewDate(
  req: Parameters<typeof getString>[0],
  prefix: string,
): ReviewDate {
  const days = getString(req, `${prefix}_in_days`);
  const at = getString(req, `${prefix}_at`);
  if (days) {
    // `parseInt` takes a numeric prefix, so "30days" and "1.5" would pass
    // for 30 and 1; require the whole string to be digits first.
    const n = /^\d+$/.test(days)
      ? parseIntInRange(days, 1, MAX_REVIEW_DAYS)
      : null;
    if (n === null) {
      return {
        ok: false,
        reason: `Review days must be a whole number from 1 to ${MAX_REVIEW_DAYS}.`,
      };
    }
    return { ok: true, date: new Date(Date.now() + n * MS_PER_DAY) };
  }
  if (at) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) {
      return { ok: false, reason: "Review date must be a valid date." };
    }
    const date = new Date(`${at}T09:00:00.000Z`);
    // `Date` rolls impossible dates over (2030-02-31 becomes March 3), so the
    // parsed day must round-trip to what was submitted.
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== at
    ) {
      return { ok: false, reason: "Review date must be a valid date." };
    }
    return { ok: true, date };
  }
  return { ok: true, date: null };
}

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
      const review = parseReviewDate(req, "review");

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

  for (const decision of DECISIONS) {
    router.post(
      `/moderation/cases/:id/${decision}`,
      asyncHandler(async (req, res) => {
        const session = requireSessionContext(req);
        const caseId = String(req.params.id);
        const note = getString(req, "note");
        const review = parseReviewDate(req, "next_review");
        const action = `moderation.case.${decision}`;

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
          const updated = await cases().decide({
            guildId: session.guildId,
            caseId,
            decision,
            byUserId: session.discordUserId,
            nextReviewAt: review.date,
            note: note || null,
          });
          await recordAudit(session, {
            action,
            targetId: caseId,
            details: {
              caseNumber: updated.caseNumber,
              status: updated.status,
              reviewAt: updated.reviewAt?.toISOString() ?? null,
            },
            result: "success",
          });
          flashRedirect(res, MODERATION_PAGE, {
            type: "ok",
            text: `Case #${updated.caseNumber} ${DECISION_PAST_TENSE[decision]}.`,
          });
        } catch (err) {
          await failure(res, session, action, caseId, err);
        }
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
  const expected = err instanceof ModerationCaseError;
  const text = err instanceof Error ? err.message : "Unknown error";
  if (!expected) logger.error(`${action} failed`, err);
  await recordAudit(session, {
    action,
    targetId,
    result: "failure",
    errorMessage: text,
  });
  flashRedirect(res, MODERATION_PAGE, {
    type: "err",
    text: expected ? text : `Something went wrong: ${text}`,
  });
}
