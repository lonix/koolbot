import mongoose, { Schema, Document } from "mongoose";
import { EVENT_GROUP_KINDS, type EventGroupKind } from "./event-group-kinds.js";

export { EVENT_GROUP_KINDS, type EventGroupKind };

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

/**
 * One group of an event (#1188): becomes a voice channel of its own once the
 * channel lifecycle (#1190) creates it. The event keeps its own copy of the
 * preset it started from, so a later preset change never alters it.
 */
export interface IEventGroup {
  /** Stable id within the event; never derived from the editable name. */
  key: string;
  name: string;
  kind: EventGroupKind;
  /** Max members and the voice channel's user limit (1 to 99); null = unlimited. */
  size: number | null;
  /** Optional clan tag (#1194); empty = no tag. */
  tag: string;
  /** Optional colour or emoji marker shown in the channel name; empty = none. */
  marker: string;
  /** Voice channel id, filled by #1190; null until then. */
  channelId: string | null;
  /**
   * The group's leader (#1195): a user id, null = none. Written only through
   * `event-group-leaders.ts`, under the same per-event lock as `memberIds`.
   * A leader is a member of the group; read it through `effectiveLeaders`.
   * Exportable and erased by a member data reset (registry entry
   * `event-group-captain`). Cleared when the event ends (#1193, the shared
   * teardown through `clearLeadersOnEnd`).
   */
  captainId: string | null;
  /**
   * The group's members (#1191): user ids, at most one group per member. Only
   * `team` groups hold any. Written only through `event-group-assignment.ts`
   * (one keyed lock per event); kept on a finished event until the member
   * resets their data (see the registry entry `event-group-member`).
   */
  memberIds: string[];
  /**
   * What the host (or the preset) set before a leader first customised the
   * group (#1196): the values "reset" goes back to, and what a recurring
   * series' next occurrence starts with. Absent until the first leader edit.
   * Written only by `event-leader-customise.ts`. Not user ids.
   */
  originalName?: string;
  originalTag?: string;
  /**
   * True while the group's stored name has not been confirmed on its channel
   * (a leader or host rename whose channel rename was refused, rate limited or
   * unconfirmed). Set in the same write that changes the name; cleared only
   * after a confirmed channel rename of that same name. A pass finishes it.
   */
  nameSyncPending?: boolean;
  /**
   * True while the group's stored size has not been confirmed as its channel's
   * user limit (a host's size change whose channel update failed or could not
   * be checked, #1241). Set in the same write that changes the size; cleared
   * only after the channel was confirmed to carry that limit. A pass finishes
   * it. Deliberately no schema default: absent reads as false. The "over size"
   * state is NOT stored: it is derived (members above size).
   */
  sizeSyncPending?: boolean;
  /**
   * The control message (button) of the leader customiser in this group's
   * channel (#1196): its message id and the channel it was posted in, so a
   * re-created channel never trusts an id from the old one.
   */
  controlMessageId?: string | null;
  controlChannelId?: string | null;
}

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
  /**
   * When the event was marked ended (#1193): the end instant the grace period
   * counts from. The scheduled end sets it to the scheduled end time, "End event
   * now" to the moment of the press. Null for a row that is not ended, and for
   * one ended before this field existed (its end is then start plus duration).
   * Not a user id: who pressed the button is only in the audit log.
   */
  endedAt: Date | null;
  reminderSent: boolean;
  /**
   * @deprecated Legacy KoolBot RSVPs (#1175). New events leave this empty:
   * members mark Interested on the native Discord event instead. Kept so
   * announcements and RSVPs from 2.0.x keep working and stay in member
   * export and erasure; retire once no such event remains.
   */
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
  /**
   * Id of the mirrored Discord native scheduled event (#1034); null when none
   * exists (mirroring off, not yet created, or finished and released). It is
   * the restart-safe link: the sync reads it back instead of creating again.
   */
  nativeEventId: string | null;
  /**
   * When a native-event create was started and its id not yet stored (#1034).
   * A create that times out may still complete in Discord, so a later scan
   * must not create again straight away: it first looks for the late event
   * (adoption) and only retries after a grace period. Cleared on claim.
   */
  nativeCreateStartedAt: Date | null;
  /**
   * A discarded duplicate occurrence kept only until its native event has been
   * closed (#1034). It is taken out of its series (no `seriesId`, no
   * recurrence) so the spawn path and the unique occurrence key never see it,
   * and the scan deletes it once `nativeEventId` and `nativeCreateStartedAt`
   * are both clear.
   */
  nativeCleanupOnly: boolean;
  /** The native event was deleted in Discord by someone else; the mirror
   * respects that and does not recreate it. */
  nativeDetached: boolean;
  /**
   * The native scheduled event existed before KoolBot and was adopted through
   * the server-adoption flow (#1034). It belongs to whoever made it: the sync
   * never edits, cancels or deletes it, it only reads it (so reminders follow
   * its schedule) and releases the link when the row ends or is cancelled.
   */
  nativeAdopted: boolean;
  /**
   * Which adoption step created this row (`<snapshot id>:<operation id>`), for
   * an idempotent apply and a rollback that removes only what it created. Null
   * for every other event. Not a user id.
   */
  adoptionRef: string | null;
  /**
   * Content hash of the event's cover image (#1181); null when it has none.
   * The bytes live in the `event-images` collection (`models/event-image.ts`),
   * shared by every occurrence of a series. Never set on an adopted row.
   */
  coverHash: string | null;
  /** The cover hash last sent to the native event; null when none is there.
   * The sync sends the image only when this differs from `coverHash`. */
  nativeCoverHash: string | null;
  /** Failed cover uploads for the current `coverHash`; the sync stops
   * retrying after a few so a rejected image cannot loop. */
  nativeCoverAttempts: number;
  /**
   * Event groups (#1188). Everything here is off by default: a row without
   * these fields (every event made before groups) behaves exactly as before.
   * The setup is only stored; channels, assignment and host controls come with
   * later issues of the groups epic (#1187). Readers of a `.lean()` row must
   * default each field (`?? false`, `?? []`), as lean reads skip schema defaults.
   */
  groupsEnabled: boolean;
  /** Built-in preset the setup started from (`builtin:...`); null for Custom. */
  presetId: string | null;
  /** What a group is called in the UI ("Team", "Squad", "Room", "Party"). */
  groupLabel: string;
  /** What a group's leader is called ("Leader", "Captain", "Lead"). */
  leaderLabel: string;
  /** Minutes before the start that the main and group channels are created;
   * null falls back to `events.create_lead_minutes`. */
  channelLeadMinutes: number | null;
  groups: IEventGroup[];
  /**
   * Host's "lock groups" switch (#1191): while true, joining a group's channel
   * does not change anyone's stored group. Per occurrence: a successor starts
   * unlocked, so it is not part of `copyGroupSetup`.
   */
  groupsLocked: boolean;
  /** Group leaders on for this event (#1195); set on the event form. */
  captainsEnabled: boolean;
  /**
   * Leaders may rename their own group and set its tag from Discord (#1196).
   * Only effective while `captainsEnabled` is on; stored as both on.
   */
  captainCustomisationEnabled: boolean;
  /**
   * Temporary clan tags on the members' server nicknames while the event is
   * active (#1194). Off by default; participants cannot opt out. The backups of
   * the original nicknames live in `models/event-nickname-backup.ts`.
   */
  tagsEnabled: boolean;
  /** The tag goes after the name ("Alice [RED]") instead of before it ("[RED] Alice"). */
  tagsSuffix: boolean;
  /**
   * Counts the saves of the host panel's live edit (#1239). A confirmation
   * token is bound to the value it was issued at, so it can be used once: any
   * later save moves the counter on. Deliberately no schema default: a row
   * without it reads as 0.
   */
  liveEditRevision?: number;
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

