import mongoose, { Schema, Document } from "mongoose";

export interface IPollItem extends Document {
  guildId: string;
  question: string;
  answers: string[]; // 2-10 answer options
  multiSelect: boolean;
  tags: string[]; // Optional categorization (e.g., "icebreaker", "funny", "absurd")
  usageCount: number; // Track how many times used
  lastUsed: Date | null; // When it was last posted
  enabled: boolean;
  createdBy: string; // User ID who created/imported the item
  source: string; // "manual" or URL it was imported from
  createdAt: Date;
  updatedAt: Date;
}

const PollItemSchema = new Schema<IPollItem>(
  {
    guildId: { type: String, required: true, index: true },
    question: { type: String, required: true, maxlength: 300 },
    answers: {
      type: [String],
      required: true,
      validate: {
        validator: function (v: string[]) {
          return v.length >= 2 && v.length <= 10;
        },
        message: "Poll must have between 2 and 10 answers",
      },
    },
    multiSelect: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    usageCount: { type: Number, default: 0 },
    lastUsed: { type: Date, default: null },
    enabled: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
    source: { type: String, default: "manual" },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient querying of eligible polls
PollItemSchema.index({ guildId: 1, enabled: 1, lastUsed: 1 });

export const PollItem = mongoose.model<IPollItem>("PollItem", PollItemSchema);
