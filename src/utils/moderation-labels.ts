import type { ModerationAction } from "../models/moderation-log.js";
import type {
  ModerationCaseOutcome,
  ModerationCaseStatus,
} from "../models/moderation-case.js";

/**
 * The words moderation shows people (#1353). One module, so the Web UI (admin
 * Moderation page, `/me/moderation`) and the Discord messages (`/modlog`,
 * `/warn`, the context notice, the review notice) name the same thing the same
 * way. The reviewed list, with the old word beside each new one, is
 * `docs/design/labels.md`.
 *
 * These are display words only. The stored values (`readmit`, `readmitted`,
 * `under_review`, `upheld`, `unban`, ...), the route paths and the
 * `moderation.case.<decision>` audit actions are never changed here, and every
 * map is typed over its stored enum so a new value fails the build until it
 * has a word.
 *
 * Words are lower case, as they read inside a sentence. A caller that wants a
 * heading capitalises the first letter.
 */

/** What each log action is called. */
export const ACTION_WORDS: Record<ModerationAction, string> = {
  warn: "warn",
  kick: "kick",
  ban: "ban",
  unban: "ban lifted",
  timeout: "timeout",
  untimeout: "timeout lifted",
  quarantine: "quarantine",
  raid_lockdown: "raid lockdown started",
  raid_clear: "raid lockdown lifted",
};

/**
 * What each case state is called. The stored `upheld` is the terminal state
 * that "Keep out for good" sets; the "Keep out for now" decision records the
 * outcome `upheld` instead (see {@link CASE_OUTCOME_WORDS}), so the two words
 * differ on purpose.
 */
export const CASE_STATUS_WORDS: Record<ModerationCaseStatus, string> = {
  open: "open",
  under_review: "needs a decision",
  upheld: "kept out for good",
  lifted: "let back in",
  expired: "expired",
};

/** What each decision recorded on a case is called in its history. */
export const CASE_OUTCOME_WORDS: Record<ModerationCaseOutcome, string> = {
  upheld: "kept out for now",
  extended: "put off to a later date",
  permanent: "kept out for good",
  readmitted: "let back in",
};

/**
 * The four decision buttons, keyed by the decision's stored name (which is
 * also the route segment and the audit action suffix, and does not change).
 */
export type CaseDecisionKey = "uphold" | "extend" | "permanent" | "readmit";

export const DECISION_LABELS: Record<CaseDecisionKey, string> = {
  uphold: "Keep out for now",
  extend: "Decide later",
  permanent: "Keep out for good",
  readmit: "Let back in",
};

/** The flash shown after a decision, after `Case #N`. */
export const DECISION_DONE: Record<CaseDecisionKey, string> = {
  uphold: "kept out for now.",
  extend: "put off to the new review date.",
  permanent: "kept out for good. It is not reviewed again.",
  readmit: "closed: the member was let back in.",
};

/** The dialog question for the two decisions that close a case. */
export const DECISION_CONFIRM_TEXT: Partial<Record<CaseDecisionKey, string>> = {
  permanent:
    "Keep this member out for good? The case closes with no further review.",
  readmit:
    "Let this member back in? KoolBot does not lift the ban in Discord; do that there.",
};

/** The consequence list under the "Keep out for good" dialog question. */
export const PERMANENT_CONFIRM_ITEMS: readonly string[] = [
  `The case closes as "${CASE_STATUS_WORDS.upheld}" and its review date is cleared.`,
  "It is not reviewed again.",
];

/**
 * The note the review job stores on its `open` to `under_review` event. It is
 * stored data (existing rows carry it), so it is not reworded; the pages leave
 * it out because the event already reads "marked as needing a decision by
 * KoolBot".
 */
export const REVIEW_JOB_NOTE = "Review came due";

/** First letter capitalised, for a heading made from one of the words. */
export function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
