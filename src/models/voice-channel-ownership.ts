import mongoose, { Schema, Document } from "mongoose";

/**
 * Persisted ownership of a bot-created dynamic voice channel.
 *
 * VoiceChannelManager tracks ownership in memory (`userChannels`), which is
 * lost on restart — orphaning every channel the bot created beforehand so they
 * are reclassified as "unmanaged" (no owner controls / rename / lifecycle, and
 * the periodic cleanup treats them as foreign). Persisting one row per managed
 * channel lets the manager rebuild that state on boot and reconcile against the
 * channels that still exist in the guild. (issue #615)
 *
 * One row per channel: `channelId` is unique. `ownerId` is updated in place
 * when ownership transfers, and `customName` mirrors a tracked custom rename so
 * the managed-channel classification survives a restart too.
 */
export interface IVoiceChannelOwnership extends Document {
  guildId: string;
  channelId: string;
  ownerId: string;
  customName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const VoiceChannelOwnershipSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true, unique: true },
    ownerId: { type: String, required: true, index: true },
    customName: { type: String },
  },
  {
    timestamps: true,
  },
);

export const VoiceChannelOwnership = mongoose.model<IVoiceChannelOwnership>(
  "VoiceChannelOwnership",
  VoiceChannelOwnershipSchema,
);
