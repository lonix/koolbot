import mongoose, { Document, Schema, type Types } from "mongoose";
import type { ModerationAction } from "./moderation-log.js";

/**
 * Moderation case (issue #908). A case is the lifecycle record staff open
 * against a kick or ban in the moderation log: a review date, the decision
 * taken when it comes due, and the trail of who decided what.
 *
 * It lives in its own collection rather than as fields on `ModerationLog` so
 * the log stays what `moderation-log.ts` says it is — an append-only history
 * whose rows never change. Mutation is confined to this small collection,
 * which exists to mutate. Cases are rare (a handful per guild per year); log
 * rows are many.
 *
 * `status` is the current answer and `events` is how it got there: every
 * transition appends one event (who, when, which outcome, why) and is never
 * edited, the same append-only-array shape as the session objects in
 * `voice-channel-tracking.ts`.
 *
 * Phase 1 has no automatic producer of `expired` and never performs the
 * Discord-side unban, so `resolutionEntryId` stays null until a later phase
 * links a recorded unban back to its case.
 */
export type ModerationCaseStatus =
  "open" | "under_review" | "upheld" | "lifted" | "expired";

export type ModerationCaseOutcome =
  "upheld" | "extended" | "permanent" | "readmitted";

/** Only removals can carry a review date. */
export type ModerationCaseAction = Extract<ModerationAction, "kick" | "ban">;

/**
 * Recorded as the actor on the due-review job's `open` → `under_review`
 * event, which no staff member performed.
 */
export const SYSTEM_ACTOR = "system";

export const TERMINAL_CASE_STATUSES: readonly ModerationCaseStatus[] = [
  "upheld",
  "lifted",
  "expired",
];

export const LIVE_CASE_STATUSES: readonly ModerationCaseStatus[] = [
  "open",
  "under_review",
];

export interface IModerationCaseEvent {
  at: Date;
  /** Staff member who recorded the decision. Cases are only opened by a human. */
  byUserId: string;
  from: ModerationCaseStatus;
  to: ModerationCaseStatus;
  /** Null for the opening event and for the cron's `open` → `under_review` flip. */
  outcome: ModerationCaseOutcome | null;
  note: string | null;
}

export interface IModerationCase extends Document {
  guildId: string;
  /** Per-guild, human-quotable ("case #14"). */
  caseNumber: number;
  /** The member the case is about. */
  userId: string;
  /** The `ModerationLog` row that opened the case (the kick/ban). */
  originEntryId: Types.ObjectId;
  /** Denormalised from the origin entry so the queue renders without a join. */
  action: ModerationCaseAction;
  status: ModerationCaseStatus;
  /** When staff should look at this again. Null on terminal statuses. */
  reviewAt: Date | null;
  openedAt: Date;
  /** Moderator who took the originating action, copied from the origin entry. */
  originModeratorId: string | null;
  /** Staff member who opened the case (not necessarily the same person). */
  openedByUserId: string;
  /** The log row that enacted a readmission, once a later phase records one. */
  resolutionEntryId: Types.ObjectId | null;
  events: IModerationCaseEvent[];
  /**
   * Version token: every transition filters on the value it read and `$inc`s
   * it, so exactly one of two concurrent writers wins. A timestamp cannot do
   * this (two writes in one millisecond collide); an integer can.
   */
  revision: number;
  updatedAt: Date;
}

const CASE_STATUSES: ModerationCaseStatus[] = [
  "open",
  "under_review",
  "upheld",
  "lifted",
  "expired",
];

const ModerationCaseEventSchema = new Schema<IModerationCaseEvent>(
  {
    at: { type: Date, required: true },
    byUserId: { type: String, required: true },
    from: { type: String, enum: CASE_STATUSES, required: true },
    to: { type: String, enum: CASE_STATUSES, required: true },
    outcome: {
      type: String,
      enum: ["upheld", "extended", "permanent", "readmitted"],
      default: null,
    },
    note: { type: String, default: null },
  },
  { _id: false },
);

const ModerationCaseSchema = new Schema<IModerationCase>(
  {
    guildId: { type: String, required: true },
    caseNumber: { type: Number, required: true },
    userId: { type: String, required: true },
    originEntryId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, enum: ["kick", "ban"], required: true },
    status: {
      type: String,
      enum: CASE_STATUSES,
      required: true,
      default: "open",
    },
    reviewAt: { type: Date, default: null },
    openedAt: { type: Date, required: true, default: Date.now },
    originModeratorId: { type: String, default: null },
    openedByUserId: { type: String, required: true },
    resolutionEntryId: { type: Schema.Types.ObjectId, default: null },
    events: { type: [ModerationCaseEventSchema], default: [] },
    revision: { type: Number, required: true, default: 0 },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

// The review queue: due and overdue cases for one guild.
ModerationCaseSchema.index({ guildId: 1, status: 1, reviewAt: 1 });
// Per-member lookup, backing the member view.
ModerationCaseSchema.index({ guildId: 1, userId: 1, openedAt: -1 });
// Case reference lookup, and the uniqueness guarantee for case numbers.
ModerationCaseSchema.index({ guildId: 1, caseNumber: 1 }, { unique: true });
// Reverse lookup from a log row, used by `/modlog`, the admin page and the
// retention exemption. Unique: one case per entry, so two staff opening the
// same entry at once cannot both win.
ModerationCaseSchema.index({ guildId: 1, originEntryId: 1 }, { unique: true });

export const ModerationCase = mongoose.model<IModerationCase>(
  "ModerationCase",
  ModerationCaseSchema,
);

/**
 * Per-guild case-number sequence. Moderators quote case numbers aloud, so a
 * hex ObjectId suffix is a poor reference; `$inc` with `upsert` is race-free
 * where `countDocuments() + 1` is not. Carries no user ids.
 */
export interface IModerationCaseCounter extends Document {
  guildId: string;
  seq: number;
}

const ModerationCaseCounterSchema = new Schema<IModerationCaseCounter>(
  {
    guildId: { type: String, required: true, unique: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: false },
);

export const ModerationCaseCounter = mongoose.model<IModerationCaseCounter>(
  "ModerationCaseCounter",
  ModerationCaseCounterSchema,
);
