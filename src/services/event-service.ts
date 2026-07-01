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
import { CronJob, CronTime } from "cron";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { ConfigService } from "./config-service.js";
import { DiscordLogger } from "./discord-logger.js";
import { Event, type IEvent, type RsvpStatus } from "../models/event.js";
import { resolveTimezone } from "../utils/timezone.js";
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
const DISCORD_UNKNOWN_MESSAGE = 10008;
const DISCORD_UNKNOWN_CHANNEL = 10003;

// Embed accent colours for the announcement message by lifecycle state.
const COLOR_SCHEDULED = 0x5865f2; // blurple
const COLOR_ACTIVE = 0x57f287; // green
const COLOR_ENDED = 0x99aab5; // grey
const COLOR_CANCELLED = 0xed4245; // red

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
 * absolute UTC instant. Returns null on any malformed or impossible input
 * (e.g. `2026-02-30`), verified by round-tripping the instant back through
 * the same zone — `fromZonedTime` otherwise silently rolls invalid dates
 * over.
 */
export function parseEventDateTime(
  dateStr: string,
  timeStr: string,
  tz: string,
): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return null;
  const zone = resolveTimezone(tz);
  try {
    const utc = fromZonedTime(`${dateStr}T${timeStr}:00`, zone);
    if (Number.isNaN(utc.getTime())) return null;
    const roundTrip = formatInTimeZone(utc, zone, "yyyy-MM-dd'T'HH:mm");
    if (roundTrip !== `${dateStr}T${timeStr}`) return null;
    return utc;
  } catch {
    return null;
  }
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

/**
 * Set a member's RSVP, replacing any previous response. Pure — returns a
 * new array and never mutates the input.
 */
export function upsertRsvp<
  T extends { userId: string; status: RsvpStatus; respondedAt: Date },
>(
  rsvps: T[],
  userId: string,
  status: RsvpStatus,
  now: Date,
): Array<{ userId: string; status: RsvpStatus; respondedAt: Date }> {
  const others = rsvps.filter((r) => r.userId !== userId);
  return [...others, { userId, status, respondedAt: now }];
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

export class EventService {
  private static instance: EventService;
  private client: Client;
  private configService: ConfigService;
  private job: CronJob | null = null;
  private isInitialized = false;
  private isRunning = false;
  private inFlight: Promise<void> | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    this.configService.registerReloadCallback(async () => {
      try {
        logger.info("Events configuration changed, reloading...");
        const enabled = await this.configService.getBoolean(
          "events.enabled",
          false,
        );
        if (!enabled && this.isInitialized) {
          logger.info("Events disabled, stopping scan job...");
          this.destroy();
        } else if (enabled) {
          await this.reload();
        }
      } catch (error) {
        logger.error(
          "Error reloading event service after configuration change:",
          error,
        );
      }
    });
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
  // Cron lifecycle
  // ---------------------------------------------------------------

  public async start(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Event service is already initialized, skipping...");
      return;
    }
    try {
      const enabled = await this.configService.getBoolean(
        "events.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Events are disabled");
        this.isInitialized = true;
        return;
      }

      if (!this.validateCronExpression(TICK_CRON)) {
        logger.error("Event service not started: invalid tick cron");
        this.isInitialized = true;
        return;
      }

      this.job = new CronJob(TICK_CRON, async () => {
        try {
          await this.runNow();
        } catch (error) {
          logger.error("Error running event scan:", error);
        }
      });
      this.job.start();
      logger.info(`Event service started (scan cron: "${TICK_CRON}")`);
      this.isInitialized = true;
    } catch (error) {
      logger.error("Error starting event service:", error);
      throw error;
    }
  }

  public async reload(): Promise<void> {
    logger.info("Reloading event service...");
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.isInitialized = false;
    await this.start();
  }

  public destroy(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.isInitialized = false;
    logger.info("Event service destroyed");
  }

  private validateCronExpression(expression: string): boolean {
    try {
      new CronTime(expression);
      return true;
    } catch (error) {
      logger.error(`Invalid cron expression for events: ${expression}`, error);
      return false;
    }
  }

  // ---------------------------------------------------------------
  // Scan
  // ---------------------------------------------------------------

  /** Run the lifecycle scan immediately. Concurrent calls coalesce. */
  public async runNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runOnce(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Event scan already in progress, skipping");
      return;
    }
    this.isRunning = true;
    try {
      const enabled = await this.configService.getBoolean(
        "events.enabled",
        false,
      );
      if (!enabled) return;

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
        (await this.configService.getNumber(
          "events.channel_grace_minutes",
          15,
        )) * MS_PER_MINUTE;

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
    } finally {
      this.isRunning = false;
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
      const channel = await this.createEventChannel(event, guild);
      if (channel) {
        event.channelId = channel.id;
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
      const channel = await this.createEventChannel(event, guild);
      if (!channel) return null;
      event.channelId = channel.id;
      event.state = "active";
      await event.save();
      await this.updateAnnouncement(event);
      logger.info(`Started event ${sanitizeForLog(String(event._id))} now`);
    }
    return event;
  }

  /** Record a member's RSVP. Returns the updated event, or null when the
   * event is missing or already finished. */
  public async setRsvp(
    eventId: string,
    userId: string,
    status: RsvpStatus,
  ): Promise<IEvent | null> {
    const event = await this.getEvent(eventId);
    if (!event) return null;
    if (event.state === "cancelled" || event.state === "ended") return null;
    event.rsvps = upsertRsvp(
      event.rsvps,
      userId,
      status,
      new Date(),
    ) as IEvent["rsvps"];
    await event.save();
    return event;
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
    const finished = event.state === "cancelled" || event.state === "ended";

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

  private async updateAnnouncement(event: IEvent): Promise<void> {
    if (!event.announcementChannelId || !event.announcementMessageId) return;
    const channel = await this.fetchTextChannel(
      event.guildId,
      event.announcementChannelId,
    );
    if (!channel) return;
    try {
      const message = await channel.messages.fetch(event.announcementMessageId);
      await message.edit(this.buildAnnouncementPayload(event));
    } catch (error) {
      if (this.isDiscardableError(error, DISCORD_UNKNOWN_MESSAGE)) {
        logger.warn(
          `Event announcement message ${sanitizeForLog(event.announcementMessageId)} gone; skipping edit`,
        );
        return;
      }
      logger.error("Failed to update event announcement:", error);
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
  ): Promise<void> {
    try {
      const channel =
        guild.channels.cache.get(channelId) ??
        (await guild.channels.fetch(channelId).catch(() => null));
      if (channel) await channel.delete("Event ended");
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
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId);
      if (channel instanceof TextChannel) return channel;
      logger.warn(
        `Event channel ${sanitizeForLog(channelId)} is not a text channel`,
      );
      return null;
    } catch (error) {
      logger.error("Failed to fetch event text channel:", error);
      return null;
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
