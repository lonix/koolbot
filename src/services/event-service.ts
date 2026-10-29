import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CategoryChannel,
  ChannelType,
  Client,
  DiscordAPIError,
  EmbedBuilder,
  Guild,
  TextChannel,
  VoiceChannel,
} from "discord.js";
import { isValidObjectId } from "mongoose";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { ScheduledService } from "./scheduled-service.js";
import { DiscordLogger } from "./discord-logger.js";
import {
  Event,
  type EventRecurrence,
  type EventState,
  type IEvent,
  type RsvpStatus,
} from "../models/event.js";
import { NativeEventSync, type NativeCache } from "./event-native-sync.js";
import {
  EDIT_MESSAGES,
  diffEventEdit,
  editModeOf,
  eventEditVersion,
  hasEdit,
  isSeriesRow,
  nextSeriesTemplate,
  parseEditScope,
  seriesWriteFilter,
  type EditScope,
  type EventEditDiff,
  type EventEditFields,
  type RenderedMode,
} from "./event-edit.js";
import { sweepOrphanCovers, withCoverLock } from "./event-cover.js";
import {
  copyGroupSetup,
  readSeriesGroupSetup,
  seriesGroupSetupOf,
  successorGroupFields,
  type EventGroupSetup,
} from "./event-groups.js";
import { syncLeadsAccess } from "./event-leads-sync.js";
import { resolveLeadsChannel } from "./event-leader-roles.js";
import { EventNicknameTags } from "./event-nickname-tags.js";
import {
  EventGroupChannels,
  type GroupChannelReport,
  type GroupRemoveOutcome,
  type GroupsOffOutcome,
  type NameSyncOutcome,
} from "./event-group-channels.js";
import {
  EventTeardown,
  type EndEventOutcome,
  type ExpectChannels,
} from "./event-teardown.js";
import { parseZonedDateTime, resolveTimezone } from "../utils/timezone.js";
import { discordTimestamp } from "../utils/discord-time.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { embedColor } from "../utils/embed-style.js";

/**
 * Events feature (#708): scheduled gatherings backed by a *temporary*
 * voice channel.
 *
 * Unlike the lobby-driven dynamic channels in `VoiceChannelManager`, an
 * event's channel lifecycle is bound to its schedule: the channel is
 * created shortly before the start time and removed once the event ends
 * and empties past a grace period. Every event is also a Discord native
 * scheduled event (`NativeEventSync`) and is announced with that event's
 * link: members mark Interested on Discord's own event card (#1175), so
 * KoolBot runs no RSVP system of its own. Announcements posted before that
 * change keep their old Going / Maybe / Can't buttons until the event ends.
 *
 * The lifecycle is driven by a single periodic scan (a one-minute
 * `CronJob`, mirroring `BirthdayService`'s "scan and decide" approach)
 * rather than per-event timers, so every transition is idempotent and
 * survives a restart — the Mongo row (`state`, `reminderSent`,
 * `channelId`) is the source of truth.
 */

const TICK_CRON = "* * * * *"; // every minute
const MS_PER_MINUTE = 60 * 1000;
// Cap the reminder's inline pings: ~22 chars per `<@id>` keeps the body well
// under Discord's 2000-char message limit, and Discord only pings up to 100
// users per message anyway. Extra RSVPs are summarised as "…and N more".
const MAX_REMINDER_MENTIONS = 50;
/** What a per-user RSVP removal found and what it managed to clear (#916). */
export interface RsvpRemovalResult {
  /** Events in the guild carrying the member's RSVP. */
  matched: number;
  /** Of those, the ones the RSVP was actually pulled from. */
  removed: number;
  /**
   * Rows cleared whose announcement could not be re-rendered (#916). The
   * database no longer has the RSVP, but the message in the channel still
   * shows it, so the erasure is not finished.
   */
  rendersFailed: number;
}

const DISCORD_UNKNOWN_MESSAGE = 10008;
const DISCORD_UNKNOWN_CHANNEL = 10003;

// Embed accent colours for the announcement message by lifecycle state.

/**
 * `ended` and `cancelled` are terminal: the event is over either way, so
 * nothing that happens afterwards can change what its announcement should
 * say.
 */
function isTerminalState(state: EventState): boolean {
  return state === "ended" || state === "cancelled";
}

/** @deprecated Legacy RSVP tally (#1175); only announcements posted before native-only events still use it. */
export interface RsvpCounts {
  going: number;
  maybe: number;
  cant: number;
}

/** How many skipped cadence steps one spawn will search through (bot offline
 * for years, or a monthly series misconfigured) before giving up. */
const MAX_OCCURRENCE_SKIP = 520;

export interface CreateEventInput {
  guildId: string;
  title: string;
  description: string;
  startTime: Date;
  timezone: string;
  durationMinutes: number;
  categoryId?: string;
  /** Repeat cadence; omitted/`none` creates a one-off event (#744). */
  recurrence?: EventRecurrence;
  /** Group setup from the event form (#1188), already validated by
   * `validateGroupSetup`; omitted for a plain event. */
  groups?: EventGroupSetup;
  createdBy: string;
  /** "When: Now" (#1305): announced as happening now; no reminder. */
  impromptu?: boolean;
}

/**
 * How far ahead an impromptu event's start is set (#1305). Discord refuses a
 * native event that starts in the past, and the mirror skips one that already
 * has, so "now" is a few seconds ahead: far enough for the native create to
 * land, short enough to read as now.
 */
export const IMPROMPTU_START_BUFFER_MS = 30 * 1000;

/** Raised by `createImpromptuEvent` when a start now cannot work; nothing is created. */
export class ImpromptuNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImpromptuNotReadyError";
  }
}

/** What the announcement shows of an event, as one comparable string. */
export function announcementContentKey(event: {
  title: string;
  description?: string | null;
  startTime: Date;
  /** `formatEventWhen` shows the zone, so a zone change alone changes the text. */
  timezone?: string | null;
  durationMinutes: number;
}): string {
  return JSON.stringify([
    event.title,
    event.description ?? "",
    event.startTime.getTime(),
    event.timezone ?? "",
    event.durationMinutes,
  ]);
}

/** The outcome of {@link EventService.editEvent} (#1298). */
export type EditEventResult =
  | { ok: true; event: IEvent; diff: EventEditDiff; scope: EditScope | null }
  | {
      ok: false;
      code:
        | "not-found"
        | "refused"
        | "scope"
        | "series-advanced"
        | "past-next-slot"
        | "anchor"
        | "conflict"
        | "locked"
        | "bad-end"
        | "past"
        | "native-pending"
        | "native-active"
        | "disabled"
        | "unchanged";
      message: string;
    };

/** Raised when a recurring event is requested while recurrence is off. */
export class RecurrenceDisabledError extends Error {
  constructor() {
    super("Recurring events are disabled (events.recurrence_enabled).");
    this.name = "RecurrenceDisabledError";
  }
}

// ---------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------

/**
 * The canonical form of an event id taken from outside (a route, a command): 24
 * hex digits, lower case, which is what `String(doc._id)` yields; null when it
 * is not one. The id-keyed maps of the service (holds, in-progress marks, locks,
 * the link cache) all use that form.
 */
export function canonicalEventId(raw: string): string | null {
  return typeof raw === "string" && /^[0-9a-f]{24}$/i.test(raw)
    ? raw.toLowerCase()
    : null;
}

/** The absolute end instant of an event. */
export function computeEndTime(startTime: Date, durationMinutes: number): Date {
  return new Date(
    startTime.getTime() + Math.max(0, durationMinutes) * MS_PER_MINUTE,
  );
}

/**
 * Parse an organiser-entered wall-clock date + time (in `tz`) into an
 * absolute UTC instant, or null when the pair is malformed or impossible
 * (e.g. `2026-02-30`).
 *
 * Kept as a named export so the events code (and its tests) read in event
 * terms; the parsing itself lives in `utils/timezone` because `/remind`
 * needs exactly the same wall-clock handling.
 */
export function parseEventDateTime(
  dateStr: string,
  timeStr: string,
  tz: string,
): Date | null {
  return parseZonedDateTime(dateStr, timeStr, tz);
}

/** Tally RSVPs by response. @deprecated Legacy RSVP data path (#1175). */
export function countRsvps(rsvps: Array<{ status: RsvpStatus }>): RsvpCounts {
  const counts: RsvpCounts = { going: 0, maybe: 0, cant: 0 };
  for (const r of rsvps) {
    if (r.status === "going") counts.going += 1;
    else if (r.status === "maybe") counts.maybe += 1;
    else if (r.status === "cant") counts.cant += 1;
  }
  return counts;
}

interface LifecycleView {
  state: IEvent["state"];
  startTime: Date;
  durationMinutes: number;
  channelId: string | null;
  reminderSent: boolean;
  /** Per-event channel lead (#1188); absent or null uses the global lead. */
  channelLeadMinutes?: number | null;
  /** When the event was marked ended (#1193); absent or null: not recorded. */
  endedAt?: Date | null;
}

/**
 * Whether the temp channel should be created on this tick. `leadMs` is the
 * server-wide lead; an event with its own `channelLeadMinutes` (event groups,
 * #1188) uses that instead.
 */
export function shouldCreateChannel(
  event: LifecycleView,
  now: Date,
  leadMs: number,
): boolean {
  if (event.state === "cancelled" || event.state === "ended") return false;
  if (event.channelId) return false;
  const start = event.startTime.getTime();
  const end = computeEndTime(event.startTime, event.durationMinutes).getTime();
  const nowMs = now.getTime();
  const own = event.channelLeadMinutes;
  const effectiveLeadMs =
    typeof own === "number" && own >= 0 ? own * MS_PER_MINUTE : leadMs;
  return nowMs >= start - effectiveLeadMs && nowMs < end;
}

/** Whether the pre-start reminder should be posted on this tick. */
export function shouldSendReminder(
  event: LifecycleView,
  now: Date,
  reminderMs: number,
): boolean {
  if (reminderMs <= 0) return false;
  if (event.reminderSent) return false;
  if (event.state === "cancelled" || event.state === "ended") return false;
  const start = event.startTime.getTime();
  const nowMs = now.getTime();
  return nowMs >= start - reminderMs && nowMs < start;
}

/** Whether the event has run past its end time and should be marked ended. */
export function shouldEndEvent(event: LifecycleView, now: Date): boolean {
  if (event.state === "cancelled" || event.state === "ended") return false;
  return (
    now.getTime() >=
    computeEndTime(event.startTime, event.durationMinutes).getTime()
  );
}

/**
 * The instant an event's grace period counts from: when it was marked ended
 * (`endedAt`, #1193: the press of "End event now", or the scheduled end), else
 * its scheduled end (a row ended before that field existed).
 */
export function effectiveEndTime(event: LifecycleView): Date {
  return (
    event.endedAt ?? computeEndTime(event.startTime, event.durationMinutes)
  );
}

/** Whether an ended event's empty channel has aged past the grace period. */
export function shouldCleanupChannel(
  event: LifecycleView,
  now: Date,
  graceMs: number,
  channelEmpty: boolean,
): boolean {
  if (!event.channelId) return false;
  if (event.state !== "ended") return false;
  if (!channelEmpty) return false;
  return now.getTime() >= effectiveEndTime(event).getTime() + graceMs;
}

/**
 * The start line for text the Web UI shows, e.g. `2026-07-04 20:00
 * (Europe/London)`. Messages posted in Discord use
 * {@link formatEventWhenDiscord} instead.
 */
export function formatEventWhen(event: {
  startTime: Date;
  timezone: string;
}): string {
  const zone = resolveTimezone(event.timezone);
  return `${formatInTimeZone(event.startTime, zone, "yyyy-MM-dd HH:mm")} (${zone})`;
}

/**
 * The start line for a Discord message: a timestamp each reader sees in their
 * own timezone, plus the relative form (#1331), e.g.
 * `<t:1783195200:f> (<t:1783195200:R>)`.
 */
export function formatEventWhenDiscord(event: { startTime: Date }): string {
  return `${discordTimestamp(event.startTime, "f")} (${discordTimestamp(event.startTime, "R")})`;
}

/** Link to a native scheduled event; Discord renders it as an event card. */
function nativeEventUrl(guildId: string, nativeEventId: string): string {
  return `https://discord.com/events/${guildId}/${nativeEventId}`;
}

/** Whether an event row belongs to a repeating series. */
export function isRecurring(event: {
  recurrence?: EventRecurrence | null;
  seriesId?: string | null;
}): boolean {
  return !!event.recurrence && event.recurrence !== "none" && !!event.seriesId;
}

/** Short human label for a cadence, e.g. `every 2 weeks`. */
export function recurrenceLabel(recurrence: EventRecurrence): string {
  switch (recurrence) {
    case "weekly":
      return "weekly";
    case "biweekly":
      return "every 2 weeks";
    case "monthly":
      return "monthly";
    default:
      return "one-off";
  }
}

/**
 * Start instant of occurrence `index` of a series anchored at `seriesStart`.
 *
 * Computed from the anchor's wall-clock date and time in `timezone` (not by
 * adding fixed milliseconds), so "Friday 20:00" stays at 20:00 across a DST
 * change. Monthly steps keep the anchor's day-of-month, clamped to the last
 * day of shorter months, and return to it afterwards (Jan 31 → Feb 28 →
 * Mar 31). A wall-clock time that does not exist on the target day (a DST
 * gap) rolls forward rather than dropping the occurrence.
 */
