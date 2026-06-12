import mongoose, { Schema, Document } from "mongoose";

/**
 * Per-user, per-guild reaction activity tracking.
 *
 * Captures two cheap, append-only counters per user: how many reactions they
 * have *given* (added to other people's messages) and *received* (added by
 * others to their messages). Reaction events are high-volume, so rather than
 * retaining per-reaction detail (which would need a cleanup pass and grow
 * without bound) we keep only lifetime totals plus per-year buckets keyed by
 * "YYYY". A future Rewind can read a single year's count in one lookup, and
 * the storage cost is one tiny map entry per user per year.
 *
 * This is a data-capture foundation only — like message tracking (#495), it
 * does not surface anything on Rewind or the WebUI yet. Gated behind
 * `reactiontracking.enabled`; nothing is written while that key is false.
 */
export interface IReactionActivityTracking extends Document {
  userId: string;
  guildId: string;
  username: string;
  totalGiven: number;
  totalReceived: number;
  // Per-year counters keyed by "YYYY" (host-timezone year at capture time).
  yearlyGiven: Map<string, number>;
  yearlyReceived: Map<string, number>;
  lastReactionAt: Date | null;
}

const ReactionActivityTrackingSchema = new Schema({
  userId: { type: String, required: true },
  guildId: { type: String, required: true },
  username: { type: String, required: true },
  totalGiven: { type: Number, default: 0 },
  totalReceived: { type: Number, default: 0 },
  yearlyGiven: { type: Map, of: Number, default: {} },
  yearlyReceived: { type: Map, of: Number, default: {} },
  lastReactionAt: { type: Date, default: null },
});

// One tracking document per user per guild.
ReactionActivityTrackingSchema.index(
  { userId: 1, guildId: 1 },
  { unique: true },
);

export const ReactionActivityTracking =
  mongoose.model<IReactionActivityTracking>(
    "ReactionActivityTracking",
    ReactionActivityTrackingSchema,
  );
