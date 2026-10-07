import mongoose, { Document, Schema } from "mongoose";

/** How an acceptance was recorded. */
export const RULES_ACCEPTANCE_SOURCES = ["button", "adopted"] as const;
export type RulesAcceptanceSource = (typeof RULES_ACCEPTANCE_SOURCES)[number];

/**
 * When a member accepted the server rules (#1024), per `(userId, guildId)`.
 *
 * `source: "button"` is a member clicking Accept. `"adopted"` marks members who
 * already held the acceptance role when it was adopted (or were granted it by
 * an adoption plan for existing members), so they never have to click.
 */
export interface IRulesAcceptance extends Document {
  userId: string;
  guildId: string;
  acceptedAt: Date;
  source: RulesAcceptanceSource;
}

const RulesAcceptanceSchema = new Schema<IRulesAcceptance>(
  {
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    acceptedAt: { type: Date, required: true, default: Date.now },
    source: {
      type: String,
      required: true,
      enum: RULES_ACCEPTANCE_SOURCES,
      default: "button",
    },
  },
  { timestamps: false },
);

RulesAcceptanceSchema.index({ userId: 1, guildId: 1 }, { unique: true });

export const RulesAcceptance = mongoose.model<IRulesAcceptance>(
  "RulesAcceptance",
  RulesAcceptanceSchema,
);
