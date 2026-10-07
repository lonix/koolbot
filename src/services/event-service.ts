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
import { parseZonedDateTime, resolveTimezone } from "../utils/timezone.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * Events feature (#708): scheduled gatherings backed by a *temporary*
 * voice channel.
 *
 * Unlike the lobby-driven dynamic channels in `VoiceChannelManager`, an
 * event's channel lifecycle is bound to its schedule: the channel is
 * created shortly before the start time and removed once the event ends
 * and empties past a grace period. A member RSVPs via Going / Maybe /
 * Can't buttons on an announcement message that shows a live attendee
 * count.
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
const COLOR_SCHEDULED = 0x5865f2; // blurple
const COLOR_ACTIVE = 0x57f287; // green
const COLOR_ENDED = 0x99aab5; // grey
const COLOR_CANCELLED = 0xed4245; // red

/**
 * `ended` and `cancelled` are terminal: the event is over either way, so
 * nothing that happens afterwards can change what its announcement should
 * say.
 */
function isTerminalState(state: EventState): boolean {
  return state === "ended" || state === "cancelled";
}

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
  createdBy: string;
}

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

/** Tally RSVPs by response. */
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
}

/** Whether the temp channel should be created on this tick. */
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
  return nowMs >= start - leadMs && nowMs < end;
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
  const end = computeEndTime(event.startTime, event.durationMinutes).getTime();
  return now.getTime() >= end + graceMs;
}

