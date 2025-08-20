import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";

interface ConfigMigration {
  oldKey: string;
  newKey: string;
  category: string;
  description: string;
  defaultValue?: string;
}

const configMigrations: ConfigMigration[] = [
  // Voice Channel Management
  {
    oldKey: "ENABLE_VC_MANAGEMENT",
    newKey: "voicechannels.enabled",
    category: "voicechannels",
    description: "Enable/disable dynamic voice channel management",
    defaultValue: "true",
  },
  {
    oldKey: "VC_CATEGORY_NAME",
    newKey: "voicechannels.category.name",
    category: "voicechannels",
    description: "Name of the category for voice channels",
    defaultValue: "Voice Channels",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME",
    newKey: "voicechannels.lobby.name",
    category: "voicechannels",
    description: "Name of the lobby channel",
    defaultValue: "Lobby",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME_OFFLINE",
    newKey: "voicechannels.lobby.offlinename",
    category: "voicechannels",
    description: "Name of the offline lobby channel",
    defaultValue: "Offline Lobby",
  },
  {
    oldKey: "VC_CHANNEL_PREFIX",
    newKey: "voicechannels.channel.prefix",
    category: "voicechannels",
    description: "Prefix for dynamically created channels",
    defaultValue: "🎮",
  },
  {
    oldKey: "VC_SUFFIX",
    newKey: "voicechannels.channel.suffix",
    category: "voicechannels",
    description: "Suffix for dynamically created channels",
    defaultValue: "", // Fixed: match isDefaultValue method
  },

  // Voice Activity Tracking
  {
    oldKey: "ENABLE_VC_TRACKING",
    newKey: "voicetracking.enabled",
    category: "voicetracking",
    description: "Enable/disable voice activity tracking",
    defaultValue: "true",
  },
  {
    oldKey: "ENABLE_SEEN",
    newKey: "voicetracking.seen.enabled",
    category: "voicetracking",
    description: "Enable/disable last seen tracking",
    defaultValue: "true",
  },
  {
    oldKey: "EXCLUDED_VC_CHANNELS",
    newKey: "voicetracking.excluded_channels",
    category: "voicetracking",
    description:
      "Comma-separated list of voice channel IDs to exclude from tracking",
    defaultValue: "",
  },
  {
    oldKey: "ENABLE_VC_WEEKLY_ANNOUNCEMENT",
    newKey: "voicetracking.announcements.enabled",
    category: "voicetracking",
    description: "Enable/disable weekly voice channel announcements",
    defaultValue: "true",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_SCHEDULE",
    newKey: "voicetracking.announcements.schedule",
    category: "voicetracking",
    description: "Cron expression for weekly announcements",
    defaultValue: "0 16 * * 5",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_CHANNEL",
    newKey: "voicetracking.announcements.channel",
    category: "voicetracking",
    description: "Channel name for voice channel announcements",
    defaultValue: "announcement",
  },
  {
    oldKey: "VC_TRACKING_ADMIN_ROLES",
    newKey: "voicetracking.admin_roles",
    category: "voicetracking",
    description: "Comma-separated role names that can manage tracking",
    defaultValue: "Admin,Moderator",
  },

  // Individual Features
  {
    oldKey: "ENABLE_PING",
    newKey: "ping.enabled",
    category: "ping",
    description: "Enable/disable ping command",
    defaultValue: "true",
  },
  {
    oldKey: "ENABLE_AMIKOOL",
    newKey: "amikool.enabled",
    category: "amikool",
    description: "Enable/disable amikool command",
    defaultValue: "true",
  },
  {
    oldKey: "COOL_ROLE_NAME",
    newKey: "amikool.role.name", // Fixed: match expected dot notation
    category: "amikool",
    description: "Name of the cool role for amikool command",
    defaultValue: "HR",
  },
  {
    oldKey: "ENABLE_PLEX_PRICE",
    newKey: "plexprice.enabled",
    category: "plexprice",
    description: "Enable/disable PLEX price checker",
    defaultValue: "true",
  },

  // Quote System
  {
    oldKey: "ENABLE_QUOTES",
    newKey: "quotes.enabled",
    category: "quotes",
    description: "Enable/disable quote system",
    defaultValue: "true",
  },
  {
    oldKey: "QUOTE_ADD_ROLES",
    newKey: "quotes.add_roles",
    category: "quotes",
    description: "Comma-separated role IDs that can add quotes",
    defaultValue: "",
  },
  {
    oldKey: "QUOTE_DELETE_ROLES",
    newKey: "quotes.delete_roles",
    category: "quotes",
    description: "Comma-separated role IDs that can delete quotes",
    defaultValue: "",
  },
  {
    oldKey: "QUOTE_MAX_LENGTH",
    newKey: "quotes.max_length",
    category: "quotes",
    description: "Maximum quote length",
    defaultValue: "1000",
  },
  {
    oldKey: "QUOTE_COOLDOWN",
    newKey: "quotes.cooldown",
    category: "quotes",
    description: "Cooldown in seconds between quote additions",
    defaultValue: "60",
  },
];

export class StartupMigrator {
  private static instance: StartupMigrator;
  private configService: ConfigService;

