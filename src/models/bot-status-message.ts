import mongoose, { Document, Schema } from "mongoose";
import {
  BOT_STATUS_POOLS,
  STATUS_TEXT_MAX,
  type BotStatusPool,
} from "../content/statuses.js";

/**
 * A single DB-backed bot presence status entry (issue #557). Each row is
 * one line in one of the three pools (`lonely` / `single` / `multiple`)
 * for a guild. `BotStatusService` reads the live rows at pick time and
 * falls back to the hardcoded `src/content/statuses.ts` defaults when a
 * pool has no rows, so behaviour is unchanged on a fresh install.
 */
export interface IBotStatusMessage extends Document {
  guildId: string;
  pool: BotStatusPool;
  text: string;
  order: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const BotStatusMessageSchema = new Schema<IBotStatusMessage>(
  {
    guildId: { type: String, required: true, index: true },
    pool: {
      type: String,
      required: true,
      enum: [...BOT_STATUS_POOLS],
    },
    text: {
      type: String,
      required: true,
      maxlength: STATUS_TEXT_MAX,
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
    createdBy: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// One compound index serves both the per-guild/per-pool ordered reads the
// service does and the guild-scoped listing the WebUI renders.
BotStatusMessageSchema.index({ guildId: 1, pool: 1, order: 1 });

export const BotStatusMessage = mongoose.model<IBotStatusMessage>(
  "BotStatusMessage",
  BotStatusMessageSchema,
);

export default BotStatusMessage;
