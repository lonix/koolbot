import { Client, ActivityType } from "discord.js";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";

export class BotStatusService {
  private static instance: BotStatusService;
  private client: Client;
  private configService: ConfigService;
  private isInitialized = false;
  private currentVcUserCount = 0;
  private statusUpdateInterval: ReturnType<typeof setInterval> | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): BotStatusService {
    if (!BotStatusService.instance) {
      BotStatusService.instance = new BotStatusService(client);
    }
    return BotStatusService.instance;
  }

  /**
   * Set the bot to connecting status (yellow)
   */
  public setConnectingStatus(): void {
    try {
      this.client.user?.setPresence({
        status: "idle",
        activities: [{
          name: "Connecting to Discord...",
          type: ActivityType.Watching
        }]
      });
      logger.info("Bot status set to: Connecting (Yellow)");
    } catch (error) {
      logger.error("Failed to set connecting status:", error);
    }
  }

  /**
   * Set the bot to fully operational status (green)
   */
  public setOperationalStatus(): void {
    try {
      this.isInitialized = true;
      this.updateActivityBasedOnVcUsers();
      logger.info("Bot status set to: Fully Operational (Green)");
    } catch (error) {
      logger.error("Failed to set operational status:", error);
    }
  }

  /**
   * Set the bot to config reload status (yellow)
   */
  public setConfigReloadStatus(): void {
    try {
      this.client.user?.setPresence({
        status: "idle",
        activities: [{
          name: "Reloading configuration...",
          type: ActivityType.Watching
        }]
      });
      logger.info("Bot status set to: Config Reload (Yellow)");
    } catch (error) {
      logger.error("Failed to set config reload status:", error);
    }
  }

  /**
   * Set the bot to shutdown status (yellow)
   */
  public setShutdownStatus(): void {
    try {
      this.client.user?.setPresence({
        status: "idle",
        activities: [{
          name: "Shutting down...",
          type: ActivityType.Watching
        }]
      });
      logger.info("Bot status set to: Shutting Down (Yellow)");
    } catch (error) {
      logger.error("Failed to set shutdown status:", error);
    }
  }

  /**
   * Set the bot to invisible (offline)
   */
  public setInvisibleStatus(): void {
    try {
      this.client.user?.setPresence({
        status: "invisible",
        activities: []
      });
      logger.info("Bot status set to: Invisible (Offline)");
    } catch (error) {
      logger.error("Failed to set invisible status:", error);
    }
  }

  /**
   * Update the bot's activity based on current VC user count
   */
  public updateActivityBasedOnVcUsers(): void {
    if (!this.isInitialized) return;

    try {
      const activityName = this.currentVcUserCount === 0
        ? "Watching nobody"
        : `Watching over ${this.currentVcUserCount} ${this.currentVcUserCount === 1 ? 'nerd' : 'nerds'}`;

      this.client.user?.setPresence({
        status: "online",
        activities: [{
          name: activityName,
          type: ActivityType.Watching
        }]
      });

      logger.debug(`Bot activity updated: ${activityName}`);
    } catch (error) {
      logger.error("Failed to update bot activity:", error);
    }
  }

  /**
   * Update the VC user count and refresh activity
   */
  public updateVcUserCount(count: number): void {
    if (this.currentVcUserCount !== count) {
      this.currentVcUserCount = count;
      this.updateActivityBasedOnVcUsers();
      logger.debug(`VC user count updated: ${count}`);
    }
  }

  /**
   * Start monitoring voice channel users for activity updates
   */
  public startVcMonitoring(): void {
    // Clear any existing interval
    if (this.statusUpdateInterval) {
      clearInterval(this.statusUpdateInterval);
    }

    // Update status every 30 seconds to keep it fresh
    this.statusUpdateInterval = setInterval(() => {
      this.updateActivityBasedOnVcUsers();
    }, 30000);

    logger.info("Started VC user monitoring for bot status updates");
  }

  /**
   * Stop monitoring voice channel users
   */
  public stopVcMonitoring(): void {
    if (this.statusUpdateInterval) {
      clearInterval(this.statusUpdateInterval);
      this.statusUpdateInterval = null;
      logger.info("Stopped VC user monitoring");
    }
  }

  /**
   * Clean shutdown - set status to invisible
   */
  public async shutdown(): Promise<void> {
    try {
      logger.info("Bot status service shutting down...");

      // Stop monitoring
      this.stopVcMonitoring();

      // Set to invisible
      this.setInvisibleStatus();

      logger.info("Bot status service shutdown complete");
    } catch (error) {
      logger.error("Error during bot status service shutdown:", error);
    }
  }

  /**
   * Get current status information
   */
  public getStatusInfo(): {
    isInitialized: boolean;
    currentVcUserCount: number;
    isMonitoring: boolean;
  } {
    return {
      isInitialized: this.isInitialized,
      currentVcUserCount: this.currentVcUserCount,
      isMonitoring: this.statusUpdateInterval !== null
    };
  }
}
