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
  addedById: { type: String, required: true }, // Discord user ID who added the quote
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