/** Human-readable start line, e.g. `2026-07-04 20:00 (Europe/London)`. */
export function formatEventWhen(event: {
  startTime: Date;
  timezone: string;
}): string {
  const zone = resolveTimezone(event.timezone);
  return `${formatInTimeZone(event.startTime, zone, "yyyy-MM-dd HH:mm")} (${zone})`;
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

function accentColor(state: IEvent["state"]): number {
  switch (state) {
    case "active":
      return COLOR_ACTIVE;
    case "ended":
      return COLOR_ENDED;
    case "cancelled":
      return COLOR_CANCELLED;
    default:
      return COLOR_SCHEDULED;
  }
}

export class EventService extends ScheduledService {
  private static instance: EventService;

  private constructor(client: Client) {
    super(client, {
      label: "Event service",
      disabledMessage: "Events are disabled",
      cronContext: "events",
      runLabel: "Event scan",
    });
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

    const reminderMs =
      (await this.configService.getNumber("events.reminder_minutes", 30)) *
      MS_PER_MINUTE;
    const leadMs =
      (await this.configService.getNumber("events.create_lead_minutes", 15)) *
      MS_PER_MINUTE;
    const graceMs =
      (await this.configService.getNumber("events.channel_grace_minutes", 15)) *
      MS_PER_MINUTE;

    for (const event of events) {
      try {
        await this.processEvent(event, guild, new Date(), {
          reminderMs,
          leadMs,
          graceMs,
        });
      } catch (error) {
        logger.error(
          `Error processing event ${sanitizeForLog(String(event._id))}:`,
          error,
        );
      }
    }
  }

  private async processEvent(
    event: IEvent,
    guild: Guild,
    now: Date,
    windows: { reminderMs: number; leadMs: number; graceMs: number },
  ): Promise<void> {
    let changed = false;

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
      await this.cancelOne(event);
      return;
    }

    // A recurring occurrence whose RSVP post failed (or was never made) is
    // retried here, since nothing else would ever repair it.
    if (
      isRecurring(event) &&
      !event.announcementMessageId &&
      (event.state === "scheduled" || event.state === "active")
    ) {
      await this.ensureAnnouncement(event);
    }

    // 1. Reminder (before start, once).
    if (shouldSendReminder(event, now, windows.reminderMs)) {
      await this.postReminder(event);
      event.reminderSent = true;
      changed = true;
    }

    // 2. Create the temp channel shortly before start.
    if (shouldCreateChannel(event, now, windows.leadMs)) {
      const channel = await this.claimEventChannel(event, guild);
      if (channel) {
        if (event.state === "scheduled") event.state = "active";
        changed = true;
        await this.updateAnnouncement(event);
      }
    }

    // 3. Mark ended once past the end time.
    if (shouldEndEvent(event, now)) {
      event.state = "ended";
      changed = true;
      await this.updateAnnouncement(event);
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

      const anchor = previous.seriesStart ?? previous.startTime;
      let index = previous.occurrenceIndex + 1;
      let start = computeOccurrenceStart(
        anchor,
        previous.recurrence,
        index,
        previous.timezone,
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
          previous.timezone,
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
      let next: IEvent | null = await Event.findOne(key);
      let created = false;
      if (!next) {
        const doc = new Event({
          guildId: previous.guildId,
          title: previous.title,
          description: previous.description,
          startTime: start,
          timezone: previous.timezone,
          durationMinutes: previous.durationMinutes,
          categoryId: previous.categoryId,
          state: "scheduled",
          reminderSent: false,
          rsvps: [],
          recurrence: previous.recurrence,
          seriesId,
          occurrenceIndex: index,
          seriesStart: anchor,
          spawnedFrom: String(previous._id),
          nextSpawned: false,
          seriesCancelled: false,
          createdBy: previous.createdBy,
        });
        try {
          await doc.save();
          next = doc;
          created = true;
        } catch (error) {
          // Lost the insert race to another caller: adopt their row.
          if ((error as { code?: number }).code !== 11000) throw error;
          next = await Event.findOne(key);
        }
      }
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
      reminderSent: false,
      rsvps: [],
      recurrence,
      createdBy: input.createdBy,
    });
    if (recurrence !== "none") {
      // The first occurrence's id doubles as the series id.
      event.seriesId = String(event._id);
      event.occurrenceIndex = 0;
      event.seriesStart = input.startTime;
    }
    await event.save();
    await this.postAnnouncement(event).catch((error) =>
      logger.error("Failed to post event announcement:", error),
    );
    logger.info(`Created event ${sanitizeForLog(String(event._id))}`);
    return event;
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
  ): Promise<IEvent | null> {
    const event = await this.getEvent(eventId);
    if (!event) return null;
    if (guildId && event.guildId !== guildId) return null;
    if (event.state === "cancelled") return event;

    await this.cancelOne(event);
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
      const wasLive = event.state !== "cancelled";
      await this.cancelOne(event);
      return { event, cancelled: wasLive ? 1 : 0 };
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
      await this.cancelOne(occurrence);
      cancelled += 1;
    }
    logger.info(
      `Cancelled event series ${sanitizeForLog(event.seriesId)} (${cancelled} occurrence(s))`,
    );
    const fresh = (await this.getEvent(eventId)) ?? event;
    return { event: fresh, cancelled };
  }

  private async cancelOne(event: IEvent): Promise<void> {
    if (event.channelId) {
      const guild = await this.client.guilds
        .fetch(event.guildId)
        .catch(() => null);
      if (guild) await this.deleteEventChannel(guild, event.channelId);
      event.channelId = null;
    }
    event.state = "cancelled";
    await event.save();
    // Re-read before refreshing the post: a concurrent announcement claim
    // may have stored its message ids after this document was loaded, and an
    // edit driven by the stale (null) ids would be skipped, leaving live RSVP
    // buttons on a cancelled event.
    const fresh = await Event.findById(event._id).catch(() => null);
    if (fresh) {
      event.announcementChannelId = fresh.announcementChannelId;
      event.announcementMessageId = fresh.announcementMessageId;
    }
    await this.updateAnnouncement(event);
    logger.info(`Cancelled event ${sanitizeForLog(String(event._id))}`);
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
      if (channel) {
        event.state = "active";
        await event.save();
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
   * filter doubles as the finished/missing guard. */
  public async setRsvp(
    eventId: string,
    userId: string,
    status: RsvpStatus,
  ): Promise<IEvent | null> {
    if (!isValidObjectId(eventId)) return null;
    return Event.findOneAndUpdate(
      { _id: eventId, state: { $nin: ["cancelled", "ended"] } },
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
      { new: true },
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
          { new: true },
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

  /** Build the RSVP embed + button row for an event. Synchronous so the
   * button handler can refresh the message in a single interaction update. */
  public buildAnnouncementPayload(event: IEvent): {
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
        { name: "When", value: formatEventWhen(event), inline: false },
        {
          name: "✅ Going",
          value: String(counts.going),
          inline: true,
        },
        { name: "🤔 Maybe", value: String(counts.maybe), inline: true },
        { name: "🚫 Can't", value: String(counts.cant), inline: true },
      );

    if (event.description) {
      embed.setDescription(event.description);
    }
    if (isRecurring(event)) {
      embed.setFooter({
        text: `🔁 Repeats ${recurrenceLabel(event.recurrence)}`,
      });
    }
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
        .setStyle(ButtonStyle.Success)
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
        .setStyle(ButtonStyle.Danger)
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
      await message.edit(this.buildAnnouncementPayload(event));
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

  private async postReminder(event: IEvent): Promise<void> {
    if (!event.announcementChannelId) return;
    const channel = await this.fetchTextChannel(
      event.guildId,
      event.announcementChannelId,
    );
    if (!channel) return;

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

    const content =
      `⏰ **${event.title}** starts at ${formatEventWhen(event)}.${where}` +
      (mentions ? `\n${mentions}` : "");

    await channel.send({
      content,
      allowedMentions: { users: pinged },
    });
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
  ): Promise<VoiceChannel | null> {
    const channel = await this.createEventChannel(event, guild);
    if (!channel) return null;

    let claimed: IEvent | null;
    try {
      claimed = await Event.findOneAndUpdate(
        { _id: event._id, channelId: null },
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

  private async createEventChannel(
    event: IEvent,
    guild: Guild,
  ): Promise<VoiceChannel | null> {
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

    const prefix = await this.configService.getString(
      "events.channel_prefix",
      "📅",
    );
    const rawName = `${prefix} ${event.title}`.trim();
    const name = rawName.slice(0, 100);

    try {
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: category as CategoryChannel,
      });
      logger.info(
        `Created event channel ${sanitizeForLog(name)} for event ${sanitizeForLog(String(event._id))}`,
      );
      return channel;
    } catch (error) {
      logger.error("Error creating event channel:", error);
      return null;
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
