/**
 * View model for the Cases section of the Moderation page (#908).
 *
 * The page needs, per case, the member, the originating action and its
 * reason, who decided what, and — the whole point of the feature — the
 * member's prior log history. This module turns the service's raw queue into
 * that shape. It is pure apart from `loadCaseHistory`, which reads history
 * through the existing `ModerationService.getHistory`, so nothing here adds a
 * new query path to the log.
 */

import {
  SYSTEM_ACTOR,
  type IModerationCase,
} from "../models/moderation-case.js";
import type {
  IModerationLog,
  ModerationAction,
} from "../models/moderation-log.js";
import type {
  CaseQueue,
  ModerationCaseService,
} from "../services/moderation-case-service.js";
import type { Types } from "mongoose";
import type { ModerationService } from "../services/moderation-service.js";

/** How many of a member's newest log entries a case card shows. */
export const CASE_HISTORY_LIMIT = 10;

export interface CaseHistoryItem {
  createdAt: string;
  action: ModerationAction;
  reason: string | null;
}

export interface CaseEventView {
  at: string;
  byLabel: string;
  to: string;
  outcome: string | null;
  note: string | null;
}

export interface CaseView {
  id: string;
  caseNumber: number;
  userId: string;
  userLabel: string;
  action: "kick" | "ban";
  status: string;
  reviewAt: string | null;
  openedAt: string;
  openedByLabel: string;
  originModeratorLabel: string | null;
  /** Reason on the log row that opened the case. */
  reason: string | null;
  events: CaseEventView[];
  history: CaseHistoryItem[];
  /** False for terminal statuses; the page offers no actions on those. */
  live: boolean;
}

export interface CaseGroups {
  overdue: CaseView[];
  dueSoon: CaseView[];
  indefinite: CaseView[];
  recentlyResolved: CaseView[];
}

const iso = (d: Date | null | undefined): string | null =>
  d instanceof Date ? d.toISOString() : d ? String(d) : null;

/** Newest history per member, one read each; a failed read just shows none. */
export async function loadCaseHistory(
  moderation: Pick<ModerationService, "getHistory">,
  guildId: string,
  cases: readonly IModerationCase[],
): Promise<Map<string, IModerationLog[]>> {
  const byUser = new Map<string, IModerationLog[]>();
  const users = [...new Set(cases.map((c) => c.userId))];
  await Promise.all(
    users.map(async (userId) => {
      const rows = await moderation
        .getHistory(guildId, userId, { limit: CASE_HISTORY_LIMIT, skip: 0 })
        .catch(() => []);
      byUser.set(userId, rows);
    }),
  );
  return byUser;
}

export function buildCaseGroups(
  queue: CaseQueue,
  originEntries: ReadonlyMap<string, IModerationLog>,
  history: ReadonlyMap<string, IModerationLog[]>,
  labelOf: (id: string | null) => string,
): CaseGroups {
  const view = (c: IModerationCase): CaseView => ({
    id: String(c._id),
    caseNumber: c.caseNumber,
    userId: c.userId,
    userLabel: labelOf(c.userId),
    action: c.action,
    status: c.status,
    reviewAt: iso(c.reviewAt),
    openedAt: iso(c.openedAt) ?? "",
    openedByLabel: labelOf(c.openedByUserId),
    originModeratorLabel: c.originModeratorId
      ? labelOf(c.originModeratorId)
      : null,
    reason: originEntries.get(String(c.originEntryId))?.reason ?? null,
    events: c.events.map((e) => ({
      at: iso(e.at) ?? "",
      // The review job records itself as "system", which is not a member.
      byLabel: e.byUserId === SYSTEM_ACTOR ? "KoolBot" : labelOf(e.byUserId),
      to: e.to,
      outcome: e.outcome,
      note: e.note,
    })),
    history: (history.get(c.userId) ?? []).map((h) => ({
      createdAt: iso(h.createdAt) ?? "",
      action: h.action,
      reason: h.reason ?? null,
    })),
    live: c.status === "open" || c.status === "under_review",
  });
  return {
    overdue: queue.overdue.map(view),
    dueSoon: queue.dueSoon.map(view),
    indefinite: queue.indefinite.map(view),
    recentlyResolved: queue.recentlyResolved.map(view),
  };
}

export interface ModerationCaseData {
  /** The master gate and `moderation.cases.enabled` are both on. */
  casesEnabled: boolean;
  defaultReviewDays: number;
  /** Null when cases are off or the queue could not be read. */
  queue: CaseQueue | null;
  /** Every case in the queue, flattened. */
  queueCases: IModerationCase[];
  /** Cases keyed by the log row on the current page that opened them. */
  casesByEntry: Map<string, IModerationCase>;
  originEntries: Map<string, IModerationLog>;
  queueHistory: Map<string, IModerationLog[]>;
}

/**
 * Everything the Moderation page needs for its Cases section, loaded in one
 * place so the route stays a thin wrapper. Cases are a second gate under the
 * master: while either is off nothing is queried. Each read degrades on its
 * own — a failed queue read leaves the log table intact.
 */
export async function loadModerationCaseData(args: {
  caseService: Pick<
    ModerationCaseService,
    | "isEnabled"
    | "getQueue"
    | "getCasesForEntries"
    | "getDefaultReviewDays"
    | "getOriginEntries"
  >;
  moderationService: Pick<ModerationService, "getHistory">;
  guildId: string;
  /** `moderation.enabled`. */
  enabled: boolean;
  entryIds: readonly Types.ObjectId[];
}): Promise<ModerationCaseData> {
  const { caseService, moderationService, guildId } = args;
  const casesEnabled = args.enabled && (await caseService.isEnabled());
  if (!casesEnabled) {
    return {
      casesEnabled: false,
      defaultReviewDays: 90,
      queue: null,
      queueCases: [],
      casesByEntry: new Map(),
      originEntries: new Map(),
      queueHistory: new Map(),
    };
  }

  const [queue, casesByEntry, defaultReviewDays] = await Promise.all([
    caseService.getQueue(guildId).catch(() => null),
    caseService
      .getCasesForEntries(guildId, args.entryIds)
      .catch(() => new Map<string, IModerationCase>()),
    caseService.getDefaultReviewDays(),
  ]);
  const queueCases = queue
    ? [
        ...queue.overdue,
        ...queue.dueSoon,
        ...queue.indefinite,
        ...queue.recentlyResolved,
      ]
    : [];
  const [originEntries, queueHistory] = await Promise.all([
    caseService
      .getOriginEntries(queueCases)
      .catch(() => new Map<string, IModerationLog>()),
    loadCaseHistory(moderationService, guildId, queueCases),
  ]);
  return {
    casesEnabled,
    defaultReviewDays,
    queue,
    queueCases,
    casesByEntry,
    originEntries,
    queueHistory,
  };
}
