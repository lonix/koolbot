import { Client, TextChannel } from "discord.js";
import { CronJob, CronTime } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import { VoiceChannelTracker } from "./voice-channel-tracker.js";

export class VoiceChannelAnnouncer {
  private static instance: VoiceChannelAnnouncer;
  private client: Client;
  private configService: ConfigService;
  private announcementJob: CronJob | null = null;
  private isInitialized: boolean = false;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): VoiceChannelAnnouncer {
    if (!VoiceChannelAnnouncer.instance) {
      VoiceChannelAnnouncer.instance = new VoiceChannelAnnouncer(client);
    }
    return VoiceChannelAnnouncer.instance;
  }

  private validateCronExpression(expression: string): boolean {
    try {
      // Remove any surrounding quotes
      const cleanExpression = expression.replace(/^["']|["']$/g, "");
      logger.debug(`Validating cron expression: ${cleanExpression}`);

      // Try to create a CronTime object - this will throw if the expression is invalid
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

  public async start(): Promise<void> {
    logger.info("Starting voice channel announcer...");

    try {
      // Wait for client to be ready
      await this.waitForClientReady();

      // Ensure guild channels are cached
      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("GUILD_ID not configured");
        return;
      }

      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        logger.error(`Guild not found with ID: ${guildId}`);
        return;
      }

      // Cache guild channels
      await guild.channels.fetch();

      const enabled = await this.configService.getBoolean(
        "voicetracking.announcements.enabled",
        false,
      );
      const trackingEnabled = await this.configService.getBoolean(
        "voicetracking.enabled",
        false,
      );
      if (!enabled || !trackingEnabled) {
        logger.info(
          "Weekly voice channel announcements are disabled or voice tracking is not enabled",
        );
        return;
      }

      let schedule = await this.configService.getString(
        "voicetracking.announcements.schedule",
        "0 16 * * 5",
      );
      // Remove any surrounding quotes from the schedule
      schedule = schedule.replace(/^["']|["']$/g, "");

      if (!this.validateCronExpression(schedule)) {
        logger.error(
          `Invalid announcement schedule: ${schedule}. Using default schedule: 0 16 * * 5`,
        );
        schedule = "0 16 * * 5";
      }

      this.announcementJob = new CronJob(schedule, () => {
        this.makeAnnouncement();
      });

      this.announcementJob.start();
      logger.info(
        `Voice channel announcements scheduled with cron: ${schedule}`,
      );

      // Log the next scheduled run time
      const nextRun = this.announcementJob.nextDate();
      logger.info(
        `Next announcement scheduled for: ${nextRun.toLocaleString()}`,
      );

      this.isInitialized = true;
    } catch (error) {
      logger.error("Error scheduling voice channel announcements:", error);
      throw error; // Re-throw the error to be handled by the caller
    }
  }

  public async makeAnnouncement(): Promise<void> {
    try {
      // Wait for client to be ready
      await this.waitForClientReady();

      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("GUILD_ID not configured");
        return;
      }

      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        logger.error(`Guild not found with ID: ${guildId}`);
        return;
      }

      const channelName = await this.configService.getString(
        "voicetracking.announcements.channel",
        "voice-stats",
      );

      // Ensure guild channels are cached
      await guild.channels.fetch();

      const channel = guild.channels.cache.find(
        (ch) => ch instanceof TextChannel && ch.name === channelName,
      ) as TextChannel;

      if (!channel) {
        logger.error(
          `Announcement channel ${channelName} not found in guild ${guild.name}`,
        );
        return;
      }

      const tracker = VoiceChannelTracker.getInstance(this.client);
      const topUsers = await tracker.getTopUsers(10, "week");

      if (topUsers.length === 0) {
        await channel.send("No voice channel activity recorded this week.");
        return;
      }

      const formatTime = (seconds: number): string => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
      };

      const message = [
        "🎙️ **Weekly Voice Channel Activity Report** 🎙️",
        "",
        "**Top 10 Most Active Members This Week:**",
        ...topUsers.map((user, index) => {
          const rank = index + 1;
          const medal =
            rank === 1
              ? "🥇"
              : rank === 2
                ? "🥈"
                : rank === 3
                  ? "🥉"
                  : `${rank}.`;
          const mention = rank <= 3 ? `<@${user.userId}>` : user.username;
          return `${medal} ${mention}: ${formatTime(user.totalTime)}`;
        }),
        "",
        "Keep up the great conversations! 🎮",
      ].join("\n");

      await channel.send(message);
      logger.info("Weekly voice channel announcement sent successfully");
    } catch (error) {
      logger.error("Error making voice channel announcement:", error);
    }
  }

  public destroy(): void {
    if (this.announcementJob) {
      this.announcementJob.stop();
      this.announcementJob = null;
    }
    this.isInitialized = false;
  }
}
