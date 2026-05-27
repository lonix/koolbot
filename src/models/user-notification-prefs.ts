import mongoose, { Document, Schema } from "mongoose";

/**
 * Per-user notification preferences (#482).
 *
 * A missing row means "all defaults true" — see
 * `UserNotificationPrefsService.getPrefs`. Storage is per `(userId, guildId)`.
 *
 * The `digest` (#483) and `rewind` (#484) fields ship from day one with
 * defaulting writes so the schema is stable across all three sub-issues:
 * downstream PRs only have to read them in their own DM paths.
 */
export interface IUserNotificationPrefs extends Document {
  userId: string;
  guildId: string;
  achievements: boolean;
  digest: boolean;
  rewind: boolean;
  updatedAt: Date;
}

const UserNotificationPrefsSchema = new Schema<IUserNotificationPrefs>(
  {
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    achievements: { type: Boolean, required: true, default: true },
    digest: { type: Boolean, required: true, default: true },
    rewind: { type: Boolean, required: true, default: true },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

UserNotificationPrefsSchema.index({ userId: 1, guildId: 1 }, { unique: true });

export const UserNotificationPrefs = mongoose.model<IUserNotificationPrefs>(
  "UserNotificationPrefs",
  UserNotificationPrefsSchema,
);
