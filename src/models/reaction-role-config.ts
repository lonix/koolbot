import mongoose, { Schema, Document } from "mongoose";

/**
 * Surface style used to self-assign the role:
 * - `reaction`: classic emoji reaction on the message (legacy default).
 * - `button`:   a clickable button component on the message.
 * - `select`:   a string select-menu option on the message.
 *
 * `button` and `select` are component-backed and resolve the acting member
 * directly from the interaction (no reaction intents/partials required).
 */
export type ReactionRoleStyle = "reaction" | "button" | "select";

export const REACTION_ROLE_STYLES: ReactionRoleStyle[] = [
  "reaction",
  "button",
  "select",
];

export interface IReactionRoleConfig extends Document {
  guildId: string;
  messageId: string;
  channelId: string;
  roleId: string;
  categoryId: string;
  emoji: string;
  roleName: string;
  style: ReactionRoleStyle;
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
    style: {
      type: String,
      enum: REACTION_ROLE_STYLES,
      // Existing documents predate this field; default to the legacy reaction
      // surface so they keep behaving exactly as before.
      default: "reaction",
      required: true,
      index: true,
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
ReactionRoleConfigSchema.index({ guildId: 1, roleName: 1 }, { unique: true });

export const ReactionRoleConfig = mongoose.model<IReactionRoleConfig>(
  "ReactionRoleConfig",
  ReactionRoleConfigSchema,
);
