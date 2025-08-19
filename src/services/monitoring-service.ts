import { Collection } from "discord.js";
import logger from "../utils/logger.js";

interface CommandMetrics {
  name: string;
  usageCount: number;
  totalResponseTime: number;
  averageResponseTime: number;
  errorCount: number;
  lastUsed: Date;
  firstUsed: Date;
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

  private constructor() {
    // Start periodic memory usage logging
    this.startPeriodicLogging();
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
   * Track command execution completion
   */
  public trackCommandEnd(
    commandName: string,
    trackingId: string,
    startTime: number,
    success: boolean = true,
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

    logger.debug(
      `Command completed: ${commandName} (ID: ${trackingId}) - ${responseTime}ms - ${success ? "SUCCESS" : "ERROR"}`,
    );
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
    setInterval(
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
}
