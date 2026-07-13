import mongoose, { Document, Schema } from "mongoose";

/**
 * The complete set of category values a config row may use. This is the single
 * source of truth for valid categories: it backs the Mongoose enum below and is
 * reused by ConfigService's cleanup sweep so the two can never drift apart (a
 * past drift caused valid `polls.*` / `notices.*` settings to be purged as
 * "unknown" — see issue #609). Some entries are retained purely for backward
 * compatibility with legacy database rows.
 */
export const CONFIG_CATEGORIES = [
  "achievements",
  "amikool", // Kept for backward compatibility; key removed but legacy rows may exist
  "announcements",
  "birthdays",
  "core",
  "digest",
  "events",
  "fun", // Kept for backward compatibility; key removed but legacy rows may exist
  "gamification", // Kept for backward compatibility during migration
  "help",
  "leaderboard_roles",
  "messagetracking",
  "moderation",
  "notices",
  "ping",
  "polls",
  "quotes",
  "ratelimit",
  "reactionroles",
  "reactiontracking",
  "rewind",
  "voicechannels",
  "voicetracking",
  "wizard", // Kept for backward compatibility; key removed but legacy rows may exist
] as const;

export interface IConfig extends Document {
  key: string;
  value: string | number | boolean;
  description: string;
  category: string;
  updatedAt: Date;
}

const ConfigSchema = new Schema<IConfig>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    value: {
      type: Schema.Types.Mixed,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      required: true,
      enum: CONFIG_CATEGORIES,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

export const Config = mongoose.model<IConfig>("Config", ConfigSchema);
