import { TextChannel, VoiceChannel, CategoryChannel } from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";

export interface WizardConfiguration {
  [key: string]: string | number | boolean;
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
  private cleanupInterval: ReturnType<typeof setTimeout> | null = null;
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
      this.cleanupExpiredSessions();
    }, 60000); // Check every minute
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
   * Apply all configuration changes from wizard
   */
  async applyConfiguration(userId: string, guildId: string): Promise<boolean> {
    const state = this.getSession(userId, guildId);
    if (!state) {
      logger.error(`No wizard session found for user ${userId}`);
      return false;
    }

    try {
      logger.info(
        `Applying wizard configuration for user ${userId}: ${Object.keys(state.configuration).length} settings`,
      );

      // Apply each configuration setting
      for (const [key, value] of Object.entries(state.configuration)) {
        const category = key.split(".")[0];
        const description = this.getSettingDescription(key);
        await this.configService.set(key, value, description, category);
        logger.debug(`Set ${key} = ${value}`);
      }

      // Trigger reload to apply changes
      await this.configService.triggerReload();
      logger.info(
        `Successfully applied wizard configuration for user ${userId}`,
      );

      return true;
    } catch (error) {
      logger.error("Error applying wizard configuration:", error);
      return false;
    }
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
      "voicechannels.category.name": "Name of the category for voice channels",
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
      "voicetracking.announcements.channel":
        "Channel name for voice channel announcements",
      "voicetracking.admin_roles":
        "Comma-separated role names that can manage tracking",
      "quotes.enabled": "Enable/disable quote system",
      "quotes.channel_id": "Channel ID for quote messages",
      "quotes.add_roles": "Comma-separated role IDs that can add quotes",
      "quotes.delete_roles": "Comma-separated role IDs that can delete quotes",
      "achievements.enabled": "Enable/disable achievements system",
      "core.startup.enabled":
        "Enable/disable Discord logging for bot startup/shutdown events",
      "core.startup.channel_id":
        "Discord channel ID for startup/shutdown logging",
      "core.errors.enabled":
        "Enable/disable Discord logging for critical errors",
      "core.errors.channel_id": "Discord channel ID for error logging",
      "core.config.enabled":
        "Enable/disable Discord logging for configuration changes",
      "core.config.channel_id": "Discord channel ID for config change logging",
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
