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

/** How a recurring event repeats. `none` is a one-off event.
 *
 * Fixed-cadence only (#744): same wall-clock time, every 7 days, 14 days or
 * calendar month. Anything fancier (RRULEs, "2nd Tuesday", holidays) is out
 * of scope. */
export type EventRecurrence = "none" | "weekly" | "biweekly" | "monthly";

export const EVENT_RECURRENCES: readonly EventRecurrence[] = [
  "none",
  "weekly",
  "biweekly",
  "monthly",
];

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
  /**
   * Recurrence (#744). A series is a set of occurrence rows sharing one
   * `seriesId`; each row is an ordinary, independently-addressable event
   * (own RSVPs, announcement message and temp channel), so mirroring a series
   * elsewhere (e.g. Discord scheduled events, #1034) can key on
   * `(seriesId, occurrenceIndex)`. Future occurrences are *not* pre-created:
   * the next one is spawned when the current one ends.
   */
  recurrence: EventRecurrence;
  /** Shared by every occurrence of a series; null for a one-off event. The
   * first occurrence's `_id`, so the series is addressable by that id. */
  seriesId: string | null;
  /** 0-based position within the series. */
  occurrenceIndex: number;
  /** Start of occurrence 0. Occurrence n is derived from this anchor rather
   * than chained from the previous one, so a monthly series started on the
   * 31st returns to the 31st after a short month instead of drifting. */
  seriesStart: Date | null;
  /** The occurrence that spawned this one (its `_id`, as a string); null for
   * the first occurrence. Lets the successor dedupe tell competing successors
   * of one predecessor apart from legitimate later descendants. */
  spawnedFrom: string | null;
  /** Set once this occurrence's successor exists. Only a "done" marker: the
   * successor itself is created idempotently (unique series/index key), so a
   * crash before this is set is retried safely. */
  nextSpawned: boolean;
  /** The whole series was cancelled; no occurrence may spawn a successor.
   * Set on every row of the series before its open rows are cancelled. */
  seriesCancelled: boolean;
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
    recurrence: {
      type: String,
      enum: EVENT_RECURRENCES,
      default: "none",
    },
    seriesId: { type: String, default: null },
    occurrenceIndex: { type: Number, default: 0 },
    seriesStart: { type: Date, default: null },
    spawnedFrom: { type: String, default: null },
    nextSpawned: { type: Boolean, default: false },
    seriesCancelled: { type: Boolean, default: false },
    createdBy: { type: String, required: true },
  },
  {
    timestamps: true,
  },
);

// The per-user export and purge both look up events by nested RSVP
// (`{ guildId, "rsvps.userId": userId }`), which was otherwise a collection
// scan (#914).
EventSchema.index({ "rsvps.userId": 1 });
// One row per occurrence of a series. This unique key is what makes spawning
// the successor idempotent across crashes, restarts and replicas (#744).
EventSchema.index(
  { guildId: 1, seriesId: 1, occurrenceIndex: 1 },
  { unique: true, partialFilterExpression: { seriesId: { $type: "string" } } },
);

export const Event = mongoose.model<IEvent>("Event", EventSchema);
