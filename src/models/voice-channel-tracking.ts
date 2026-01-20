import mongoose, { Schema, Document } from "mongoose";

export interface IVoiceChannelTracking extends Document {
  userId: string;
  username: string;
  totalTime: number; // in seconds
  lastSeen: Date;
  sessions: Array<{
    startTime: Date;
    endTime?: Date;
    duration?: number; // in seconds
    channelId: string;
    channelName: string;
    otherUsers?: string[]; // Array of other user IDs who were in the channel during this session
  }>;
  excludedChannels: string[]; // Array of voice channel IDs to exclude from tracking
  // Cleanup-related fields for future use
  lastCleanupDate?: Date;
  monthlyTotals?: Array<{
    month: string; // YYYY-MM format
    totalTime: number;
    sessionCount: number;
    channels: string[];
    averageSessionLength: number;
  }>;
  yearlyTotals?: Array<{
    year: string; // YYYY format
    totalTime: number;
    sessionCount: number;
    channels: string[];
    averageSessionLength: number;
  }>;
}

const VoiceChannelTrackingSchema = new Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  totalTime: { type: Number, default: 0 },
  lastSeen: { type: Date, default: Date.now },
  sessions: [
    {
      startTime: { type: Date, required: true },
      endTime: { type: Date },
      duration: { type: Number },
      channelId: { type: String, required: true },
      channelName: { type: String, required: true },
      otherUsers: { type: [String], default: [] },
    },
  ],
  excludedChannels: { type: [String], default: [] },
  // Cleanup-related fields
  lastCleanupDate: { type: Date },
  monthlyTotals: [
    {
      month: { type: String, required: true },
      totalTime: { type: Number, required: true },
      sessionCount: { type: Number, required: true },
      channels: [{ type: String }],
      averageSessionLength: { type: Number, required: true },
    },
  ],
  yearlyTotals: [
    {
      year: { type: String, required: true },
      totalTime: { type: Number, required: true },
      sessionCount: { type: Number, required: true },
      channels: [{ type: String }],
      averageSessionLength: { type: Number, required: true },
    },
  ],
});

export const VoiceChannelTracking = mongoose.model<IVoiceChannelTracking>(
  "VoiceChannelTracking",
  VoiceChannelTrackingSchema,
);
