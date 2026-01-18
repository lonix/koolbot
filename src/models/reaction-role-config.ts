import mongoose, { Schema, Document } from "mongoose";

export interface IReactionRoleConfig extends Document {
  guildId: string;
  messageId: string;
  channelId: string;
  roleId: string;
  categoryId: string;
  emoji: string;
  roleName: string;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

const ReactionRoleConfigSchema = new Schema<IReactionRoleConfig>(
  {
    guildId: {
      type: String,
      required: true,
      index: true,
    },
    messageId: {
      type: String,
      required: true,
      index: true,
    },
    channelId: {
      type: String,
      required: true,
    },
    roleId: {
      type: String,
      required: true,
      index: true,
    },
    categoryId: {
      type: String,
      required: true,
    },
    emoji: {
      type: String,
      required: true,
    },
    roleName: {
      type: String,
      required: true,
    },
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
    },
    archivedAt: {
      type: Date,
      required: false,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient queries
ReactionRoleConfigSchema.index({ guildId: 1, messageId: 1, emoji: 1 });
ReactionRoleConfigSchema.index({ guildId: 1, roleId: 1 });

export const ReactionRoleConfig = mongoose.model<IReactionRoleConfig>(
  "ReactionRoleConfig",
  ReactionRoleConfigSchema,
);
