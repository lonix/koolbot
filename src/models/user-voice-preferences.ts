import mongoose, { Schema, Document } from "mongoose";

export interface IChannelPreset {
  name: string; // Preset label, e.g. "Squad night"
  channelName?: string; // Channel name to apply when this preset is loaded
  userLimit?: number; // 0 = unlimited
  bitrate?: number; // kbps (Discord accepts 8–384)
  isDefault?: boolean; // Auto-apply on next lobby spawn
}

export interface IUserVoicePreferences extends Document {
  userId: string;
  namePattern?: string; // Custom channel naming pattern (e.g., "{username}'s Room", "🎮 {username}")
  presets: IChannelPreset[];
  createdAt: Date;
  updatedAt: Date;
}

const ChannelPresetSchema = new Schema<IChannelPreset>(
  {
    name: { type: String, required: true, maxlength: 50 },
    channelName: { type: String, maxlength: 100 },
    userLimit: { type: Number, min: 0, max: 99 },
    bitrate: { type: Number, min: 8, max: 384 },
    isDefault: { type: Boolean, default: false },
  },
  { _id: false },
);

const UserVoicePreferencesSchema = new Schema(
  {
    userId: { type: String, required: true, unique: true },
    namePattern: { type: String },
    presets: { type: [ChannelPresetSchema], default: [] },
  },
  {
    timestamps: true,
  },
);

export const UserVoicePreferences = mongoose.model<IUserVoicePreferences>(
  "UserVoicePreferences",
  UserVoicePreferencesSchema,
);
