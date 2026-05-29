import mongoose, { Schema, Document } from "mongoose";

/**
 * Per-user, per-guild text-message activity tracking.
 *
 * Mirrors `VoiceChannelTracking` for text: `channels[]` keeps cheap
 * all-time per-channel totals (never pruned), while `recentMessages[]`
 * holds the thin per-message detail used to derive peak day / weekly /
 * yearly aggregates without scanning Discord history. The detail array is
 * trimmed by the cleanup pass (`MessageActivityCleanupService`); the
 * all-time totals are kept indefinitely.
 */
export interface IMessageActivityTracking extends Document {
  userId: string;
  guildId: string;
  username: string;
  channels: Array<{ channelId: string; count: number }>;
  recentMessages: Array<{ sentAt: Date; channelId: string }>;
  totalCount: number;
  lastMessageAt: Date | null;
  // Cleanup bookkeeping, mirroring VoiceChannelTracking.lastCleanupDate.
  lastCleanupDate?: Date;
}

const MessageActivityTrackingSchema = new Schema({
  userId: { type: String, required: true },
  guildId: { type: String, required: true },
  username: { type: String, required: true },
  channels: [
    {
      channelId: { type: String, required: true },
      count: { type: Number, default: 0 },
    },
  ],
  recentMessages: [
    {
      sentAt: { type: Date, required: true },
      channelId: { type: String, required: true },
    },
  ],
  totalCount: { type: Number, default: 0 },
  lastMessageAt: { type: Date, default: null },
  lastCleanupDate: { type: Date },
});

// One tracking document per user per guild.
MessageActivityTrackingSchema.index(
  { userId: 1, guildId: 1 },
  { unique: true },
);

export const MessageActivityTracking = mongoose.model<IMessageActivityTracking>(
  "MessageActivityTracking",
  MessageActivityTrackingSchema,
);
