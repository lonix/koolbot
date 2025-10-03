import { Client, ActivityType } from "discord.js";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";

export class BotStatusService {
  private static instance: BotStatusService;
  private client: Client;
  private configService: ConfigService;
  private isInitialized = false;
  private currentVcUserCount = 0;
  private currentVcUserName = "";
  private statusUpdateInterval: ReturnType<typeof setInterval> | null = null;

  // Fun status messages for different scenarios
  private readonly lonelyStatuses = [
    "is lonely",
    "kinda bored ngl",
    "contemplating existence",
    "counting pixels",
    "having a midlife crisis",
    "playing solitaire",
    "staring at the void",
    "having an existential crisis",
    "feeling like a background character",
    "contemplating the meaning of life",
  ];

  private readonly singleUserStatuses = [
    "{user} is alone and crying",
    "please i cant listen to {user} anymore",
    "someone please save me from {user}",
    "{user} is talking to themselves again",
    "help {user} is having a breakdown",
    "{user} is having an existential crisis",
    "i'm trapped with {user} send help",
    "{user} is going insane please help",
    "someone rescue me from {user}",
    "{user} is having a midlife crisis",
  ];

  private readonly multipleUsersStatuses = [
    "watching {count} nerds",
    "stalking {count} souls",
    "observing {count} humans",
    "babysitting {count} chatters",
    "watching {count} socialize",
    "keeping tabs on {count} gamers",
    "watching {count} conversations",
    "keeping {count} from walls",
    "observing {count} madness",
    "watching {count} crises",
  ];

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  /**
   * Get a random status message based on the current VC user count
   */
  private getRandomStatusMessage(): string {
    if (this.currentVcUserCount === 0) {
      return this.lonelyStatuses[
        Math.floor(Math.random() * this.lonelyStatuses.length)
      ];
    } else if (this.currentVcUserCount === 1) {
      const template =
        this.singleUserStatuses[
          Math.floor(Math.random() * this.singleUserStatuses.length)
        ];
      return template.replace("{user}", this.currentVcUserName || "someone");
    } else {
      const template =
        this.multipleUsersStatuses[
          Math.floor(Math.random() * this.multipleUsersStatuses.length)
        ];
      return template.replace("{count}", this.currentVcUserCount.toString());
    }
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
        activities: [
          {
            name: "Connecting to Discord...",
            type: ActivityType.Watching,
          },
        ],
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
        activities: [
          {
            name: "Reloading configuration...",
            type: ActivityType.Watching,
          },
        ],
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
        activities: [
          {
            name: "Shutting down...",
            type: ActivityType.Watching,
          },
        ],
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
        activities: [],
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
      const activityName = this.getRandomStatusMessage();

      this.client.user?.setPresence({
        status: "online",
        activities: [
          {
            name: activityName,
            type: ActivityType.Watching,
          },
        ],
      });

      logger.debug(`Bot activity updated: ${activityName}`);
    } catch (error) {
      logger.error("Failed to update bot activity:", error);
    }
  }

  /**
   * Update the VC user count and refresh activity
   */
  public updateVcUserCount(count: number, userName?: string): void {
    if (this.currentVcUserCount !== count || this.currentVcUserName !== userName) {
      this.currentVcUserCount = count;
      this.currentVcUserName = userName || "";
      this.updateActivityBasedOnVcUsers();
      logger.debug(`VC user count updated: ${count}${userName ? ` (${userName})` : ""}`);
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
      isMonitoring: this.statusUpdateInterval !== null,
    };
  }
}
