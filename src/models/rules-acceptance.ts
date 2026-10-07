import mongoose, { Document, Schema } from "mongoose";

/** How an acceptance was recorded. */
export const RULES_ACCEPTANCE_SOURCES = ["button", "adopted"] as const;
export type RulesAcceptanceSource = (typeof RULES_ACCEPTANCE_SOURCES)[number];

/**
 * When a member accepted the server rules (#1024), per `(userId, guildId)`.
 *
 * `source: "button"` is a member clicking Accept. `"adopted"` marks members who
 * already held the acceptance role: it is written by the explicit "record
 * current holders" action, or when such a holder clicks Accept. Adoption-plan
 * grants only add the role; they do not create records.
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
