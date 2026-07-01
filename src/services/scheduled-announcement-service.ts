import { Client, Guild, TextChannel, EmbedBuilder } from "discord.js";
import { CronJob, CronTime } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import {
  ScheduledAnnouncement,
  IScheduledAnnouncement,
} from "../models/scheduled-announcement.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

interface ScheduledJob {
  announcement: IScheduledAnnouncement;
  job: CronJob;
}

/**
 * The subset of an announcement needed to actually render + send it. Every
 * persisted `IScheduledAnnouncement` satisfies this, but a one-off "send once"
 * (which is never stored) can supply just these fields.
 */
export type AnnouncementContent = Pick<
  IScheduledAnnouncement,
  "guildId" | "channelId" | "message" | "placeholders"
> & {
  _id?: unknown;
  embedData?: IScheduledAnnouncement["embedData"];
};

export class ScheduledAnnouncementService {
  private static instance: ScheduledAnnouncementService;
  private client: Client;
  private configService: ConfigService;
  private jobs: Map<string, ScheduledJob> = new Map();
  private isInitialized: boolean = false;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    // Register configuration reload callback
    this.configService.registerReloadCallback(async () => {
      try {
        logger.info(
          "Scheduled announcements configuration changed, reloading...",
        );

        // Check if the feature is enabled before reloading
        const enabled = await this.configService.getBoolean(
          "announcements.enabled",
          false,
        );

        if (!enabled && this.isInitialized) {
          // Feature disabled, clean up existing jobs
          logger.info("Scheduled announcements disabled, cleaning up jobs...");
          this.destroy();
        } else if (enabled) {
          // Feature enabled or still enabled, reload
          await this.reload();
        }
      } catch (error) {
        logger.error(
          "Error reloading scheduled announcements after configuration change:",
          error,
        );
      }
    });
  }

  public static getInstance(client: Client): ScheduledAnnouncementService {
    if (!ScheduledAnnouncementService.instance) {
      ScheduledAnnouncementService.instance = new ScheduledAnnouncementService(
        client,
      );
    } else if (ScheduledAnnouncementService.instance.client !== client) {
      throw new Error(
        "ScheduledAnnouncementService already initialised with a different client",
      );
    }
    return ScheduledAnnouncementService.instance;
  }

  public static reset(): void {
    if (ScheduledAnnouncementService.instance) {
      ScheduledAnnouncementService.instance.destroy();
    }
    ScheduledAnnouncementService.instance =
      undefined as unknown as ScheduledAnnouncementService;
  }

  private validateCronExpression(expression: string): boolean {
    try {
      const cleanExpression = expression.replace(/^["']|["']$/g, "");
      new CronTime(cleanExpression);
      return true;
    } catch (error) {
      logger.error(
        `Invalid cron expression: ${sanitizeForLog(expression)}`,
        error,
      );
      return false;
    }
  }

  private async waitForClientReady(): Promise<void> {
    if (this.client.isReady()) {
      return;
    }

    return new Promise((resolve) => {
      const maxWaitMs = 30000;
      const pollIntervalMs = 500;
      let resolved = false;
      let elapsed = 0;

      const cleanup = (): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        this.client.off("ready", onReady);
        clearInterval(intervalId);
      };

      const onReady = (): void => {
        cleanup();
        resolve();
      };

      const intervalId = setInterval(() => {
        if (this.client.isReady()) {
          cleanup();
          resolve();
          return;
        }

        elapsed += pollIntervalMs;
        if (elapsed >= maxWaitMs) {
          logger.warn(
            "ScheduledAnnouncementService: client did not become ready within the expected time; continuing anyway.",
          );
          cleanup();
          resolve();
        }
      }, pollIntervalMs);

      this.client.once("ready", onReady);
    });
  }

  /**
   * Resolve every placeholder token to its value once per announcement. The
   * async/expensive work (member-cache scan, `fetchOwner()` API call, random
   * pick) happens here a single time; `applyPlaceholders` then substitutes the
   * cached map into each text field synchronously. This avoids re-doing the
   * work (and the owner API call) for every embed field/title/footer, which
   * matters for the immediate "post now"/"post once" paths.
   */
  private async buildPlaceholderMap(
    guild: Guild,
  ): Promise<Record<string, string>> {
    const now = new Date();

    // Members currently online — best effort. Requires the GUILD_PRESENCES
    // intent and a populated member cache; when presence data is unavailable
    // this counts 0 rather than throwing.
    let onlineCount = 0;
    try {
      onlineCount = guild.members.cache.filter(
        (m) => m.presence != null && m.presence.status !== "offline",
      ).size;
    } catch {
      onlineCount = 0;
    }

    // Server owner mention. fetchOwner can reject if the owner is uncached or
    // temporarily unavailable — degrade to an empty string rather than fail
    // the whole announcement.
    let ownerMention = "";
    try {
      const owner = await guild.fetchOwner();
      ownerMention = owner.toString();
    } catch {
      ownerMention = "";
    }

    // Random member mention for fun/engagement — best effort from the cache.
    // Picked once so a single announcement references the same member across
    // all of its text fields.
    let randomMember = "";
    const members = [...guild.members.cache.values()];
    if (members.length > 0) {
      const picked = members[Math.floor(Math.random() * members.length)];
      if (picked) randomMember = picked.toString();
    }

    return {
      "{server_name}": guild.name,
      "{member_count}": guild.memberCount.toString(),
      "{online_count}": onlineCount.toString(),
      "{owner}": ownerMention,
      "{boost_count}": (guild.premiumSubscriptionCount ?? 0).toString(),
      "{boost_tier}": guild.premiumTier.toString(),
      "{channel_count}": guild.channels.cache.size.toString(),
      "{role_count}": guild.roles.cache.size.toString(),
      "{random_member}": randomMember,
      "{date}": now.toLocaleDateString(),
      "{time}": now.toLocaleTimeString(),
      "{day}": now.toLocaleDateString(undefined, { weekday: "long" }),
      "{month}": now.toLocaleDateString(undefined, { month: "long" }),
      "{year}": now.getFullYear().toString(),
      // Locale-independent ISO 8601 forms for operators who want a stable,
      // unambiguous format instead of the locale-implicit {date}/{time}.
      "{date_iso}": now.toISOString().slice(0, 10),
      "{time_iso}": now.toISOString().slice(11, 19),
      "{datetime_iso}": now.toISOString(),
    };
  }

  private applyPlaceholders(
    text: string,
    replacements: Record<string, string>,
  ): string {
    let result = text;
    for (const [placeholder, value] of Object.entries(replacements)) {
      // Use split-join pattern for compatibility with older JS versions
      result = result.split(placeholder).join(value);
    }
    return result;
  }

  private async makeAnnouncement(
    announcement: AnnouncementContent,
  ): Promise<void> {
    try {
      await this.dispatchAnnouncement(announcement);
      logger.info(
        `Scheduled announcement ${announcement._id} sent successfully to channel ${announcement.channelId}`,
      );
    } catch (error) {
      logger.error(
        `Error making scheduled announcement ${announcement._id}:`,
        error,
      );
    }
  }

  /**
   * Render + send an announcement, throwing on any failure (guild/channel
   * missing, Discord send error). `makeAnnouncement` wraps this to swallow
   * errors for fire-and-forget cron jobs; the immediate "post now"/"send once"
   * paths call it directly so the WebUI can surface failures to the operator.
   */
  private async dispatchAnnouncement(
    announcement: AnnouncementContent,
  ): Promise<void> {
    await this.waitForClientReady();

    const guild = await this.client.guilds.fetch(announcement.guildId);
    if (!guild) {
      throw new Error(
        `Guild not found with ID: ${announcement.guildId} for announcement ${announcement._id}`,
      );
    }

    const channel = await guild.channels.fetch(announcement.channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      throw new Error(
        `Channel not found or not a text channel: ${announcement.channelId} for announcement ${announcement._id}`,
      );
    }

    // Resolve placeholders once for the whole announcement, then substitute the
    // cached map into each field synchronously. `expand` is a no-op when the
    // announcement has placeholders disabled.
    const placeholderMap = announcement.placeholders
      ? await this.buildPlaceholderMap(guild)
      : null;
    const expand = (text: string): string =>
      placeholderMap ? this.applyPlaceholders(text, placeholderMap) : text;

    const message = expand(announcement.message);

    if (announcement.embedData) {
      const embed = new EmbedBuilder();

      if (announcement.embedData.title) {
        embed.setTitle(expand(announcement.embedData.title));
      }

      if (announcement.embedData.description) {
        embed.setDescription(expand(announcement.embedData.description));
      }

      if (announcement.embedData.color) {
        embed.setColor(announcement.embedData.color);
      }

      if (announcement.embedData.fields) {
        for (const field of announcement.embedData.fields) {
          embed.addFields({
            name: expand(field.name),
            value: expand(field.value),
            inline: field.inline,
          });
        }
      }

      if (announcement.embedData.footer) {
        embed.setFooter({
          text: expand(announcement.embedData.footer.text),
          iconURL: announcement.embedData.footer.iconUrl,
        });
      }

      if (announcement.embedData.thumbnail) {
        embed.setThumbnail(announcement.embedData.thumbnail);
      }

      if (announcement.embedData.image) {
        embed.setImage(announcement.embedData.image);
      }

      await channel.send({ content: message, embeds: [embed] });
    } else {
      await channel.send(message);
    }
  }

  /**
   * Fire an existing scheduled announcement once, immediately, without waiting
   * for its cron to elapse. Reuses the announcement's channel/message/embed/
   * placeholder config. Returns false when the announcement is missing or
   * belongs to another guild; throws if the send itself fails so the caller
   * can report the reason.
   */
  public async postAnnouncementNow(
    announcementId: string,
    guildId?: string,
  ): Promise<boolean> {
    const announcement = await ScheduledAnnouncement.findById(announcementId);
    if (!announcement) {
      return false;
    }
    if (guildId && announcement.guildId !== guildId) {
      logger.warn(
        `Attempted to post announcement ${sanitizeForLog(announcementId)} from wrong guild. Expected: ${sanitizeForLog(announcement.guildId)}, Got: ${sanitizeForLog(guildId)}`,
      );
      return false;
    }

    await this.dispatchAnnouncement(announcement);
    logger.info(
      `Posted announcement ${sanitizeForLog(announcementId)} on demand to channel ${announcement.channelId}`,
    );
    return true;
  }

  /**
   * Compose-and-send-once: dispatch an ad-hoc announcement immediately without
   * persisting a cron schedule. Throws if the send fails so the WebUI can
   * surface the error.
   */
  public async postOnce(announcement: AnnouncementContent): Promise<void> {
    await this.dispatchAnnouncement(announcement);
    logger.info(
      `Posted one-off announcement to channel ${announcement.channelId}`,
    );
  }

  private scheduleAnnouncement(
    announcement: IScheduledAnnouncement,
  ): CronJob | null {
    if (!this.validateCronExpression(announcement.cronSchedule)) {
      logger.error(
        `Invalid cron schedule for announcement ${announcement._id}: ${announcement.cronSchedule}`,
      );
      return null;
    }

    try {
      const job = new CronJob(announcement.cronSchedule, async () => {
        try {
          // Fetch fresh announcement data from database to handle updates
          const latestAnnouncement =
            (await ScheduledAnnouncement.findById(announcement._id)) ??
            announcement;

          await this.makeAnnouncement(latestAnnouncement);
        } catch (error) {
          logger.error(
            `Error in scheduled announcement ${announcement._id}:`,
            error,
          );
        }
      });

      job.start();
      logger.info(
        `Scheduled announcement ${announcement._id} with cron: ${announcement.cronSchedule}`,
      );

      const nextRun = job.nextDate();
      logger.info(
        `Next announcement ${announcement._id} scheduled for: ${nextRun.toLocaleString()}`,
      );

      return job;
    } catch (error) {
      logger.error(`Error scheduling announcement ${announcement._id}:`, error);
      return null;
    }
  }

  public async start(): Promise<void> {
    if (this.isInitialized) {
      logger.warn(
        "Scheduled announcement service is already initialized, skipping...",
      );
      return;
    }

    logger.info("Starting scheduled announcement service...");

    try {
      await this.waitForClientReady();

      const enabled = await this.configService.getBoolean(
        "announcements.enabled",
        false,
      );

      if (!enabled) {
        logger.info("Scheduled announcements are disabled");
        return;
      }

      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("GUILD_ID not configured");
        return;
      }

      // Load all enabled announcements for this guild
      let announcements;
      try {
        announcements = await ScheduledAnnouncement.find({
          guildId,
          enabled: true,
        });
      } catch (error) {
        logger.error("Error loading announcements from database:", error);
        throw error;
      }

      logger.info(
        `Found ${announcements.length} enabled announcements to schedule`,
      );

      for (const announcement of announcements) {
        const job = this.scheduleAnnouncement(announcement);
        if (job) {
          this.jobs.set(announcement._id.toString(), { announcement, job });
        }
      }

      this.isInitialized = true;
      logger.info(
        `Scheduled announcement service started with ${this.jobs.size} active jobs`,
      );
    } catch (error) {
      logger.error("Error starting scheduled announcement service:", error);
      throw error;
    }
  }

  public async createAnnouncement(
    data: Omit<IScheduledAnnouncement, "createdAt" | "updatedAt">,
  ): Promise<IScheduledAnnouncement> {
    if (!this.validateCronExpression(data.cronSchedule)) {
      throw new Error(`Invalid cron expression: ${data.cronSchedule}`);
    }

    const announcement = new ScheduledAnnouncement(data);
    await announcement.save();

    // If the service is running and the announcement is enabled, schedule it
    if (this.isInitialized && announcement.enabled) {
      const job = this.scheduleAnnouncement(announcement);
      if (job) {
        this.jobs.set(announcement._id.toString(), { announcement, job });
      }
    }

    logger.info(`Created new announcement: ${announcement._id}`);
    return announcement;
  }

  /**
   * Flip an announcement's `enabled` flag. Re-syncs the active cron job:
   * enabling reschedules immediately, disabling stops the running job.
   * Used by the WebUI write surface (#383). Returns the updated document
   * or null if the announcement was not found or belongs to another guild.
   */
  public async setAnnouncementEnabled(
    announcementId: string,
    enabled: boolean,
    guildId?: string,
  ): Promise<IScheduledAnnouncement | null> {
    const announcement = await ScheduledAnnouncement.findById(announcementId);
    if (!announcement) {
      return null;
    }
    if (guildId && announcement.guildId !== guildId) {
      logger.warn(
        `Attempted to toggle announcement ${sanitizeForLog(announcement._id.toString())} from wrong guild. Expected: ${announcement.guildId}, Got: ${sanitizeForLog(guildId)}`,
      );
      return null;
    }

    if (announcement.enabled === enabled) {
      return announcement;
    }

    announcement.enabled = enabled;
    await announcement.save();

    const existing = this.jobs.get(announcementId);
    if (existing) {
      existing.job.stop();
      this.jobs.delete(announcementId);
    }

    if (this.isInitialized && enabled) {
      const job = this.scheduleAnnouncement(announcement);
      if (job) {
        this.jobs.set(announcement._id.toString(), { announcement, job });
      }
    }

    logger.info(
      `${enabled ? "Enabled" : "Disabled"} announcement: ${sanitizeForLog(announcement._id.toString())}`,
    );
    return announcement;
  }

  public async deleteAnnouncement(
    announcementId: string,
    guildId?: string,
  ): Promise<boolean> {
    // Verify the announcement exists and optionally belongs to the guild
    const announcement = await ScheduledAnnouncement.findById(announcementId);
    if (!announcement) {
      return false;
    }

    // If guildId is provided, verify it matches
    if (guildId && announcement.guildId !== guildId) {
      logger.warn(
        `Attempted to delete announcement ${sanitizeForLog(announcementId)} from wrong guild. Expected: ${sanitizeForLog(announcement.guildId)}, Got: ${sanitizeForLog(guildId)}`,
      );
      return false;
    }

    // Stop the job if it's running
    const scheduledJob = this.jobs.get(announcementId);
    if (scheduledJob) {
      scheduledJob.job.stop();
      this.jobs.delete(announcementId);
    }

    // Delete from database
    await ScheduledAnnouncement.findByIdAndDelete(announcementId);
    logger.info(`Deleted announcement: ${sanitizeForLog(announcementId)}`);
    return true;
  }

  public async listAnnouncements(
    guildId: string,
  ): Promise<IScheduledAnnouncement[]> {
    return await ScheduledAnnouncement.find({ guildId }).sort({
      createdAt: -1,
    });
  }

  public async getAnnouncement(
    announcementId: string,
  ): Promise<IScheduledAnnouncement | null> {
    return await ScheduledAnnouncement.findById(announcementId);
  }

  public async reload(): Promise<void> {
    logger.info("Reloading scheduled announcements...");

    // Stop all existing jobs
    for (const [id, scheduledJob] of this.jobs.entries()) {
      scheduledJob.job.stop();
      this.jobs.delete(id);
    }

    this.isInitialized = false;

    // Restart the service
    await this.start();
  }

  public destroy(): void {
    for (const scheduledJob of this.jobs.values()) {
      scheduledJob.job.stop();
    }
    this.jobs.clear();
    this.isInitialized = false;
    logger.info("Scheduled announcement service destroyed");
  }
}
