import mongoose, { Schema, Document } from "mongoose";

/**
 * A scheduled server event (#708).
 *
 * An event is a planned gathering with a start time and a *temporary*
 * voice channel that the bot spins up shortly before the event begins and
 * tears down once it ends and empties. Unlike the lobby-driven dynamic
 * channels owned by `VoiceChannelManager`, an event channel's lifecycle is
 * bound to the event's schedule rather than to someone joining a lobby.
 *
 * The whole lifecycle is driven by a single periodic scan in
 * `EventService` (mirroring the birthday service's "scan and decide"
 * cron), so progress is idempotent and survives a restart: the row's
 * `state`, `reminderSent` and `channelId` fields are the source of truth,
 * not any in-memory timer.
 *
 * Times are stored as absolute UTC instants (`startTime`); `timezone`
 * records the IANA zone the organiser entered the wall-clock time in, for
 * display only.
 */

/** Lifecycle states. `scheduled → active → ended`, or `cancelled` at any
 * point before it ends. Terminal states are `ended` and `cancelled`. */
export type EventState = "scheduled" | "active" | "ended" | "cancelled";

/** RSVP responses surfaced by the Going / Maybe / Can't buttons. */
export type RsvpStatus = "going" | "maybe" | "cant";

export interface IEventRsvp {
  userId: string;
  status: RsvpStatus;
  respondedAt: Date;
}

export interface IEvent extends Document {
  guildId: string;
  title: string;
  description: string;
  /** Absolute start instant (UTC). */
  startTime: Date;
  /** IANA zone the organiser entered the time in (display only). */
  timezone: string;
  durationMinutes: number;
  /** Category the temp channel is created under; empty falls back to the
   * `events.category_id` config value at creation time. */
  categoryId: string;
  /** Temp voice channel id, once created; null until then / after cleanup. */
  channelId: string | null;
  /** Channel the RSVP/announcement message was posted in. */
  announcementChannelId: string | null;
  /** Message id of the RSVP/announcement post, for live edits + reminders. */
  announcementMessageId: string | null;
  state: EventState;
  reminderSent: boolean;
  rsvps: IEventRsvp[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const EventRsvpSchema = new Schema<IEventRsvp>(
  {
    userId: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ["going", "maybe", "cant"],
    },
    respondedAt: { type: Date, required: true },
  },
  { _id: false },
);

const EventSchema = new Schema<IEvent>(
  {
    guildId: { type: String, required: true, index: true },
    // Discord channel-name cap is 100; the title also renders as an embed
    // heading, so keep it comfortably short.
    title: { type: String, required: true, maxlength: 100 },
    description: { type: String, default: "", maxlength: 1000 },
    startTime: { type: Date, required: true, index: true },
    timezone: { type: String, default: "" },
    durationMinutes: { type: Number, default: 120 },
    categoryId: { type: String, default: "" },
    channelId: { type: String, default: null },
    announcementChannelId: { type: String, default: null },
    announcementMessageId: { type: String, default: null },
    state: {
      type: String,
      required: true,
      enum: ["scheduled", "active", "ended", "cancelled"],
      default: "scheduled",
      index: true,
    },
    reminderSent: { type: Boolean, default: false },
    rsvps: { type: [EventRsvpSchema], default: [] },
    createdBy: { type: String, required: true },
  },
  {
    timestamps: true,
  },
);

export const Event = mongoose.model<IEvent>("Event", EventSchema);
