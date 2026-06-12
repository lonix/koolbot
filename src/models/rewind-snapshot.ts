import mongoose, { Document, Schema } from "mongoose";
import type { RewindSummary } from "../services/rewind-service.js";

/**
 * Immutable per-user per-year Rewind snapshot (#574).
 *
 * Rewind is normally computed live from raw voice/text activity, but that
 * raw data is pruned by retention (`VoiceChannelTruncationService`,
 * `MessageActivityCleanupService`). So a completed year's recap silently
 * degrades — open your 2026 Rewind in 2028 and the source sessions/messages
 * are long gone. To keep a finished year permanent we freeze each
 * qualifying user's full `RewindSummary` into one row at year rollover.
 *
 * One row per `(guildId, userId, year)`, written once by
 * `RewindNudgeService` alongside the end-of-year nudge cron. Creation is
 * idempotent via the unique index: a re-run never duplicates or mutates an
 * existing snapshot — the recap is frozen exactly as it was generated.
 *
 * `summary` stores the serialised `RewindSummary` (already a plain,
 * view-ready shape). `schemaVersion` lets the summary shape evolve: old
 * snapshots render with their stored version and the view tolerates fields
 * added after they were frozen.
 */
export interface IRewindSnapshot extends Document {
  guildId: string;
  userId: string;
  year: number;
  summary: RewindSummary;
  schemaVersion: number;
  generatedAt: Date;
}

const RewindSnapshotSchema = new Schema<IRewindSnapshot>(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    year: { type: Number, required: true },
    // The full view-ready summary, stored verbatim. Mixed because the
    // shape is owned by `RewindService` and intentionally frozen per
    // `schemaVersion` rather than re-validated here.
    summary: { type: Schema.Types.Mixed, required: true },
    schemaVersion: { type: Number, required: true },
    generatedAt: { type: Date, required: true },
  },
  { timestamps: false, minimize: false },
);

RewindSnapshotSchema.index(
  { guildId: 1, userId: 1, year: 1 },
  { unique: true },
);

export const RewindSnapshot = mongoose.model<IRewindSnapshot>(
  "RewindSnapshot",
  RewindSnapshotSchema,
);
