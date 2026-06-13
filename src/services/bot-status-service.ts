import { Client, ActivityType } from "discord.js";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import { BotStatusMessage } from "../models/bot-status-message.js";
import {
  STATUS_POOL_DEFAULTS,
  BOT_STATUS_POOLS,
  type BotStatusPool,
} from "../content/statuses.js";

type StatusPools = Record<BotStatusPool, string[]>;

/**
 * How often the status monitor re-syncs the VC user count from the
 * provider as a defensive self-heal (in case a `voiceStateUpdate` event
 * is ever missed). It's a cheap cache walk, no Discord API call.
 */
const VC_COUNT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Fresh, mutable copy of the hardcoded defaults for every pool. */
function defaultStatusPools(): StatusPools {
  return {
    lonely: [...STATUS_POOL_DEFAULTS.lonely],
    single: [...STATUS_POOL_DEFAULTS.single],
    multiple: [...STATUS_POOL_DEFAULTS.multiple],
  };
}

export class BotStatusService {
  private static instance: BotStatusService;
  private client: Client;
  private configService: ConfigService;
  private isInitialized = false;
  private currentVcUserCount = 0;
  // Username tracking removed for simplified status logic (field deleted)
  private statusUpdateInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Pulls the current total VC user count on demand (a cache walk over the
   * managed category's voice channels). Registered at startup so the count
   * can be primed once the client is ready and re-synced on the monitor
   * interval, instead of relying solely on `voiceStateUpdate` events.
   */
  private vcUserCountProvider: (() => Promise<number>) | null = null;
  /**
   * In-memory copy of the live status pools, seeded with the hardcoded
   * defaults so `getRandomStatusMessage()` (which is synchronous, called
   * from presence updates) always has something to pick from — even
   * before the first DB read or when the store is empty. Refreshed from
   * the DB at startup, on `/config reload`, and after every WebUI edit.
   */
  private statusPools: StatusPools = defaultStatusPools();

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    // Re-read the pools when configuration is reloaded so a `/config
    // reload` picks up store changes without a redeploy, mirroring the
    // reload-callback pattern used by the other services.
    this.configService.registerReloadCallback(async () => {
      await this.refreshStatusPools();
    });
  }

  /**
   * Reload the status pools from the DB store, falling back to the
   * hardcoded defaults for any pool with no stored rows. Safe to call
   * repeatedly; never throws — on error the existing cached pools are
   * kept so presence updates keep working.
   */
  public async refreshStatusPools(): Promise<void> {
    try {
      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        // No guild bound (e.g. early startup / tests): reset to defaults.
        this.statusPools = defaultStatusPools();
      } else {
        const rows = await BotStatusMessage.find({ guildId })
          .sort({ pool: 1, order: 1 })
          .lean();

        const next = defaultStatusPools();
        const stored: Partial<Record<BotStatusPool, string[]>> = {};
        for (const row of rows) {
          const pool = row.pool;
          (stored[pool] ??= []).push(row.text);
        }
        for (const pool of BOT_STATUS_POOLS) {
          const list = stored[pool];
          // Empty store for a pool → keep that pool's built-in defaults.
          if (list && list.length > 0) {
            next[pool] = list;
          }
        }
        this.statusPools = next;
        logger.debug("Bot status pools refreshed from store");
      }
      // Re-render the presence now so a WebUI edit or `/config reload`
      // takes effect immediately instead of waiting for the next VC
      // count change. No-op until the service is operational.
      this.updateActivityBasedOnVcUsers();
    } catch (error) {
      logger.error("Failed to refresh bot status pools:", error);
    }
  }

  /**
   * Get a random status message based on the current VC user count
   */
  private getRandomStatusMessage(): string {
    // Simplified: only differentiate between 0, 1, and many users; no name interpolation
    const pickFrom = (list: string[]): string =>
      list[Math.floor(Math.random() * list.length)];

    if (this.currentVcUserCount <= 0) {
      return pickFrom(this.statusPools.lonely);
    }
    if (this.currentVcUserCount === 1) {
      return pickFrom(this.statusPools.single);
    }
    const template = pickFrom(this.statusPools.multiple);
    return template.replace("{count}", this.currentVcUserCount.toString());
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
      // Render immediately from the seeded defaults so presence works at
      // once, then load the live pools from the store in the background
      // (refreshStatusPools re-renders once the curated lists arrive).
      this.updateActivityBasedOnVcUsers();
      void this.refreshStatusPools();
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
   * Register a function that reports the live total VC user count. Used to
   * prime the count at startup and to self-heal it on the monitor interval.
   */
  public setVcUserCountProvider(provider: () => Promise<number>): void {
    this.vcUserCountProvider = provider;
  }

  /**
   * Pull the current VC user count from the registered provider and apply
   * it. No-op (and never throws) when no provider is registered or the
   * lookup fails, so it's safe to call from startup and interval ticks.
   */
  public async refreshVcUserCount(): Promise<void> {
    if (!this.vcUserCountProvider) return;
    try {
      const count = await this.vcUserCountProvider();
      this.updateVcUserCount(count);
    } catch (error) {
      logger.error("Failed to refresh VC user count:", error);
    }
  }

  /**
   * Update the VC user count and refresh activity
   */
  public updateVcUserCount(count: number): void {
    // Ignore usernames entirely; only react to count changes
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

    // Periodically re-sync the count from the provider so the presence
    // self-heals if a `voiceStateUpdate` event is ever missed (e.g. a
    // gateway hiccup), not only when voice state changes. The provider is
    // a cheap cache walk, so this stays inexpensive.
    this.statusUpdateInterval = setInterval(() => {
      void this.refreshVcUserCount();
    }, VC_COUNT_REFRESH_INTERVAL_MS);
    // Don't let this background self-heal timer keep the process alive on
    // shutdown (and avoid leaking an open handle in tests).
    this.statusUpdateInterval.unref?.();

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
