import { Config, IConfig } from "../models/config.js";
import Logger from "../utils/logger.js";
import mongoose from "mongoose";

const logger = Logger.getInstance();

export class ConfigService {
  private static instance: ConfigService;
  private cache: Map<string, any> = new Map();
  private initialized = false;

  private constructor() {}

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load all configs into cache
      const configs = await Config.find({});
      for (const config of configs) {
        this.cache.set(config.key, config.value);
      }
      this.initialized = true;
      logger.info("Configuration service initialized");
    } catch (error) {
      logger.error("Error initializing configuration service:", error);
      throw error;
    }
  }

  public async get<T>(key: string, defaultValue?: T): Promise<T> {
    if (!this.initialized) {
      await this.initialize();
    }

    const value = this.cache.get(key);
    if (value === undefined) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Configuration key '${key}' not found`);
    }
    return value as T;
  }

  public async set<T>(key: string, value: T, description: string, category: string): Promise<void> {
    try {
      const config = await Config.findOneAndUpdate(
        { key },
        {
          key,
          value,
          description,
          category,
          updatedAt: new Date(),
        },
        { upsert: true, new: true }
      );

      this.cache.set(key, value);
      logger.info(`Configuration updated: ${key} = ${value}`);
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
        key: "ENABLE_VC_WEEKLY_ANNOUNCEMENT",
        category: "announcements",
        description: "Enable/disable weekly voice channel announcements",
        defaultValue: "true",
      },
      {
        key: "VC_ANNOUNCEMENT_SCHEDULE",
        category: "announcements",
        description: "Cron schedule for weekly announcements",
        defaultValue: "0 16 * * 5",
      },
      {
        key: "VC_ANNOUNCEMENT_CHANNEL",
        category: "announcements",
        description: "Channel name for weekly announcements",
        defaultValue: "voice-stats",
      },

      // Bot Features
      {
        key: "ENABLE_PING",
        category: "features",
        description: "Enable/disable ping command",
        defaultValue: "true",
      },
      {
        key: "ENABLE_AMIKOOL",
        category: "features",
        description: "Enable/disable amikool command",
        defaultValue: "true",
      },
      {
        key: "ENABLE_PLEX_PRICE",
        category: "features",
        description: "Enable/disable plex price checking",
        defaultValue: "true",
      },

      // Roles
      {
        key: "COOL_ROLE_NAME",
        category: "roles",
        description: "Name of the role for kool verification",
        defaultValue: "Kool",
      },
      {
        key: "VC_TRACKING_ADMIN_ROLES",
        category: "roles",
        description: "Comma-separated list of admin role names",
        defaultValue: "Admin,Moderator",
      },
    ];

    for (const mapping of envMappings) {
      // Skip critical settings
      if (criticalSettings.includes(mapping.key)) {
        continue;
      }

      // Use environment value if available, otherwise use default
      const value = process.env[mapping.key] || mapping.defaultValue;
      await this.set(
        mapping.key,
        value,
        mapping.description,
        mapping.category
      );
      logger.info(`Migrated ${mapping.key} from environment to database`);
    }
  }
}
