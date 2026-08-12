import { TextChannel, VoiceChannel, CategoryChannel } from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";
import { DependencyError, hasOwn } from "./config-schema.js";
import type { IConfig } from "../models/config.js";

export interface WizardConfiguration {
  [key: string]: string | number | boolean;
}

/**
 * Outcome of a wizard apply (#780). A plain boolean can't describe a batch
 * that failed partway through, so the result reports exactly which keys were
 * written, which were restored to their prior state, and which (if any) could
 * not be restored and are therefore live in the config store.
 */
export interface WizardApplyResult {
  /** True when every setting persisted and the config reload ran. */
  success: boolean;
  /** Keys persisted by this call, in apply order (includes keys that were later rolled back). */
  appliedKeys: string[];
  /** The key whose write failed, when a per-key write threw. */
  failedKey?: string;
  /** Human-readable reason for a failure (per-key write, reload, or missing session). */
  errorMessage?: string;
  /** Keys that were persisted and then successfully restored to their prior state. */
  rolledBackKeys: string[];
  /** Keys that were persisted but could not be restored — they remain in effect. */
  revertFailedKeys: string[];
}

export interface DetectedResources {
  categories?: CategoryChannel[];
  voiceChannels?: VoiceChannel[];
  textChannels?: TextChannel[];
}

export interface WizardState {
  userId: string;
  guildId: string;
  currentStep: number;
  selectedFeatures: string[];
  configuration: WizardConfiguration;
  detectedResources: DetectedResources;
  startTime: Date;
  messageId?: string;
  allowNavigation: boolean;
  channelPage?: number; // Track current page for channel selection
}

/**
 * Service for managing wizard state and flow
 * Provides session-based state management with automatic cleanup
 */
export class WizardService {
  private static instance: WizardService;
  private sessions: Map<string, WizardState> = new Map();
  private readonly SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private configService: ConfigService;

  private constructor() {
    this.configService = ConfigService.getInstance();
    this.startCleanupTimer();
  }

  static getInstance(): WizardService {
    if (!WizardService.instance) {
      WizardService.instance = new WizardService();
    }
    return WizardService.instance;
  }

  /**
   * Start periodic cleanup of expired sessions
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      try {
        this.cleanupExpiredSessions();
      } catch (error) {
        logger.error("WizardService: error during session cleanup:", error);
      }
    }, 60000); // Check every minute

    // Don't keep the event loop alive solely for this background cleanup.
    this.cleanupInterval.unref?.();
  }

  /**
   * Clean up expired wizard sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    this.sessions.forEach((state, key) => {
      const elapsed = now - state.startTime.getTime();
      if (elapsed > this.SESSION_TIMEOUT_MS) {
        this.sessions.delete(key);
        cleaned++;
      }
    });

    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} expired wizard sessions`);
    }
  }

  /**
   * Create a new wizard session
   */
  createSession(
    userId: string,
    guildId: string,
    selectedFeatures: string[] = [],
  ): WizardState {
    const sessionKey = this.getSessionKey(userId, guildId);

    // End any existing session for this user
    if (this.sessions.has(sessionKey)) {
      logger.debug(`Replacing existing wizard session for user ${userId}`);
      this.sessions.delete(sessionKey);
    }

    const state: WizardState = {
      userId,
      guildId,
      currentStep: 0,
      selectedFeatures,
      configuration: {},
      detectedResources: {},
      startTime: new Date(),
      allowNavigation: true,
      channelPage: 0,
    };

    this.sessions.set(sessionKey, state);
    logger.debug(
      `Created wizard session for user ${userId} in guild ${guildId}`,
    );
    return state;
  }

  /**
   * Get an existing wizard session
   */
  getSession(userId: string, guildId: string): WizardState | null {
    const sessionKey = this.getSessionKey(userId, guildId);
    const state = this.sessions.get(sessionKey);

    if (!state) {
      return null;
    }

    // Check if session has expired
    const elapsed = Date.now() - state.startTime.getTime();
    if (elapsed > this.SESSION_TIMEOUT_MS) {
      this.sessions.delete(sessionKey);
      logger.debug(`Wizard session expired for user ${userId}`);
      return null;
    }

    return state;
  }

