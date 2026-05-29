import { Client } from "discord.js";
import logger from "../utils/logger.js";
import { MessageActivityTracking } from "../models/message-activity-tracking.js";
import { ConfigService } from "./config-service.js";
import { DiscordLogger } from "./discord-logger.js";
import mongoose from "mongoose";
import { CronJob } from "cron";

export interface IMessageCleanupStats {
  /** Number of `recentMessages` entries pruned across all users. */
  messagesPruned: number;
  /** Number of user documents that had at least one entry pruned. */
  usersProcessed: number;
  executionTime: number;
  errors: string[];
  timestamp: Date;
  /**
   * `true` when the run returned early because the 24h minimum interval
   * hadn't elapsed since the previous cleanup.
   */
  skipped?: boolean;
}

/**
 * Prunes the per-message detail (`recentMessages`) from
 * `MessageActivityTracking` documents beyond a configurable retention
 * window. Mirrors `VoiceChannelTruncationService` and the
 * `voicetracking.cleanup.*` cron, but only trims the detail array — the
 * all-time `channels[]` totals and `totalCount` are intentionally kept so
 * they can feed all-time leaderboards. See issue #495.
 */
export class MessageActivityCleanupService {
  private static instance: MessageActivityCleanupService;
  private client: Client;
  private configService: ConfigService;
  private discordLogger: DiscordLogger;
  private isRunning = false;
  private isScheduled = false;
  private lastCleanupDate: Date | null = null;
  private cleanupJob: CronJob | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.discordLogger = DiscordLogger.getInstance(client);

