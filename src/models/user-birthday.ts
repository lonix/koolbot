import mongoose, { Document, Schema } from "mongoose";

/**
 * Per-user birthday, stored per `(userId, guildId)` (#657).
 *
 * Greenfield model — there is no birthday data anywhere else. The
 * feature is fully opt-in: a row only exists once a member sets their
 * birthday on the `/me/birthday` self-service page, so a missing row
 * simply means "this member has no birthday on file" and the daily
 * announcer skips them.
 *
 * `year` is **optional** by design (privacy): many people are happy to
 * share the date but not the age. When omitted, no age is computed or
 * shown. `lastAnnouncedYear` is the calendar year — evaluated in the
 * member's own timezone — that the bot last posted a birthday message,
 * and is the idempotency guard that prevents a double-post across
 * restarts, DST edges, or a sub-daily cron cadence.
 *
 * `roleAssignedAt` records when the temporary "birthday" role was last
 * granted to the member, so the daily sweep can revoke it once the
 * configured duration has elapsed even if the process restarted in
 * between (the grant is not held in memory).
 */
export interface IUserBirthday extends Document {
  userId: string;
  guildId: string;
  month: number; // 1-12
  day: number; // 1-31
  year?: number; // optional — omitted means "don't show/compute age"
  lastAnnouncedYear?: number; // year (in the member's tz) last announced
  roleAssignedAt?: Date; // when the temp birthday role was granted
  updatedAt: Date;
}

const UserBirthdaySchema = new Schema<IUserBirthday>(
  {
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    day: { type: Number, required: true, min: 1, max: 31 },
    // Optional birth year; absent → age is never computed or displayed.
    year: { type: Number, required: false },
    lastAnnouncedYear: { type: Number, required: false },
    roleAssignedAt: { type: Date, required: false },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

UserBirthdaySchema.index({ userId: 1, guildId: 1 }, { unique: true });

export const UserBirthday = mongoose.model<IUserBirthday>(
  "UserBirthday",
  UserBirthdaySchema,
);