  /**
   * Update wizard state
   */
  updateSession(
    userId: string,
    guildId: string,
    updates: Partial<WizardState>,
  ): boolean {
    const sessionKey = this.getSessionKey(userId, guildId);
    const state = this.sessions.get(sessionKey);

    if (!state) {
      logger.warn(`No wizard session found for user ${userId}`);
      return false;
    }

    // Merge updates
    Object.assign(state, updates);
    this.sessions.set(sessionKey, state);
    return true;
  }

  /**
   * Add configuration to wizard state
   */
  addConfiguration(
    userId: string,
    guildId: string,
    key: string,
    value: string | number | boolean,
  ): boolean {
    const state = this.getSession(userId, guildId);
    if (!state) {
      return false;
    }

    state.configuration[key] = value;
    return this.updateSession(userId, guildId, state);
  }

  /**
   * Get configuration value from wizard state
   */
  getConfiguration(
    userId: string,
    guildId: string,
    key: string,
  ): string | number | boolean | undefined {
    const state = this.getSession(userId, guildId);
    if (!state) {
      return undefined;
    }

    return state.configuration[key];
  }

  /**
   * Navigate to a specific step
   */
  navigateToStep(userId: string, guildId: string, step: number): boolean {
    const state = this.getSession(userId, guildId);
    if (!state) {
      return false;
    }

    if (!state.allowNavigation) {
      logger.warn(`Navigation disabled for wizard session ${userId}`);
      return false;
    }

    state.currentStep = step;
    return this.updateSession(userId, guildId, state);
  }

  /**
   * Move to next step
   */
  nextStep(userId: string, guildId: string): boolean {
    const state = this.getSession(userId, guildId);
    if (!state) {
      return false;
    }

    state.currentStep++;
    return this.updateSession(userId, guildId, state);
  }

  /**
   * Move to previous step
   */
  previousStep(userId: string, guildId: string): boolean {
    const state = this.getSession(userId, guildId);
    if (!state) {
      return false;
    }

    if (state.currentStep > 0) {
      state.currentStep--;
      return this.updateSession(userId, guildId, state);
    }

    return false;
  }

