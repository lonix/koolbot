import { Client } from "discord.js";
import { isValidObjectId, type Types } from "mongoose";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";
import {
  ModerationCase,
  ModerationCaseCounter,
  LIVE_CASE_STATUSES,
  TERMINAL_CASE_STATUSES,
  type IModerationCase,
  type IModerationCaseEvent,
  type ModerationCaseOutcome,
  type ModerationCaseStatus,
} from "../models/moderation-case.js";
import {
  ModerationLog,
  type IModerationLog,
} from "../models/moderation-log.js";

/** The four decisions staff can record on a live case. */
export type ModerationCaseDecision =
  "uphold" | "extend" | "permanent" | "readmit";

/** Why a case operation was refused. Surfaced to staff as a flash message. */
export type ModerationCaseErrorCode =
  | "entry-not-found"
  | "not-removal"
  | "already-has-case"
  | "case-not-found"
  | "terminal"
  | "status-changed"
  | "review-date-required"
  | "review-date-past";

export class ModerationCaseError extends Error {
  public readonly code: ModerationCaseErrorCode;
  /** The status found when a conditional update lost a race. */
  public readonly foundStatus?: ModerationCaseStatus;

  constructor(
    code: ModerationCaseErrorCode,
    message: string,
    foundStatus?: ModerationCaseStatus,
  ) {
    super(message);
    this.name = "ModerationCaseError";
    this.code = code;
    this.foundStatus = foundStatus;
  }
}

export interface OpenCaseInput {
  guildId: string;
  entryId: string;
  openedByUserId: string;
  /** Null opens an indefinite case that never enters the due queue. */
  reviewAt: Date | null;
  note: string | null;
}

export interface DecideInput {
  guildId: string;
  caseId: string;
  decision: ModerationCaseDecision;
  byUserId: string;
  /** Required for `extend`; optional for `uphold`; ignored otherwise. */
  nextReviewAt: Date | null;
  note: string | null;
}

export interface CaseQueue {
  /** Due now: `under_review`, or `open` with a passed `reviewAt` not yet flipped. */
  overdue: IModerationCase[];
  /** `open` with a `reviewAt` inside the look-ahead window. */
  dueSoon: IModerationCase[];
  /** `open` with no review date; never enters the due queue. */
  indefinite: IModerationCase[];
  /** Terminal cases resolved inside the look-back window. */
  recentlyResolved: IModerationCase[];
}

export const DUE_SOON_DAYS = 7;
export const RECENTLY_RESOLVED_DAYS = 30;
/** Cap per queue group; the queue is a prompt, and cases are rare. */
const QUEUE_GROUP_LIMIT = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * What each decision does to a live case: the status it lands in, the
 * outcome recorded in `events[]`, and whether it needs / clears `reviewAt`.
 * `uphold` and `extend` both land back in `open`; they stay distinct because
 * the recorded outcome is the point — "reviewed and upheld twice" reads
 * differently from "kept getting deferred".
 */
const TRANSITIONS: Record<
  ModerationCaseDecision,
  {
    to: ModerationCaseStatus;
    outcome: ModerationCaseOutcome;
    reviewDate: "required" | "optional" | "cleared";
  }
> = {
  uphold: { to: "open", outcome: "upheld", reviewDate: "optional" },
  extend: { to: "open", outcome: "extended", reviewDate: "required" },
  permanent: { to: "upheld", outcome: "permanent", reviewDate: "cleared" },
  readmit: { to: "lifted", outcome: "readmitted", reviewDate: "cleared" },
};

/**
 * Case lifecycle on top of the append-only moderation log (issue #908).
 *
 * Every transition goes through one conditional update keyed on the status
 * the caller last saw, so two staff resolving the same case from two browser
 * tabs cannot both win — the loser gets a {@link ModerationCaseError} naming
 * the status it actually found. The log rows themselves are never touched.
 *
 * Gated behind `moderation.enabled` and `moderation.cases.enabled`; the
 * service has no timers of its own (the due-review job is
 * `ModerationCaseReviewService`).
 */
