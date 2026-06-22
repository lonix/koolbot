import { Collection } from "discord.js";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { CommandMetrics as CommandMetricsModel } from "../models/command-metrics.js";
import { ConfigService } from "./config-service.js";

interface CommandMetrics {
  name: string;
  usageCount: number;
  totalResponseTime: number;
  averageResponseTime: number;
  errorCount: number;
  lastUsed: Date;
  firstUsed: Date;
}

/**
 * Accumulated counters for a single `{guildId, command, date}` bucket,
 * waiting to be flushed to MongoDB. Batching these in memory keeps the DB
 * write off the per-invocation hot path (issue #648).
 */
interface PendingBucket {
  command: string;
  guildId: string;
  /** UTC "YYYY-MM-DD" day key. */
  date: string;
  usageCount: number;
  errorCount: number;
  totalResponseMs: number;
  firstUsedAt: Date;
  lastUsedAt: Date;
}

/**
 * How often the pending buckets are flushed to MongoDB. Comfortably under
 * the "at least once per hour" bar from the issue, while still batching so
 * a busy guild doesn't trigger a write per command.
 */
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hard cap on the number of distinct pending buckets held in memory. A
 * prolonged DB outage makes `flushMetrics` keep (rather than drain) the
 * buffer, so without a cap a busy multi-guild bot could accumulate buckets
 * without bound and OOM during the very incident that caused the outage.
 * At the cap, new buckets are dropped (with a one-shot warning) while
 * already-tracked buckets keep merging. Buckets are tiny, so this still
 * allows tens of thousands — far beyond any legitimate
 * commands x guilds x days working set — before shedding load.
 */
export const MAX_PENDING_BUCKETS = 50_000;

function pendingKey(guildId: string, command: string, date: string): string {
  // NUL separator can't appear in a command name or snowflake.
  return `${guildId}\u0000${command}\u0000${date}`;
}

interface PerformanceMetrics {
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  uptime: number;
  totalCommands: number;
  totalErrors: number;
  averageResponseTime: number;
}

export class MonitoringService {
  private static instance: MonitoringService;
  private commandMetrics: Collection<string, CommandMetrics> = new Collection();
  private startTime: Date = new Date();
  private totalCommands: number = 0;
  private totalErrors: number = 0;
  private periodicLoggingInterval: ReturnType<typeof setInterval> | null = null;
  // Per-bucket counters awaiting a batched DB flush (issue #648).
  private pendingBuckets: Map<string, PendingBucket> = new Map();
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  // Latches true once the buffer hits MAX_PENDING_BUCKETS so the cap warning
  // fires once per episode rather than on every dropped bucket. Cleared when
  // the buffer next drains via a successful flush.
  private droppingPending = false;

  private constructor() {
    // Start periodic memory usage logging
    this.startPeriodicLogging();
    // Periodically persist accumulated command metrics to MongoDB.
    this.startPeriodicFlush();
  }

  public static getInstance(): MonitoringService {
    if (!MonitoringService.instance) {
      MonitoringService.instance = new MonitoringService();
    }
    return MonitoringService.instance;
  }

