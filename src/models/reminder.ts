import mongoose, { Schema, Document } from "mongoose";

/**
 * A personal, one-off reminder (#866).
 *
 * A member schedules one with `/remind set`; a once-a-minute scan in
 * `ReminderService` delivers it by DM (falling back to the channel it was
 * set in when the member's DMs are closed) and flips `delivered`.
 *
 * Like the event and birthday lifecycles, the row is the source of truth
 * rather than any in-memory timer, so a reminder survives a restart: the
 * scan simply picks up every undelivered row whose `remindAt` has passed.
 *
 * `remindAt` is an absolute UTC instant. When the member scheduled it with
 * a wall-clock `date:`/`time:` pair, `timezone` records the IANA zone that
 * pair was interpreted in — display only, so `/remind list` can echo the
 * zone the member actually meant.
 */
export interface IReminder extends Document {
  userId: string;
  guildId: string;
  /** Channel the reminder was set in; the fallback delivery target. */
  channelId: string;
  message: string;
  /** Absolute instant the reminder is due (UTC). */
  remindAt: Date;
  /** IANA zone the member's wall-clock input was read in (display only). */
  timezone: string;
  /**
   * Claimed-and-sent marker. Set *before* the DM is attempted so an
   * overlapping or retried scan can never deliver the same reminder twice.
   */
  delivered: boolean;
  /**
   * When the row was claimed for delivery. Drives the TTL index that
   * eventually prunes delivered rows; absent while still pending.
   */
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How long a delivered reminder is kept before Mongo's TTL monitor removes
 * it. Long enough that a member can still see a just-fired reminder in
 * their history, short enough that the collection stays small without a
 * dedicated cleanup service.
 */
export const DELIVERED_RETENTION_SECONDS = 7 * 24 * 60 * 60;

const ReminderSchema = new Schema<IReminder>(
  {
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    // Bounded here as well as on the slash-command option so a write from
    // any other path can't store an undeliverable payload.
    message: { type: String, required: true, maxlength: 500 },
    remindAt: { type: Date, required: true },
    timezone: { type: String, required: false, default: "" },
    delivered: { type: Boolean, required: true, default: false },
    deliveredAt: { type: Date, required: false },
  },
  { timestamps: true },
);

// The scan's only query: undelivered rows that are now due.
ReminderSchema.index({ delivered: 1, remindAt: 1 });
// `/remind list` and the per-user pending cap.
ReminderSchema.index({ userId: 1, guildId: 1, delivered: 1 });
// Prune delivered rows. Pending rows have no `deliveredAt`, and Mongo's TTL
// monitor ignores documents whose indexed field is missing, so they are
// never touched by this.
ReminderSchema.index(
  { deliveredAt: 1 },
  { expireAfterSeconds: DELIVERED_RETENTION_SECONDS },
);

export const Reminder = mongoose.model<IReminder>("Reminder", ReminderSchema);
