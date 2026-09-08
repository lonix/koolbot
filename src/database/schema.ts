import { Schema } from "mongoose";

/**
 * One recorded change to a quote's 👍 tally (#817).
 *
 * Votes used to be stored only as cumulative counters, so "top-voted this
 * week" could not be answered for a quote added before the window. Each
 * signed `delta` (a like gained, or an un-reacted like lost) is stamped with
 * the time it was observed, which is what makes a vote window answerable.
 */
export const quoteLikeEventSchema = new Schema(
  {
    at: { type: Date, required: true },
    delta: { type: Number, required: true },
  },
  { _id: false },
);

export const quoteSchema = new Schema({
  content: { type: String, required: true },
  authorId: { type: String, required: true }, // Discord user ID who said the quote
  // Discord user ID who added the quote. `required: true`, so a per-user
  // purge cannot null it out — it writes the `ANONYMISED_USER_ID` sentinel
  // ("0", see `services/user-data-registry.ts`) instead, which keeps the
  // quote standing while dropping the saver's identity (#914).
  addedById: { type: String, required: true },
  channelId: { type: String, required: true }, // Channel where quote was said
  messageId: { type: String, required: true }, // Original message ID
  createdAt: { type: Date, required: true, default: Date.now },
  addedAt: { type: Date, required: true, default: Date.now },
  likes: { type: Number, required: true, default: 0 },
  dislikes: { type: Number, required: true, default: 0 },
  // Per-vote like timing, retained for a bounded window (#817). Absent on
  // quotes that predate the feature — those simply contribute nothing to a
  // vote window, which is the documented "no backfill" behaviour.
  likeEvents: { type: [quoteLikeEventSchema], default: [] },
});

quoteSchema.index({ "likeEvents.at": -1 });
// Both user fields are queried directly by the per-user export and purge
// (`{ $or: [{ authorId }, { addedById }] }`), and the achievement counters
// hit them on every quote added. Without these the schema declared no
// user-field index at all and each of those was a collection scan (#914).
quoteSchema.index({ authorId: 1 });
quoteSchema.index({ addedById: 1 });
