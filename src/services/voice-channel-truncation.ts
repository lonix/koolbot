import { Client } from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { ConfigService } from "./config-service.js";
import { DiscordLogger } from "./discord-logger.js";
import mongoose from "mongoose";

export interface ICleanupStats {
  sessionsRemoved: number;
  dataAggregated: number;
  executionTime: number;
  errors: string[];
  timestamp: Date;
}

export interface IRetentionConfig {
  detailedSessionsDays: number;
  monthlySummariesMonths: number;
  yearlySummariesYears: number;
}

export class VoiceChannelTruncationService {
  private static instance: VoiceChannelTruncationService;
  private client: Client;
  private configService: ConfigService;
  private discordLogger: DiscordLogger;
  private isRunning = false;
  private lastCleanupDate: Date | null = null;
  private isConnected = false;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.discordLogger = DiscordLogger.getInstance(client);
  }

  public static getInstance(client: Client): VoiceChannelTruncationService {
    if (!VoiceChannelTruncationService.instance) {
      VoiceChannelTruncationService.instance =
        new VoiceChannelTruncationService(client);
    }
    return VoiceChannelTruncationService.instance;
  }

  /**
   * Check if the cleanup service is enabled
   */
  public async isEnabled(): Promise<boolean> {
    try {
      return (await this.configService.get(
        "voicetracking.cleanup.enabled",
      )) as boolean;
    } catch (error) {
      logger.debug(
        "Cleanup service enabled check failed, defaulting to false:",
        error,
      );
      return false;
    }
  }

  /**
   * Get the current status of the cleanup service
   */
  public getStatus(): {
    isRunning: boolean;
    isConnected: boolean;
    lastCleanupDate: Date | null;
  } {
    return {
      isRunning: this.isRunning,
      isConnected: this.isConnected,
      lastCleanupDate: this.lastCleanupDate,
    };
  }

  /**
   * Get the notification channel ID
   */
  public async getNotificationChannel(): Promise<string | null> {
    try {
      return (await this.configService.get("core.cleanup.channel_id")) as
        | string
        | null;
    } catch (error) {
      logger.debug(
        "Failed to get notification channel, defaulting to null:",
        error,
      );
      return null;
    }
  }

  /**
   * Get the cleanup schedule
   */
  public async getSchedule(): Promise<string | null> {
    try {
      return (await this.configService.get(
        "voicetracking.cleanup.schedule",
      )) as string | null;
    } catch (error) {
      logger.debug(
        "Failed to get cleanup schedule, defaulting to null:",
        error,
      );
      return null;
    }
  }

  /**
   * Initialize the cleanup service
   */
  public async initialize(): Promise<void> {
    try {
      logger.info("Initializing voice channel truncation service...");

      // Check database connection
      this.isConnected = mongoose.connection.readyState === 1;

      if (!this.isConnected) {
        logger.warn(
          "Database not connected, cleanup service will not function properly",
        );
      }

      logger.info("Voice channel truncation service initialized successfully");
    } catch (error) {
      logger.error(
        "Error initializing voice channel truncation service:",
        error,
      );
      throw error;
    }
  }

  /**
   * Run the cleanup process
   */
  public async runCleanup(): Promise<ICleanupStats> {
    if (this.isRunning) {
      throw new Error("Cleanup is already running");
    }

    if (!this.isConnected) {
      throw new Error("Database not connected");
    }

    const startTime = Date.now();
    this.isRunning = true;

    try {
      logger.info("Starting voice channel cleanup process...");

      // Check if cleanup is enabled
      const enabled = await this.isEnabled();
      if (!enabled) {
        throw new Error("Cleanup service is disabled");
      }

      // Check minimum interval between cleanups
      if (this.lastCleanupDate) {
        const now = new Date();
        const timeSinceLastCleanup =
          now.getTime() - this.lastCleanupDate.getTime();
        const minIntervalMs = 24 * 60 * 60 * 1000; // 24 hours minimum

        if (timeSinceLastCleanup < minIntervalMs) {
          return {
            sessionsRemoved: 0,
            dataAggregated: 0,
            executionTime: Date.now() - startTime,
            errors: ["Cleanup skipped: minimum interval not met"],
            timestamp: new Date(),
          };
        }
      }

      const stats = await this.performCleanup();

      // Update last cleanup date
      this.lastCleanupDate = new Date();

      logger.info(
        `Cleanup completed successfully. Removed ${stats.sessionsRemoved} sessions, aggregated ${stats.dataAggregated} records`,
      );

      // Log results to Discord
      await this.discordLogger.logCleanupResults(stats);

      return stats;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error("Error during cleanup:", error);

      const errorStats: ICleanupStats = {
        sessionsRemoved: 0,
        dataAggregated: 0,
        executionTime: Date.now() - startTime,
        errors: [errorMessage],
        timestamp: new Date(),
      };

      // Log error to Discord
      await this.discordLogger.logError(
        error instanceof Error ? error : new Error(errorMessage),
        "Voice Channel Cleanup",
      );

      return errorStats;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Perform the actual cleanup operations
   */
  private async performCleanup(): Promise<ICleanupStats> {
    const startTime = Date.now();
    let sessionsRemoved = 0;
    let dataAggregated = 0;
    const errors: string[] = [];

    try {
      // Get retention configuration
      const retentionConfig = await this.getRetentionConfig();

      // Get all users with voice tracking data
      const users = await VoiceChannelTracking.find({}).exec();

      for (const user of users) {
        try {
          if (user.sessions && user.sessions.length > 0) {
            const cutoffDate = new Date();
            cutoffDate.setDate(
              cutoffDate.getDate() - retentionConfig.detailedSessionsDays,
            );

            // Separate recent and old sessions
            const recentSessions = user.sessions.filter(
              (session) => session.startTime >= cutoffDate,
            );
            const oldSessions = user.sessions.filter(
              (session) => session.startTime < cutoffDate,
            );

            if (oldSessions.length > 0) {
              // Update user document: remove old sessions, keep recent ones
              await VoiceChannelTracking.updateOne(
                { _id: user._id },
                {
                  $set: {
                    sessions: recentSessions,
                    lastCleanupDate: new Date(),
                  },
                },
              );

              sessionsRemoved += oldSessions.length;
              dataAggregated += 1;

              logger.debug(
                `Cleaned up ${oldSessions.length} old sessions for user ${user.username}, kept ${recentSessions.length} recent sessions`,
              );
            }
          }
        } catch (userError) {
          const errorMessage = `Error processing user ${user.username}: ${userError instanceof Error ? userError.message : String(userError)}`;
          errors.push(errorMessage);
          logger.error(errorMessage, userError);
        }
      }

      logger.info(
        `Cleanup completed: ${sessionsRemoved} sessions removed, ${dataAggregated} users processed`,
      );
    } catch (error) {
      const errorMessage = `General cleanup error: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errorMessage);
      logger.error(errorMessage, error);
    }

    return {
      sessionsRemoved,
      dataAggregated,
      errors,
      executionTime: Date.now() - startTime,
      timestamp: new Date(),
    };
  }

  /**
   * Get retention configuration from database
   */
  private async getRetentionConfig(): Promise<IRetentionConfig> {
    try {
      const detailedSessionsDays =
        ((await this.configService.get(
          "voicetracking.cleanup.retention.detailed_sessions_days",
        )) as number) || 30;
      const monthlySummariesMonths =
        ((await this.configService.get(
          "voicetracking.cleanup.retention.monthly_summaries_months",
        )) as number) || 12;
      const yearlySummariesYears =
        ((await this.configService.get(
          "voicetracking.cleanup.retention.yearly_summaries_years",
        )) as number) || 5;

      return {
        detailedSessionsDays,
        monthlySummariesMonths,
        yearlySummariesYears,
      };
    } catch (error) {
      logger.warn("Failed to load retention config, using defaults:", error);
      return {
        detailedSessionsDays: 30,
        monthlySummariesMonths: 12,
        yearlySummariesYears: 5,
      };
    }
  }
}
