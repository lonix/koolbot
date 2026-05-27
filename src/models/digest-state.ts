import mongoose, { Document, Schema } from "mongoose";

/**
 * Per-user weekly digest delivery state (#483).
 *
 * One row per `(userId, guildId)`. The fields capture the snapshot from
 * the previous successful delivery so the next run can compute deltas
 * (voice-time, rank) and maintain the consecutive-weeks streak without
 * re-aggregating beyond the current 7-day window.
 *
 * Rows are written by `DigestService` after a digest is sent (or after
 * a qualifying-but-undeliverable week, to keep streak math correct);
 * deletions happen only when the user is purged from the guild and are
 * not the digest job's responsibility.
 */
export interface IDigestState extends Document {
  userId: string;
  guildId: string;
  lastSentAt: Date;
  lastWeekTotalTime: number; // seconds
  lastWeekRank: number | null; // null when user was unranked
  streakWeeks: number; // consecutive qualifying weeks ending lastSentAt
}

const DigestStateSchema = new Schema<IDigestState>(
  {
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    lastSentAt: { type: Date, required: true },
    lastWeekTotalTime: { type: Number, required: true, default: 0 },
    lastWeekRank: { type: Number, default: null },
    streakWeeks: { type: Number, required: true, default: 0 },
  },
  { timestamps: false },
);

DigestStateSchema.index({ userId: 1, guildId: 1 }, { unique: true });

export const DigestState = mongoose.model<IDigestState>(
  "DigestState",
  DigestStateSchema,
);
