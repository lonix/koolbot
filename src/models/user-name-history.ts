import mongoose, { Document, Schema } from "mongoose";

export const NAME_KINDS = ["username", "globalName", "nickname"] as const;
export type NameKind = (typeof NAME_KINDS)[number];

/**
 * One name KoolBot has seen a member use (#1038): a Discord username, a
 * global display name, or a server nickname. One row per distinct
 * `(guildId, userId, kind, name)`; seeing the same name again only bumps
 * `lastSeenAt`, so the collection grows with the number of *changes*, not the
 * number of events the bot observed.
 */
export interface IUserNameHistory extends Document {
  guildId: string;
  userId: string;
  kind: NameKind;
  name: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const UserNameHistorySchema = new Schema<IUserNameHistory>(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    kind: { type: String, required: true, enum: NAME_KINDS },
    name: { type: String, required: true },
    firstSeenAt: { type: Date, required: true, default: Date.now },
    lastSeenAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

UserNameHistorySchema.index(
  { guildId: 1, userId: 1, kind: 1, name: 1 },
  { unique: true },
);
// Retention cleanup scans by lastSeenAt.
UserNameHistorySchema.index({ lastSeenAt: 1 });

export const UserNameHistory = mongoose.model<IUserNameHistory>(
  "UserNameHistory",
  UserNameHistorySchema,
);