  /**
   * Track command execution start
   */
  public trackCommandStart(commandName: string): string {
    const trackingId = `${commandName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Initialize command metrics if not exists
    if (!this.commandMetrics.has(commandName)) {
      this.commandMetrics.set(commandName, {
        name: commandName,
        usageCount: 0,
        totalResponseTime: 0,
        averageResponseTime: 0,
        errorCount: 0,
        lastUsed: new Date(),
        firstUsed: new Date(),
      });
    }

    const metrics = this.commandMetrics.get(commandName)!;
    metrics.usageCount++;
    metrics.lastUsed = new Date();

    this.totalCommands++;

    logger.debug(`Command started: ${commandName} (ID: ${trackingId})`);
    return trackingId;
  }

  /**
   * Track command execution completion.
   *
   * When a `guildId` is supplied, the invocation is also accumulated into a
   * pending daily bucket for batched persistence to MongoDB (issue #648).
   * Callers that represent a blocked attempt rather than a real execution
   * (permission denied, rate limited) intentionally omit the `guildId` so
   * those don't pollute the historical usage/error counts.
   */
  public trackCommandEnd(
    commandName: string,
    trackingId: string,
    startTime: number,
    success: boolean = true,
    guildId?: string | null,
  ): void {
    const endTime = Date.now();
    const responseTime = endTime - startTime;

    const metrics = this.commandMetrics.get(commandName);
    if (metrics) {
      metrics.totalResponseTime += responseTime;
      metrics.averageResponseTime =
        metrics.totalResponseTime / metrics.usageCount;

      if (!success) {
        metrics.errorCount++;
        this.totalErrors++;
      }
    }

    if (guildId) {
      const now = new Date();
      this.addPending({
        command: commandName,
        guildId,
        date: this.dayKey(now),
        usageCount: 1,
        errorCount: success ? 0 : 1,
        totalResponseMs: responseTime,
        firstUsedAt: now,
        lastUsedAt: now,
      });
    }

    logger.debug(
      `Command completed: ${commandName} (ID: ${trackingId}) - ${responseTime}ms - ${success ? "SUCCESS" : "ERROR"}`,
    );
  }

  /** UTC day-bucket key ("YYYY-MM-DD") for a timestamp. */
  private dayKey(when: Date): string {
    return when.toISOString().slice(0, 10);
  }

  /**
   * Fold a bucket's counters into the pending map, merging with any counters
   * already accumulated for the same `{guildId, command, date}` key. Used both
   * by the live track path and by `flushMetrics` when re-queuing a batch that
   * failed to write.
   */
  private addPending(bucket: PendingBucket): void {
    const key = pendingKey(bucket.guildId, bucket.command, bucket.date);
    const existing = this.pendingBuckets.get(key);
    if (existing) {
      existing.usageCount += bucket.usageCount;
      existing.errorCount += bucket.errorCount;
      existing.totalResponseMs += bucket.totalResponseMs;
      if (bucket.firstUsedAt < existing.firstUsedAt) {
        existing.firstUsedAt = bucket.firstUsedAt;
      }
      if (bucket.lastUsedAt > existing.lastUsedAt) {
        existing.lastUsedAt = bucket.lastUsedAt;
      }
      return;
    }
    // Merging above never adds a key; only a brand-new bucket grows the map.
    // Shed those once at the cap so a DB outage can't drive unbounded growth.
    if (this.pendingBuckets.size >= MAX_PENDING_BUCKETS) {
      if (!this.droppingPending) {
        this.droppingPending = true;
        logger.warn(
          `Command-metrics buffer reached its ${MAX_PENDING_BUCKETS}-bucket cap; ` +
            "dropping new buckets until it drains (is MongoDB reachable?).",
        );
      }
      return;
    }
    this.pendingBuckets.set(key, bucket);
  }

  /**
   * Persist accumulated command-metric buckets to MongoDB in a single
   * `bulkWrite` of upserts (issue #648). Each op increments the matching
   * daily doc's counters and bumps its TTL anchor based on the configured
   * retention.
   *
   * No-op (counters kept for the next tick) when the DB isn't connected, and
   * a guard skips the whole pass when persistence is disabled. A failed write
   * re-queues the whole batch so a transient blip doesn't lose counts. Never
   * throws — safe to call from a timer.
   */
  public async flushMetrics(): Promise<void> {
    if (this.pendingBuckets.size === 0) return;
    if (mongoose.connection.readyState !== 1) return;

    const config = ConfigService.getInstance();
    const enabled = await config
      .getBoolean("monitoring.metrics_persistence.enabled", true)
      .catch(() => true);
    if (!enabled) {
      // Persistence is off — drop the buffer so it can't grow unbounded.
      this.pendingBuckets.clear();
      this.droppingPending = false;
      return;
    }
    const retentionDays = await config
      .getNumber("monitoring.metrics_retention_days", 30)
      .catch(() => 30);

    // Snapshot and clear up front so concurrent tracking accumulates into a
    // fresh batch rather than racing the write below.
    const batch = Array.from(this.pendingBuckets.values());
    this.pendingBuckets.clear();

    const ops = batch.map((bucket) => {
      const expiresAt = new Date(
        bucket.lastUsedAt.getTime() + retentionDays * DAY_MS,
      );
      return {
        updateOne: {
          filter: {
            command: bucket.command,
            date: bucket.date,
            guildId: bucket.guildId,
          },
          update: {
            $inc: {
              usageCount: bucket.usageCount,
              totalResponseMs: bucket.totalResponseMs,
              errorCount: bucket.errorCount,
            },
            $min: { firstUsedAt: bucket.firstUsedAt },
            $max: { lastUsedAt: bucket.lastUsedAt, expiresAt },
          },
          upsert: true,
        },
      };
    });

    try {
      // `ordered: false` so one bad op can't block the rest of the batch.
      await CommandMetricsModel.bulkWrite(ops, { ordered: false });
      // A clean flush drained the buffer — clear the cap-warning latch.
      this.droppingPending = false;
    } catch (error) {
      logger.error("Failed to flush command metrics batch:", error);
      // Re-queue the whole batch so the counts survive a transient DB failure.
      for (const bucket of batch) {
        this.addPending(bucket);
      }
    }
  }

  /**
   * Track error occurrence
   */
  public trackError(commandName: string, error: Error): void {
    this.totalErrors++;

    const metrics = this.commandMetrics.get(commandName);
    if (metrics) {
      metrics.errorCount++;
    }

    logger.error(`Error tracked for command ${commandName}:`, error);
  }

  /**
   * Get command-specific metrics
   */
  public getCommandMetrics(commandName: string): CommandMetrics | undefined {
    return this.commandMetrics.get(commandName);
  }

  /**
   * Get all command metrics
   */
  public getAllCommandMetrics(): CommandMetrics[] {
    return Array.from(this.commandMetrics.values()).sort(
      (a, b) => b.usageCount - a.usageCount,
    );
  }

  /**
   * Get overall performance metrics
   */
  public getPerformanceMetrics(): PerformanceMetrics {
    const totalResponseTime = Array.from(this.commandMetrics.values()).reduce(
      (sum, metrics) => sum + metrics.totalResponseTime,
      0,
    );

    const averageResponseTime =
      this.totalCommands > 0 ? totalResponseTime / this.totalCommands : 0;

    return {
      memoryUsage: process.memoryUsage(),
      uptime: Date.now() - this.startTime.getTime(),
      totalCommands: this.totalCommands,
      totalErrors: this.totalErrors,
      averageResponseTime,
    };
  }

  /**
   * Get top commands by usage
   */
  public getTopCommands(limit: number = 10): CommandMetrics[] {
    return this.getAllCommandMetrics().slice(0, limit);
  }

  /**
   * Get commands with highest error rates
   */
  public getCommandsWithErrors(limit: number = 10): CommandMetrics[] {
    return Array.from(this.commandMetrics.values())
      .filter((metrics) => metrics.errorCount > 0)
      .sort((a, b) => b.errorCount / b.usageCount - a.errorCount / a.usageCount)
      .slice(0, limit);
  }

  /**
   * Get slowest commands
   */
  public getSlowestCommands(limit: number = 10): CommandMetrics[] {
    return Array.from(this.commandMetrics.values())
      .filter((metrics) => metrics.usageCount > 0)
      .sort((a, b) => b.averageResponseTime - a.averageResponseTime)
      .slice(0, limit);
  }

  /**
   * Reset metrics (useful for testing or periodic resets)
   */
  public resetMetrics(): void {
    this.commandMetrics.clear();
    this.totalCommands = 0;
    this.totalErrors = 0;
    this.startTime = new Date();
    logger.info("Monitoring metrics have been reset");
  }

  /**
   * Start periodic logging of performance metrics
   */
  private startPeriodicLogging(): void {
    // Log performance metrics every hour
    this.periodicLoggingInterval = setInterval(
      () => {
        const metrics = this.getPerformanceMetrics();
        const memoryMB = Math.round(metrics.memoryUsage.heapUsed / 1024 / 1024);
        const uptimeHours = Math.round(metrics.uptime / 1000 / 60 / 60);

        logger.info(
          `Performance Metrics - Uptime: ${uptimeHours}h, Commands: ${metrics.totalCommands}, Errors: ${metrics.totalErrors}, Memory: ${memoryMB}MB`,
        );

        // Log top commands every 6 hours
        if (uptimeHours % 6 === 0) {
          const topCommands = this.getTopCommands(5);
          logger.info(
            `Top Commands: ${topCommands.map((cmd) => `${cmd.name}(${cmd.usageCount})`).join(", ")}`,
          );
        }
      },
      60 * 60 * 1000,
    ); // Every hour
  }

  /**
   * Start the periodic batched flush of command metrics to MongoDB.
   */
  private startPeriodicFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flushMetrics().catch((error) => {
        logger.error("Periodic command-metrics flush failed:", error);
      });
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * Format uptime for display
   */
  public formatUptime(): string {
    const uptime = Date.now() - this.startTime.getTime();
    const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
    const hours = Math.floor(
      (uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
    );
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }

  /**
   * Stop periodic logging/flush timers and clear the interval handles.
   *
   * Any metrics still pending are NOT flushed here (destroy is synchronous
   * and runs during shutdown right before the DB connection closes). The
   * shutdown path awaits `flushMetrics()` explicitly before calling this so
   * the final batch isn't lost.
   */
  public destroy(): void {
    if (this.periodicLoggingInterval) {
      clearInterval(this.periodicLoggingInterval);
      this.periodicLoggingInterval = null;
    }
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }
}
