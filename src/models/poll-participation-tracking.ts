import mongoose, { Schema, Document } from "mongoose";

/**
 * Per-user, per-guild poll-participation tracking.
 *
 * Discord's native polls do not persist per-user votes anywhere we can query
 * after the fact, so a vote that isn't captured the moment it is cast can
 * never be backfilled. This collection records one cheap counter per user:
 * how many poll votes they have cast. As with reaction tracking we keep only
 * a lifetime total plus per-year buckets keyed by "YYYY", so a future Rewind
 * can read a single year's "votes cast" count without retaining per-vote
 * detail or needing a cleanup pass.
 *
 * Gated behind `polls.participation.enabled`; nothing is written while that
 * key is false. The captured counts are surfaced (#655) on the `/me/`
 * overview ("Poll participation" card), on the Rewind card (`pollVotesCast`
 * for the year), and by the poll-participation accolades.
 */
export interface IPollParticipationTracking extends Document {
  userId: string;
  guildId: string;
  username: string;
  totalVotes: number;
  // Per-year vote counters keyed by "YYYY" (host-timezone year at capture).
  yearlyVotes: Map<string, number>;
  lastVoteAt: Date | null;
}

const PollParticipationTrackingSchema = new Schema({
  userId: { type: String, required: true },
  guildId: { type: String, required: true },
  username: { type: String, required: true },
  totalVotes: { type: Number, default: 0 },
  yearlyVotes: { type: Map, of: Number, default: {} },
  lastVoteAt: { type: Date, default: null },
});

// One tracking document per user per guild.
PollParticipationTrackingSchema.index(
  { userId: 1, guildId: 1 },
  { unique: true },
);

export const PollParticipationTracking =
  mongoose.model<IPollParticipationTracking>(
    "PollParticipationTracking",
    PollParticipationTrackingSchema,
  );
