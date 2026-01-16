import mongoose, { Schema, Document } from "mongoose";

export interface IUserVoicePreferences extends Document {
  userId: string;
  namePattern?: string; // Custom channel naming pattern (e.g., "{username}'s Room", "🎮 {username}")
  userLimit?: number; // Channel user limit (0 = unlimited)
  bitrate?: number; // Bitrate in kbps (8-384 for most servers, up to 128 for non-boosted)
  createdAt: Date;
  updatedAt: Date;
}

const UserVoicePreferencesSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true },
    namePattern: { type: String },
    userLimit: { type: Number, min: 0, max: 99 },
    bitrate: { type: Number, min: 8, max: 384 }, // Discord limits: 8kbps min, 384kbps max (with boost)
  },
  {
    timestamps: true,
  },
);

export const UserVoicePreferences = mongoose.model<IUserVoicePreferences>(
  "UserVoicePreferences",
  UserVoicePreferencesSchema,
);
