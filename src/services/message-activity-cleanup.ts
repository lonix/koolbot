import { Client } from "discord.js";
import logger from "../utils/logger.js";
import { ScheduledService } from "./scheduled-service.js";
import { MessageActivityTracking } from "../models/message-activity-tracking.js";
import { DiscordLogger } from "./discord-logger.js";
import mongoose from "mongoose";

/** Daily at 03:00 — used when no cleanup schedule is configured. */
const DEFAULT_CLEANUP_SCHEDULE = "0 3 * * *";

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
export class MessageActivityCleanupService extends ScheduledService<IMessageCleanupStats> {
  private static instance: MessageActivityCleanupService;
  private discordLogger: DiscordLogger;
  private lastCleanupDate: Date | null = null;

  private constructor(client: Client) {
    super(client, {
      label: "Message activity cleanup service",
      disabledMessage: "Message activity cleanup is disabled",
      cronContext: "message activity cleanup",
      runLabel: "Message cleanup run",
    });
    this.discordLogger = DiscordLogger.getInstance(client);
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
      isRunning: this.isRunning(),
      isScheduled: this.isScheduled(),
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

  protected async resolveSchedule(): Promise<string> {
    return (await this.getSchedule()) || DEFAULT_CLEANUP_SCHEDULE;
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
      await this.start();
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

  /**
   * Run a cleanup pass now (WebUI "run now", or a test). Shares the base
   * class's overlap guard: a call arriving mid-run joins the in-flight pass.
   */
  public async runCleanup(): Promise<IMessageCleanupStats> {
    const stats = await this.runNow();
    return stats ?? this.failureStats("Message cleanup service is disabled");
  }

  private failureStats(message: string): IMessageCleanupStats {
    return {
      messagesPruned: 0,
      usersProcessed: 0,
      executionTime: 0,
      errors: [message],
      timestamp: new Date(),
    };
  }

  protected async runOnce(): Promise<IMessageCleanupStats> {
    if (mongoose.connection.readyState !== 1) {
      throw new Error("Database not connected");
    }

    const startTime = Date.now();

    try {
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
        ...this.failureStats(errorMessage),
        executionTime: Date.now() - startTime,
      };
    }
  }

  private async performCleanup(): Promise<IMessageCleanupStats> {
    const startTime = Date.now();
    let messagesPruned = 0;
    let usersProcessed = 0;
    const errors: string[] = [];

    try {
      const retentionDays = await this.getRetentionDays();

      // `0` means "keep forever" on every retention key (#835). A 0 (or
      // negative) window would put the cutoff at — or after — now and `$pull`
      // every recentMessages entry, so the sweep is skipped instead. Checked
      // on the consumed value so a stray 0 stored before the write boundary
      // refused blank input is covered too.
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        logger.info(
          `Skipping message pruning: message-detail retention is ${retentionDays} (0 = keep forever; only a positive window prunes)`,
        );
        return {
          messagesPruned: 0,
          usersProcessed: 0,
          errors,
          executionTime: Date.now() - startTime,
          timestamp: new Date(),
        };
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      // Count the entries about to be pruned, for reporting only. The
      // deletion below is keyed on the same criterion — not on this count —
      // so a write landing between the two just makes the stats off by one.
      const [pruneCounts] = await MessageActivityTracking.aggregate<{
        messages: number;
      }>([
        { $match: { "recentMessages.sentAt": { $lt: cutoffDate } } },
        {
          $group: {
            _id: null,
            messages: {
              $sum: {
                $size: {
                  $filter: {
                    input: "$recentMessages",
                    cond: { $lt: ["$$this.sentAt", cutoffDate] },
                  },
                },
              },
            },
          },
        },
      ]);

      // Prune expired entries with a scoped, atomic $pull. Reading a
      // snapshot, filtering in memory, and $set-ing the whole array back
      // races with the tracker's concurrent `$push` appends — a message
      // recorded mid-sweep would be silently overwritten (#755). `$pull`
      // is applied atomically per document, so concurrent appends survive.
      // Only recentMessages is touched — channels[] and totalCount are
      // all-time and intentionally preserved.
      const result = await MessageActivityTracking.updateMany(
        { "recentMessages.sentAt": { $lt: cutoffDate } },
        {
          $pull: { recentMessages: { sentAt: { $lt: cutoffDate } } },
          $set: { lastCleanupDate: new Date() },
        },
      );

      messagesPruned = pruneCounts?.messages ?? 0;
      usersProcessed = result.modifiedCount;
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
}
