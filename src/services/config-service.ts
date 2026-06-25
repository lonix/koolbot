import { Config, CONFIG_CATEGORIES, IConfig } from "../models/config.js";
import { env, getEnv } from "../config/env.js";
import logger from "../utils/logger.js";
import { Client } from "discord.js";
import mongoose from "mongoose";
import {
  defaultConfig,
  settingsMetadata,
  getDependencies,
  getDependents,
  validateDependencies,
  hasOwn,
  DependencyError,
  type ConfigSchema,
  type DependencyIssue,
} from "./config-schema.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

export class ConfigService {
  private static instance: ConfigService;
  private cache: Map<string, unknown> = new Map();
  private initialized = false;
  private client: Client | null = null;
  private reloadCallbacks: Set<() => Promise<void>> = new Set();

  private constructor() {}

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  public setClient(client: Client): void {
    this.client = client;
  }

  public registerReloadCallback(callback: () => Promise<void>): void {
    this.reloadCallbacks.add(callback);
  }

  public removeReloadCallback(callback: () => Promise<void>): void {
    this.reloadCallbacks.delete(callback);
  }

  public async triggerReload(): Promise<void> {
    logger.info("Triggering configuration reload...");

    // Clear the cache
    this.cache.clear();
    this.initialized = false;

    // Reinitialize the service
    await this.initialize();

    // Execute all registered reload callbacks
    for (const callback of this.reloadCallbacks) {
      try {
        await callback();
      } catch (error) {
        logger.error("Error during configuration reload callback:", error);
      }
    }

    logger.info("Configuration reload completed");
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure MongoDB is connected
      if (mongoose.connection.readyState !== 1) {
        logger.info("Waiting for MongoDB connection...");
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let pollTimeoutId: ReturnType<typeof setTimeout> | null = null;
          const rejectTimeoutId = setTimeout(() => {
            settled = true;
            if (pollTimeoutId) clearTimeout(pollTimeoutId);
            reject(new Error("MongoDB connection timeout"));
          }, 10000);

          const checkConnection = async (): Promise<void> => {
            if (settled) return;
            try {
              if (mongoose.connection.readyState === 1) {
                settled = true;
                clearTimeout(rejectTimeoutId);
                resolve();
              } else if (mongoose.connection.readyState === 0) {
                // Try to connect if not connected
                await mongoose.connect(env.mongoUri);
                if (settled) return;
                settled = true;
                clearTimeout(rejectTimeoutId);
                resolve();
              } else {
                pollTimeoutId = setTimeout(checkConnection, 100);
              }
            } catch (error) {
              if (settled) return;
              settled = true;
              clearTimeout(rejectTimeoutId);
              if (pollTimeoutId) clearTimeout(pollTimeoutId);
              reject(error);
            }
          };

          checkConnection();
        });
      }

      // Load critical settings from environment variables first
      const criticalSettings = {
        GUILD_ID: getEnv("GUILD_ID"),
        CLIENT_ID: getEnv("CLIENT_ID"),
        DISCORD_TOKEN: getEnv("DISCORD_TOKEN"),
        MONGODB_URI: getEnv("MONGODB_URI"),
        DEBUG: getEnv("DEBUG"),
        NODE_ENV: getEnv("NODE_ENV"),
      };

      for (const [key, value] of Object.entries(criticalSettings)) {
        if (value) {
          this.cache.set(key, value);
        }
      }

      // Load all configs from database
      const configs = await Config.find({});
      for (const config of configs) {
        // Only set if not already set by critical settings
        if (!this.cache.has(config.key)) {
          this.cache.set(config.key, config.value);
        }
      }

      // Clean up old/unknown settings from database
      await this.cleanupUnknownSettings();

      this.initialized = true;
      logger.info("Configuration service initialized");
    } catch (error) {
      logger.error("Error initializing configuration service:", error);
      throw error;
    }
  }

  /**
   * Clean up old/unknown settings from the database
   * This removes settings that are not in the current config schema
   * Note: Critical settings (GUILD_ID, CLIENT_ID, DISCORD_TOKEN, MONGODB_URI, DEBUG, NODE_ENV) must ONLY come
   * from environment variables. MONGODB_URI is needed to establish the database connection, and the others
   * are security-sensitive or required before database access. They will be removed from the database if found.
   */
  private async cleanupUnknownSettings(): Promise<void> {
    try {
      // Get all valid config keys from the schema
      const validKeys = new Set(Object.keys(defaultConfig));

      // Old keys that are known but being migrated (keep them for now)
      const knownOldKeys = [
        "ENABLE_VC_MANAGEMENT",
        "VC_CATEGORY_NAME",
        "LOBBY_CHANNEL_NAME",
        "LOBBY_CHANNEL_NAME_OFFLINE",
        "VC_CHANNEL_PREFIX",
        "VC_SUFFIX",
        "ENABLE_VC_TRACKING",
        "ENABLE_SEEN",
        "EXCLUDED_VC_CHANNELS",
        "ENABLE_VC_WEEKLY_ANNOUNCEMENT",
        "VC_ANNOUNCEMENT_SCHEDULE",
        "VC_ANNOUNCEMENT_CHANNEL",
        "VC_TRACKING_ADMIN_ROLES",
        "ENABLE_PING",
        "ENABLE_QUOTES",
        "QUOTE_ADD_ROLES",
        "QUOTE_DELETE_ROLES",
        "QUOTE_MAX_LENGTH",
        "QUOTE_COOLDOWN",
        // Old gamification keys (renamed to achievements)
        "gamification.enabled",
        "gamification.announcements.enabled",
        "gamification.dm_notifications.enabled",
        // Old dot-notation keys used as fallbacks during migration
        "voice_channel.enabled",
        "voice_channel.category_name",
        "voice_channel.lobby_channel_name",
        "voice_channel.lobby_channel_name_offline",
        "voice_channel.suffix",
        "tracking.enabled",
        "tracking.weekly_announcement_channel",
        // Pre-rename keys preserved until the Discord-ready name→ID
        // migrator runs (see name-id-migrator.ts).
        "voicetracking.announcements.channel",
        "voicechannels.category.name",
        // Runtime bookkeeping keys written by cleanup services. These are
        // not part of defaultConfig (they hold a timestamp, not an
        // operator-tunable default) but must survive the unknown-settings
        // sweep so the 24h cleanup guard persists across restarts.
        "messagetracking.cleanup.last_run",
      ];
      knownOldKeys.forEach((key) => validKeys.add(key));

      // Get all settings from database
      const allSettings = await Config.find({});
      const unknownSettings: string[] = [];
      const invalidCategorySettings: Array<{
        key: string;
        currentCategory: string;
        correctCategory: string;
      }> = [];

      // Category mapping for old to new categories
      const categoryMapping: Record<string, string> = {
        voice_channel: "voicechannels",
        tracking: "voicetracking",
        gamification: "achievements",
      };

      // Valid categories, derived from the single source of truth shared with
      // the Config model's schema enum so the two cannot drift apart (#609).
      // Categories that still have an active normalization mapping (e.g. the
      // legacy `gamification` → `achievements`) are excluded so those rows are
      // routed through the fix-up below instead of being treated as final.
      const validCategories = new Set<string>(CONFIG_CATEGORIES);
      for (const legacyCategory of Object.keys(categoryMapping)) {
        validCategories.delete(legacyCategory);
      }

      // Find unknown settings and settings with invalid categories
      for (const setting of allSettings) {
        if (!validKeys.has(setting.key)) {
          unknownSettings.push(setting.key);
        } else if (!validCategories.has(setting.category)) {
          // Category is invalid, try to fix it
          const correctCategory =
            categoryMapping[setting.category] || setting.key.split(".")[0]; // Use key prefix as category
          if (validCategories.has(correctCategory)) {
            invalidCategorySettings.push({
              key: setting.key,
              currentCategory: setting.category,
              correctCategory,
            });
          } else {
            // Can't fix category, delete the setting
            unknownSettings.push(setting.key);
          }
        }
      }

      // Fix invalid categories
      if (invalidCategorySettings.length > 0) {
        logger.info(
          `🔧 Found ${invalidCategorySettings.length} settings with invalid categories, fixing them...`,
        );

        for (const {
          key,
          currentCategory,
          correctCategory,
        } of invalidCategorySettings) {
          try {
            await Config.updateOne(
              { key },
              { $set: { category: correctCategory } },
            );
            logger.info(
              `  ✓ Fixed category for ${key}: ${currentCategory} → ${correctCategory}`,
            );
          } catch (error) {
            logger.error(`  ✗ Failed to fix category for ${key}:`, error);
          }
        }

        logger.info(
          `✅ Category fix complete: updated ${invalidCategorySettings.length} settings`,
        );
      }

      // Delete unknown settings
      if (unknownSettings.length > 0) {
        logger.info(
          `🧹 Found ${unknownSettings.length} unknown/old settings in database, removing them...`,
        );

        for (const key of unknownSettings) {
          try {
            await Config.deleteOne({ key });
            this.cache.delete(key);
            logger.info(`  ✓ Deleted unknown setting: ${key}`);
          } catch (error) {
            logger.error(`  ✗ Failed to delete setting ${key}:`, error);
          }
        }

        logger.info(
          `✅ Cleanup complete: removed ${unknownSettings.length} unknown settings`,
        );
      } else {
        logger.info("✅ No unknown settings found in database");
      }
    } catch (error) {
      logger.error("Error cleaning up unknown settings:", error);
      // Don't throw - this is not critical to startup
    }
  }

  public async get(key: string): Promise<unknown> {
    try {
      // Check cache first
      if (this.cache.has(key)) {
        return this.cache.get(key);
      }

      // Try to get from database
      const config = await Config.findOne({ key });
      if (config) {
        this.cache.set(key, config.value);
        return config.value;
      }

      // Handle backward compatibility for gamification -> achievements migration
      if (key.startsWith("achievements.")) {
        const oldKey = key.replace("achievements.", "gamification.");
        const oldConfig = await Config.findOne({ key: oldKey });
        if (oldConfig) {
          logger.info(
            `⚠️  Found old gamification config key: ${sanitizeForLog(oldKey)}, migrating to ${sanitizeForLog(key)}`,
          );
          // Migrate the old key to new key. This is a rename carrying the
          // previously-stored value verbatim, not an operator enabling a
          // feature, so it must never be blocked by dependency validation.
          await this.set(
            key,
            oldConfig.value,
            oldConfig.description.replace(/gamification/gi, "achievements"),
            "achievements",
            { skipDependencyCheck: true },
          );
          // Delete the old key
          await Config.deleteOne({ key: oldKey });
          return oldConfig.value;
        }
      }

      // If not found, try to get from environment variables (for backward compatibility)
      const envValue = getEnv(key);
      if (envValue !== undefined && envValue.trim() !== "") {
        // Convert string values to appropriate types
        if (envValue === "true" || envValue === "false") {
          const boolValue = envValue === "true";
          this.cache.set(key, boolValue);
          return boolValue;
        }
        const numValue = Number(envValue);
        if (!isNaN(numValue)) {
          this.cache.set(key, numValue);
          return numValue;
        }
        this.cache.set(key, envValue);
        return envValue;
      }

      // Return null if not found anywhere
      return null;
    } catch (error) {
      logger.error(
        `Error getting configuration for key ${sanitizeForLog(key)}:`,
        error,
      );
      return null;
    }
  }

  public async getString(
    key: string,
    defaultValue: string = "",
  ): Promise<string> {
    const value = await this.get(key);
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return defaultValue;
  }

  public async getBoolean(
    key: string,
    defaultValue: boolean = false,
  ): Promise<boolean> {
    const value = await this.get(key);
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return value === "true";
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    return defaultValue;
  }

  public async getNumber(
    key: string,
    defaultValue: number = 0,
  ): Promise<number> {
    const value = await this.get(key);
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string") {
      const num = Number(value);
      return isNaN(num) ? defaultValue : num;
    }
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    return defaultValue;
  }

  /**
   * Validate a batch of proposed writes against the feature dependency graph
   * (#663) and return any violations (empty array when consistent). Shared by
   * every multi-key write surface — the Settings section save, YAML import, and
   * the Setup Wizard apply — so they all reject the same way and an intra-batch
   * pair (enabling a feature and its dependency together) passes.
   *
   * Dependency state for keys not in the batch is read from the live config via
   * `getBoolean` with a `false` fallback, so a dependent only blocks a disable
   * when it is *actively* turned on — a default-on-but-unset sub-toggle won't.
   */
  public async findDependencyIssues(
    pending: Record<string, unknown>,
  ): Promise<DependencyIssue[]> {
    // Resolve the live state of every dependency/dependent the batch touches
    // but doesn't itself set; keys inside the batch are judged from `pending`.
    const needed = new Set<keyof ConfigSchema>();
    for (const rawKey of Object.keys(pending)) {
      if (!hasOwn(settingsMetadata, rawKey)) continue;
      const schemaKey = rawKey as keyof ConfigSchema;
      for (const dep of getDependencies(schemaKey)) needed.add(dep);
      for (const dependent of getDependents(schemaKey)) needed.add(dependent);
    }
    const snapshot = new Map<keyof ConfigSchema, boolean>();
    for (const relatedKey of needed) {
      if (hasOwn(pending, relatedKey)) continue;
      snapshot.set(relatedKey, await this.getBoolean(relatedKey, false));
    }
    return validateDependencies(pending, (k) => snapshot.get(k) ?? false);
  }

  /**
   * Validate a single proposed write against the feature dependency graph
   * (#663). Throws {@link DependencyError} when enabling a key whose
   * dependency is off, or disabling a key something still depends on. Only
   * schema keys participate; anything else (timestamps, header message IDs,
   * env-mirrored bootstrap keys) returns immediately.
   */
  private async assertDependenciesSatisfied(
    key: string,
    value: unknown,
  ): Promise<void> {
    if (!hasOwn(settingsMetadata, key)) return;
    const issues = await this.findDependencyIssues({ [key]: value });
    if (issues.length > 0) {
      throw new DependencyError(issues);
    }
  }

  /**
   * Persist a config value.
   *
   * By default every write is checked against the feature dependency graph
   * (#663) and rejected with a {@link DependencyError} if it would break it.
   * Pass `skipDependencyCheck` for bulk/system writers that validate the whole
   * batch up front (Setup Wizard apply, Settings section save) or that replace
   * the entire config snapshot (reset-to-defaults, YAML import, env migration),
   * where per-key ordering would otherwise produce spurious rejections.
   */
  public async set<T>(
    key: string,
    value: T,
    description: string,
    category: string,
    options: { skipDependencyCheck?: boolean } = {},
  ): Promise<void> {
    if (!options.skipDependencyCheck) {
      await this.assertDependenciesSatisfied(key, value);
    }
    try {
      await Config.findOneAndUpdate(
        { key },
        {
          key,
          value,
          description,
          category,
          updatedAt: new Date(),
        },
        { upsert: true, new: true },
      );

      this.cache.set(key, value);
      logger.info(
        `Configuration updated: ${sanitizeForLog(key)} = ${sanitizeForLog(value)}`,
      );

      // No automatic reloads - users must manually trigger via /config reload
    } catch (error) {
      logger.error(
        `Error updating configuration ${sanitizeForLog(key)}:`,
        error,
      );
      throw error;
    }
  }

  public async delete(key: string): Promise<void> {
    try {
      await Config.deleteOne({ key });
      this.cache.delete(key);
      logger.info(`Configuration deleted: ${key}`);

      // No automatic reloads - users must manually trigger via /config reload
    } catch (error) {
      logger.error(`Error deleting configuration ${key}:`, error);
      throw error;
    }
  }

  public async getAll(): Promise<IConfig[]> {
    return Config.find({}).sort({ category: 1, key: 1 });
  }

  public async getByCategory(category: string): Promise<IConfig[]> {
    return Config.find({ category }).sort({ key: 1 });
  }

  public async migrateFromEnv(): Promise<void> {
    // Critical settings that should remain in .env
    const criticalSettings = [
      "DISCORD_TOKEN",
      "GUILD_ID",
      "CLIENT_ID",
      "MONGODB_URI",
      "DEBUG",
      "NODE_ENV",
    ];

    const envMappings = [
      // Voice Channel Management
      {
        key: "ENABLE_VC_MANAGEMENT",
        category: "voicechannels",
        description: "Enable/disable voice channel management",
        defaultValue: "true",
      },
      {
        key: "VC_CATEGORY_NAME",
        category: "voicechannels",
        description: "Name of the category for voice channels",
        defaultValue: "Voice Channels",
      },
      {
        key: "LOBBY_CHANNEL_NAME",
        category: "voicechannels",
        description: "Name of the lobby channel",
        defaultValue: "Lobby",
      },
      {
        key: "LOBBY_CHANNEL_NAME_OFFLINE",
        category: "voicechannels",
        description: "Name of the offline lobby channel",
        defaultValue: "Offline Lobby",
      },
      {
        key: "VC_CHANNEL_PREFIX",
        category: "voicechannels",
        description: "Prefix for dynamically created channels",
        defaultValue: "🎮",
      },
      {
        key: "VC_SUFFIX",
        category: "voicechannels",
        description: "Suffix for dynamically created channels",
        defaultValue: "",
      },

      // Voice Channel Tracking
      {
        key: "ENABLE_VC_TRACKING",
        category: "voicetracking",
        description: "Enable/disable voice channel tracking",
        defaultValue: "true",
      },
      {
        key: "ENABLE_SEEN",
        category: "voicetracking",
        description: "Enable/disable last seen tracking",
        defaultValue: "true",
      },
      {
        key: "EXCLUDED_VC_CHANNELS",
        category: "voicetracking",
        description:
          "Comma-separated list of voice channel IDs to exclude from tracking",
        defaultValue: "",
      },
      {
        key: "ENABLE_VC_WEEKLY_ANNOUNCEMENT",
        category: "voicetracking",
        description: "Enable/disable weekly voice channel announcements",
        defaultValue: "true",
      },
      {
        key: "VC_ANNOUNCEMENT_SCHEDULE",
        category: "voicetracking",
        description: "Cron expression for weekly announcements",
        defaultValue: "0 16 * * 5",
      },
      {
        key: "VC_ANNOUNCEMENT_CHANNEL",
        category: "voicetracking",
        description: "Channel name for voice channel announcements",
        defaultValue: "voice-stats",
      },
    ];

    const migratedSettings: string[] = [];
    const skippedSettings: string[] = [];

    for (const mapping of envMappings) {
      // Skip if this is a critical setting
      if (criticalSettings.includes(mapping.key)) {
        continue;
      }

      // Check if this setting already exists in the database
      const existingConfig = await Config.findOne({ key: mapping.key });
      if (existingConfig) {
        skippedSettings.push(mapping.key);
        logger.debug(
          `Configuration ${mapping.key} already exists in database, skipping migration`,
        );
        continue;
      }

      const envValue = getEnv(mapping.key);
      if (envValue !== undefined) {
        try {
          await this.set(
            mapping.key,
            envValue,
            mapping.description,
            mapping.category,
            { skipDependencyCheck: true },
          );
          migratedSettings.push(mapping.key);
          logger.info(`Migrated ${mapping.key} from environment variables`);
        } catch (error) {
          logger.error(`Error migrating ${mapping.key}:`, error);
        }
      } else if (mapping.defaultValue !== undefined) {
        try {
          await this.set(
            mapping.key,
            mapping.defaultValue,
            mapping.description,
            mapping.category,
            { skipDependencyCheck: true },
          );
          logger.info(`Set default value for ${mapping.key}`);
        } catch (error) {
          logger.error(`Error setting default for ${mapping.key}:`, error);
        }
      }
    }

    // Output summary of migrations
    if (migratedSettings.length > 0) {
      logger.info(
        "The following settings were migrated from .env to the database:",
      );
      migratedSettings.forEach((setting) => {
        logger.info(`- ${setting}`);
      });
      logger.info(
        "These settings can now be managed through the bot's commands and no longer need to be in .env",
      );
    }

    if (skippedSettings.length > 0) {
      logger.info(
        "The following settings were already in the database and were not migrated:",
      );
      skippedSettings.forEach((setting) => {
        logger.info(`- ${setting}`);
      });
    }

    logger.info("Critical settings that must remain in .env:");
    criticalSettings.forEach((setting) => {
      logger.info(`- ${setting}`);
    });
  }
}
