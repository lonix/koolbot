import mongoose, { Document, Schema } from "mongoose";

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
      enum: [
        "amikool",
        "announcements",
        "core",
        "fun",
        "gamification",
        "help",
        "ping",
        "quotes",
        "ratelimit",
        "reactionroles",
        "voicechannels",
        "voicetracking",
        "wizard",
      ],
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
