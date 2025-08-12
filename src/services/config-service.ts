import { Config, IConfig } from "../models/config.js";
import logger from "../utils/logger.js";
import { Client } from "discord.js";
import mongoose from "mongoose";

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

  private async triggerReload(): Promise<void> {
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
          let timeoutId: ReturnType<typeof setTimeout>;
          timeoutId = setTimeout(() => {
            reject(new Error("MongoDB connection timeout"));
          }, 10000);

          const checkConnection = async (): Promise<void> => {
            try {
              if (mongoose.connection.readyState === 1) {
                clearTimeout(timeoutId);
                resolve();
              } else if (mongoose.connection.readyState === 0) {
                // Try to connect if not connected
                await mongoose.connect(
                  process.env.MONGODB_URI || "mongodb://mongodb:27017/koolbot",
                );
                clearTimeout(timeoutId);
                resolve();
              } else {
                timeoutId = setTimeout(checkConnection, 100);
              }
            } catch (error) {
              reject(error);
            }
          };

          checkConnection();
        });
      }

      // Load critical settings from environment variables first
      const criticalSettings = {
        GUILD_ID: process.env.GUILD_ID,
        CLIENT_ID: process.env.CLIENT_ID,
        DISCORD_TOKEN: process.env.DISCORD_TOKEN,
        MONGODB_URI: process.env.MONGODB_URI,
        DEBUG: process.env.DEBUG,
        NODE_ENV: process.env.NODE_ENV,
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

      this.initialized = true;
      logger.info("Configuration service initialized");
    } catch (error) {
      logger.error("Error initializing configuration service:", error);
      throw error;
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

      // If not found, try to get from environment variables (for backward compatibility)
      const envValue = process.env[key];
      if (envValue !== undefined) {
        // Convert string values to appropriate types
        if (envValue === "true" || envValue === "false") {
          const boolValue = envValue === "true";
          this.cache.set(key, boolValue);
          return boolValue;
        }
        if (!isNaN(Number(envValue))) {
          const numValue = Number(envValue);
          this.cache.set(key, numValue);
          return numValue;
        }
        this.cache.set(key, envValue);
        return envValue;
      }

      // Return null if not found anywhere
      return null;
    } catch (error) {
      logger.error(`Error getting configuration for key ${key}:`, error);
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

  public async set<T>(
    key: string,
    value: T,
    description: string,
    category: string,
  ): Promise<void> {
    try {
      const oldValue = this.cache.get(key);
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
      logger.info(`Configuration updated: ${key} = ${value}`);

      // If the value has changed, trigger a reload
      if (oldValue !== value) {
        await this.triggerReload();
      }
    } catch (error) {
      logger.error(`Error updating configuration ${key}:`, error);
      throw error;
    }
  }

  public async delete(key: string): Promise<void> {
    try {
      await Config.deleteOne({ key });
      this.cache.delete(key);
      logger.info(`Configuration deleted: ${key}`);

      // Trigger reload after deletion
      await this.triggerReload();
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
        category: "voice_channel",
        description: "Enable/disable voice channel management",
        defaultValue: "true",
      },
      {
        key: "VC_CATEGORY_NAME",
        category: "voice_channel",
        description: "Name of the category for voice channels",
        defaultValue: "Voice Channels",
      },
      {
        key: "LOBBY_CHANNEL_NAME",
        category: "voice_channel",
        description: "Name of the lobby channel",
        defaultValue: "Lobby",
      },
      {
        key: "LOBBY_CHANNEL_NAME_OFFLINE",
        category: "voice_channel",
        description: "Name of the offline lobby channel",
        defaultValue: "Offline Lobby",
      },
      {
        key: "VC_CHANNEL_PREFIX",
        category: "voice_channel",
        description: "Prefix for dynamically created channels",
        defaultValue: "🎮",
      },
      {
        key: "VC_SUFFIX",
        category: "voice_channel",
        description: "Suffix for dynamically created channels",
        defaultValue: "",
      },

      // Voice Channel Tracking
      {
        key: "ENABLE_VC_TRACKING",
        category: "tracking",
        description: "Enable/disable voice channel tracking",
        defaultValue: "true",
      },
      {
        key: "ENABLE_SEEN",
        category: "tracking",
        description: "Enable/disable last seen tracking",
        defaultValue: "true",
      },
      {
        key: "EXCLUDED_VC_CHANNELS",
        category: "tracking",
        description:
          "Comma-separated list of voice channel IDs to exclude from tracking",
        defaultValue: "",
      },
      {
        key: "ENABLE_VC_WEEKLY_ANNOUNCEMENT",
        category: "tracking",
        description: "Enable/disable weekly voice channel announcements",
        defaultValue: "true",
      },
      {
        key: "VC_ANNOUNCEMENT_SCHEDULE",
        category: "tracking",
        description: "Cron expression for weekly announcements",
        defaultValue: "0 16 * * 5",
      },
      {
        key: "VC_ANNOUNCEMENT_CHANNEL",
        category: "tracking",
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

      const envValue = process.env[mapping.key];
      if (envValue !== undefined) {
        try {
          await this.set(
            mapping.key,
            envValue,
            mapping.description,
            mapping.category,
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
