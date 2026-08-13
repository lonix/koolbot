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

/**
 * Assignment behaviour for a reaction role (#814):
 * - `toggle` (default, back-compat): react = add, unreact = remove.
 * - `sticky`: react grants the role; removing the reaction does NOT revoke it.
 * - `unique`: reacting removes the sibling roles configured on the same
 *   message (one-of-set / pick exactly one).
 */
export type ReactionRoleMode = "toggle" | "sticky" | "unique";

export const REACTION_ROLE_MODES: readonly ReactionRoleMode[] = [
  "toggle",
  "sticky",
  "unique",
];

export interface IReactionRoleConfig extends Document {
  guildId: string;
  messageId: string;
  /**
   * The private text channel created for an auto-created reaction role.
   * Optional: mappings that bind to an existing role (or opt out of the
   * private category/channel) have no owned channel.
   */
  channelId?: string;
  roleId: string;
  /**
   * The private category created for an auto-created reaction role.
   * Optional for the same reasons as {@link channelId}.
   */
  categoryId?: string;
  emoji: string;
  roleName: string;
  style: ReactionRoleStyle;
  /**
   * True when the bot created the role (and, when present, its category and
   * channel) as part of this mapping and therefore owns their lifecycle.
   * When false the mapping merely points at a pre-existing role, so deleting
   * the mapping must never delete the role. Legacy rows created before this
   * field existed are all auto-created; the startup migration backfills them
   * with `true` (see reaction-role-migrator.ts).
   */
  autoCreated: boolean;
  mode: ReactionRoleMode;
  // Correlates the mappings that share one message as a one-of-set group
  // (#814). Populated only for grouped mappings; single mappings leave it
  // undefined. Equal to the group's anchor message id at creation time.
  groupId?: string;
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
      required: false,
    },
    roleId: {
      type: String,
      required: true,
      index: true,
    },
    categoryId: {
      type: String,
      required: false,
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
    autoCreated: {
      type: Boolean,
      default: true,
      index: true,
    },
    mode: {
      type: String,
      enum: REACTION_ROLE_MODES,
      default: "toggle",
      required: true,
    },
    groupId: {
      type: String,
      required: false,
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

// A single message can now carry many emoji→role mappings, but a given emoji
// on a given message must still resolve to exactly one mapping — otherwise the
// reaction handlers wouldn't know which role to grant. This unique compound
// index enforces that and replaces the former `{ guildId, roleName }` unique
// index, which wrongly assumed a role could only ever appear on one picker.
ReactionRoleConfigSchema.index(
  { guildId: 1, messageId: 1, emoji: 1 },
  { unique: true },
);
ReactionRoleConfigSchema.index({ guildId: 1, roleId: 1 });
// Non-unique: the same role name may appear across multiple pickers/messages.
ReactionRoleConfigSchema.index({ guildId: 1, roleName: 1 });

export const ReactionRoleConfig = mongoose.model<IReactionRoleConfig>(
  "ReactionRoleConfig",
  ReactionRoleConfigSchema,
);
