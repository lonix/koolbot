import { Client, TextChannel } from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { ConfigService } from "./config-service.js";
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
  private isConnected: boolean = false;
  private isRunning: boolean = false;
  private lastCleanupDate: Date | null = null;

  // Retention configuration - stored in variables for futureproofing
  private readonly DEFAULT_RETENTION: IRetentionConfig = {
    detailedSessionsDays: 30,
    monthlySummariesMonths: 12,
    yearlySummariesYears: 5,
  };

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.setupDatabaseConnection();
  }

  public static getInstance(client: Client): VoiceChannelTruncationService {
    if (!VoiceChannelTruncationService.instance) {
      VoiceChannelTruncationService.instance = new VoiceChannelTruncationService(client);
    }
    return VoiceChannelTruncationService.instance;
  }

  private setupDatabaseConnection(): void {
    mongoose.connection.on("connected", () => {
      this.isConnected = true;
      logger.info("MongoDB connected for voice channel truncation service");
    });

    mongoose.connection.on("disconnected", () => {
      this.isConnected = false;
      logger.warn("MongoDB disconnected from voice channel truncation service");
    });

    mongoose.connection.on("error", (error) => {
      this.isConnected = false;
      logger.error("MongoDB connection error in voice channel truncation service:", error);
    });
  }

  private async ensureConnection(): Promise<void> {
    if (!this.isConnected) {
      try {
        await mongoose.connect(
          await this.configService.getString(
            "MONGODB_URI",
            "mongodb://mongodb:27017/koolbot",
          ),
        );
        logger.info("Reconnected to MongoDB for voice channel truncation service");
      } catch (error: unknown) {
        logger.error("Error reconnecting to MongoDB:", error);
        throw error;
      }
    }
  }

  public async isEnabled(): Promise<boolean> {
    try {
      return await this.configService.getBoolean("voicetracking.cleanup.enabled") ?? false;
    } catch (error) {
      logger.error("Error checking if cleanup is enabled:", error);
      return false;
    }
  }

  public async getNotificationChannel(): Promise<string | null> {
    try {
      return await this.configService.getString("voicetracking.cleanup.notification_channel") ?? null;
    } catch (error) {
      logger.error("Error getting notification channel:", error);
      return null;
    }
  }

  public async getSchedule(): Promise<string> {
    try {
      return await this.configService.getString("voicetracking.cleanup.schedule") ?? "0 2 * * *";
    } catch (error) {
      logger.error("Error getting cleanup schedule:", error);
      return "0 2 * * *";
    }
  }

  public async shouldRunCleanup(): Promise<boolean> {
    try {
      // Check if cleanup is enabled
      if (!(await this.isEnabled())) {
        return false;
      }

      // Check if cleanup is already running
      if (this.isRunning) {
        logger.info("Cleanup already running, skipping");
        return false;
      }

      // Check if enough time has passed since last cleanup
      if (this.lastCleanupDate) {
        const now = new Date();
        const timeSinceLastCleanup = now.getTime() - this.lastCleanupDate.getTime();
        const minIntervalMs = 24 * 60 * 60 * 1000; // 24 hours minimum

        if (timeSinceLastCleanup < minIntervalMs) {
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error("Error checking if cleanup should run:", error);
      return false;
    }
  }

  public async runCleanup(): Promise<ICleanupStats> {
    if (this.isRunning) {
      throw new Error("Cleanup already running");
    }

    this.isRunning = true;
    const startTime = Date.now();
    const stats: ICleanupStats = {
      sessionsRemoved: 0,
      dataAggregated: 0,
      executionTime: 0,
      errors: [],
      timestamp: new Date(),
    };

    try {
      await this.ensureConnection();
      logger.info("Starting voice channel data cleanup");

      // Get retention configuration
      const retention = await this.getRetentionConfig();

      // Clean up old detailed sessions
      const cleanupResult = await this.cleanupOldSessions(retention.detailedSessionsDays);
      stats.sessionsRemoved = cleanupResult.sessionsRemoved;
      stats.dataAggregated = cleanupResult.dataAggregated;

      // Update last cleanup date
      this.lastCleanupDate = new Date();

      logger.info(`Cleanup completed successfully. Removed ${stats.sessionsRemoved} sessions, aggregated ${stats.dataAggregated} records`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      stats.errors.push(errorMessage);
      logger.error("Error during cleanup:", error);
    } finally {
      this.isRunning = false;
      stats.executionTime = Date.now() - startTime;
    }

    return stats;
  }

  private async getRetentionConfig(): Promise<IRetentionConfig> {
    // For now, return default values - these will be configurable in the future
    return this.DEFAULT_RETENTION;
  }

  private async cleanupOldSessions(detailedSessionsDays: number): Promise<{ sessionsRemoved: number; dataAggregated: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - detailedSessionsDays);

    logger.info(`Cleaning up sessions older than ${cutoffDate.toISOString()}`);

    let sessionsRemoved = 0;
    let dataAggregated = 0;

    try {
      // Find all users with old sessions
      const usersWithOldSessions = await VoiceChannelTracking.find({
        "sessions.startTime": { $lt: cutoffDate }
      });

      for (const user of usersWithOldSessions) {
        const oldSessions = user.sessions.filter(session => session.startTime < cutoffDate);
        const recentSessions = user.sessions.filter(session => session.startTime >= cutoffDate);

        if (oldSessions.length > 0) {
          // Update user document: remove old sessions, keep recent ones
          await VoiceChannelTracking.updateOne(
            { _id: user._id },
            {
              $set: {
                sessions: recentSessions,
                lastCleanupDate: new Date()
              }
            }
          );

          sessionsRemoved += oldSessions.length;
          dataAggregated += 1;

          logger.debug(`Cleaned up ${oldSessions.length} old sessions for user ${user.username}, kept ${recentSessions.length} recent sessions`);
        }
      }

      logger.info(`Cleanup completed: removed ${sessionsRemoved} old sessions from ${dataAggregated} users`);
    } catch (error) {
      logger.error("Error during session cleanup:", error);
      throw error;
    }

    return { sessionsRemoved, dataAggregated };
  }

  public async sendCleanupNotification(stats: ICleanupStats): Promise<void> {
    try {
      const channelId = await this.getNotificationChannel();
      if (!channelId) {
        logger.info("No notification channel configured, skipping notification");
        return;
      }

      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.error(`Notification channel ${channelId} not found or is not a text channel`);
        return;
      }

      const embed = {
        color: stats.errors.length > 0 ? 0xFF0000 : 0x00FF00,
        title: "🎙️ Voice Channel Cleanup Report",
        timestamp: stats.timestamp.toISOString(),
        fields: [
          {
            name: "📊 Cleanup Summary",
            value: `Sessions Removed: ${stats.sessionsRemoved}\nData Aggregated: ${stats.dataAggregated}`,
            inline: true,
          },
          {
            name: "⏱️ Execution Time",
            value: `${stats.executionTime}ms`,
            inline: true,
          },
        ],
        footer: {
          text: "Voice Channel Cleanup Service",
        },
      };

      if (stats.errors.length > 0) {
        embed.fields.push({
          name: "❌ Errors",
          value: stats.errors.slice(0, 3).join("\n") + (stats.errors.length > 3 ? "\n..." : ""),
          inline: false,
        });
      }

      await channel.send({ embeds: [embed] });
      logger.info("Cleanup notification sent successfully");
    } catch (error) {
      logger.error("Error sending cleanup notification:", error);
    }
  }

  public getStatus(): {
    enabled: boolean;
    isRunning: boolean;
    lastCleanupDate: Date | null;
    isConnected: boolean;
  } {
    return {
      enabled: false, // Will be updated when we implement the config check
      isRunning: this.isRunning,
      lastCleanupDate: this.lastCleanupDate,
      isConnected: this.isConnected,
    };
  }

  public destroy(): void {
    this.isRunning = false;
    logger.info("Voice channel truncation service destroyed");
  }
}
