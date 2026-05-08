import mongoose, { Document, Schema } from "mongoose";

export interface IWebSession extends Document {
  token_hash: string;
  discord_user_id: string;
  guild_id: string;
  scopes: string[];
  created_at: Date;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

const WebSessionSchema = new Schema<IWebSession>(
  {
    token_hash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    discord_user_id: {
      type: String,
      required: true,
      index: true,
    },
    guild_id: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      required: true,
      default: [],
    },
    created_at: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expires_at: {
      type: Date,
      required: true,
    },
    used_at: {
      type: Date,
      default: null,
    },
    revoked_at: {
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