export function computeOccurrenceStart(
  seriesStart: Date,
  recurrence: EventRecurrence,
  index: number,
  timezone: string,
): Date {
  if (recurrence === "none" || index <= 0) return new Date(seriesStart);
  const zone = resolveTimezone(timezone);
  const [y, m, d] = formatInTimeZone(seriesStart, zone, "yyyy-MM-dd")
    .split("-")
    .map(Number);
  const time = formatInTimeZone(seriesStart, zone, "HH:mm:ss");

  let target: Date;
  if (recurrence === "monthly") {
    const monthIndex = m - 1 + index;
    const year = y + Math.floor(monthIndex / 12);
    const month = ((monthIndex % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    target = new Date(Date.UTC(year, month, Math.min(d, lastDay)));
  } else {
    const stepDays = recurrence === "weekly" ? 7 : 14;
    target = new Date(Date.UTC(y, m - 1, d + stepDays * index));
  }
  const date = target.toISOString().slice(0, 10);
  const resolved = fromZonedTime(`${date}T${time}`, zone);
  // A wall-clock time inside a DST gap does not exist; `fromZonedTime`
  // resolves it backwards, to an instant that reads earlier than requested.
  // Push it forward by the gap so 01:30 becomes 02:30 rather than 00:30.
  const toSeconds = (hms: string): number => {
    const [h, m, sec] = hms.split(":").map(Number);
    return h * 3600 + m * 60 + sec;
  };
  let drift =
    toSeconds(time) - toSeconds(formatInTimeZone(resolved, zone, "HH:mm:ss"));
  if (drift > 43200) drift -= 86400;
  else if (drift < -43200) drift += 86400;
  return drift > 0 ? new Date(resolved.getTime() + drift * 1000) : resolved;
}

/**
 * The series anchor that puts occurrence `index` at `start` (the inverse of
 * {@link computeOccurrenceStart}), or null when no anchor does: a monthly day
 * the anchor month lacks, or a wall-clock time inside a DST gap. The result is
 * checked by running the forward computation, so a non-null anchor always
 * reproduces `start` exactly (#1298).
 */
export function anchorForOccurrence(
  start: Date,
  recurrence: EventRecurrence,
  index: number,
  timezone: string,
  prefer?: Date,
): Date | null {
  if (recurrence === "none" || index <= 0) return new Date(start);
  const zone = resolveTimezone(timezone);
  const [y, m, d] = formatInTimeZone(start, zone, "yyyy-MM-dd")
    .split("-")
    .map(Number);
  const time = formatInTimeZone(start, zone, "HH:mm:ss");
  const reproduces = (anchor: Date): boolean =>
    computeOccurrenceStart(anchor, recurrence, index, timezone).getTime() ===
    start.getTime();
  let target: Date;
  if (recurrence === "monthly") {
    const monthIndex = m - 1 - index;
    const year = y + Math.floor(monthIndex / 12);
    const month = ((monthIndex % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    // Several anchors can reproduce a clamped month (28 Feb from the 28th, 29th,
    // 30th or 31st), and they differ in the months after. The existing anchor's
    // day is kept when it still reproduces `start`, so a change of time alone
    // leaves a series on the 31st on the 31st.
    if (prefer) {
      const day = Number(formatInTimeZone(prefer, zone, "d"));
      if (day <= lastDay) {
        const preferred = fromZonedTime(
          `${new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)}T${time}`,
          zone,
        );
        if (reproduces(preferred)) return preferred;
      }
    }
    target = new Date(Date.UTC(year, month, Math.min(d, lastDay)));
  } else {
    const stepDays = recurrence === "weekly" ? 7 : 14;
    target = new Date(Date.UTC(y, m - 1, d - stepDays * index));
  }
  const anchor = fromZonedTime(
    `${target.toISOString().slice(0, 10)}T${time}`,
    zone,
  );
  return reproduces(anchor) ? anchor : null;
}

function accentColor(state: IEvent["state"]): number {
  switch (state) {
    case "active":
      return embedColor("ok");
    case "ended":
      return embedColor("neutral");
    case "cancelled":
      return embedColor("danger");
    default:
      return embedColor("brand");
  }
}

export class EventService extends ScheduledService {
  private static instance: EventService;
  /** Mirrors events to Discord native scheduled events (#1034); opt-in. */
  private readonly nativeSync: NativeEventSync;
  /**
   * Temporary clan tags on nicknames (#1194). Every decision there is taken
   * from a fresh read, never from this service's event copies, so none of the
   * hold invariants above apply to it; this class only tells it when to look.
   */
  private readonly nicknameTags: EventNicknameTags;
  /** Per open event: the `message|native event` ids of the announcement last
   * rendered successfully (in memory: re-checked once after a restart). */
  private readonly linkVerified = new Map<string, string>();
  /** Voice channels of event groups (#1190). */
  private readonly groupChannels: EventGroupChannels;
  /** Per event: the failures last logged, so a standing one is logged once. */
  private readonly groupFailuresLogged = new Map<string, string>();
  /** The one teardown of an ending event (#1193), manual and scheduled. */
  private readonly teardown: EventTeardown;
  /**
   * THE HOLD MECHANISM (every event path that takes an event to a terminal state
   * goes through it: an end, manual or scheduled, and a cancel).
   *
   * The danger: a scan loads every event once, then works through them one by
   * one with no deadline, so its copy of an event can be arbitrarily old when
   * the scan reaches it. If the event was ended (or cancelled) meanwhile, that
   * open copy must not write anything (reminder, announcement, native sync,
   * channel create, delete). A time-based hold alone cannot guarantee that.
   *
   * One clock (`scanClock`) orders scans and holds. A scan takes a tick when it
   * starts (it loads its rows then). A hold takes a tick when it begins and
   * starts out "pending": `clock = Infinity`, `until = Infinity`. When the claim
   * lands (`claimCompleted`) the hold's clock becomes the tick of that moment,
   * and its expiry restarts. Invariants:
   *
   * 1. A scan that started before the claim completed (so it may hold an open
   *    row; this includes scans that started AFTER the hold began but while the
   *    claim was still pending) has an id below the hold's clock. A hold is
   *    removed only when it has expired AND no active scan has an id below its
   *    clock. A pending hold is never removed by time, and every running scan
   *    is "older" than a pending one.
   * 2. A scan that started after the claim completed read the new state and
   *    needs no protection.
   * 3. A lost claim (`abortEnding`) removes only that caller's own hold and
   *    in-progress mark; the winner has its own, taken before its own claim.
   * 4. `endsInProgress` (set at begin, removed in `finishEnding`, in a `finally`
   *    around the work) stops scans on a copy in ANY state while the work runs
   *    (an ended copy must not sweep the main channel under a pull-back).
   * 5. `mustSkipScan` is checked at the start of `processEvent`, after every
   *    await that precedes an outward write, and again right before the
   *    outward write itself where the write is preceded by its own fetches
   *    (reminder send, announcement send and edit).
   * 7. NO PATH LEAVES A HOLD THAT NEVER EXPIRES. `beginEnding` is paired, at
   *    every call site (`EventTeardown.run`, `cancelOne`), with a `finally`
   *    that calls `finishEnding`. From begin, a claim that lands calls
   *    `claimCompleted` (finite hold); a claim that is LOST calls `abortEnding`
   *    (hold removed); a claim that FAILS or work that THROWS reaches
   *    `finishEnding` with the hold still pending, which settles it to a finite
   *    hold stamped now (a failed write may have landed, so protection for
   *    older scans stays, but only until they are done and the time is up).
   * 6. Holds and marks are keyed by the canonical event id (24 lower-case hex,
   *    `String(doc._id)`); a caller that takes an id from outside normalises it
   *    first (`canonicalEventId`).
   * In memory: the bot is one process, and a scan after a restart loads fresh
   * rows.
   */
  private readonly endingEvents = new Map<
    string,
    Map<number, { until: number; clock: number }>
  >();
  private scanClock = 0;
  private readonly activeScans = new Set<number>();
  /**
   * Events whose teardown is running right now (id to the callers' holds),
   * given back when it finishes. Unlike `endingEvents` this also stops the scan
   * on a copy that already reads `ended`: with a grace period of 0 it would
   * otherwise delete the main channel before the pull-back has used it.
   */
  private readonly endsInProgress = new Map<string, Set<number>>();
  /** Events whose scheduled end was deferred (people in a voice channel), so the deferral is logged once. */
  private readonly endDeferred = new Set<string>();

  private constructor(client: Client) {
    super(client, {
      label: "Event service",
      disabledMessage: "Events are disabled",
      cronContext: "events",
      runLabel: "Event scan",
    });
    this.nativeSync = new NativeEventSync(client);
    this.nicknameTags = EventNicknameTags.getInstance(client);
    this.groupChannels = new EventGroupChannels(client, {
      getPrefix: (): Promise<string> =>
        this.configService.getString("events.channel_prefix", "📅"),
      getGraceMs: async (): Promise<number> =>
        (await this.configService.getNumber(
          "events.channel_grace_minutes",
          15,
        )) * MS_PER_MINUTE,
      isEnabled: (): Promise<boolean> =>
        this.configService.getBoolean("events.enabled", false),
      // The Web UI's admins (who may act as host) hold the role of an admin
      // group; the leaders-only channel never denies or moves them (#1199).
      // Loaded on demand: only an event with a leads channel gets here.
      getAdminRoleIds: async (guildId: string): Promise<string[]> => {
        const { RoleGroupService } = await import("./role-group-service.js");
        const { adminGroupRoleIds } = await import("./role-group-adoption.js");
        return adminGroupRoleIds(
          await RoleGroupService.getInstance().list(guildId),
        );
      },
    });
    this.teardown = new EventTeardown({
      client,
      updateAnnouncement: (event): Promise<boolean> =>
        this.updateAnnouncement(event),
      syncNative: (event, guild): Promise<void> =>
        this.nativeSync.syncEvent(event, guild),
      cleanupGroupChannels: async (
        event,
        guild,
        now,
      ): Promise<GroupChannelReport> => {
        const report = await this.groupChannels.cleanup(event, guild, now);
        await this.logGroupReport(event, report);
        return report;
      },
      logLifecycle: (event): Promise<void> => this.logLifecycle(event),
      getGraceMinutes: (): Promise<number> =>
        this.configService.getNumber("events.channel_grace_minutes", 15),
      beginEnding: (id): number => this.beginEnding(id),
      abortEnding: (id, hold): void => this.abortEnding(id, hold),
      finishEnding: (id, hold): void => this.finishEnding(id, hold),
      claimCompleted: (id, hold): void => this.claimCompleted(id, hold),
    });
  }

  /**
   * A SCHEDULED end never ends an event while anyone is in one of its voice
   * channels: the main channel (the end removes it after the grace period) or
   * any group channel. Bots do not count. The event then stays live and the
   * next scan asks again: nothing is deleted and nobody is moved. Only the
   * host's manual "End event now" may end it with people present.
   *
   * It decides from NOW, not from the scan's copy: the channel ids are read
   * from the stored event (a group pass may have recorded one since the scan
   * loaded it), every channel is read from Discord first (forced), and only then
   * are all the live member lists looked at together, with nothing awaited
   * between that look and the decision, so someone moving from a checked
   * channel into another is not missed. The ids it looked at go into the end's
   * claim (`expectChannels`), which refuses a change. Fails closed: an event
   * that cannot be read, or a channel that cannot be read, counts as occupied;
   * a channel that is gone (10003) cannot hold anyone.
   *
   * Occupancy is the gateway's voice cache of each channel after the forced
   * read (Discord has no call that lists a channel's members; the per-person raw
   * voice-state read of the mover needs the people first), the same count the
   * channel cleanup uses. The deferral is logged once per event.
   */
  private async checkScheduledEnd(
    event: IEvent,
    guild: Guild,
  ): Promise<
    { defer: true } | { defer: false; expectChannels: ExpectChannels }
  > {
    const id = String(event._id);
    const defer = (): { defer: true } => {
      if (!this.endDeferred.has(id)) {
        this.endDeferred.add(id);
        logger.info(
          `Event ${sanitizeForLog(id)}: its scheduled end is deferred while someone is in one of its voice channels (or that cannot be checked); checked again every scan`,
        );
      }
      return { defer: true };
    };

    let row: {
      channelId?: string | null;
      groupsEnabled?: boolean;
      groups?: Array<{ key: string; channelId?: string | null }>;
    } | null;
    try {
      row = (await Event.findById(event._id).lean()) as typeof row;
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(id)}: could not read the event to check its channels:`,
        error,
      );
      row = null;
    }
    if (!row) return defer();
    const main = row.channelId ?? null;
    // The stored groups as they are, whether or not they are switched on: a
    // switch-off keeps them as history (channel ids cleared), and the claim
    // compares the stored array with this snapshot (a recorded channel of a
    // disabled group is also looked at below).
    const groups = (row.groups ?? []).map((g) => ({
      key: g.key,
      channelId: g.channelId ?? null,
    }));
    const ids = [main, ...groups.map((g) => g.channelId)].filter(
      (cid): cid is string => !!cid,
    );

    // Every read first...
    const seen: Array<{ channel: unknown; unreadable: boolean }> = [];
    for (const channelId of ids) {
      try {
        seen.push({
          channel: await guild.channels.fetch(channelId, { force: true }),
          unreadable: false,
        });
      } catch (error) {
        if (this.isDiscardableError(error, DISCORD_UNKNOWN_CHANNEL)) continue;
        seen.push({ channel: null, unreadable: true });
      }
    }
    // ...then one look at all of them, synchronously.
    const occupied = seen.some((s) => {
      if (s.unreadable) return true;
      const channel = s.channel as VoiceChannel | null;
      if (!channel || channel.type !== ChannelType.GuildVoice) return false;
      for (const member of channel.members.values()) {
        if (!member.user?.bot) return true;
      }
      return false;
    });
    if (occupied) return defer();
    this.endDeferred.delete(id);
    return { defer: false, expectChannels: { main, groups } };
  }

  /**
   * Keep paths a claim already wrote out of this copy's later `save()`: a
   * claimed write is the source of truth, and a copy that is older than a
   * concurrent claim (a cancel clearing the channel id, say) must not write it
   * back. A later assignment to the path marks it modified again, so a step that
   * really means to write it still can. (A plain object in a test has no
   * `$ignore`.)
   */
  private ignoreClaimed(event: IEvent, ...paths: string[]): void {
    const doc = event as unknown as { $ignore?: (path: string) => void };
    for (const path of paths) doc.$ignore?.(path);
  }

  /**
   * Ask the nickname tags to look at an event (#1194): `sync` applies what is
   * wanted now (the event just went active), `restore` puts every nickname back
   * (cancel). Fire and forget: the decision is made there from a fresh read, a
   * failure is logged, and the sweep after every scan retries whatever is left.
   * Only an event that has tags on can have anything to do.
   */
  private kickTags(event: IEvent, what: "sync" | "restore"): void {
    if (event.tagsEnabled !== true) return;
    const id = String(event._id);
    const work =
      what === "sync"
        ? this.nicknameTags.syncEvent(event.guildId, id)
        : this.nicknameTags
            .restoreEvent(event.guildId, id)
            .then(() => undefined);
    void work.catch((error: unknown) =>
      logger.error(
        `Event ${sanitizeForLog(id)}: nickname tags (${what}) failed:`,
        error,
      ),
    );
  }

  /**
   * `scheduled` to `active` as a conditional write with an outcome, not a field
   * the copy's `save()` carries: a cancel or an end that landed since the copy
   * was read must not be turned back into `active`. True when the stored event
   * is now `active` (this call moved it, or it already was); false when it is
   * no longer open. The copy takes `active` (ignored by its save) only when the
   * stored event is.
   */
  private async activateScheduled(event: IEvent): Promise<boolean> {
    const moved = await Event.updateOne(
      { _id: event._id, state: "scheduled" },
      { $set: { state: "active" } },
    );
    let active =
      (moved as { matchedCount?: number } | undefined)?.matchedCount !== 0;
    if (!active) {
      // Nothing matched: it may simply be `active` already (the scan or Start
      // now got there first). Only a state that is not open is a refusal.
      try {
        const row = (await Event.findById(event._id).lean()) as {
          state?: string;
        } | null;
        active = row?.state === "active";
      } catch {
        // Unreadable: not confirmed active.
      }
    }
    if (active) {
      event.state = "active";
      this.ignoreClaimed(event, "state");
      // Assignments already in place get their tags now (#1194). Not awaited:
      // paced edits must not hold the scan; the sweep repeats it every scan.
      this.kickTags(event, "sync");
    }
    return active;
  }

  /** The scan leaves an event alone for this long after an end began. */
  private static readonly ENDING_HOLD_MS = 5 * MS_PER_MINUTE;

  /**
   * Take a hold on an event. Each caller gets its own, so a caller that loses
   * the claim (a double click, the scan's own attempt) gives up only its own
   * and cannot lift the hold of the caller that is ending the event.
   */
  private beginEnding(eventId: string): number {
    const now = Date.now();
    for (const id of [...this.endingEvents.keys()]) this.pruneHolds(id, now);
    const hold = ++this.scanClock;
    const holds =
      this.endingEvents.get(eventId) ??
      new Map<number, { until: number; clock: number }>();
    // Pending until the claim lands: never expires by time, and every running
    // scan counts as older (see the invariants above).
    holds.set(hold, {
      until: Number.POSITIVE_INFINITY,
      clock: Number.POSITIVE_INFINITY,
    });
    this.endingEvents.set(eventId, holds);
    const running = this.endsInProgress.get(eventId) ?? new Set<number>();
    running.add(hold);
    this.endsInProgress.set(eventId, running);
    return hold;
  }

  /**
   * The claim landed. From this tick on, a scan that started earlier may still
   * hold an open copy, a scan that starts later cannot: the hold's clock is
   * this moment, and its expiry restarts.
   */
  private claimCompleted(eventId: string, hold: number): void {
    const entry = this.endingEvents.get(eventId)?.get(hold);
    if (!entry) return;
    entry.clock = ++this.scanClock;
    entry.until = Date.now() + EventService.ENDING_HOLD_MS;
  }

  /** The claim was lost: give up this caller's own holds, and only those. */
  private abortEnding(eventId: string, hold: number): void {
    const holds = this.endingEvents.get(eventId);
    holds?.delete(hold);
    if (holds && holds.size === 0) this.endingEvents.delete(eventId);
    this.finishEnding(eventId, hold);
  }

  /**
   * This caller's work is over, whatever happened. The in-progress mark goes,
   * and a hold that is still pending (its claim neither landed nor was lost: it
   * failed, or the work threw) is settled into a finite, scan-aware one: the
   * write may have reached the database, so protection is not dropped, and it
   * must not stay forever either. The recently-ended hold of a landed claim
   * stays until it expires.
   */
  private finishEnding(eventId: string, hold: number): void {
    const running = this.endsInProgress.get(eventId);
    running?.delete(hold);
    if (running && running.size === 0) this.endsInProgress.delete(eventId);
    const entry = this.endingEvents.get(eventId)?.get(hold);
    if (entry && entry.clock === Number.POSITIVE_INFINITY) {
      entry.clock = ++this.scanClock;
      entry.until = Date.now() + EventService.ENDING_HOLD_MS;
    }
  }

  /**
   * Whether a scan must not act on its copy of the event now: a teardown is
   * running (whatever state the copy shows), or the copy is still open although
   * an end began (an older copy than the end).
   */
  private mustSkipScan(event: IEvent): boolean {
    const id = String(event._id);
    if (this.endsInProgress.has(id)) return true;
    return (
      (event.state === "scheduled" || event.state === "active") &&
      this.isBeingEnded(id)
    );
  }

  private pruneHolds(eventId: string, now: number): void {
    const holds = this.endingEvents.get(eventId);
    if (!holds) return;
    for (const [hold, { until, clock }] of holds) {
      const olderScanRunning = [...this.activeScans].some((id) => id < clock);
      if (until <= now && !olderScanRunning) holds.delete(hold);
    }
    if (holds.size === 0) this.endingEvents.delete(eventId);
  }

  /** Whether any caller holds the event as being ended (or just ended). */
  private isBeingEnded(eventId: string): boolean {
    this.pruneHolds(eventId, Date.now());
    return this.endingEvents.has(eventId);
  }

  /**
   * Whether an end or cancel holds this event right now (a hold that has not
   * lapsed, or a teardown still running). Read-only and synchronous, for
   * writers that must not touch an event while it is being ended (the live edit
   * of the host panel, #1239: it asks before every write). Fails closed: an id
   * that is not an event id counts as held.
   */
  public isEventBeingEnded(eventId: string): boolean {
    const id = canonicalEventId(eventId);
    if (!id) return true;
    return this.endsInProgress.has(id) || this.isBeingEnded(id);
  }

  /**
   * "End event now" (#1193): run the shared teardown for a running event. The
   * state is decided from the atomic claim inside the teardown, never from a
   * copy the caller read earlier. Only an `active` event can be ended; an
   * ended one answers "already ended" and changes nothing. Gated on
   * `events.enabled` (fails closed). The teardown always moves everyone from
   * the group channels to the main channel first (#1441). A recurring occurrence's successor is
   * created by the next scan, as after a scheduled end.
   */
  public async endEventNow(
    eventId: string,
    guildId: string,
  ): Promise<EndEventOutcome> {
    // One canonical id for the claim, the holds and every id-keyed map: a valid
    // id posted in upper case reaches the same row, so it must not key a
    // second, unseen set of holds.
    const canonical = canonicalEventId(eventId);
    if (!canonical) return { status: "not-found" };
    eventId = canonical;
    let enabled = false;
    try {
      enabled = await this.configService.getBoolean("events.enabled", false);
    } catch (error) {
      logger.warn("Could not read events.enabled to end an event:", error);
    }
    if (!enabled) {
      return {
        status: "refused",
        message:
          "Events are turned off, so the event was not ended. Turn on events.enabled first.",
      };
    }
    const now = new Date();
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    const outcome = await this.teardown.run({
      eventId,
      guildId,
      trigger: "manual",
      now,
      endedAt: now,
      fromStates: ["active"],
      guild,
      syncNative: true,
    });
    if (outcome.status === "ended") this.linkVerified.delete(eventId);
    return outcome;
  }

  /**
   * Whether the leads channel needs a pass (the cache-only check), after
   * refreshing the snapshot of the admin groups' roles it judges by: they
   * change in the role-group settings without any event noticing, so each scan
   * reads them again (the role-group service caches them briefly) and a role
   * that became or stopped being an admin's shows up as a difference.
   */
  private async leadsAdminsChanged(
    event: IEvent,
    guild: Guild,
  ): Promise<boolean> {
    if (resolveLeadsChannel(event)) {
      await this.groupChannels.leadsAdminRoles(event.guildId);
    }
    return this.groupChannels.leadsNeedsAttention(event, guild);
  }

  /** Note a leader change synchronously (see `EventGroupChannels.trackLeaderChange`). */
  public trackLeaderChange(change: {
    eventId: string;
    groupKey: string;
    fromUserId: string | null;
    toUserId: string | null;
  }): void {
    this.groupChannels.trackLeaderChange(change.eventId, change);
  }

  /**
   * Make the leaders-only channel of an event match who leads it now, and move
   * out whoever lost access (#1199). Called by the leader-change subscription
   * (`installLeadsChannelSync` in `src/index.ts`, once for every source of a
   * change) and by the scan. It decides from a fresh read of the event and the
   * channel, never from the change that asked for it. Never throws.
   * `takeRevoked` runs first thing inside the pass's lock.
   */
  public syncLeadsAccess(
    guildId: string,
    eventId: string,
    takeRevoked?: () => readonly string[],
  ): Promise<void> {
    return syncLeadsAccess({
      client: this.client,
      channels: this.groupChannels,
      guildId,
      eventId,
      takeRevoked,
    });
  }

  /**
   * Make the group channels of an open event match its record now (create the
   * missing ones, re-create deleted ones), for a retry from the host panel
   * (#1189). Null when the event or the server is not found. The scan does the
   * same every minute.
   *
   * For later issues (#1191 to #1199): the channel of a group is
   * `event.groups.find((g) => g.key === key)?.channelId` (null until created;
   * a lean row may have no `groups` at all). Anything that writes
   * `groups[].channelId` must use a positional update such as
   * `{ "groups.$.channelId": id }` filtered on the group, never `save()` a
   * `groups` array read earlier, and must run through this class so it takes
   * the same per-event lock; do not delete a group channel from anywhere else.
   */
  public async reconcileGroupChannels(
    eventId: string,
    guildId?: string,
  ): Promise<GroupChannelReport | null> {
    const event = await this.getEvent(eventId);
    if (!event || (guildId && event.guildId !== guildId)) return null;
    const guild = await this.client.guilds
      .fetch(event.guildId)
      .catch(() => null);
    if (!guild) return null;
    const report = await this.groupChannels.reconcile(event, guild);
    await this.logGroupReport(event, report);
    return report;
  }

  /**
   * Remove the group channels of a finished event now (the same pass the scan
   * runs: empty ones only, after the grace period of an ended event, at once
   * for a cancelled one). The shared teardown of #1193 builds on this.
   */
  public async cleanupGroupChannels(
    eventId: string,
    guildId?: string,
  ): Promise<GroupChannelReport | null> {
    const event = await this.getEvent(eventId);
    if (!event || (guildId && event.guildId !== guildId)) return null;
    const guild = await this.client.guilds
      .fetch(event.guildId)
      .catch(() => null);
    if (!guild) return null;
    const report = await this.groupChannels.cleanup(event, guild, new Date());
    await this.logGroupReport(event, report);
    return report;
  }

  /**
   * Finish the pending channel renames of an event (the leader customiser,
   * #1196; the host's live rename, #1197, shares it): the stored group name is
   * the truth and the channel follows, through the shared rename queue (a rate
   * limit is reported, never slept on). `groupKey` limits it to one group.
   * Null when the server cannot be found.
   */
  public async syncGroupNames(
    eventId: string,
    guildId: string,
    groupKey?: string,
  ): Promise<NameSyncOutcome[] | null> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;
    return this.groupChannels.syncNames(eventId, guild, groupKey);
  }

  /**
   * Finish the pending channel user limits of an event (the host's live size
   * change, #1241): the stored size is the truth and the channel follows, one
   * attempt, never sleeping on a rate limit. `groupKey` limits it to one group.
   * Null when the server cannot be found.
   */
  public async syncGroupUserLimits(
    eventId: string,
    guildId: string,
    groupKey?: string,
  ): Promise<NameSyncOutcome[] | null> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;
    return this.groupChannels.syncUserLimits(eventId, guild, groupKey);
  }

  /**
   * Post, check or remove the "Customise team" message of every team channel so
   * it matches the event's switches now (#1196). The scan does this when it
   * sees a difference; #1197 calls it right after the host flips a switch.
   */
  public async syncGroupControls(eventId: string): Promise<void> {
    await this.groupChannels.syncControls(eventId);
  }

  /**
   * Delete one group's channel and take the group out of the event (the host's
   * live removal of a group, #1242): one step under the channel lock, see
   * `EventGroupChannels.removeGroup`. Null when the server cannot be found.
   */
  public async removeGroupChannel(
    eventId: string,
    guildId: string,
    opts: {
      groupKey: string;
      channelId: string;
      ignore?: ReadonlySet<string>;
      ending?: () => boolean;
    },
  ): Promise<GroupRemoveOutcome | null> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;
    return this.groupChannels.removeGroup(eventId, guild, opts);
  }

  /**
   * Delete every group channel of an event and switch its groups off in one
   * step under the channel lock (the host's live "groups off", #1243): see
   * `EventGroupChannels.removeAllGroupChannels`. Null when the server cannot
   * be found.
   */
  public async removeAllGroupChannels(
    eventId: string,
    guildId: string,
    opts: { ignore?: ReadonlySet<string>; ending?: () => boolean },
  ): Promise<GroupsOffOutcome | null> {
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;
    return this.groupChannels.removeAllGroupChannels(eventId, guild, opts);
  }

  /** What the last group-channel pass did for an event (host panel, #1189). */
  public getGroupChannelReport(eventId: string): GroupChannelReport | null {
    return this.groupChannels.getReport(eventId);
  }

  protected async isEnabled(): Promise<boolean> {
    return this.configService.getBoolean("events.enabled", false);
  }

  /** Events are scanned on a fixed tick rather than an admin-set schedule. */
  protected async resolveSchedule(): Promise<string> {
    return TICK_CRON;
  }

  public static getInstance(client: Client): EventService {
    if (!EventService.instance) {
      EventService.instance = new EventService(client);
    } else if (EventService.instance.client !== client) {
      throw new Error(
        "EventService already initialised with a different client",
      );
    }
    return EventService.instance;
  }

  public static reset(): void {
    if (EventService.instance) {
      EventService.instance.destroy();
    }
    EventService.instance = undefined as unknown as EventService;
  }

  // ---------------------------------------------------------------
  // Scan
  // ---------------------------------------------------------------

  protected async runOnce(): Promise<void> {
    const scanId = ++this.scanClock;
    this.activeScans.add(scanId);
    try {
      await this.scanOnce();
    } finally {
      this.activeScans.delete(scanId);
    }
  }

  private async scanOnce(): Promise<void> {
    const guildId = await this.configService.getString("GUILD_ID", "");
    if (!guildId) {
      logger.error("Event scan aborted: GUILD_ID not configured");
      return;
    }

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      logger.error(`Event scan aborted: guild ${guildId} not found`);
      return;
    }

    // Everything not yet finished, plus ended events whose channel still
    // needs sweeping.
    const events = await Event.find({
      guildId,
      $or: [
        { state: { $in: ["scheduled", "active"] } },
        { state: "ended", channelId: { $ne: null } },
        // A cancel keeps the channel id until Discord confirms the delete; the
        // scan finishes one a restart or an error left behind.
        { state: "cancelled", channelId: { $ne: null } },
        // Finished or cancelled events whose native scheduled event still
        // needs closing (#1034); the link is released once that succeeds.
        {
          state: { $in: ["ended", "cancelled"] },
          nativeEventId: { $ne: null },
        },
        // ...and ones whose native create timed out before its id was stored
        // (the event may still appear in Discord, #1034).
        {
          state: { $in: ["ended", "cancelled"] },
          nativeEventId: null,
          nativeCreateStartedAt: { $ne: null },
        },
        // Finished or cancelled group events whose group channels are still
        // recorded (#1190): the scan removes them once they are empty.
        {
          state: { $in: ["ended", "cancelled"] },
          "groups.channelId": { $type: "string" },
        },
        // Ended — or individually cancelled — recurring occurrences whose
        // successor has not been created yet (e.g. a crash between ending
        // and spawning, #744). A whole-series cancel is excluded.
        {
          state: { $in: ["ended", "cancelled"] },
          recurrence: { $ne: "none" },
          nextSpawned: false,
          seriesCancelled: { $ne: true },
        },
      ],
    });

    // Drop the covers of finished events and series (#1181).
    await sweepOrphanCovers(guildId).catch((error) =>
      logger.warn("Event covers: cleanup failed:", error),
    );

    const reminderMs =
      (await this.configService.getNumber("events.reminder_minutes", 30)) *
      MS_PER_MINUTE;
    const leadMs =
      (await this.configService.getNumber("events.create_lead_minutes", 15)) *
      MS_PER_MINUTE;
    const graceMs =
      (await this.configService.getNumber("events.channel_grace_minutes", 15)) *
      MS_PER_MINUTE;

    // One listing of the guild's native events per scan, not one per event.
    const loaded =
      events.length > 0 ? await this.nativeSync.loadCache(guild) : null;
    // A failed listing skips native sync this tick (no per-event fallback).
    const native = loaded === "failed" ? null : loaded;
    const skipNative = loaded === "failed";

    for (const event of events) {
      try {
        await this.processEvent(event, guild, new Date(), {
          reminderMs,
          leadMs,
          graceMs,
          native,
          skipNative,
        });
      } catch (error) {
        logger.error(
          `Error processing event ${sanitizeForLog(String(event._id))}:`,
          error,
        );
      }
    }

    // Clan tags (#1194): ask for a pass (restore what is owed, tag members of
    // running events). Not awaited: nickname edits are paced and can take
    // minutes, and the scan (starts, reminders, scheduled ends of unrelated
    // events) must never wait on them. One pass runs at a time.
    this.nicknameTags.requestSweep(guildId);
  }

  private async processEvent(
    event: IEvent,
    guild: Guild,
    now: Date,
    windows: {
      reminderMs: number;
      leadMs: number;
      graceMs: number;
      native?: NativeCache | null;
      skipNative?: boolean;
    },
  ): Promise<void> {
    let changed = false;

    // Being ended (or ended a moment ago) by "End event now" (#1193): this
    // copy of the row is older than the end, or the teardown is still using
    // the event's channels, and must not be acted on.
    if (this.mustSkipScan(event)) return;

    // An adopted event follows its native event, which stays the source of
    // truth (#1034): its edits are copied onto the row, and one deleted or
    // cancelled in Discord cancels the row. Nothing is written to Discord.
    if (
      event.nativeAdopted &&
      !windows.skipNative &&
      (event.state === "scheduled" || event.state === "active")
    ) {
      const before = `${event.title}|${event.description}|${event.startTime.getTime()}`;
      const outcome = await this.nativeSync.pullAdopted(
        event,
        guild,
        windows.native,
      );
      // The read above is an await: an end that began meanwhile (an adopted
      // event can be `active` during its channel lead) makes this copy older.
      if (this.mustSkipScan(event)) return;
      if (outcome === "gone") {
        // Before the start only. A temp channel that already has people in it
        // is left alone this tick; the check is repeated on the next scan.
        if (
          event.channelId &&
          !(await this.isChannelEmpty(guild, event.channelId))
        ) {
          return;
        }
        // ...and so is the occupancy check. `cancelOne` also writes only if the
        // stored state is still the one this copy decided from.
        if (this.mustSkipScan(event)) return;
        await this.cancelOne(event, windows.native, windows.skipNative);
        return;
      }
      // The announcement shows the title, time and description in plain text:
      // when a pull changed them, re-render it through the link-refresh path.
      if (
        before !==
        `${event.title}|${event.description}|${event.startTime.getTime()}`
      ) {
        this.linkVerified.delete(String(event._id));
      }
    }

    // A series cancel that was interrupted (crash, failed query) leaves
    // flagged rows still open: finish it instead of running their lifecycle.
    if (
      (event.state === "scheduled" || event.state === "active") &&
      (event.seriesCancelled ||
        (isRecurring(event) && (await this.isSeriesCancelled(event))))
    ) {
      // A successor inserted just after a series cancel can miss the flag
      // (its spawner died before re-checking); a cancelled sibling anywhere
      // in the series settles it, and the flag is carried onto this row.
      event.seriesCancelled = true;
      await this.cancelOne(event, windows.native, windows.skipNative);
      return;
    }

    // A recurring occurrence whose announcement failed (or was never made) is
    // retried here, since nothing else would ever repair it. An adopted event
    // has no post to begin with: this is where its link announcement is made.
    if (
      (isRecurring(event) || event.nativeAdopted) &&
      !event.announcementMessageId &&
      (event.state === "scheduled" || event.state === "active")
    ) {
      await this.ensureAnnouncement(event);
    }

    // The reads above (the adopted event, the series) can outlast a manual end:
    // an older, open copy posts no reminder and no new announcement after it.
    if (this.mustSkipScan(event)) return;

    // 1. Reminder (before start, once).
    if (shouldSendReminder(event, now, windows.reminderMs)) {
      // A reminder skipped because an end or cancel holds the event is not a
      // sent reminder: it is not recorded as one (the event may still be open
      // if that claim failed). Every other outcome is recorded as before.
      if ((await this.postReminder(event)) !== false) {
        event.reminderSent = true;
        changed = true;
      }
    }

    // 2. Create the temp channel shortly before start.
    if (
      shouldCreateChannel(event, now, windows.leadMs) &&
      !this.adoptedHasOwnChannel(event, windows.native)
    ) {
      const channel = await this.claimEventChannel(event, guild, {
        enforceLead: true,
      });
      // The claim wrote the channel id (or adopted the winner's): the scan's
      // save must not write it back, whatever a cancel does to it meanwhile.
      this.ignoreClaimed(event, "channelId");
      if (channel) {
        if (event.state === "scheduled") await this.activateScheduled(event);
        changed = true;
        // Skips itself (and says so) when an end or cancel holds the event.
        await this.updateAnnouncement(event);
      }
    }

    // 3. End once past the end time: the one shared teardown (#1193), the same
    // a manual "End event now" runs. It saves the end with an atomic claim
    // (state and times as this scan read them), so an end made meanwhile, a
    // cancel or an edited schedule is not overwritten; the group channels go
    // there too, and this scan's own native sync below closes the Discord event.
    let teardownRan = false;
    const endCheck = shouldEndEvent(event, now)
      ? await this.checkScheduledEnd(event, guild)
      : null;
    if (endCheck && !endCheck.defer) {
      // The occupancy reads are awaits: an end that began meanwhile wins.
      if (this.mustSkipScan(event)) return;
      const outcome = await this.teardown.run({
        eventId: String(event._id),
        guildId: event.guildId,
        trigger: "scheduled",
        now,
        endedAt: computeEndTime(event.startTime, event.durationMinutes),
        fromStates: ["scheduled", "active"],
        expectTimes: {
          startTime: event.startTime,
          durationMinutes: event.durationMinutes,
        },
        expectChannels: endCheck.expectChannels,
        guild,
        event,
        syncNative: false,
      });
      if (outcome.status === "ended") {
        teardownRan = true;
        changed = true;
      } else if (outcome.status === "already-ended") {
        // Ended elsewhere a moment ago (a manual end). That caller is still
        // working on it while it holds the event: leave it to finish alone and
        // look again next scan, on a fresh copy.
        if (this.isBeingEnded(String(event._id))) return;
        // Ended earlier: follow it. The claim wrote both fields, so this copy's
        // save must not write them again.
        event.state = "ended";
        event.endedAt = outcome.endedAt;
        const doc = event as unknown as { $ignore?: (path: string) => void };
        doc.$ignore?.("state");
        doc.$ignore?.("endedAt");
      } else {
        // Cancelled or edited meanwhile, or the end could not be saved: this
        // copy is stale or the write failed; the next scan decides again.
        return;
      }
    }

    // 4a. A cancelled event's channel goes at once (the cancel's own delete did
    // not finish, or was cut short by a restart).
    if (
      event.channelId &&
      event.state === "cancelled" &&
      !this.mustSkipScan(event)
    ) {
      await this.releaseCancelledChannel(event, guild, event.channelId);
    }

    // 4. Sweep the empty channel after the grace period.
    if (event.channelId && event.state === "ended") {
      const empty = await this.isChannelEmpty(guild, event.channelId);
      if (shouldCleanupChannel(event, now, windows.graceMs, empty)) {
        await this.deleteEventChannel(guild, event.channelId);
        event.channelId = null;
        changed = true;
      }
    }

    if (changed) {
      await event.save();
      await this.logLifecycle(event);
    }

    // 2b. Group channels (#1190): created next to the main channel, and made
    // again after a restart or a deletion. Only a group event with a main
    // channel gets here, and only while something is missing: a plain event
    // makes no call at all. This runs after the scan's own save on purpose: the
    // pass is slow (paced writes), and a cancel that lands meanwhile must not be
    // overwritten by this scan saving its older copy of the event afterwards.
    if (this.needsGroupReconcile(event, guild, now)) {
      await this.logGroupReport(
        event,
        await this.groupChannels.reconcile(event, guild),
      );
    }

    // 2c. The leaders-only channel's access (#1199): never verified since it was
    // created or since a restart, overwrites that differ from who leads, a
    // stranger in it, or a move still owed. Judged from the cache only; the
    // pass reads Discord and the event fresh before it writes anything. An
    // event that is still open keeps being looked after past its scheduled end:
    // that end is deferred while people are in its channels (#1193), and the
    // admin roles and owed moves must not wait for them to leave. One this scan
    // just ended, and any ended or cancelled one, is left alone (and the pass
    // itself ignores an event that is not open).
    if (
      event.groupsEnabled === true &&
      !event.nativeAdopted &&
      !teardownRan &&
      (event.state === "scheduled" || event.state === "active") &&
      (await this.leadsAdminsChanged(event, guild))
    ) {
      await this.syncLeadsAccess(event.guildId, String(event._id));
    }

    // 2d. The leader customiser (#1196): a stored team name whose channel has
    // not been confirmed to carry it, and the "Customise team" message of each
    // team channel (posted, checked or taken away to match the switches). Both
    // triggers are pure reads of this copy; the passes read the event fresh
    // inside the channel lock and refuse one that is not open.
    if (
      event.groupsEnabled === true &&
      !event.nativeAdopted &&
      !teardownRan &&
      (event.state === "scheduled" || event.state === "active") &&
      !this.mustSkipScan(event)
    ) {
      const eventId = String(event._id);
      if (this.groupChannels.namesNeedAttention(event)) {
        await this.groupChannels.syncNames(eventId, guild);
      }
      if (this.groupChannels.sizesNeedAttention(event)) {
        await this.groupChannels.syncUserLimits(eventId, guild);
      }
      if (this.groupChannels.controlsNeedAttention(event)) {
        await this.groupChannels.syncControls(eventId);
      }
    }

    // 4b. Group channels of a finished event go with the main channel (#1190),
    // judged from the saved state (a fresh read), channel by channel.
    if (
      !teardownRan &&
      this.hasRecordedGroupChannels(event) &&
      (event.state === "ended" || event.state === "cancelled")
    ) {
      await this.logGroupReport(
        event,
        await this.groupChannels.cleanup(event, guild, now),
      );
    }

    // The slow steps above can outlast a manual end that landed meanwhile.
    if (this.mustSkipScan(event)) return;

    // Keep the native scheduled event in line (#1034): creates it for events
    // that predate the toggle, pushes edits, and closes it on end/cancel.
    if (!windows.skipNative) {
      await this.nativeSync.syncEvent(event, guild, windows.native);
      // That await can outlast a manual end too: this copy still says open.
      if (this.mustSkipScan(event)) return;
      // The announcement carries the native event's link. The ids are stored
      // before the post is edited, so a failed edit (or a post another sender
      // replaced) would not be noticed by comparing ids between scans.
      // `linkVerified` instead remembers, per event, the (message, native
      // event) pair last rendered successfully; any other pair, or none, is
      // refreshed again on every scan until it succeeds. In memory only, so
      // each event is re-checked once after a restart.
      const id = String(event._id);
      if (event.state !== "scheduled" && event.state !== "active") {
        this.linkVerified.delete(id);
      } else {
        // The content this copy renders is part of the key (#1298): a scan
        // holding the row from before an edit can finish its refresh after the
        // edit's own, overwrite the post with the old text, and must not certify
        // it. The next scan reads the edited row, sees another key and refreshes.
        const pair = `${event.announcementMessageId ?? ""}|${event.nativeEventId ?? ""}|${announcementContentKey(event)}`;
        if (this.linkVerified.get(id) !== pair) {
          const refreshed = await this.updateAnnouncement(event);
          if (refreshed && event.announcementMessageId) {
            this.linkVerified.set(id, pair);
          } else {
            this.linkVerified.delete(id);
          }
        }
      }
      // A discarded duplicate's cleanup record has done its job once the
      // native event is closed.
      if (
        event.nativeCleanupOnly &&
        !event.nativeEventId &&
        !event.nativeCreateStartedAt
      ) {
        await Event.deleteOne({ _id: event._id });
        return;
      }
    }

    // 5. A finished (or individually cancelled) occurrence hands over to the
    // next one in its series.
    if (
      (event.state === "ended" || event.state === "cancelled") &&
      isRecurring(event) &&
      !event.nextSpawned &&
      !event.seriesCancelled
    ) {
      await this.spawnNextOccurrence(event, now);
    }
  }

  // ---------------------------------------------------------------
  // Recurrence (#744)
  // ---------------------------------------------------------------

  /**
   * An adopted event that happens in a Discord channel of its own (a voice or
   * stage event) gets no temporary channel. Also true while that is unknown (no
   * native listing this scan), so a channel is never made by mistake; the next
   * scan decides.
   */
  private adoptedHasOwnChannel(
    event: IEvent,
    native?: NativeCache | null,
  ): boolean {
    if (!event.nativeAdopted) return false;
    return this.nativeSync.adoptedHasChannel(event, native) !== false;
  }

  /**
   * Undo an adoption step (#1034): remove the KoolBot row the step created
   * (found by its adoption reference, so only that row), its announcement post
   * and its temporary channel. The native event is not touched in any way, and
   * the row is never cancelled or ended first, which would reach the native
   * event. Throws when the temporary channel is in use, so the rollback is
   * retried later instead of pulling the channel from under people.
   */
  public async removeAdoptedEvent(adoptionRef: string): Promise<boolean> {
    const row = await Event.findOne({ adoptionRef, nativeAdopted: true });
    if (!row) return false;
    // Cleanup is strict: only a confirmed absence counts as done. Any other
    // failure propagates, and the row (the only record of the channel and the
    // post) is kept so a retry can find them.
    if (row.channelId) {
      await this.removeChannelStrict(row.guildId, row.channelId);
    }
    if (row.announcementChannelId && row.announcementMessageId) {
      await this.removePostStrict(
        row.guildId,
        row.announcementChannelId,
        row.announcementMessageId,
      );
    }
    // Delete only while the row still tracks exactly what was cleaned up. A
    // scan or "Start now" that attached a post or channel since the read makes
    // this a no-op; the next attempt then cleans up the new resources too. A
    // creator that loses to the delete removes its own resource (its claim
    // filters on the row).
    const result = await Event.deleteOne({
      _id: row._id,
      adoptionRef,
      nativeAdopted: true,
      channelId: row.channelId ?? null,
      announcementMessageId: row.announcementMessageId ?? null,
    });
    if (result?.deletedCount === 0) {
      throw new Error(
        "The event changed while it was being removed. Try again.",
      );
    }
    this.linkVerified.delete(String(row._id));
    return true;
  }

  /** Delete a temp channel that must be empty; absence is the only quiet outcome. */
  private async removeChannelStrict(
    guildId: string,
    channelId: string,
  ): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    let channel;
    try {
      channel =
        guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId));
    } catch (error) {
      if (this.isDiscardableError(error, DISCORD_UNKNOWN_CHANNEL)) return;
      throw error;
    }
    if (!channel) return;
    if (
      channel.type === ChannelType.GuildVoice &&
      (channel as VoiceChannel).members.size > 0
    ) {
      throw new Error(
        "The event's temporary voice channel is in use. Try again once it is empty.",
      );
    }
    try {
      await channel.delete("Event adoption rolled back");
    } catch (error) {
      if (this.isDiscardableError(error, DISCORD_UNKNOWN_CHANNEL)) return;
      throw error;
    }
  }

  /** Delete an announcement post; absence is the only quiet outcome. */
  private async removePostStrict(
    guildId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const { channel, gone } = await this.fetchTextChannelDetailed(
      guildId,
      channelId,
    );
    if (!channel) {
      if (gone) return;
      throw new Error("The announcement channel could not be read.");
    }
    try {
      const message = await channel.messages.fetch(messageId);
      await message.delete();
    } catch (error) {
      if (
        this.isDiscardableError(error, DISCORD_UNKNOWN_MESSAGE) ||
        this.isDiscardableError(error, DISCORD_UNKNOWN_CHANNEL)
      ) {
        return;
      }
      throw error;
    }
  }

  public async isRecurrenceEnabled(): Promise<boolean> {
    return this.configService.getBoolean("events.recurrence_enabled", true);
  }

  /**
   * Create the occurrence after `previous`, exactly once.
   *
   * Idempotent rather than claim-first: the successor is inserted under the
   * unique `(guildId, seriesId, occurrenceIndex)` key, so a crash, a restart
   * or a concurrent caller (the scan, a cancel-this-occurrence, another
   * replica) at worst finds the row already there and adopts it. Only after
   * the successor exists is `previous.nextSpawned` set, as a "done" marker; a
   * crash before that is simply retried on the next scan.
   *
   * Series cancellation is durable (`seriesCancelled` on every row, set
   * before open rows are cancelled). A spawn that raced past the first check
   * re-reads the flag after inserting and cancels its own successor, and
   * `cancelSeries`' open-row query cannot miss a successor inserted before
   * that re-read — so a cancelled series cannot be revived either way.
   *
   * The schedule comes from the series anchor (`computeOccurrenceStart`);
   * cadence steps already in the past — the bot was down, or the series was
   * paused — are skipped, not back-filled.
   */
  private async spawnNextOccurrence(
    previous: IEvent,
    now: Date,
  ): Promise<IEvent | null> {
    if (!isRecurring(previous) || !previous.seriesId) return null;
    if (previous.nextSpawned || previous.seriesCancelled) return null;
    if (!(await this.isRecurrenceEnabled())) return null;

    const seriesId = previous.seriesId;
    try {
      // The caller's copy may predate a series cancel or another replica.
      const fresh = await Event.findById(previous._id);
      if (!fresh || fresh.nextSpawned || fresh.seriesCancelled) return null;

      // A successor may already exist (saved, but `nextSpawned` never got
      // set): adopt it rather than skipping past it and creating another.
      const later = await Event.findOne({
        guildId: previous.guildId,
        seriesId,
        occurrenceIndex: { $gt: previous.occurrenceIndex },
      });
      if (later) {
        await Event.updateOne(
          { _id: previous._id },
          { $set: { nextSpawned: true } },
        );
        previous.nextSpawned = true;
        return later;
      }

      // What an edit left for the series (#1298), read from the fresh row: the
      // occurrence has left `scheduled`/`active` by now, so no edit can still
      // change it. Without a template the occurrence's own values carry on.
      const template = fresh.seriesTemplate ?? null;
      const zone = template ? template.timezone : previous.timezone;
      const anchor =
        fresh.seriesStart ?? previous.seriesStart ?? previous.startTime;
      let index = previous.occurrenceIndex + 1;
      let start = computeOccurrenceStart(
        anchor,
        previous.recurrence,
        index,
        zone,
      );
      for (
        let skipped = 0;
        start.getTime() <= now.getTime() && skipped < MAX_OCCURRENCE_SKIP;
        skipped++
      ) {
        index += 1;
        start = computeOccurrenceStart(
          anchor,
          previous.recurrence,
          index,
          zone,
        );
      }
      if (start.getTime() <= now.getTime()) {
        throw new Error("no future occurrence within the search window");
      }

      const key = {
        guildId: previous.guildId,
        seriesId,
        occurrenceIndex: index,
      };
      // Hold the series' cover lock from reading the cover hash to saving the
      // row, so an upload, replace or remove (which holds it across both its
      // writes) either finishes first and is read here, or runs after the
      // insert and its bulk update covers the new row (#1181).
      const spawned = await withCoverLock(
        previous.guildId,
        seriesId,
        async (): Promise<{ next: IEvent | null; created: boolean }> => {
          const existing: IEvent | null = await Event.findOne(key);
          if (existing) return { next: existing, created: false };
          const latest = await Event.findById(previous._id);
          // The group setup carries over like the cover, from the freshest row
          // (#1188), but it is the HOST'S setup for the series (#1266): the
          // stored series setup, which only the creation of the series and a
          // ticked "also for the next occurrences" save change. An un-ticked live
          // edit of the running event therefore stays with that occurrence, and a
          // leader's rename or tag never reaches the next one. A row without a
          // series setup (made before it existed) is read as it is, with the
          // lock off; its successor then carries the setup on. The
          // memberships, leaders and channel ids stay behind either way.
          const source = latest ?? previous;
          const series =
            readSeriesGroupSetup(source.seriesGroupSetup) ??
            seriesGroupSetupOf(source);
          const groupSetup = successorGroupFields(
            series,
            copyGroupSetup(source).channelLeadMinutes,
          );
          const doc = new Event({
            guildId: previous.guildId,
            title: template ? template.title : previous.title,
            description: template ? template.description : previous.description,
            startTime: start,
            timezone: zone,
            durationMinutes: template
              ? template.durationMinutes
              : previous.durationMinutes,
            categoryId: previous.categoryId,
            state: "scheduled",
            reminderSent: false,
            recurrence: previous.recurrence,
            seriesId,
            occurrenceIndex: index,
            seriesStart: anchor,
            spawnedFrom: String(previous._id),
            nextSpawned: false,
            seriesCancelled: false,
            // Each occurrence is mirrored with the series' cover (#1181); the
            // image itself is shared, only its hash is copied.
            coverHash: latest?.coverHash ?? null,
            // The channel lead time belongs to every event, with or without
            // groups: a host's live edit of it (#1239) reaches the next
            // occurrence of a plain event too.
            channelLeadMinutes: groupSetup.channelLeadMinutes,
            ...(groupSetup.groupsEnabled ? groupSetup : {}),
            seriesGroupSetup: series,
            createdBy: previous.createdBy,
          });
          try {
            await doc.save();
            return { next: doc, created: true };
          } catch (error) {
            // Lost the insert race to another caller: adopt their row.
            if ((error as { code?: number }).code !== 11000) throw error;
            return { next: await Event.findOne(key), created: false };
          }
        },
      );
      const next = spawned.next;
      const created = spawned.created;
      if (!next) return null;

      if (created) {
        // Two spawns whose `now` straddled a cadence boundary can pick
        // different indices and both insert. Whoever sees a lower-indexed
        // sibling removes its own just-inserted row; the lowest survives.
        const sibling = await Event.findOne({
          guildId: previous.guildId,
          seriesId,
          occurrenceIndex: { $gt: previous.occurrenceIndex, $lt: index },
          // Only competing successors of THIS predecessor count; a later
          // descendant legitimately spawned from another occurrence must not.
          spawnedFrom: String(previous._id),
          _id: { $ne: next._id },
        });
        if (sibling) {
          await this.discardDuplicate(next);
          await Event.updateOne(
            { _id: previous._id },
            { $set: { nextSpawned: true } },
          );
          previous.nextSpawned = true;
          return sibling;
        }
        // The reverse insert order: a higher-indexed duplicate may have gone
        // in (and passed its own check) before this lower row existed. This
        // row is the lower one, so it wins and sweeps those up; between the
        // two checks the lowest index always survives.
        const higher = await Event.find({
          guildId: previous.guildId,
          seriesId,
          occurrenceIndex: { $gt: index },
          spawnedFrom: String(previous._id),
          state: "scheduled",
        });
        for (const duplicate of higher) {
          await this.discardDuplicate(duplicate);
        }
        await this.postAnnouncement(next).catch((error) =>
          logger.error("Failed to post event announcement:", error),
        );
        // A series cancel may have landed between the check above and the
        // insert; if so, take the successor down again.
        const recheck = await Event.findById(previous._id);
        if (recheck?.seriesCancelled) {
          // Persist the flag too, so the recovery scan doesn't treat this
          // as an individually cancelled occurrence and spawn again.
          next.seriesCancelled = true;
          await this.cancelOne(next);
          return null;
        }
        logger.info(
          `Spawned occurrence ${index} of event series ${sanitizeForLog(seriesId)}`,
        );
      }

      await Event.updateOne(
        { _id: previous._id },
        { $set: { nextSpawned: true } },
      );
      previous.nextSpawned = true;
      return next;
    } catch (error) {
      // Nothing to undo: `nextSpawned` is untouched, so the next scan retries.
      logger.error(
        `Failed to spawn the next occurrence of series ${sanitizeForLog(seriesId)}:`,
        error,
      );
      return null;
    }
  }

  /** Every occurrence of a series, oldest first. */
  public async listSeries(
    guildId: string,
    seriesId: string,
  ): Promise<IEvent[]> {
    return Event.find({ guildId, seriesId }).sort({ occurrenceIndex: 1 });
  }

  // ---------------------------------------------------------------
  // Public API (command + web + button handler)
  // ---------------------------------------------------------------

  public async createEvent(input: CreateEventInput): Promise<IEvent> {
    const recurrence = input.recurrence ?? "none";
    if (recurrence !== "none" && !(await this.isRecurrenceEnabled())) {
      throw new RecurrenceDisabledError();
    }
    const event = new Event({
      guildId: input.guildId,
      title: input.title,
      description: input.description,
      startTime: input.startTime,
      timezone: input.timezone,
      durationMinutes: input.durationMinutes,
      categoryId: input.categoryId ?? "",
      state: "scheduled",
      // An impromptu event has no lead-up to remind anyone of.
      reminderSent: input.impromptu === true,
      ...(input.impromptu === true ? { impromptu: true } : {}),
      recurrence,
      // Only set when the form switched groups on; a plain event leaves every
      // group field at its schema default.
      ...(input.groups?.groupsEnabled ? input.groups : {}),
      createdBy: input.createdBy,
    });
    if (recurrence !== "none") {
      // The first occurrence's id doubles as the series id.
      event.seriesId = String(event._id);
      event.occurrenceIndex = 0;
      event.seriesStart = input.startTime;
      // What the next occurrences start with (#1266): the setup the form made,
      // or none. Later changes to a running occurrence do not move it unless the
      // host ticks "also for the next occurrences".
      event.seriesGroupSetup = seriesGroupSetupOf(
        input.groups?.groupsEnabled ? input.groups : {},
      );
    }
    await event.save();
    // Create the native event first so the announcement can carry its link.
    await this.nativeSync.syncEvent(event);
    await this.postAnnouncement(event).catch((error) =>
      logger.error("Failed to post event announcement:", error),
    );
    logger.info(`Created event ${sanitizeForLog(String(event._id))}`);
    return event;
  }

  /**
   * An impromptu event, "we are doing this now" (#1305): creates the event a few
   * seconds ahead (so the native Discord event can be created), then runs the
   * same Start now as the host panel, so the event voice channel and the group
   * channels exist at once, ignoring the lead time. One-off only: it never
   * repeats. Nothing is created when no channel category is configured, since
   * Start now could not make a channel (`ImpromptuNotReadyError`).
   *
   * `started` is false when the event was created but Start now could not run
   * (channel creation failed); the row stays, and the scan retries the channel
   * on its next tick. Called by the Web UI create routes; #1319's list can call
   * it too.
   */
  public async createImpromptuEvent(
    input: Omit<CreateEventInput, "startTime" | "recurrence" | "impromptu">,
    now: Date = new Date(),
  ): Promise<{ event: IEvent; started: boolean }> {
    const categoryId = await this.configService.getString(
      "events.category_id",
      "",
    );
    if (!categoryId) {
      throw new ImpromptuNotReadyError(
        "No channel category is set (events.category_id), so the event channels cannot be created.",
      );
    }
    const event = await this.createEvent({
      ...input,
      startTime: new Date(now.getTime() + IMPROMPTU_START_BUFFER_MS),
      recurrence: "none",
      impromptu: true,
    });
    let started: IEvent | null = null;
    try {
      started = await this.startEventNow(String(event._id), input.guildId);
    } catch (error) {
      logger.error(
        `Impromptu event ${sanitizeForLog(String(event._id))}: start now failed:`,
        error,
      );
    }
    return { event: started ?? event, started: started !== null };
  }

  /**
   * Edit an upcoming event in place (#1298). One conditional write, so an edit
   * that loses a race with Start now, an end, a cancel or another edit changes
   * nothing and says so (`conflict`).
   *
   * Nothing is timer-driven: the one-minute scan reads the row, so a new
   * `startTime` re-arms the lead-time channel and the reminder by itself. The
   * only thing that must be put back is `reminderSent` when the start moves.
   * Afterwards the native Discord event is patched through the normal sync
   * (`diffNativeFields` then `scheduledEvents.edit`, never delete and create,
   * so the Interested list survives) and the announcement is edited in place.
   * RSVPs, the cover, the groups and the announcement ids are not touched.
   *
   * `expectedVersion` is `eventEditVersion` of the row the form was built from,
   * with the mode it was rendered in. The caller refuses a form rendered full
   * for an event that is limited now before it reads any posted field; a clock
   * step between that check and this one is safe because a limited event still
   * refuses a changed title or start (`locked`).
   * Does not take `withEventMoveLock` or move `liveEditRevision`: no group
   * field changes here.
   */
  public async editEvent(input: {
    eventId: string;
    guildId: string;
    expectedVersion: string;
    /** The mode the form was rendered in; part of the token (`eventEditVersion`). */
    renderedMode: RenderedMode;
    changes: EventEditFields;
    /**
     * How far the edit reaches on a recurring event; required there (a missing
     * one is refused, never defaulted) and ignored on a one-off event.
     */
    scope?: EditScope | null;
    now?: Date;
  }): Promise<EditEventResult> {
    const now = input.now ?? new Date();
    const id = canonicalEventId(input.eventId);
    const row = id ? await this.getEvent(id) : null;
    if (!id || !row || row.guildId !== input.guildId) {
      return { ok: false, code: "not-found", message: "Event not found." };
    }
    // Fails closed, as `endEventNow` does: with events off the native sync and
    // the repair scan are idle, so an edit would leave Discord and the
    // announcement on a different schedule from the row.
    if (!(await this.editsAllowed())) {
      return { ok: false, code: "disabled", message: EDIT_MESSAGES.disabled };
    }
    const mode = editModeOf(row, now, this.isBeingEnded(id));
    if (mode.mode === "refused") {
      return { ok: false, code: "refused", message: mode.message };
    }
    const conflict = (): EditEventResult => ({
      ok: false,
      code: "conflict",
      message: EDIT_MESSAGES.conflict,
    });
    if (eventEditVersion(row, input.renderedMode) !== input.expectedVersion) {
      return conflict();
    }

    // A recurring event needs to be told how far the edit reaches (#1298).
    const series = isSeriesRow(row);
    // Exactly the two known values: anything else is refused, never read as one.
    const scope = series
      ? parseEditScope(typeof input.scope === "string" ? input.scope : "")
      : null;
    if (series && scope === null) {
      return { ok: false, code: "scope", message: EDIT_MESSAGES.scope };
    }
    if (series && row.nextSpawned === true) {
      return {
        ok: false,
        code: "series-advanced",
        message: EDIT_MESSAGES.seriesAdvanced,
      };
    }

    const want = input.changes;
    const moved = want.startTime.getTime() !== row.startTime.getTime();
    if (
      mode.mode === "limited" &&
      (want.title !== row.title ||
        moved ||
        (want.timezone ?? "") !== (row.timezone ?? ""))
    ) {
      return { ok: false, code: "locked", message: EDIT_MESSAGES.locked };
    }
    if (moved && want.startTime.getTime() <= now.getTime()) {
      return { ok: false, code: "past", message: EDIT_MESSAGES.past };
    }
    // Only a change of the duration can end the event: an event the scan keeps
    // open past its scheduled end (people still in its channels) still takes a
    // new description.
    if (
      mode.mode === "limited" &&
      want.durationMinutes !== row.durationMinutes &&
      computeEndTime(row.startTime, want.durationMinutes).getTime() <=
        now.getTime()
    ) {
      return { ok: false, code: "bad-end", message: EDIT_MESSAGES.badEnd };
    }
    // The mirror never moves the start of a running native event, so a start
    // that moved here would leave Discord, the reminder and the channel on
    // different schedules. Unreadable counts as locked.
    if (moved && !(await this.startMayMove(row))) {
      return {
        ok: false,
        code: "native-active",
        message: EDIT_MESSAGES.nativeActive,
      };
    }
    const diff = diffEventEdit(row, want);
    if (!hasEdit(diff)) {
      return { ok: false, code: "unchanged", message: EDIT_MESSAGES.unchanged };
    }
    // What a recurring edit writes besides the row's own fields: the template
    // the next occurrence is built from, and the series anchor.
    const seriesWrite: Record<string, unknown> = {};
    if (series && scope !== null) {
      const template = nextSeriesTemplate(scope, row, want);
      seriesWrite.seriesTemplate = template;
      // The anchor the schedule is computed from. A row without one (made
      // before it was stored) is pinned to its start as it is NOW, so a move of
      // this occurrence cannot drag the series along.
      const anchor = row.seriesStart ?? row.startTime;
      if (!row.seriesStart) seriesWrite.seriesStart = row.startTime;
      const recurs = !!row.recurrence && row.recurrence !== "none";
      const zoneChanged = (want.timezone ?? "") !== (row.timezone ?? "");
      let scheduleAnchor = anchor;
      if (scope === "following" && (moved || zoneChanged)) {
        // The existing anchor is passed as the preferred one, so a time-only
        // change keeps a monthly series' day (31st) instead of the clamped one.
        const newAnchor = recurs
          ? anchorForOccurrence(
              want.startTime,
              row.recurrence,
              row.occurrenceIndex ?? 0,
              template.timezone,
              row.seriesStart ?? undefined,
            )
          : new Date(want.startTime);
        if (!newAnchor) {
          return { ok: false, code: "anchor", message: EDIT_MESSAGES.anchor };
        }
        seriesWrite.seriesStart = newAnchor;
        scheduleAnchor = newAnchor;
      }
      // The next occurrence is created once this one has ended, and a slot that
      // is already past by then is skipped. So the edited event must end before
      // the next slot, or the series silently loses an occurrence. Checked when
      // the edit changes the start or the duration (the end), against the slot
      // of the schedule the edit leaves behind.
      if (
        recurs &&
        (moved || zoneChanged || want.durationMinutes !== row.durationMinutes)
      ) {
        const nextSlot = computeOccurrenceStart(
          scheduleAnchor,
          row.recurrence,
          (row.occurrenceIndex ?? 0) + 1,
          template.timezone,
        );
        if (
          computeEndTime(want.startTime, want.durationMinutes).getTime() >=
          nextSlot.getTime()
        ) {
          return {
            ok: false,
            code: "past-next-slot",
            message: EDIT_MESSAGES.pastNextSlot,
          };
        }
      }
    }

    // A native create that timed out may still land in Discord, and the sync
    // recognises it by the row's name and start. Renaming or moving the row now
    // would make it unrecognisable and a second Discord event would be created,
    // stranding the first one's Interested list.
    const identityChange = want.title !== row.title || moved;
    if (identityChange && !row.nativeEventId && row.nativeCreateStartedAt) {
      return {
        ok: false,
        code: "native-pending",
        message: EDIT_MESSAGES.nativePending,
      };
    }

    const changes: Record<string, unknown> = {};
    if (want.title !== row.title) changes.title = want.title;
    if (want.description !== (row.description ?? "")) {
      changes.description = want.description;
    }
    if (moved) {
      changes.startTime = want.startTime;
      // Re-arm the reminder for the new start.
      changes.reminderSent = false;
    }
    if ((want.timezone ?? "") !== (row.timezone ?? "")) {
      changes.timezone = want.timezone;
    }
    if (want.durationMinutes !== row.durationMinutes) {
      changes.durationMinutes = want.durationMinutes;
    }
    Object.assign(changes, seriesWrite);

    const updated = await Event.findOneAndUpdate(
      {
        _id: row._id,
        guildId: row.guildId,
        // The state and channel the edit was judged on: a start, end or cancel
        // since then no longer matches. `channelId` is part of it, so the scan's
        // lead-time creation cannot slip in between a full edit's check and write.
        state: row.state,
        channelId: row.channelId ?? null,
        title: row.title,
        description:
          (row.description ?? "") === ""
            ? { $in: ["", null] }
            : row.description,
        startTime: row.startTime,
        // Matched like the version token reads it, so two edits that read the
        // same version cannot both win by changing only the timezone.
        timezone:
          (row.timezone ?? "") === "" ? { $in: ["", null] } : row.timezone,
        durationMinutes: row.durationMinutes,
        // Paired with `markCreateStarted`, which is conditioned on the title and
        // start: whichever of an identity edit and a native create starts first
        // wins, and the other sees a changed row.
        ...(identityChange
          ? {
              nativeEventId: row.nativeEventId ?? null,
              nativeCreateStartedAt: row.nativeCreateStartedAt ?? null,
            }
          : {}),
        // A successor that appeared since (or a moved anchor) means the series
        // has moved on from what the scope was judged against.
        ...(series ? seriesWriteFilter(row) : {}),
        nativeAdopted: { $ne: true },
        seriesCancelled: { $ne: true },
      },
      { $set: changes },
      { new: true },
    );
    if (!updated) return conflict();

    // The write is done; what follows is best effort and repaired by the scan
    // (the native sync and the link refresh both run on every tick).
    this.linkVerified.delete(id);
    try {
      try {
        await this.nativeSync.syncEvent(updated);
      } catch (error) {
        logger.error(
          `Event ${sanitizeForLog(id)}: native sync after edit failed:`,
          error,
        );
      }
      try {
        await this.updateAnnouncement(updated);
      } catch (error) {
        logger.error(
          `Event ${sanitizeForLog(id)}: announcement refresh after edit failed:`,
          error,
        );
      }
    } finally {
      // Cleared again once the refresh has settled, failed or not: an edit that
      // paused above while a newer edit committed and a scan certified it just
      // wrote its older row over the post, and nothing may vouch for the post
      // until the next scan has looked at it.
      this.linkVerified.delete(id);
    }
    logger.info(`Edited event ${sanitizeForLog(id)}`);
    return { ok: true, event: updated, diff, scope };
  }

  /** Whether events are on; false when off or when the setting cannot be read. */
  public async editsAllowed(): Promise<boolean> {
    try {
      return (
        (await this.configService.getBoolean("events.enabled", false)) === true
      );
    } catch (error) {
      logger.warn("Could not read events.enabled to edit an event:", error);
      return false;
    }
  }

  /**
   * Whether the event's start may move: its linked native event, read fresh,
   * is still Scheduled (or there is none). False when it is running, finished
   * or cannot be read. Adopted events are refused earlier.
   */
  public async startMayMove(event: {
    guildId: string;
    nativeEventId?: string | null;
  }): Promise<boolean> {
    const status = await this.nativeSync.linkedStatus({
      guildId: event.guildId,
      nativeEventId: event.nativeEventId ?? null,
    });
    return status === "none" || status === "scheduled";
  }

  public async listEvents(guildId: string): Promise<IEvent[]> {
    return Event.find({ guildId }).sort({ startTime: 1 });
  }

  public async getEvent(eventId: string): Promise<IEvent | null> {
    return Event.findById(eventId).catch(() => null);
  }

  /**
   * Cancel one event: mark cancelled and tear down any live channel.
   *
   * For a recurring event this cancels just this occurrence; the series
   * carries on, so the following occurrence is created straight away (it
   * would otherwise only appear once this one ended, which it now never
   * will). Use {@link cancelSeries} to stop the whole series.
   */
  public async cancelEvent(
    eventId: string,
    guildId?: string,
    opts: { refuseRunningAt?: Date } = {},
  ): Promise<IEvent | null> {
    const event = await this.getEvent(eventId);
    if (!event) return null;
    if (guildId && event.guildId !== guildId) return null;
    if (event.state === "cancelled") return event;

    // Only a cancel THIS call made is announced as one: a lost claim (the
    // event ended, or was cancelled by someone else, since it was read) neither
    // spawns a successor nor reports success. The caller reads `state` of the
    // returned row: `cancelled` means cancelled, anything else means it was not.
    const cancelled = await this.cancelOne(
      event,
      undefined,
      false,
      opts.refuseRunningAt,
    );
    if (!cancelled) {
      return (await this.getEvent(eventId)) ?? event;
    }
    if (isRecurring(event) && !event.nextSpawned && !event.seriesCancelled) {
      await this.spawnNextOccurrence(event, new Date());
    }
    return event;
  }

  /**
   * Cancel every unfinished occurrence of the series `eventId` belongs to and
   * stop it spawning more. Returns the addressed event plus how many
   * occurrences were cancelled, or null when it is missing / another guild's.
   * A one-off event is just cancelled (count 1).
   */
  public async cancelSeries(
    eventId: string,
    guildId?: string,
  ): Promise<{ event: IEvent; cancelled: number } | null> {
    const event = await this.getEvent(eventId);
    if (!event) return null;
    if (guildId && event.guildId !== guildId) return null;
    if (!isRecurring(event) || !event.seriesId) {
      const cancelled = await this.cancelOne(event);
      return {
        event: cancelled ? event : ((await this.getEvent(eventId)) ?? event),
        cancelled: cancelled ? 1 : 0,
      };
    }

    // Block spawning first, so an occurrence ending mid-cancel cannot
    // resurrect the series.
    await Event.updateMany(
      { guildId: event.guildId, seriesId: event.seriesId },
      { $set: { seriesCancelled: true } },
    );
    const open = await Event.find({
      guildId: event.guildId,
      seriesId: event.seriesId,
      state: { $in: ["scheduled", "active"] },
    });
    let cancelled = 0;
    for (const occurrence of open) {
      // Rows inserted after the bulk update above are still blocked.
      occurrence.seriesCancelled = true;
      if (await this.cancelOne(occurrence)) cancelled += 1;
    }
    logger.info(
      `Cancelled event series ${sanitizeForLog(event.seriesId)} (${cancelled} occurrence(s))`,
    );
    const fresh = (await this.getEvent(eventId)) ?? event;
    return { event: fresh, cancelled };
  }

  /**
   * Cancel an open event. Returns whether THIS call cancelled it; callers must
   * honour that (no success report, no counted cancellation, no successor when
   * it is false).
   *
   * The cancel is saved FIRST, by one atomic update that matches only while the
   * stored event is still open (`scheduled` or `active`, whichever it has
   * become since this copy was read: the scan turns `scheduled` into `active`
   * at the channel lead and that is still a cancel). An event that has ended
   * (or is being ended: the end claim comes first) matches nothing, so a cancel
   * decided on an older copy, or from an admin page opened earlier, neither
   * deletes the main channel nor turns `ended` into `cancelled`.
   */
  private async cancelOne(
    event: IEvent,
    nativeCache?: NativeCache | null,
    skipNative = false,
    refuseRunningAt?: Date,
  ): Promise<boolean> {
    // `new: false`: the document as it was AT the claim. The channel to delete
    // is read from it, not from the caller's copy, which may be older (a channel
    // recorded by Start now or the scan after that copy was read). The stored
    // `channelId` is kept: it is the only record of the channel until Discord
    // confirms it is gone, so a restart in between leaves it for the scan.
    // Like an end, a cancel takes a hold first (see the hold invariants): a scan
    // holding an older, open copy must not write after it.
    const id = String(event._id);
    const hold = this.beginEnding(id);
    try {
      return await this.cancelClaimed(
        event,
        hold,
        nativeCache,
        skipNative,
        refuseRunningAt,
      );
    } finally {
      this.finishEnding(id, hold);
    }
  }

  private async cancelClaimed(
    event: IEvent,
    hold: number,
    nativeCache?: NativeCache | null,
    skipNative = false,
    refuseRunningAt?: Date,
  ): Promise<boolean> {
    // A host's cancel (#1319) is refused inside the claim for an event that is
    // running at `refuseRunningAt` (see `isEventRunning`), so an activation
    // that lands after the caller's read cannot be cancelled by it.
    const claimed = (await Event.findOneAndUpdate(
      {
        _id: event._id,
        state: { $in: ["scheduled", "active"] },
        ...(refuseRunningAt
          ? {
              $nor: [{ state: "active", startTime: { $lte: refuseRunningAt } }],
            }
          : {}),
      },
      { $set: { state: "cancelled" } },
      { new: false },
    )) as { channelId?: string | null } | null | undefined;
    if (claimed === null) {
      this.abortEnding(String(event._id), hold);
      logger.info(
        `Event ${sanitizeForLog(String(event._id))} is no longer open; not cancelled`,
      );
      return false;
    }
    this.claimCompleted(String(event._id), hold);
    // A cancel runs no end hooks: put the nicknames back here (#1194). Not
    // awaited, and safe to repeat; whatever is left is finished by the sweep.
    this.kickTags(event, "restore");
    const channelId =
      claimed && claimed.channelId !== undefined
        ? claimed.channelId
        : event.channelId;
    event.state = "cancelled";
    event.channelId = channelId ?? null;
    // The claim wrote the state; the save below carries only the other fields
    // (a caller may have set `seriesCancelled`) and must not write it again.
    const doc = event as unknown as { $ignore?: (path: string) => void };
    doc.$ignore?.("state");
    doc.$ignore?.("channelId");
    if (channelId) {
      const guild = await this.client.guilds
        .fetch(event.guildId)
        .catch(() => null);
      if (guild) await this.releaseCancelledChannel(event, guild, channelId);
    }
    await event.save();
    // Group channels (#1190) are removed once the cancel is saved: the cleanup
    // only acts on an event it reads back as cancelled. Occupied ones, and any
    // failure, are retried by the scan.
    if (this.hasRecordedGroupChannels(event)) {
      const guild = await this.client.guilds
        .fetch(event.guildId)
        .catch(() => null);
      if (guild) {
        await this.logGroupReport(
          event,
          await this.groupChannels.cleanup(event, guild, new Date()),
        );
      }
    }
    // Re-read before refreshing the post: a concurrent announcement claim
    // may have stored its message ids after this document was loaded, and an
    // edit driven by the stale (null) ids would be skipped, leaving live RSVP
    // buttons on a cancelled event.
    const fresh = await Event.findById(event._id).catch(() => null);
    if (fresh) {
      event.announcementChannelId = fresh.announcementChannelId;
      event.announcementMessageId = fresh.announcementMessageId;
      this.ignoreClaimed(
        event,
        "announcementChannelId",
        "announcementMessageId",
      );
    }
    await this.updateAnnouncement(event);
    // When the scan's shared listing failed, skip (no per-event fetch). The
    // cancelled row keeps its native id or create marker, so the scan's
    // terminal-row query picks it up again on a later tick and closes it.
    if (!skipNative) {
      await this.nativeSync.syncEvent(event, null, nativeCache);
    }
    logger.info(`Cancelled event ${sanitizeForLog(String(event._id))}`);
    return true;
  }

  /** Event ids whose immediate post-room native sync already logged a failure. */
  private readonly nativeAfterRoomWarned = new Set<string>();

  /**
   * Best-effort native sync right after the main room was claimed outside the
   * scan (#1421). Never throws; a failure is logged once per event and the
   * next scan retries the sync as usual.
   */
  private async syncNativeAfterRoom(
    event: IEvent,
    guild: Guild,
  ): Promise<void> {
    const id = String(event._id);
    try {
      await this.nativeSync.syncEvent(event, guild);
      this.nativeAfterRoomWarned.delete(id);
    } catch (error) {
      if (this.nativeAfterRoomWarned.has(id)) return;
      this.nativeAfterRoomWarned.add(id);
      logger.warn(
        `Event ${sanitizeForLog(id)}: native sync after room creation failed (the scan retries):`,
        error,
      );
    }
  }

  /** Force the temp channel to spin up now, ahead of its scheduled lead. */
  public async startEventNow(
    eventId: string,
    guildId?: string,
  ): Promise<IEvent | null> {
    const event = await this.getEvent(eventId);
    if (!event) return null;
    if (guildId && event.guildId !== guildId) return null;
    if (event.state === "cancelled" || event.state === "ended") return null;

    if (!event.channelId) {
      const guild = await this.client.guilds
        .fetch(event.guildId)
        .catch(() => null);
      if (!guild) return null;
      const channel = await this.claimEventChannel(event, guild);
      this.ignoreClaimed(event, "channelId");
      if (channel) {
        // The claim wrote the channel id; the state step is conditional, so a
        // cancel that landed since the read is not undone (and Start now then
        // says it could not start).
        if (
          event.state === "scheduled" &&
          !(await this.activateScheduled(event))
        ) {
          return null;
        }
        // Link the native event to the new room now (#1421). An impromptu
        // event starts 30 s ahead, so waiting for the minute scan could pass
        // the start and miss the only window in which linking is allowed.
        await this.syncNativeAfterRoom(event, guild);
        if (event.groupsEnabled === true && !event.nativeAdopted) {
          // Not awaited: up to 25 paced creates must not hold the web request
          // open. The per-event lock keeps it from overlapping the scan, which
          // would also pick the groups up on its next tick.
          void this.groupChannels
            .reconcile(event, guild)
            .then((report) => this.logGroupReport(event, report))
            .catch((error) =>
              logger.error(
                `Event ${sanitizeForLog(String(event._id))}: group channels failed:`,
                error,
              ),
            );
        }
        await this.updateAnnouncement(event);
        logger.info(`Started event ${sanitizeForLog(String(event._id))} now`);
      } else if (!event.channelId) {
        // Channel creation genuinely failed (e.g. no category configured);
        // a lost race instead leaves event.channelId set to the winner's id.
        return null;
      }
    }
    return event;
  }

  /** Record a member's RSVP. Returns the updated event, or null when the
   * event is missing or already finished.
   *
   * RSVP clicks are the highest-concurrency write in the feature — one
   * announcement ping draws many button presses in the same tick, so a
   * fetch/modify/save of the whole `rsvps` array would let the last save
   * silently overwrite RSVPs recorded in between (lost update). Instead
   * the upsert runs server-side as a single atomic `findOneAndUpdate`
   * (the same lost-update defence as `claimEventChannel`'s
   * compare-and-set): the pipeline drops any previous entry for this
   * user and appends the new one in one document update, and the state
   * filter doubles as the finished/missing guard.
   *
   * @deprecated Legacy RSVP buttons (#1175). Only announcements posted before
   * native-only events still have them; new events use Discord's own
   * Interested. `messageId` pins the click to the event's current
   * announcement, so a button on any other message is refused. */
  public async setRsvp(
    eventId: string,
    userId: string,
    status: RsvpStatus,
    messageId: string,
  ): Promise<IEvent | null> {
    if (!isValidObjectId(eventId)) return null;
    return Event.findOneAndUpdate(
      {
        _id: eventId,
        state: { $nin: ["cancelled", "ended"] },
        announcementMessageId: messageId,
      },
      [
        {
          $set: {
            rsvps: {
              $concatArrays: [
                {
                  $filter: {
                    input: "$rsvps",
                    as: "rsvp",
                    cond: { $ne: ["$$rsvp.userId", userId] },
                  },
                },
                [{ userId, status, respondedAt: new Date() }],
              ],
            },
          },
        },
      ],
      // Mongoose 9 rejects an array update unless `updatePipeline` is set (#1103).
      { returnDocument: "after", updatePipeline: true },
    );
  }

  /**
   * Remove a member's RSVP from every event in the guild (#914).
   *
   * `setRsvp` cannot be reused for this. It filters on
   * `state: { $nin: ["cancelled", "ended"] }`, and a purge has to clear
   * RSVPs from ended and cancelled events too — which is most of a member's
   * RSVP history.
   *
   * The `$pull` runs server-side per event, for the same lost-update reason
   * `setRsvp`'s aggregation pipeline exists: a fetch/modify/save of the whole
   * `rsvps` array would silently drop RSVPs recorded in between.
   *
   * Only non-terminal events get their announcement re-rendered. Editing an
   * ended or cancelled event's post is churn nobody reads, and
   * `updateAnnouncement` already no-ops when the message is gone.
   *
   * Returns the events carrying the member's RSVP, how many were actually
   * cleared, and how many announcements could not be refreshed afterwards —
   * a shortfall in either is an unfinished erasure the caller reports rather
   * than loses (#916).
   */
  public async removeRsvp(
    guildId: string,
    userId: string,
  ): Promise<RsvpRemovalResult> {
    const matches = await Event.find({ guildId, "rsvps.userId": userId });
    if (matches.length === 0)
      return { matched: 0, removed: 0, rendersFailed: 0 };

    let removed = 0;
    let rendersFailed = 0;
    for (const match of matches) {
      // Per event, so one failure neither stops the others nor discards the
      // record of the RSVPs already pulled (#916). The count that comes back
      // is what actually happened, and the shortfall against `matched` is
      // what makes a partial removal visible in the purge report.
      try {
        // The announcement first, then the row (#916). `rsvps.userId` is the
        // only way this event can be found again, so pulling first and then
        // failing to refresh leaves the member listed on a public post that
        // nothing will ever select. Redrawing first can only show the
        // announcement without them slightly before the database agrees, and
        // the event stays selectable until it does.
        if (!isTerminalState(match.state)) {
          // Rendered from the document as it will be, not as it is: the
          // RSVP is dropped in memory only — nothing is saved — so the embed
          // shows the post-pull attendees.
          match.rsvps = match.rsvps.filter((rsvp) => rsvp.userId !== userId);
          if (!(await this.updateAnnouncement(match))) {
            rendersFailed++;
            logger.warn(
              `Announcement for event ${match._id} could not be refreshed; keeping the RSVP of ${sanitizeForLog(userId)} so a retry can still find it`,
            );
            continue;
          }
        }

        const updated = await Event.findByIdAndUpdate(
          match._id,
          { $pull: { rsvps: { userId } } },
          { returnDocument: "after" },
        );
        if (!updated) continue;
        removed++;
      } catch (error) {
        logger.error(
          `Failed to remove the RSVP of ${sanitizeForLog(userId)} from event ${match._id}:`,
          error,
        );
        // The update may have applied and only lost its acknowledgement, in
        // which case the row is clean, no retry will ever match this event on
        // `rsvps.userId` again, and the announcement would keep the member
        // listed for good. Re-read and, if the RSVP really is gone, refresh
        // from that document — still reporting the write as failed (#916).
        rendersFailed += (await this.refreshAfterFailedPull(match._id, userId))
          ? 0
          : 1;
      }
    }

    logger.info(
      `Removed RSVPs for user ${sanitizeForLog(userId)} from ${removed} of ${matches.length} event(s)` +
        (rendersFailed > 0
          ? `; ${rendersFailed} announcement(s) could not be refreshed`
          : ""),
    );
    return { matched: matches.length, removed, rendersFailed };
  }

  /**
   * After a `$pull` that threw: re-read the event and, if the RSVP is in fact
   * gone, redraw the announcement (#916).
   *
   * Returns whether the public post is known to be consistent with the
   * database — true when the RSVP is still there (the pull genuinely did not
   * apply, so the announcement is not stale and the write error alone is the
   * story) or when the refresh landed; false when the member may still be
   * listed. Never throws: this runs inside the caller's recovery path.
   */
  private async refreshAfterFailedPull(
    eventId: unknown,
    userId: string,
  ): Promise<boolean> {
    try {
      const current = await Event.findById(eventId);
      if (!current) return true; // The event itself is gone.
      if (current.rsvps.some((rsvp) => rsvp.userId === userId)) return true;
      if (isTerminalState(current.state)) return true;
      return await this.updateAnnouncement(current);
    } catch (error) {
      logger.error(
        `Could not check whether the announcement for event ${eventId} still lists ${sanitizeForLog(userId)}:`,
        error,
      );
      return false;
    }
  }

  // ---------------------------------------------------------------
  // Announcement rendering
  // ---------------------------------------------------------------

  /**
   * The announcement for an event (#1175): a plain message whose content holds
   * the native event's link, which Discord renders as an event card with its
   * own Interested button. Mentions are disabled so a title or description can
   * never ping anyone. Without a link (the native event could not be created,
   * or the event is finished) the message is the same text without the card.
   */
  public buildAnnouncementPayload(event: IEvent): {
    content: string;
    embeds: never[];
    components: never[];
    allowedMentions: { parse: never[] };
  } {
    const finished = isTerminalState(event.state);
    const lines: string[] = [
      event.state === "cancelled"
        ? `❌ **${event.title}** (cancelled)`
        : event.state === "ended"
          ? `📅 **${event.title}** (ended)`
          : `📅 **${event.title}**`,
      // An impromptu event says so while it is open (#1305); once finished it
      // reads like any other.
      event.impromptu === true && !finished
        ? "🔴 **Happening now**"
        : `🕒 ${formatEventWhenDiscord(event)}`,
    ];
    if (event.description) lines.push(event.description);
    if (isRecurring(event)) {
      lines.push(`🔁 Repeats ${recurrenceLabel(event.recurrence)}`);
    }
    if (event.channelId && !finished) {
      lines.push(`🔊 Voice channel: <#${event.channelId}>`);
    }
    if (event.nativeEventId && !finished) {
      lines.push(nativeEventUrl(event.guildId, event.nativeEventId));
    }
    return {
      content: lines.join("\n"),
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    };
  }

  /**
   * Build the old RSVP embed + button row.
   *
   * @deprecated Legacy (#1175): only used to keep rendering announcements
   * posted before native-only events, which still carry Going / Maybe / Can't
   * buttons. Synchronous so the button handler can refresh the message in a
   * single interaction update.
   */
  public buildLegacyRsvpPayload(event: IEvent): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const counts = countRsvps(event.rsvps);
    const finished = isTerminalState(event.state);

    const embed = new EmbedBuilder()
      .setColor(accentColor(event.state))
      .setTitle(
        event.state === "cancelled"
          ? `❌ ${event.title} (cancelled)`
          : `📅 ${event.title}`,
      )
      .addFields(
        { name: "When", value: formatEventWhenDiscord(event), inline: false },
        {
          name: "Going",
          value: String(counts.going),
          inline: true,
        },
        { name: "Maybe", value: String(counts.maybe), inline: true },
        { name: "Can't", value: String(counts.cant), inline: true },
      );

    if (event.description) {
      embed.setDescription(event.description);
    }
    if (isRecurring(event)) {
      embed.addFields({
        name: "Repeats",
        value: recurrenceLabel(event.recurrence),
        inline: false,
      });
    }
    embed.setFooter({ text: "KoolBot · Events" });
    if (event.channelId && !finished) {
      embed.addFields({
        name: "Voice channel",
        value: `<#${event.channelId}>`,
        inline: false,
      });
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`event_rsvp_${event._id}_going`)
        .setLabel("Going")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(finished),
      new ButtonBuilder()
        .setCustomId(`event_rsvp_${event._id}_maybe`)
        .setLabel("Maybe")
        .setEmoji("🤔")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(finished),
      new ButtonBuilder()
        .setCustomId(`event_rsvp_${event._id}_cant`)
        .setLabel("Can't")
        .setEmoji("🚫")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(finished),
    );

    return { embeds: [embed], components: [row] };
  }

  /** Delete a duplicate successor row, taking down any RSVP post the scan's
   * announcement retry already attached to it so nothing is orphaned. */
  private async discardDuplicate(event: IEvent): Promise<void> {
    const mine = await Event.findById(event._id).catch(() => null);
    if (mine?.announcementChannelId && mine.announcementMessageId) {
      await this.deleteAnnouncementPost(
        mine.guildId,
        mine.announcementChannelId,
        mine.announcementMessageId,
      );
    }
    // The duplicate may already mirror (or be mid-create of) a native event
    // (#1034). Close it by the terminal rules first. The sync is best-effort
    // (it does nothing when mirroring is off or the permission is missing, and
    // swallows REST failures), so success is read from the row afterwards: the
    // link and create marker are cleared only once the native event is closed,
    // already gone (10070), or a late event was dealt with.
    if (mine && (mine.nativeEventId || mine.nativeCreateStartedAt)) {
      mine.state = "cancelled"; // in memory only: selects the closing rules
      await this.nativeSync.syncEvent(mine, null);
      if (mine.nativeEventId || mine.nativeCreateStartedAt) {
        // Not confirmed. Do not delete the only record of the native event:
        // keep it as a cleanup record, taken out of the series so the spawn
        // path cannot adopt it and its unique occurrence key is freed. The
        // scan retries the close and deletes the row once it succeeds. While
        // mirroring is disabled it simply waits for it to be re-enabled.
        await Event.updateOne(
          { _id: event._id },
          {
            $set: {
              state: "cancelled",
              nativeCleanupOnly: true,
              seriesId: null,
              recurrence: "none",
              nextSpawned: true,
            },
          },
        );
        logger.warn(
          `Kept discarded duplicate ${sanitizeForLog(String(event._id))} as a cleanup record until its native event is closed`,
        );
        return;
      }
    }
    await Event.deleteOne({ _id: event._id });
  }

  /** Best-effort removal of an announcement post whose row is going away. */
  private async deleteAnnouncementPost(
    guildId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    try {
      const channel = await this.fetchTextChannel(guildId, channelId);
      const message = await channel?.messages.fetch(messageId);
      await message?.delete();
    } catch (error) {
      logger.warn(
        `Could not remove orphaned event announcement ${sanitizeForLog(messageId)}:`,
        error,
      );
    }
  }

  private async isSeriesCancelled(event: IEvent): Promise<boolean> {
    return !!(await Event.exists({
      guildId: event.guildId,
      seriesId: event.seriesId,
      seriesCancelled: true,
    }));
  }

  /** Post the RSVP message for a saved event that has none, when a channel is
   * configured (no channel is a deliberate no-op, not a failure to retry). */
  private async ensureAnnouncement(event: IEvent): Promise<void> {
    const channelId = await this.configService.getString(
      "events.announcement_channel_id",
      "",
    );
    if (!channelId) return;
    await this.postAnnouncement(event).catch((error) =>
      logger.error("Failed to post event announcement:", error),
    );
    // Stored by an atomic claim (or adopted from the winner's): not written back
    // by this copy's save.
    this.ignoreClaimed(event, "announcementChannelId", "announcementMessageId");
  }

  private async postAnnouncement(event: IEvent): Promise<void> {
    const channelId = await this.configService.getString(
      "events.announcement_channel_id",
      "",
    );
    if (!channelId) {
      logger.warn(
        "events.announcement_channel_id not set — skipping event announcement",
      );
      return;
    }
    const channel = await this.fetchTextChannel(event.guildId, channelId);
    if (!channel) return;

    // Same: the fetches above can outlast an end that began meanwhile.
    if (this.mustSkipScan(event)) return;
    const message = await channel.send(this.buildAnnouncementPayload(event));
    // Claim the message id atomically (as `claimEventChannel` does for the
    // channel): the creator and the scan's retry can both be sending at once,
    // and a plain save would leave the loser's post untracked and never
    // updated. The loser deletes its post and adopts the winner's ids.
    // Only an open, non-cancelled row may take the post: if a cancel landed
    // while the send was pending (it skipped the edit because the ids were
    // still null), the claim fails and the stale post is removed below.
    let claimed: IEvent | null;
    try {
      claimed = await Event.findOneAndUpdate(
        {
          _id: event._id,
          announcementMessageId: null,
          state: { $in: ["scheduled", "active"] },
          seriesCancelled: { $ne: true },
        },
        {
          $set: {
            announcementChannelId: channelId,
            announcementMessageId: message.id,
          },
        },
      );
    } catch (error) {
      // The write may or may not have applied. Reconcile against the stored
      // id before touching the post: keep it if it is ours, drop it if the
      // row has none (the scan reposts), and leave it alone when the outcome
      // cannot be determined, rather than orphan or double-post.
      logger.error("Failed to claim event announcement:", error);
      const stored = await Event.findById(event._id).catch(() => undefined);
      if (stored === undefined) return;
      if (stored?.announcementMessageId === message.id) {
        event.announcementChannelId = channelId;
        event.announcementMessageId = message.id;
        return;
      }
      // Either the row has no id (the scan reposts) or another sender won:
      // our post is the untracked one. Drop it and adopt the winner's ids.
      await message.delete().catch(() => undefined);
      if (stored?.announcementMessageId) {
        event.announcementChannelId =
          stored.announcementChannelId ?? event.announcementChannelId;
        event.announcementMessageId = stored.announcementMessageId;
      }
      return;
    }
    if (!claimed) {
      await message.delete().catch(() => undefined);
      const fresh = await Event.findById(event._id).catch(() => null);
      event.announcementChannelId =
        fresh?.announcementChannelId ?? event.announcementChannelId;
      event.announcementMessageId =
        fresh?.announcementMessageId ?? event.announcementMessageId;
      return;
    }
    event.announcementChannelId = channelId;
    event.announcementMessageId = message.id;
  }

  /**
   * Refresh an event's announcement message.
   *
   * Returns whether the post now reflects the event — which is not the same
   * as "no exception escaped" (#916). A purge re-renders to take the
   * member's RSVP off a message anyone in the guild can read, so an
   * unreachable channel or a failed edit leaves their answer publicly
   * visible and has to be reported, not swallowed. Nothing to refresh counts
   * as success — no announcement configured, the message already gone
   * (`10008`), or the whole channel deleted (`10003`) — because in each case
   * there is no stale post left to fix.
   */
  private async updateAnnouncement(event: IEvent): Promise<boolean> {
    if (!event.announcementChannelId || !event.announcementMessageId) {
      return true;
    }
    const { channel, gone } = await this.fetchTextChannelDetailed(
      event.guildId,
      event.announcementChannelId,
    );
    // A deleted channel took the announcement with it, so there is no stale
    // post left to fix; anything else leaves one standing.
    if (!channel) return gone;
    try {
      const message = await channel.messages.fetch(event.announcementMessageId);
      // A post that still carries buttons predates native-only events and
      // keeps its RSVP embed; anything else gets the link announcement.
      const legacy = message.components.length > 0;
      // The fetches above are awaits: an open copy must not write the post once
      // an end began meanwhile (it would show a finished event as running).
      // Nothing is awaited between this check and the edit request.
      if (
        (event.state === "scheduled" || event.state === "active") &&
        this.isBeingEnded(String(event._id))
      ) {
        // Skipped, which is NOT a refresh: the post was not changed, so callers
        // that must know it is current (a member's RSVP removal keeps the RSVP
        // for a retry) see a failure, and the link refresh tries again.
        return false;
      }
      await message.edit(
        legacy
          ? this.buildLegacyRsvpPayload(event)
          : this.buildAnnouncementPayload(event),
      );
      return true;
    } catch (error) {
      // The message, or the channel holding it, can go between the fetch
      // above and this edit. Either way there is no stale announcement left
      // to fix, so the refresh is complete rather than failed (#916) — the
      // same call the channel-fetch path above makes for `gone`.
      if (
        this.isDiscardableError(error, DISCORD_UNKNOWN_MESSAGE) ||
        this.isDiscardableError(error, DISCORD_UNKNOWN_CHANNEL)
      ) {
        logger.warn(
          `Event announcement message ${sanitizeForLog(event.announcementMessageId)} gone; skipping edit`,
        );
        return true;
      }
      logger.error("Failed to update event announcement:", error);
      return false;
    }
  }

  /** False only when the reminder was skipped because an end or cancel holds the event. */
  private async postReminder(event: IEvent): Promise<boolean> {
    if (!event.announcementChannelId) return true;
    const channel = await this.fetchTextChannel(
      event.guildId,
      event.announcementChannelId,
    );
    if (!channel) return true;

    const interested = event.rsvps
      .filter((r) => r.status === "going" || r.status === "maybe")
      .map((r) => r.userId);
    // Cap the ping list so the message body can't blow Discord's 2000-char
    // limit (each `<@id>` is ~22 chars) and so the mention text matches the
    // ids we actually allow to ping. Any overflow is summarised, not listed.
    const pinged = interested.slice(0, MAX_REMINDER_MENTIONS);
    const overflow = interested.length - pinged.length;
    const mentions =
      pinged.length > 0
        ? pinged.map((id) => `<@${id}>`).join(" ") +
          (overflow > 0 ? ` …and ${overflow} more` : "")
        : "";
    const where = event.channelId ? ` Join here: <#${event.channelId}>.` : "";
    const link = event.nativeEventId
      ? `\n${nativeEventUrl(event.guildId, event.nativeEventId)}`
      : "";

    // New events have no KoolBot RSVPs and no start-time ping (#1175): Discord
    // notifies whoever marked Interested. Legacy RSVPs (events created before
    // native-only events) are still pinged, as shipped in 2.0.0.
    const content =
      `⏰ **${event.title}** starts at ${formatEventWhenDiscord(event)}.${where}${link}` +
      (mentions ? `\n${mentions}` : "");

    // The channel fetch above is an await: an older, still-open copy sends no
    // start reminder (legacy pings, old links) once an end has begun.
    if (this.mustSkipScan(event)) return false;
    await channel.send({
      content,
      allowedMentions: { users: pinged },
    });
    return true;
  }

  // ---------------------------------------------------------------
  // Channel plumbing
  // ---------------------------------------------------------------

  /**
   * Create the temp channel and atomically claim it on the event row.
   *
   * Both the cron scan (`processEvent`) and the manual "start now" path
   * (`startEventNow`) can decide to create a channel for the same event at
   * the same moment. Without a claim they each gate on their own in-memory
   * copy of `channelId` and both call `guild.channels.create()`, producing
   * two channels while the row can only reference one — the loser's channel
   * is orphaned forever (see #730).
   *
   * The `findOneAndUpdate` with a `channelId: null` filter is an atomic
   * compare-and-set: only the first caller to land its write matches the
   * document and wins the claim (this also holds across multiple
   * processes/replicas). A caller that loses the race deletes the redundant
   * channel it just created and adopts the winner's `channelId`, so no
   * orphan is left behind. If the claim write itself throws (transient
   * DB/connectivity error) after the channel was created, the channel is
   * likewise torn down so the failure can't leak one either.
   *
   * Returns the channel when THIS call won the claim, otherwise `null`. On a
   * lost race `event.channelId` is refreshed to the winner's id; on an
   * outright creation failure or a failed claim it stays `null`, so callers
   * can tell the two apart.
   */
  private async claimEventChannel(
    event: IEvent,
    guild: Guild,
    options: { enforceLead?: boolean } = {},
  ): Promise<VoiceChannel | null> {
    const channel = await this.createEventChannel(event, guild);
    if (!channel) return null;

    let claimed: IEvent | null;
    try {
      claimed = await Event.findOneAndUpdate(
        {
          _id: event._id,
          channelId: null,
          // A cancel that landed while the channel was being created must
          // win: the claim then fails and the unclaimed channel is removed.
          state: { $in: ["scheduled", "active"] },
          seriesCancelled: { $ne: true },
          // The scan decided to create from the lead time on its copy. A host
          // who changed it while the channel was being created (live edit,
          // #1239: it is conditional on "no channel yet", which this creation
          // is not yet) must win: the claim then fails and the channel is
          // removed, and the next scan decides again from the new lead. Not
          // asked of "Start now", which creates whatever the lead says.
          // The same goes for the start time (#1298): an edit that moved it
          // while the channel was being created wins, and the next scan decides
          // again from the new start.
          ...(options.enforceLead
            ? {
                channelLeadMinutes: event.channelLeadMinutes ?? null,
                startTime: event.startTime,
              }
            : {}),
          // The channel was named from this title. An edit that renamed the
          // event while it was being created wins: the claim fails and the
          // wrongly named channel is removed (a started event's title is
          // locked, so it could never be fixed afterwards). Not for an adopted
          // event, whose title is copied onto the in-memory row by the scan
          // before it is saved.
          ...(event.nativeAdopted === true ? {} : { title: event.title }),
        },
        { $set: { channelId: channel.id } },
      );
    } catch (error) {
      // The claim write failed after the channel was already created — tear
      // it down so we don't leak an unreferenced channel, and let the next
      // scan retry cleanly (channelId is still null in the row).
      logger.error(
        `Failed to claim event channel for event ${sanitizeForLog(String(event._id))}; removing unclaimed channel:`,
        error,
      );
      await this.deleteEventChannel(
        guild,
        channel.id,
        "Event channel claim failed",
      );
      return null;
    }

    if (!claimed) {
      // Another path claimed the channel first — tear ours down and adopt
      // the winner's id so we don't leak a channel.
      logger.warn(
        `Lost event-channel creation race for event ${sanitizeForLog(String(event._id))}; removing redundant channel`,
      );
      await this.deleteEventChannel(
        guild,
        channel.id,
        "Redundant event channel (creation race)",
      );
      const fresh = await Event.findById(event._id).catch(() => null);
      event.channelId = fresh?.channelId ?? event.channelId;
      return null;
    }

    event.channelId = channel.id;
    return channel;
  }

  /** The category an event's channels live in, or null (logged). */
  private async resolveEventCategory(
    event: IEvent,
    guild: Guild,
  ): Promise<CategoryChannel | null> {
    const categoryId =
      event.categoryId ||
      (await this.configService.getString("events.category_id", ""));
    if (!categoryId) {
      logger.warn(
        `events.category_id not set — cannot create channel for event ${sanitizeForLog(String(event._id))}`,
      );
      return null;
    }
    const category = guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      logger.error(
        `Event category ${sanitizeForLog(categoryId)} not found or not a category`,
      );
      return null;
    }
    return category as CategoryChannel;
  }

  /** Whether the group channels of this open event need a pass: a group has no
   * channel yet, or a recorded one is not in the cache. False for a plain
   * event, an adopted one, one without its main channel, or one past its end. */
  private needsGroupReconcile(event: IEvent, guild: Guild, now: Date): boolean {
    if (event.groupsEnabled !== true || event.nativeAdopted) return false;
    if (!event.channelId) return false;
    if (event.state !== "scheduled" && event.state !== "active") return false;
    if (shouldEndEvent(event, now)) return false;
    return (
      (event.groups ?? []).some(
        (group) =>
          !group.channelId || !guild.channels.cache.has(group.channelId),
      ) ||
      // Cache only: out-of-place group channels (#1214) start a pass that reads
      // Discord fresh before it writes anything.
      this.groupChannels.orderLooksWrong(event, guild)
    );
  }

  private hasRecordedGroupChannels(event: IEvent): boolean {
    return (
      event.groupsEnabled === true &&
      (event.groups ?? []).some((group) => !!group.channelId)
    );
  }

  private async logGroupReport(
    event: IEvent,
    report: GroupChannelReport,
  ): Promise<void> {
    const id = String(event._id);
    if (report.failures.length === 0) {
      this.groupFailuresLogged.delete(id);
      return;
    }
    // A standing problem (a full category, a missing permission) is logged
    // when it first appears or changes, not on every scan.
    const signature = report.failures
      .map((f) => `${f.key}:${f.reason}`)
      .join("|");
    if (this.groupFailuresLogged.get(id) === signature) return;
    this.groupFailuresLogged.set(id, signature);
    logger.warn(
      `Event ${sanitizeForLog(String(event._id))}: ${report.failures.length} group channel(s) not applied: ` +
        report.failures
          .map((f) => `${sanitizeForLog(f.name)} (${sanitizeForLog(f.reason)})`)
          .join("; "),
    );
  }

  private async createEventChannel(
    event: IEvent,
    guild: Guild,
  ): Promise<VoiceChannel | null> {
    const category = await this.resolveEventCategory(event, guild);
    if (!category) return null;

    const prefix = await this.configService.getString(
      "events.channel_prefix",
      "📅",
    );
    const rawName = `${prefix} ${event.title}`.trim();
    const name = rawName.slice(0, 100);

    try {
      // A group event's host (#1190) also gets access to the main channel. A
      // plain event keeps the exact call it always had.
      const notices: string[] = [];
      const overwrites =
        event.groupsEnabled === true
          ? this.groupChannels.hostOverwritesFor(
              event,
              guild,
              category,
              notices,
            )
          : null;
      let channel: VoiceChannel;
      try {
        channel = await guild.channels.create({
          name,
          type: ChannelType.GuildVoice,
          parent: category,
          ...(overwrites ? { permissionOverwrites: overwrites } : {}),
        });
      } catch (error) {
        // Discord refusing the host's overwrites must not cost the event its
        // channel: retry as a plain channel, which inherits the category.
        if (
          !overwrites ||
          !(error instanceof DiscordAPIError) ||
          error.code !== 50013
        ) {
          throw error;
        }
        logger.warn(
          `Discord refused the host's access on the main channel of event ${sanitizeForLog(String(event._id))}; creating it without`,
        );
        notices.push(
          "Discord refused the host's access on the main voice channel, so it was created without it.",
        );
        channel = await guild.channels.create({
          name,
          type: ChannelType.GuildVoice,
          parent: category,
        });
      }
      // Kept for the host panel; a later group pass cannot replace them.
      for (const notice of notices) this.groupChannels.addNotice(event, notice);
      logger.info(
        `Created event channel ${sanitizeForLog(name)} for event ${sanitizeForLog(String(event._id))}`,
      );
      return channel;
    } catch (error) {
      logger.error("Error creating event channel:", error);
      return null;
    }
  }

  /**
   * Delete a cancelled event's main channel and, only once Discord confirmed it
   * is gone (deleted, or 10003), clear the stored reference (conditional on it
   * still being that id). Any other failure keeps the id, so the scan retries.
   * Cancel deletes at once, with no grace period.
   */
  private async releaseCancelledChannel(
    event: IEvent,
    guild: Guild,
    channelId: string,
  ): Promise<void> {
    if (!(await this.deleteChannelConfirmed(guild, channelId))) return;
    try {
      await Event.updateOne(
        { _id: event._id, channelId },
        { $set: { channelId: null } },
      );
    } catch (error) {
      logger.error("Could not clear a cancelled event's channel id:", error);
      return;
    }
    event.channelId = null;
    (event as unknown as { $ignore?: (p: string) => void }).$ignore?.(
      "channelId",
    );
  }

  /** True when the channel was deleted or Discord says it does not exist. */
  private async deleteChannelConfirmed(
    guild: Guild,
    channelId: string,
    reason = "Event cancelled",
  ): Promise<boolean> {
    try {
      const channel =
        guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId));
      if (channel) await channel.delete(reason);
      return true;
    } catch (error) {
      if (this.isDiscardableError(error, DISCORD_UNKNOWN_CHANNEL)) return true;
      logger.error("Error deleting event channel:", error);
      return false;
    }
  }

  private async deleteEventChannel(
    guild: Guild,
    channelId: string,
    reason = "Event ended",
  ): Promise<void> {
    try {
      const channel =
        guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId).catch(() => null));
      if (channel) await channel.delete(reason);
    } catch (error) {
      if (this.isDiscardableError(error, DISCORD_UNKNOWN_CHANNEL)) return;
      logger.error("Error deleting event channel:", error);
    }
  }

  private async isChannelEmpty(
    guild: Guild,
    channelId: string,
  ): Promise<boolean> {
    const channel =
      guild.channels.cache.get(channelId) ??
      (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      // Gone already — treat as empty so the sweep clears the stale id.
      return true;
    }
    return (channel as VoiceChannel).members.size === 0;
  }

  private async fetchTextChannel(
    guildId: string,
    channelId: string,
  ): Promise<TextChannel | null> {
    return (await this.fetchTextChannelDetailed(guildId, channelId)).channel;
  }

  /**
   * As `fetchTextChannel`, but says *why* there is no channel.
   *
   * A purge has to tell "the channel is gone, so the announcement — and the
   * member's RSVP on it — is gone with it" apart from "we could not reach
   * the channel this time", because the first owes nothing and the second is
   * an unfinished erasure (#916).
   */
  private async fetchTextChannelDetailed(
    guildId: string,
    channelId: string,
  ): Promise<{ channel: TextChannel | null; gone: boolean }> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId);
      if (channel instanceof TextChannel) return { channel, gone: false };
      logger.warn(
        `Event channel ${sanitizeForLog(channelId)} is not a text channel`,
      );
      return { channel: null, gone: false };
    } catch (error) {
      if (this.isDiscardableError(error, DISCORD_UNKNOWN_CHANNEL)) {
        return { channel: null, gone: true };
      }
      logger.error("Failed to fetch event text channel:", error);
      return { channel: null, gone: false };
    }
  }

  private isDiscardableError(error: unknown, code: number): boolean {
    return error instanceof DiscordAPIError && error.code === code;
  }

  private async logLifecycle(event: IEvent): Promise<void> {
    try {
      const discordLogger = DiscordLogger.getInstance(this.client);
      if (!discordLogger.isReady()) return;
      await discordLogger.logCronSuccess(
        "Events",
        `${event.title}: ${event.state}`,
      );
    } catch (error) {
      logger.error("Events: failed to post lifecycle log:", error);
    }
  }
}
