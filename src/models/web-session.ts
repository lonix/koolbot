import mongoose, { Document, Schema } from "mongoose";

export interface IWebSession extends Document {
  tokenHash: string;
  discordUserId: string;
  guildId: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

const WebSessionSchema = new Schema<IWebSession>(
  {
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    discordUserId: {
      type: String,
      required: true,
      index: true,
    },
    guildId: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      required: true,
      default: [],
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    usedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: false },
);

export const WebSession = mongoose.model<IWebSession>(
  "WebSession",
  WebSessionSchema,
);
