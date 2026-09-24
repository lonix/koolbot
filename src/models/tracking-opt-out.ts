import mongoose, { Document, Schema } from "mongoose";

/**
 * A member's standing "do not track me" flag, per `(userId, guildId)` (#918).
 *
 * A row existing *is* the opt-out: the message, reaction and voice trackers
 * skip every write for a member who has one. There is no `optedOut: false`
 * state — opting back in deletes the row, so the collection only ever holds
 * members who are currently opted out.
 *
 * This is the one row a `/me/privacy` reset deliberately keeps. Without it
 * the trackers start writing again on the member's next message, reaction
 * or voice join, and the reset is only a reset; with it, the reset is a
 * deletion. That makes the flag itself a small piece of personal data the
 * reset cannot remove — which the page copy says out loud — and the only
 * way to remove it is to opt back in.
 */
export interface ITrackingOptOut extends Document {
  userId: string;
  guildId: string;
  optedOutAt: Date;
}

const TrackingOptOutSchema = new Schema<ITrackingOptOut>(
  {
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    optedOutAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

TrackingOptOutSchema.index({ userId: 1, guildId: 1 }, { unique: true });

export const TrackingOptOut = mongoose.model<ITrackingOptOut>(
  "TrackingOptOut",
  TrackingOptOutSchema,
);