const EventGroupSchema = new Schema<IEventGroup>(
  {
    key: { type: String, required: true, maxlength: 32 },
    name: { type: String, required: true, maxlength: 50 },
    kind: { type: String, required: true, enum: EVENT_GROUP_KINDS },
    size: { type: Number, default: null, min: 1, max: 99 },
    tag: { type: String, default: "", maxlength: 8 },
    marker: { type: String, default: "", maxlength: 16 },
    channelId: { type: String, default: null },
    captainId: { type: String, default: null },
    memberIds: { type: [String], default: [] },
    originalName: { type: String, maxlength: 50 },
    originalTag: { type: String, maxlength: 8 },
    nameSyncPending: { type: Boolean },
    sizeSyncPending: { type: Boolean },
    controlMessageId: { type: String },
    controlChannelId: { type: String },
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
    endedAt: { type: Date, default: null },
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
    nativeEventId: { type: String, default: null },
    nativeCreateStartedAt: { type: Date, default: null },
    nativeCleanupOnly: { type: Boolean, default: false },
    nativeDetached: { type: Boolean, default: false },
    nativeAdopted: { type: Boolean, default: false },
    adoptionRef: { type: String, default: null },
    coverHash: { type: String, default: null },
    nativeCoverHash: { type: String, default: null },
    nativeCoverAttempts: { type: Number, default: 0 },
    groupsEnabled: { type: Boolean, default: false },
    presetId: { type: String, default: null },
    groupLabel: { type: String, default: "Team", maxlength: 20 },
    leaderLabel: { type: String, default: "Leader", maxlength: 20 },
    channelLeadMinutes: { type: Number, default: null, min: 0, max: 1440 },
    groups: { type: [EventGroupSchema], default: [] },
    groupsLocked: { type: Boolean, default: false },
    captainsEnabled: { type: Boolean, default: false },
    captainCustomisationEnabled: { type: Boolean, default: false },
    tagsEnabled: { type: Boolean, default: false },
    tagsSuffix: { type: Boolean, default: false },
    liveEditRevision: { type: Number },
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
// Group assignment (#1191): the member export and reset find events by
// `groups.memberIds`, and every voice join looks up the event whose group
// channel it is by `groups.channelId`. Both were collection scans.
EventSchema.index({ "groups.memberIds": 1 });
EventSchema.index({ "groups.channelId": 1 });
// Leaders (#1195): the member export and reset find events by `groups.captainId`.
EventSchema.index({ "groups.captainId": 1 });
// One row per occurrence of a series. This unique key is what makes spawning
// the successor idempotent across crashes, restarts and replicas (#744).
EventSchema.index(
  { guildId: 1, seriesId: 1, occurrenceIndex: 1 },
  { unique: true, partialFilterExpression: { seriesId: { $type: "string" } } },
);

// A native scheduled event belongs to at most one row (#1034). The claim in
// `NativeEventSync` is a per-row compare-and-set, so two replicas recovering
// the same orphan for two same-name, same-start events could both win it;
// this index makes the second claim fail atomically (E11000 = lost the race).
EventSchema.index(
  { nativeEventId: 1 },
  {
    unique: true,
    partialFilterExpression: { nativeEventId: { $type: "string" } },
  },
);

// One row per adoption step, so a retried apply finds the row it already wrote
// instead of inserting a second one (#1034).
EventSchema.index(
  { adoptionRef: 1 },
  {
    unique: true,
    partialFilterExpression: { adoptionRef: { $type: "string" } },
  },
);

export const Event = mongoose.model<IEvent>("Event", EventSchema);
