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
import { formatInTimeZone } from "date-fns-tz";
import { ScheduledService } from "./scheduled-service.js";
import { DiscordLogger } from "./discord-logger.js";
import {
  Event,
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

export interface CreateEventInput {
  guildId: string;
  title: string;
  description: string;
  startTime: Date;
  timezone: string;
  durationMinutes: number;
  categoryId?: string;
  createdBy: string;
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
  }

  // ---------------------------------------------------------------
  // Public API (command + web + button handler)
  // ---------------------------------------------------------------

  public async createEvent(input: CreateEventInput): Promise<IEvent> {
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
      createdBy: input.createdBy,
    });
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

  /** Cancel an event: mark cancelled and tear down any live channel. */
  public async cancelEvent(
    eventId: string,
    guildId?: string,
  ): Promise<IEvent | null> {
    const event = await this.getEvent(eventId);
    if (!event) return null;
    if (guildId && event.guildId !== guildId) return null;
    if (event.state === "cancelled") return event;

    if (event.channelId) {
      const guild = await this.client.guilds
        .fetch(event.guildId)
        .catch(() => null);
      if (guild) await this.deleteEventChannel(guild, event.channelId);
      event.channelId = null;
    }
    event.state = "cancelled";
    await event.save();
    await this.updateAnnouncement(event);
    logger.info(`Cancelled event ${sanitizeForLog(String(event._id))}`);
    return event;
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
    event.announcementChannelId = channelId;
    event.announcementMessageId = message.id;
    await event.save();
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
