import mongoose, { Document, Schema } from "mongoose";

export type WebSessionRole = "admin" | "user";

export interface IWebSession extends Document {
  tokenHash: string;
  discordUserId: string;
  guildId: string;
  /**
   * Determines which web surface this session is authorised for. `admin`
   * sessions may use `/admin/*` and `/me/*`; `user` sessions are limited to
   * `/me/*`. Pre-role rows in the DB are missing this field — callers must
   * treat that case as legacy `admin` (the only role that could exist before
   * #481) at read time.
   */
  role: WebSessionRole;
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
    role: {
      type: String,
      enum: ["admin", "user"],
      required: true,
      default: "user",
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