  /**
   * Apply all configuration changes from wizard.
   *
   * The batch is atomic in effect (#780): prior values are snapshotted before
   * anything is written, and a mid-batch write failure triggers a best-effort
   * rollback of the keys already persisted. If any rollback itself fails, the
   * config reload still runs so services on registered reload callbacks pick
   * up what actually persisted rather than silently lagging behind the DB,
   * and the returned result names the keys left in effect.
   */
  async applyConfiguration(
    userId: string,
    guildId: string,
  ): Promise<WizardApplyResult> {
    const state = this.getSession(userId, guildId);
    if (!state) {
      logger.error(`No wizard session found for user ${userId}`);
      return {
        success: false,
        appliedKeys: [],
        rolledBackKeys: [],
        revertFailedKeys: [],
        errorMessage: "No active wizard session",
      };
    }

    // Validate the whole proposed batch against the feature dependency graph
    // (#663) before writing anything. Validating the batch (rather than each
    // key in isolation) lets an operator enable a feature and its dependency
    // together in one wizard run. A violation aborts the apply with an
    // operator-friendly message so the caller can surface it; partial writes
    // are avoided because nothing has been persisted yet.
    const issues = await this.configService.findDependencyIssues(
      state.configuration,
    );
    if (issues.length > 0) {
      throw new DependencyError(issues);
    }

    const entries = Object.entries(state.configuration);
    logger.info(
      `Applying wizard configuration for user ${userId}: ${entries.length} settings`,
    );

    // Snapshot the stored rows for the batch's keys before writing anything,
    // so a mid-batch failure can restore each written key to its exact prior
    // state — a key with no stored row is deleted on rollback rather than
    // left behind with a wizard-supplied value.
    const priorRows = new Map<string, IConfig>();
    for (const row of await this.configService.getAll()) {
      if (hasOwn(state.configuration, row.key)) {
        priorRows.set(row.key, row);
      }
    }

    // Apply each configuration setting. The batch was already validated
    // above, so per-key dependency checks are skipped to avoid spurious
    // ordering-dependent rejections within the batch.
    const appliedKeys: string[] = [];
    let failedKey: string | undefined;
    let errorMessage: string | undefined;
    for (const [key, value] of entries) {
      const category = key.split(".")[0];
      const description = this.getSettingDescription(key);
      try {
        await this.configService.set(key, value, description, category, {
          skipDependencyCheck: true,
        });
        appliedKeys.push(key);
        logger.debug(`Set ${key} = ${value}`);
      } catch (error) {
        failedKey = key;
        errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Error applying wizard configuration at ${key}:`, error);
        break;
      }
    }

    if (failedKey === undefined) {
      try {
        await this.configService.triggerReload();
      } catch (error) {
        // Every key persisted (and is cached), but the reload didn't run, so
        // callback-driven services are still on their old config. Surface
        // that precisely instead of pretending nothing was written.
        logger.error(
          "Error reloading configuration after wizard apply:",
          error,
        );
        return {
          success: false,
          appliedKeys,
          rolledBackKeys: [],
          revertFailedKeys: [],
          errorMessage:
            "All settings were saved, but the configuration reload failed — run /config reload to apply them",
        };
      }
      logger.info(
        `Successfully applied wizard configuration for user ${userId}`,
      );
      return {
        success: true,
        appliedKeys,
        rolledBackKeys: [],
        revertFailedKeys: [],
      };
    }

    // A write failed partway through the batch: best-effort revert of the
    // keys persisted before the failure, newest first.
    const rolledBackKeys: string[] = [];
    const revertFailedKeys: string[] = [];
    for (const key of [...appliedKeys].reverse()) {
      try {
        const prior = priorRows.get(key);
        if (prior) {
          await this.configService.set(
            key,
            prior.value,
            prior.description,
            prior.category,
            { skipDependencyCheck: true },
          );
        } else {
          await this.configService.delete(key);
        }
        rolledBackKeys.push(key);
      } catch (error) {
        revertFailedKeys.push(key);
        logger.error(`Failed to roll back wizard setting ${key}:`, error);
      }
    }

    if (revertFailedKeys.length > 0) {
      // Some writes could not be undone, so the DB has changed. Reload so
      // services pick those values up immediately instead of diverging from
      // the store until the next /config reload or restart.
      try {
        await this.configService.triggerReload();
      } catch (reloadError) {
        logger.error(
          "Error reloading configuration after partial wizard apply:",
          reloadError,
        );
      }
    }

    return {
      success: false,
      appliedKeys,
      failedKey,
      errorMessage,
      rolledBackKeys,
      revertFailedKeys,
    };
  }

  /**
   * End a wizard session
   */
  endSession(userId: string, guildId: string): boolean {
    const sessionKey = this.getSessionKey(userId, guildId);
    const existed = this.sessions.has(sessionKey);

    if (existed) {
      this.sessions.delete(sessionKey);
      logger.debug(`Ended wizard session for user ${userId}`);
    }

    return existed;
  }

  /**
   * Get session key from user ID and guild ID
   */
  private getSessionKey(userId: string, guildId: string): string {
    return `${guildId}:${userId}`;
  }

  /**
   * Get description for a configuration key
   */
  private getSettingDescription(key: string): string {
    const descriptions: Record<string, string> = {
      "voicechannels.enabled":
        "Enable/disable dynamic voice channel management",
      "voicechannels.category_id":
        "Discord category ID for managed voice channels",
      "voicechannels.lobby.name": "Name of the lobby channel",
      "voicechannels.lobby.offlinename": "Name of the offline lobby channel",
      "voicechannels.channel.prefix": "Prefix for dynamically created channels",
      "voicechannels.channel.suffix": "Suffix for dynamically created channels",
      "voicetracking.enabled": "Enable/disable voice activity tracking",
      "voicetracking.seen.enabled": "Enable/disable last seen tracking",
      "voicetracking.announcements.enabled":
        "Enable/disable weekly voice channel announcements",
      "voicetracking.announcements.schedule":
        "Cron expression for weekly announcements",
      "voicetracking.announcements.channel_id":
        "Discord channel ID for voice channel announcements",
      "quotes.enabled": "Enable/disable quote system",
      "quotes.channel_id": "Channel ID for quote messages",
      "quotes.delete_roles": "Comma-separated role IDs that can delete quotes",
      "achievements.enabled": "Enable/disable achievements system",
    };

    return descriptions[key] || "Configuration setting";
  }

  /**
   * Cleanup on shutdown
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
    logger.info("WizardService shutdown complete");
  }
}
