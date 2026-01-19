import mongoose, { Schema, Document } from "mongoose";

// Accolades are persistent badges earned once and kept forever
export interface IAccolade {
  type: string; // e.g., "night_owl", "marathon", "social_butterfly"
  earnedAt: Date;
  metadata?: {
    value?: number; // The value that earned the badge (hours, sessions, etc.)
    description?: string;
  };
}

// Achievements are time-based accomplishments (weekly/monthly)
export interface IAchievement {
  type: string;
  earnedAt: Date;
  period: string; // e.g., "2026-W03" for week, "2026-01" for month
  rank?: number; // Rank in leaderboard if applicable
  metadata?: {
    value?: number;
    description?: string;
  };
}

export interface IUserGamification extends Document {
  userId: string;
  username: string;
  accolades: IAccolade[]; // Persistent badges
  achievements: IAchievement[]; // Recent accomplishments
  lastChecked: Date; // Last time achievements were checked
  statistics: {
    totalAccolades: number;
    totalAchievements: number;
  };
}

const UserGamificationSchema = new Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  accolades: [
    {
      type: { type: String, required: true },
      earnedAt: { type: Date, required: true },
      metadata: {
        value: { type: Number },
        description: { type: String },
      },
    },
  ],
  achievements: [
    {
      type: { type: String, required: true },
      earnedAt: { type: Date, required: true },
      period: { type: String, required: true },
      rank: { type: Number },
      metadata: {
        value: { type: Number },
        description: { type: String },
      },
    },
  ],
  lastChecked: { type: Date, default: Date.now },
  statistics: {
    totalAccolades: { type: Number, default: 0 },
    totalAchievements: { type: Number, default: 0 },
  },
});

export const UserGamification = mongoose.model<IUserGamification>(
  "UserGamification",
  UserGamificationSchema,
);