    // Apply config changes at runtime (e.g. after /config reload) so the
    // cron is (re)started, rescheduled, or stopped without a bot restart —
    // matching digest-service and scheduled-announcement-service.
    this.configService.registerReloadCallback(async () => {
      try {
        logger.info("Message cleanup configuration changed, reloading...");
        // Tear down any existing schedule, then re-evaluate from config.
        // startScheduledCleanup() is a no-op when the feature is disabled.
        this.destroy();
        await this.startScheduledCleanup();
      } catch (error) {
        logger.error(
          "Error reloading message cleanup service after configuration change:",
          error,
        );
      }
    });
  }

  public static getInstance(client: Client): MessageActivityCleanupService {
    if (!MessageActivityCleanupService.instance) {
      MessageActivityCleanupService.instance =
        new MessageActivityCleanupService(client);
    }
    return MessageActivityCleanupService.instance;
  }

  public async isEnabled(): Promise<boolean> {
    try {
      return await this.configService.getBoolean(
        "messagetracking.cleanup.enabled",
        false,
      );
    } catch (error) {
      logger.debug(
        "Message cleanup enabled check failed, defaulting to false:",
        error,
      );
      return false;
    }
  }

  public getStatus(): {
    isRunning: boolean;
    isScheduled: boolean;
    isConnected: boolean;
    lastCleanupDate: Date | null;
  } {
    return {
      isRunning: this.isRunning,
      isScheduled: this.isScheduled,
      isConnected: mongoose.connection.readyState === 1,
      lastCleanupDate: this.lastCleanupDate,
    };
  }

  public async getSchedule(): Promise<string | null> {
    try {
      return await this.configService.getString(
        "messagetracking.cleanup.schedule",
        "",
      );
    } catch (error) {
      logger.debug(
        "Failed to get message cleanup schedule, defaulting to null:",
        error,
      );
      return null;
    }
  }

  private async getRetentionDays(): Promise<number> {
    try {
      return await this.configService.getNumber(
        "messagetracking.cleanup.retention.detailed_days",
        400,
      );
    } catch (error) {
      logger.warn(
        "Failed to load message retention config, using default (400):",
        error,
      );
      return 400;
    }
  }

  public async initialize(): Promise<void> {
    try {
      logger.info("Initializing message activity cleanup service...");
      await this.loadLastCleanupDate();
      await this.startScheduledCleanup();
      logger.info("Message activity cleanup service initialized successfully");
    } catch (error) {
      logger.error(
        "Error initializing message activity cleanup service:",
        error,
      );
      throw error;
    }
  }

  private async loadLastCleanupDate(): Promise<void> {
    try {
      const lastCleanup = await this.configService.get(
        "messagetracking.cleanup.last_run",
      );
      if (lastCleanup && typeof lastCleanup === "string") {
        this.lastCleanupDate = new Date(lastCleanup);
        logger.info(
          `Loaded last message cleanup date: ${this.lastCleanupDate.toLocaleString()}`,
        );
      } else {
        this.lastCleanupDate = null;
      }
    } catch (error) {
      logger.warn("Failed to load last message cleanup date:", error);
      this.lastCleanupDate = null;
    }
  }

  private async saveLastCleanupDate(date: Date): Promise<void> {
    try {
      await this.configService.set(
        "messagetracking.cleanup.last_run",
        date.toISOString(),
        "Last message-tracking cleanup execution timestamp",
        "messagetracking",
      );
    } catch (error) {
      logger.error("Failed to save last message cleanup date:", error);
    }
  }

  private async startScheduledCleanup(): Promise<void> {
    try {
      if (this.isScheduled && this.cleanupJob) {
        logger.warn(
          "Message activity cleanup scheduler is already running, skipping...",
        );
        return;
      }

      const enabled = await this.isEnabled();
      logger.info(`Message cleanup service enabled: ${enabled}`);

      if (!enabled) {
        if (this.cleanupJob) {
          this.cleanupJob.stop();
          this.cleanupJob = null;
        }
        this.isScheduled = false;
        return;
      }

      const schedule = await this.getSchedule();
      const cleanSchedule = schedule
        ? schedule.replace(/^["']|["']$/g, "")
        : "0 3 * * *";

      this.cleanupJob = new CronJob(cleanSchedule, () => {
        logger.info("Scheduled message activity cleanup triggered");
        this.runCleanup().catch((error) => {
          logger.error("Error in scheduled message cleanup:", error);
        });
      });

      this.cleanupJob.start();
      this.isScheduled = true;
      logger.info(
        `✅ Message activity cleanup scheduled successfully with cron: ${cleanSchedule}`,
      );
    } catch (error) {
      logger.error("❌ Error starting scheduled message cleanup:", error);
      this.isScheduled = false;
    }
  }

  public async runCleanup(): Promise<IMessageCleanupStats> {
    if (this.isRunning) {
      throw new Error("Message cleanup is already running");
    }

    if (mongoose.connection.readyState !== 1) {
      throw new Error("Database not connected");
    }

    const startTime = Date.now();
    this.isRunning = true;

    try {
      const enabled = await this.isEnabled();
      if (!enabled) {
        throw new Error("Message cleanup service is disabled");
      }

      // Enforce a 24h minimum interval between runs.
      if (this.lastCleanupDate) {
        const timeSinceLastCleanup =
          Date.now() - this.lastCleanupDate.getTime();
        const minIntervalMs = 24 * 60 * 60 * 1000;
        if (timeSinceLastCleanup < minIntervalMs) {
          return {
            messagesPruned: 0,
            usersProcessed: 0,
            executionTime: Date.now() - startTime,
            errors: ["Cleanup skipped: minimum interval not met"],
            timestamp: new Date(),
            skipped: true,
          };
        }
      }

      const stats = await this.performCleanup();

      const cleanupDate = new Date();
      this.lastCleanupDate = cleanupDate;
      await this.saveLastCleanupDate(cleanupDate);

      logger.info(
        `Message cleanup completed. Pruned ${stats.messagesPruned} entries across ${stats.usersProcessed} users`,
      );

      return stats;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Error during message cleanup:", error);

      await this.discordLogger.logError(
        error instanceof Error ? error : new Error(errorMessage),
        "Message Activity Cleanup",
      );

      return {
        messagesPruned: 0,
        usersProcessed: 0,
        executionTime: Date.now() - startTime,
        errors: [errorMessage],
        timestamp: new Date(),
      };
    } finally {
      this.isRunning = false;
    }
  }

  private async performCleanup(): Promise<IMessageCleanupStats> {
    const startTime = Date.now();
    let messagesPruned = 0;
    let usersProcessed = 0;
    const errors: string[] = [];

    try {
      const retentionDays = await this.getRetentionDays();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      const users = await MessageActivityTracking.find({}).exec();

      for (const user of users) {
        try {
          if (user.recentMessages && user.recentMessages.length > 0) {
            const recent = user.recentMessages.filter(
              (entry) => entry.sentAt >= cutoffDate,
            );
            const prunedCount = user.recentMessages.length - recent.length;

            if (prunedCount > 0) {
              // Only touch recentMessages — channels[] and totalCount are
              // all-time and intentionally preserved.
              await MessageActivityTracking.updateOne(
                { _id: user._id },
                {
                  $set: {
                    recentMessages: recent,
                    lastCleanupDate: new Date(),
                  },
                },
              );
              messagesPruned += prunedCount;
              usersProcessed += 1;
            }
          }
        } catch (userError) {
          const errorMessage = `Error processing user ${user.username}: ${userError instanceof Error ? userError.message : String(userError)}`;
          errors.push(errorMessage);
          logger.error(errorMessage, userError);
        }
      }
    } catch (error) {
      const errorMessage = `General message cleanup error: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errorMessage);
      logger.error(errorMessage, error);
    }

    return {
      messagesPruned,
      usersProcessed,
      errors,
      executionTime: Date.now() - startTime,
      timestamp: new Date(),
    };
  }

  public destroy(): void {
    if (this.cleanupJob) {
      this.cleanupJob.stop();
      this.cleanupJob = null;
    }
    this.isRunning = false;
    this.isScheduled = false;
  }
}
