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
  }>;
  excludedChannels: string[]; // Array of voice channel IDs to exclude from tracking
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
    },
  ],
  excludedChannels: { type: [String], default: [] },
});

export const VoiceChannelTracking = mongoose.model<IVoiceChannelTracking>(
  "VoiceChannelTracking",
  VoiceChannelTrackingSchema,
);
