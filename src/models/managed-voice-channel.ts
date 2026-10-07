import mongoose, { Schema, Document } from "mongoose";

/**
 * A voice channel KoolBot itself created (or, once, adopted), tracked by ID.
 *
 * Only consulted when `voicechannels.cleanup.managed_only` is on (issue #1032).
 * In that mode startup and periodic cleanup delete a channel only if its ID is
 * in this collection (or in the ownership registry), so an existing, shared
 * category can be pointed at without KoolBot deleting another bot's
 * join-to-create channel or a community's permanent rooms.
 *
 * Rows are written whenever the bot creates a channel regardless of the
 * toggle, so enabling it later starts from an accurate set. `source: "adopted"`
 * marks channels claimed by the one-time naming-pattern migration.
 *
 * Holds no Discord user ids, so it is not part of the member data registry;
 * per-owner state stays in `voice-channel-ownership`.
 */
export type ManagedVoiceChannelKind = "channel" | "waiting_room" | "lobby";
export type ManagedVoiceChannelSource = "created" | "adopted";

export interface IManagedVoiceChannel extends Document {
  guildId: string;
  channelId: string;
  kind: ManagedVoiceChannelKind;
  source: ManagedVoiceChannelSource;
  createdAt: Date;
  updatedAt: Date;
}

const ManagedVoiceChannelSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true, unique: true },
    kind: {
      type: String,
      enum: ["channel", "waiting_room", "lobby"],
      default: "channel",
    },
    source: {
      type: String,
      enum: ["created", "adopted"],
      default: "created",
    },
  },
  { timestamps: true },
);

export const ManagedVoiceChannel = mongoose.model<IManagedVoiceChannel>(
  "ManagedVoiceChannel",
  ManagedVoiceChannelSchema,
);

/**
 * Marks that the one-time "adopt channels matching the KoolBot naming pattern"
 * migration has run for a guild, so it never repeats (issue #1032).
 */
export interface IManagedVoiceMigration extends Document {
  guildId: string;
  adoptedCount: number;
  migratedAt: Date;
}

const ManagedVoiceMigrationSchema = new Schema({
  guildId: { type: String, required: true, unique: true },
  adoptedCount: { type: Number, default: 0 },
  migratedAt: { type: Date, default: Date.now },
});

export const ManagedVoiceMigration = mongoose.model<IManagedVoiceMigration>(
  "ManagedVoiceMigration",
  ManagedVoiceMigrationSchema,
);
