import { Schema } from "mongoose";

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
});
