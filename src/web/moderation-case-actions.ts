/**
 * The case decision shared by the admin Moderation page and the moderator's
 * `/me/moderation` page (#1320): one function validates the form, calls
 * `ModerationCaseService.decide` and records the audit row, so the two
 * surfaces cannot drift in what a decision means or what is logged.
 *
 * It knows nothing about HTTP routing: each caller turns the returned flash
 * into its own redirect, and passes the audit writer its surface uses (the
 * `/me` surface bounds member-supplied strings first).
 */

import type { Client } from "discord.js";
import logger from "../utils/logger.js";
import {
  ModerationCaseError,
  ModerationCaseService,
  MAX_REVIEW_DAYS,
  type ModerationCaseDecision,
} from "../services/moderation-case-service.js";
import type { AuditEntry } from "./audit.js";
import type { WebSessionContext } from "./session.js";
import {
  TEXT_LIMITS,
  firstLengthError,
  parseIntInRange,
} from "./routes/write/helpers.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const CASE_DECISIONS: ModerationCaseDecision[] = [
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

export type ReviewDate =
  { ok: true; date: Date | null } | { ok: false; reason: string };

/**
 * Read the review date from the form: either `<prefix>_in_days` (a number of
 * days from now) or `<prefix>_at` (a `YYYY-MM-DD` date). Both empty means "no
 * review date"; whether that is allowed is the service's call.
 */
export function parseReviewDate(
  get: (name: string) => string,
  prefix: string,
): ReviewDate {
  const days = get(`${prefix}_in_days`);
  const at = get(`${prefix}_at`);
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

export interface CaseFlash {
  type: "ok" | "err";
  text: string;
}

type AuditWriter = (
  session: WebSessionContext,
  entry: AuditEntry,
) => Promise<void>;

/** Audit and describe a failed case operation. Expected refusals are not errors. */
export async function auditCaseFailure(
  audit: AuditWriter,
  session: WebSessionContext,
  action: string,
  targetId: string | null,
  err: unknown,
): Promise<CaseFlash> {
  const expected = err instanceof ModerationCaseError;
  const text = err instanceof Error ? err.message : "Unknown error";
  if (!expected) logger.error(`${action} failed`, err);
  await audit(session, {
    action,
    targetId,
    result: "failure",
    errorMessage: text,
  });
  return {
    type: "err",
    text: expected ? text : `Something went wrong: ${text}`,
  };
}

/** Record one decision on a case: the whole of "Review". */
export async function decideCase(args: {
  client: Client;
  session: WebSessionContext;
  caseId: string;
  decision: ModerationCaseDecision;
  /** Reads a trimmed form field. */
  get: (name: string) => string;
  audit: AuditWriter;
}): Promise<CaseFlash> {
  const { client, session, caseId, decision, get, audit } = args;
  const cases = ModerationCaseService.getInstance(client);
  const note = get("note");
  const review = parseReviewDate(get, "next_review");
  const action = `moderation.case.${decision}`;

  // A refusal is audited like any other failed attempt: who tried which
  // decision on which case. The reason is one of our own fixed sentences, never
  // the note or the date the person typed, so no free text reaches the row.
  const refuse = async (text: string): Promise<CaseFlash> => {
    await audit(session, {
      action,
      targetId: caseId,
      result: "failure",
      errorMessage: text,
    });
    return { type: "err", text };
  };

  if (!(await cases.isEnabled())) {
    return refuse("Moderation cases are turned off.");
  }
  const lengthError = firstLengthError([
    { label: "Note", value: note, max: TEXT_LIMITS.caseNote },
  ]);
  if (lengthError || !review.ok) {
    return refuse(lengthError ?? (review.ok ? "" : review.reason));
  }

  try {
    const updated = await cases.decide({
      guildId: session.guildId,
      caseId,
      decision,
      byUserId: session.discordUserId,
      nextReviewAt: review.date,
      note: note || null,
    });
    await audit(session, {
      action,
      targetId: caseId,
      details: {
        caseNumber: updated.caseNumber,
        status: updated.status,
        reviewAt: updated.reviewAt?.toISOString() ?? null,
      },
      result: "success",
    });
    return {
      type: "ok",
      text: `Case #${updated.caseNumber} ${DECISION_PAST_TENSE[decision]}.`,
    };
  } catch (err) {
    return auditCaseFailure(audit, session, action, caseId, err);
  }
}
