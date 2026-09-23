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
 * between (the grant is not held in memory). `roleAssignedId` records
 * *which* role that was: `birthdays.role_id` can be changed or cleared
 * while a grant is live, and without the id the sweep and a per-user purge
 * would revoke the wrong role — or none — and then drop the only marker,
 * leaving the old role on the member for good (#916). Rows written before
 * that field existed have no id; the configured role is the best available
 * fallback for them.
 *
 * `announcements` records the birthday messages the bot has posted about
 * this member — one per year, each naming them and, when `year` is set,
 * their age. Those posts are the member's data too, and nothing else on the
 * server knows the bot wrote them, so a per-user purge has to be able to
 * find and delete them; without this list the row goes and the messages stay
 * up for good (#916). Rows written before the field existed have no list,
 * which is the best available answer for posts that were never recorded.
 */
export interface IUserBirthday extends Document {
  userId: string;
  guildId: string;
  month: number; // 1-12
  day: number; // 1-31
  year?: number; // optional — omitted means "don't show/compute age"
  lastAnnouncedYear?: number; // year (in the member's tz) last announced
  roleAssignedAt?: Date; // when the temp birthday role was granted
  roleAssignedId?: string; // which role that was (see the note above)
  announcements?: IBirthdayAnnouncement[]; // posts to delete on a purge
  updatedAt: Date;
}

/** One birthday message the bot posted about a member (see the note above). */
export interface IBirthdayAnnouncement {
  channelId: string;
  messageId: string;
  /** Calendar year the post was made for, in the member's own timezone. */
  year: number;
}

const AnnouncementSchema = new Schema<IBirthdayAnnouncement>(
  {
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
    year: { type: Number, required: true },
  },
  { _id: false },
);

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
    roleAssignedId: { type: String, required: false },
    announcements: {
      type: [AnnouncementSchema],
      required: false,
      default: undefined,
    },
    updatedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

UserBirthdaySchema.index({ userId: 1, guildId: 1 }, { unique: true });

export const UserBirthday = mongoose.model<IUserBirthday>(
  "UserBirthday",
  UserBirthdaySchema,
);
