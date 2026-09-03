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
    // Precise per-companion co-presence in seconds — the overlapping interval
    // between this user and each other user, not the session-level union that
    // `otherUsers` records. Captured only when `voicetracking.companions.enabled`
    // is true; omitted otherwise so existing documents are unaffected. (#570)
    companions?: Array<{ userId: string; seconds: number }>;
    // Voice "firsts": whether the channel was empty when this user joined
    // (they were the first occupant), and the set of users already present at
    // their join (enables "who you most often joined right after"). Captured
    // only when `voicetracking.companions.enabled` is true. (#570)
    wasFirst?: boolean;
    joinedExisting?: string[];
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
      // Optional companion/firsts capture (#570). `default: undefined` keeps
      // the fields off existing and companion-disabled sessions entirely.
      companions: {
        type: [{ userId: String, seconds: Number }],
        default: undefined,
      },
      wasFirst: { type: Boolean },
      joinedExisting: { type: [String], default: undefined },
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

// Multikey index over the embedded session timestamps. Every time-windowed
// read filters on `sessions.startTime` — `getTopUsers` (week/month), the
// truncation sweep's `$lt: cutoff` prune, the achievements weekly champion,
// and the Rewind/analytics aggregations — but the schema previously carried
// only the implicit unique index on `userId`, so each of those was a full
// collection scan that grew linearly with guild history (#842).
VoiceChannelTrackingSchema.index({ "sessions.startTime": 1 });

export const VoiceChannelTracking = mongoose.model<IVoiceChannelTracking>(
  "VoiceChannelTracking",
  VoiceChannelTrackingSchema,
);