  private constructor() {
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(): StartupMigrator {
    if (!StartupMigrator.instance) {
      StartupMigrator.instance = new StartupMigrator();
    }
    return StartupMigrator.instance;
  }

  /**
   * Check for outdated settings and warn about them
   */
  public async checkForOutdatedSettings(): Promise<void> {
    logger.info("Checking for outdated configuration settings...");

    const outdatedSettings: string[] = [];
    const missingSettings: string[] = [];

    // Check for old flat settings that need migration
    for (const migration of configMigrations) {
      try {
        // Check if old setting exists in database (not just in cache/env)
        const oldSetting = await this.configService.get(migration.oldKey);
        logger.debug(
          `Checking old setting ${migration.oldKey}: ${oldSetting} (type: ${typeof oldSetting})`,
        );

        // Only consider it outdated if it's actually in the database, not from env vars
        if (
          oldSetting !== null &&
          oldSetting !== undefined &&
          !this.isFromEnvironment(migration.oldKey)
        ) {
          outdatedSettings.push(migration.oldKey);
          logger.debug(
            `✓ Found outdated setting in database: ${migration.oldKey}`,
          );
        } else {
          logger.debug(
            `✗ No outdated setting found in database: ${migration.oldKey}`,
          );
        }

        // Check if new setting exists
        const newSetting = await this.configService.get(migration.newKey);
        logger.debug(
          `Checking new setting ${migration.newKey}: ${newSetting} (type: ${typeof newSetting})`,
        );

        if (newSetting === null || newSetting === undefined) {
          missingSettings.push(migration.newKey);
          logger.debug(`✗ Missing new setting: ${migration.newKey}`);
        } else {
          logger.debug(`✓ New setting exists: ${migration.newKey}`);
        }
      } catch (error) {
        logger.error(`Error checking setting ${migration.oldKey}:`, error);
      }
    }

    // Warn about outdated settings
    if (outdatedSettings.length > 0) {
      logger.warn(
        `⚠️  Found ${outdatedSettings.length} outdated settings that need migration:`,
      );
      outdatedSettings.forEach((setting) => {
        logger.warn(`   - ${setting} (should be migrated to new dot notation)`);
      });
      logger.warn(
        "💡 Run 'npm run migrate-config' to migrate these settings to the new format",
      );
    }

    // Create missing settings with defaults
    if (missingSettings.length > 0) {
      logger.info(
        `Creating ${missingSettings.length} missing settings with default values...`,
      );
      await this.ensureDefaultSettings();
    }

    if (outdatedSettings.length === 0 && missingSettings.length === 0) {
      logger.info("✅ All configuration settings are up to date");
    } else if (outdatedSettings.length === 0) {
      logger.info("✅ All outdated settings have been migrated");
    }
  }

  /**
   * Check if a setting value comes from environment variables
   */
  private isFromEnvironment(key: string): boolean {
    return process.env[key] !== undefined;
  }

  /**
   * Check if a setting has its default value
   */
  private isDefaultValue(key: string, value: any): boolean {
    // Define default values for each setting
    const defaultValues: Record<string, any> = {
      "voicechannels.enabled": true,
      "voicechannels.category.name": "Voice Channels",
      "voicechannels.lobby.name": "🟢 Lobby",
      "voicechannels.lobby.offlinename": "🔴 Lobby",
      "voicechannels.channel.prefix": "🎮",
      "voicechannels.channel.suffix": "", // Fixed: match migration defaultValue
      "voicetracking.enabled": true,
      "voicetracking.seen.enabled": true,
      "voicetracking.excluded_channels": "",
      "voicetracking.announcements.enabled": true,
      "voicetracking.announcements.schedule": "0 16 * * 5",
      "voicetracking.announcements.channel": "announcement",
      "voicetracking.admin_roles": "Admin,Moderator",
      "ping.enabled": true,
      "amikool.enabled": true,
      "amikool.role.name": "HR",
      "plexprice.enabled": true,
      "quotes.enabled": true,
      "quotes.add_roles": "@HR",
      "quotes.delete_roles": "None",
      "quotes.max_length": 1000,
      "quotes.cooldown": 60,
    };

    return defaultValues[key] === value;
  }

  /**
   * Ensure all expected settings exist with default values
   * Only creates settings that are truly missing (not just migrated)
   */
  private async ensureDefaultSettings(): Promise<void> {
    logger.info("Ensuring all expected settings exist with default values...");

    let createdCount = 0;

    for (const migration of configMigrations) {
      try {
        // Check if the new setting exists
        const existingSetting = await this.configService.get(migration.newKey);

        if (existingSetting === null || existingSetting === undefined) {
          // Setting doesn't exist, create it with default value
          if (migration.defaultValue !== undefined) {
            logger.info(
              `Creating missing setting: ${migration.newKey} with default value: ${migration.defaultValue}`,
            );

            await this.configService.set(
              migration.newKey,
              migration.defaultValue,
              migration.description,
              migration.category,
            );

            createdCount++;
          }
        } else {
          logger.debug(
            `Setting ${migration.newKey} already exists with value: ${existingSetting}`,
          );
        }
      } catch (error) {
        logger.error(
          `Failed to create default setting ${migration.newKey}:`,
          error,
        );
      }
    }

    if (createdCount > 0) {
      logger.info(
        `Created ${createdCount} missing settings with default values`,
      );
    } else {
      logger.info("All expected settings already exist");
    }
  }

  /**
   * Get all available migrations for reference
   */
  public getMigrations(): ConfigMigration[] {
    return [...configMigrations];
  }
}