export class ModerationCaseService {
  private static instance: ModerationCaseService;
  private client: Client;
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): ModerationCaseService {
    if (!ModerationCaseService.instance) {
      ModerationCaseService.instance = new ModerationCaseService(client);
    } else if (ModerationCaseService.instance.client !== client) {
      throw new Error(
        "ModerationCaseService already initialised with a different client",
      );
    }
    return ModerationCaseService.instance;
  }

  public static reset(): void {
    ModerationCaseService.instance =
      undefined as unknown as ModerationCaseService;
  }

  public async isEnabled(): Promise<boolean> {
    const [moderation, cases] = await Promise.all([
      this.configService.getBoolean("moderation.enabled", false),
      this.configService.getBoolean("moderation.cases.enabled", false),
    ]);
    return moderation && cases;
  }

  /** The pre-filled review window when staff open a case. */
  public async getDefaultReviewDays(): Promise<number> {
    const days = await this.configService
      .getNumber("moderation.cases.default_review_days", 90)
      .catch(() => 90);
    return Number.isFinite(days) && days > 0 ? days : 90;
  }

  /**
   * Allocate the next per-guild case number. `$inc` + `upsert` is atomic;
   * the unique `(guildId, caseNumber)` index is the backstop.
   */
  private async nextCaseNumber(guildId: string): Promise<number> {
    const counter = await ModerationCaseCounter.findOneAndUpdate(
      { guildId },
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    ).exec();
    return counter.seq;
  }

  /**
   * Open a case against an existing kick/ban log row. Cases are only ever
   * opened by a human: Discord's native flow has no field that could carry a
   * review date, so setting one is always a second, deliberate step.
   */
  public async openCase(input: OpenCaseInput): Promise<IModerationCase> {
    if (!isValidObjectId(input.entryId)) {
      throw new ModerationCaseError(
        "entry-not-found",
        "That moderation entry does not exist.",
      );
    }
    const entry = await ModerationLog.findOne({
      _id: input.entryId,
      guildId: input.guildId,
    })
      .lean()
      .exec();
    if (!entry) {
      throw new ModerationCaseError(
        "entry-not-found",
        "That moderation entry does not exist.",
      );
    }
    if (entry.action !== "kick" && entry.action !== "ban") {
      throw new ModerationCaseError(
        "not-removal",
        "Only a kick or a ban can carry a review date.",
      );
    }
    if (input.reviewAt && input.reviewAt.getTime() <= Date.now()) {
      throw new ModerationCaseError(
        "review-date-past",
        "The review date must be in the future.",
      );
    }
    const existing = await ModerationCase.exists({
      guildId: input.guildId,
      originEntryId: entry._id,
    });
    if (existing) {
      throw new ModerationCaseError(
        "already-has-case",
        "A case is already open for that entry.",
      );
    }

    const now = new Date();
    const caseNumber = await this.nextCaseNumber(input.guildId);
    const doc = {
      guildId: input.guildId,
      caseNumber,
      userId: entry.userId,
      originEntryId: entry._id,
      action: entry.action,
      status: "open" as const,
      reviewAt: input.reviewAt,
      openedAt: now,
      originModeratorId: entry.moderatorId ?? null,
      openedByUserId: input.openedByUserId,
      resolutionEntryId: null,
      events: [
        {
          at: now,
          byUserId: input.openedByUserId,
          from: "open" as const,
          to: "open" as const,
          outcome: null,
          note: input.note,
        },
      ],
      updatedAt: now,
    };
    let created: IModerationCase;
    try {
      created = await ModerationCase.create(doc);
    } catch (error) {
      // The unique `(guildId, originEntryId)` index is the backstop for two
      // staff opening the same entry at once; the loser sees the same refusal
      // as the up-front check.
      if ((error as { code?: number }).code === 11000) {
        throw new ModerationCaseError(
          "already-has-case",
          "A case is already open for that entry.",
        );
      }
      throw error;
    }
    logger.info(
      `Moderation case #${caseNumber} opened in guild ${input.guildId} (${entry.action})`,
    );
    return created;
  }

  /**
   * Record a decision on a live case. The queue is a prompt, not a gate:
   * staff may decide an `open` case before it comes due.
   */
  public async decide(input: DecideInput): Promise<IModerationCase> {
    const transition = TRANSITIONS[input.decision];
    const current = await this.findCase(input.guildId, input.caseId);
    if (!current) {
      throw new ModerationCaseError(
        "case-not-found",
        "That case does not exist.",
      );
    }
    if (TERMINAL_CASE_STATUSES.includes(current.status)) {
      throw new ModerationCaseError(
        "terminal",
        `Case #${current.caseNumber} is already ${current.status}.`,
        current.status,
      );
    }

    let reviewAt: Date | null = null;
    if (transition.reviewDate !== "cleared") {
      reviewAt = input.nextReviewAt;
      if (!reviewAt && transition.reviewDate === "required") {
        throw new ModerationCaseError(
          "review-date-required",
          "Extending a case needs a new review date.",
        );
      }
      if (reviewAt && reviewAt.getTime() <= Date.now()) {
        throw new ModerationCaseError(
          "review-date-past",
          "The review date must be in the future.",
        );
      }
    }

    const now = new Date();
    const event: IModerationCaseEvent = {
      at: now,
      byUserId: input.byUserId,
      from: current.status,
      to: transition.to,
      outcome: transition.outcome,
      note: input.note,
    };
    const updated = await ModerationCase.findOneAndUpdate(
      { _id: current._id, guildId: input.guildId, status: current.status },
      {
        $set: { status: transition.to, reviewAt, updatedAt: now },
        $push: { events: event },
      },
      { new: true },
    ).exec();
    if (!updated) {
      throw await this.lostRace(input.guildId, input.caseId);
    }
    logger.info(
      `Moderation case #${updated.caseNumber} ${transition.outcome} in guild ${input.guildId}`,
    );
    return updated;
  }

  /**
   * Flip an `open` case whose review has come due to `under_review`. The
   * conditional update makes the cron's notice idempotent: only the run that
   * actually flipped a case reports it. Returns `null` when the case was no
   * longer `open` (someone decided it first, or a previous run flipped it).
   */
  public async markUnderReview(
    caseDoc: Pick<IModerationCase, "_id" | "guildId">,
    byUserId: string,
  ): Promise<IModerationCase | null> {
    const now = new Date();
    const event: IModerationCaseEvent = {
      at: now,
      byUserId,
      from: "open",
      to: "under_review",
      outcome: null,
      note: "Review came due",
    };
    return ModerationCase.findOneAndUpdate(
      {
        _id: caseDoc._id,
        guildId: caseDoc.guildId,
        status: "open",
        reviewAt: { $lte: now },
      },
      {
        $set: { status: "under_review", updatedAt: now },
        $push: { events: event },
      },
      { new: true },
    ).exec();
  }

  private async lostRace(
    guildId: string,
    caseId: string,
  ): Promise<ModerationCaseError> {
    const found = await this.findCase(guildId, caseId);
    if (!found) {
      return new ModerationCaseError(
        "case-not-found",
        "That case does not exist.",
      );
    }
    return new ModerationCaseError(
      "status-changed",
      `Case #${found.caseNumber} was already ${found.status.replace("_", " ")}.`,
      found.status,
    );
  }

  public async findCase(
    guildId: string,
    caseId: string,
  ): Promise<IModerationCase | null> {
    if (!isValidObjectId(caseId)) return null;
    return ModerationCase.findOne({ _id: caseId, guildId }).exec();
  }

  /** Cases keyed by the log row that opened them. Backs the admin table. */
  public async getCasesForEntries(
    guildId: string,
    entryIds: readonly Types.ObjectId[],
  ): Promise<Map<string, IModerationCase>> {
    const byEntry = new Map<string, IModerationCase>();
    if (entryIds.length === 0) return byEntry;
    const rows = await ModerationCase.find({
      guildId,
      originEntryId: { $in: entryIds },
    })
      .lean<IModerationCase[]>()
      .exec();
    for (const row of rows) byEntry.set(String(row.originEntryId), row);
    return byEntry;
  }

  /** The log rows that opened the given cases, keyed by entry id. */
  public async getOriginEntries(
    cases: readonly IModerationCase[],
  ): Promise<Map<string, IModerationLog>> {
    const byId = new Map<string, IModerationLog>();
    if (cases.length === 0) return byId;
    const rows = await ModerationLog.find({
      _id: { $in: cases.map((c) => c.originEntryId) },
    })
      .lean<IModerationLog[]>()
      .exec();
    for (const row of rows) byId.set(String(row._id), row);
    return byId;
  }

  /** The review queue, in the order the admin page shows it. */
  public async getQueue(
    guildId: string,
    now: Date = new Date(),
  ): Promise<CaseQueue> {
    const soon = new Date(now.getTime() + DUE_SOON_DAYS * MS_PER_DAY);
    const since = new Date(now.getTime() - RECENTLY_RESOLVED_DAYS * MS_PER_DAY);
    const find = (
      filter: Record<string, unknown>,
      sort: Record<string, 1 | -1>,
    ): Promise<IModerationCase[]> =>
      ModerationCase.find({ guildId, ...filter })
        .sort(sort)
        .limit(QUEUE_GROUP_LIMIT)
        .lean<IModerationCase[]>()
        .exec();

    const [overdue, dueSoon, indefinite, recentlyResolved] = await Promise.all([
      find(
        { status: { $in: LIVE_CASE_STATUSES }, reviewAt: { $lte: now } },
        { reviewAt: 1 },
      ),
      find(
        { status: "open", reviewAt: { $gt: now, $lte: soon } },
        { reviewAt: 1 },
      ),
      find({ status: "open", reviewAt: null }, { openedAt: 1 }),
      find(
        { status: { $in: TERMINAL_CASE_STATUSES }, updatedAt: { $gte: since } },
        { updatedAt: -1 },
      ),
    ]);
    return { overdue, dueSoon, indefinite, recentlyResolved };
  }
}
