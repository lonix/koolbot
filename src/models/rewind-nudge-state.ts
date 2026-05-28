import mongoose, { Document, Schema } from "mongoose";

/**
 * Per-user per-year delivery marker for the Rewind nudge (#484).
 *
 * One row per `(userId, guildId, year)`. The presence of a row means
 * the end-of-year nudge has already been sent for that user/year — the
 * `RewindNudgeService` checks for it before sending so a re-run of the
 * cron (or a manual `runNow()` during validation) cannot double-DM.
 *
 * Rows are only written after a SUCCESSFUL send; DM-closed / failed
 * deliveries do not record a marker so a retry can pick them up.
 */
export interface IRewindNudgeState extends Document {
  userId: string;
  guildId: string;
  year: number;
  sentAt: Date;
}

const RewindNudgeStateSchema = new Schema<IRewindNudgeState>(
  {
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    year: { type: Number, required: true },
    sentAt: { type: Date, required: true },
  },
  { timestamps: false },
);

RewindNudgeStateSchema.index(
  { userId: 1, guildId: 1, year: 1 },
  { unique: true },
);

export const RewindNudgeState = mongoose.model<IRewindNudgeState>(
  "RewindNudgeState",
  RewindNudgeStateSchema,
);
