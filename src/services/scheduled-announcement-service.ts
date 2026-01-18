import { Client, TextChannel, EmbedBuilder } from "discord.js";
import { CronJob, CronTime } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import {
  ScheduledAnnouncement,
  IScheduledAnnouncement,
} from "../models/scheduled-announcement.js";

interface ScheduledJob {
  announcement: IScheduledAnnouncement;
  job: CronJob;
}

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
        await this.reload();
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
      ScheduledAnnouncementService.instance =
        new ScheduledAnnouncementService(client);
    }
    return ScheduledAnnouncementService.instance;
  }

  private validateCronExpression(expression: string): boolean {
    try {
      const cleanExpression = expression.replace(/^["']|["']$/g, "");
      new CronTime(cleanExpression);
      return true;
    } catch (error) {
      logger.error(`Invalid cron expression: ${expression}`, error);
      return false;
    }
  }

  private async waitForClientReady(): Promise<void> {
    if (this.client.isReady()) {
      return;
    }

    return new Promise((resolve) => {
      const checkReady = () => {
        if (this.client.isReady()) {
          resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });
  }

  private processPlaceholders(
    text: string,
    guildId: string,
  ): string | Promise<string> {
    return (async () => {
      await this.waitForClientReady();

      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) return text;

      const now = new Date();
      const replacements: Record<string, string> = {
        "{server_name}": guild.name,
        "{member_count}": guild.memberCount.toString(),
        "{date}": now.toLocaleDateString(),
        "{time}": now.toLocaleTimeString(),
        "{day}": now.toLocaleDateString(undefined, { weekday: "long" }),
        "{month}": now.toLocaleDateString(undefined, { month: "long" }),
        "{year}": now.getFullYear().toString(),
      };

      let result = text;
      for (const [placeholder, value] of Object.entries(replacements)) {
        result = result.replace(new RegExp(placeholder, "g"), value);
      }
      return result;
    })();
  }

  private async makeAnnouncement(
    announcement: IScheduledAnnouncement,
  ): Promise<void> {
    try {
      await this.waitForClientReady();

      const guild = await this.client.guilds.fetch(announcement.guildId);
      if (!guild) {
        logger.error(
          `Guild not found with ID: ${announcement.guildId} for announcement ${announcement._id}`,
        );
        return;
      }

      const channel = await guild.channels.fetch(announcement.channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.error(
          `Channel not found or not a text channel: ${announcement.channelId} for announcement ${announcement._id}`,
        );
        return;
      }

      let message = announcement.message;
      if (announcement.placeholders) {
        message = await this.processPlaceholders(message, announcement.guildId);
      }

      if (announcement.embedData) {
        const embed = new EmbedBuilder();

        if (announcement.embedData.title) {
          let title = announcement.embedData.title;
          if (announcement.placeholders) {
            title = await this.processPlaceholders(title, announcement.guildId);
          }
          embed.setTitle(title);
        }

        if (announcement.embedData.description) {
          let description = announcement.embedData.description;
          if (announcement.placeholders) {
            description = await this.processPlaceholders(
              description,
              announcement.guildId,
            );
          }
          embed.setDescription(description);
        }

        if (announcement.embedData.color) {
          embed.setColor(announcement.embedData.color);
        }

        if (announcement.embedData.fields) {
          for (const field of announcement.embedData.fields) {
            let name = field.name;
            let value = field.value;
            if (announcement.placeholders) {
              name = await this.processPlaceholders(name, announcement.guildId);
              value = await this.processPlaceholders(
                value,
                announcement.guildId,
              );
            }
            embed.addFields({ name, value, inline: field.inline });
          }
        }

        if (announcement.embedData.footer) {
          let footerText = announcement.embedData.footer.text;
          if (announcement.placeholders) {
            footerText = await this.processPlaceholders(
              footerText,
              announcement.guildId,
            );
          }
          embed.setFooter({
            text: footerText,
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
      const job = new CronJob(announcement.cronSchedule, () => {
        this.makeAnnouncement(announcement);
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
      logger.error(
        `Error scheduling announcement ${announcement._id}:`,
        error,
      );
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
      const announcements = await ScheduledAnnouncement.find({
        guildId,
        enabled: true,
      });

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

  public async deleteAnnouncement(announcementId: string): Promise<boolean> {
    // Stop the job if it's running
    const scheduledJob = this.jobs.get(announcementId);
    if (scheduledJob) {
      scheduledJob.job.stop();
      this.jobs.delete(announcementId);
    }

    // Delete from database
    const result = await ScheduledAnnouncement.findByIdAndDelete(
      announcementId,
    );
    if (result) {
      logger.info(`Deleted announcement: ${announcementId}`);
      return true;
    }

    return false;
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
