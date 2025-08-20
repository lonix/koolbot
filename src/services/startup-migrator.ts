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
    defaultValue: "'s Room",
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
    newKey: "amikool.cool_role_name",
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
   * Run migration on startup to convert old flat settings to new dot notation
   */
  public async migrateOnStartup(): Promise<void> {
    logger.info("Starting configuration migration check...");

    // First, force migration by removing new settings with default values
    await this.forceMigration();

    let migratedCount = 0;
    let skippedCount = 0;

    logger.debug(`Total migrations to check: ${configMigrations.length}`);

    for (const migration of configMigrations) {
      try {
        logger.debug(`Checking migration: ${migration.oldKey} -> ${migration.newKey}`);
        const wasMigrated = await this.migrateSetting(migration);
        if (wasMigrated) {
          migratedCount++;
          logger.debug(`✓ Migrated: ${migration.oldKey} -> ${migration.newKey}`);
        } else {
          skippedCount++;
          logger.debug(`✗ Skipped: ${migration.oldKey} -> ${migration.newKey}`);
        }
      } catch (error) {
        logger.error(`Failed to migrate setting ${migration.oldKey}:`, error);
      }
    }

    // Ensure all expected settings exist with default values
    await this.ensureDefaultSettings();

    // Clean up old settings that are no longer needed
    if (migratedCount > 0) {
      await this.cleanupOldSettings();
    }

    if (migratedCount > 0) {
      logger.info(
        `Configuration migration completed: ${migratedCount} settings migrated, ${skippedCount} skipped`,
      );
    } else {
      logger.info(
        "No configuration migration needed - all settings are already in new format",
      );
    }
  }

  /**
   * Force migration by temporarily removing new settings with default values
   */
  private async forceMigration(): Promise<void> {
    logger.info("Forcing migration by removing new settings with default values...");

    for (const migration of configMigrations) {
      try {
        const oldSetting = await this.configService.get(migration.oldKey);
        const newSetting = await this.configService.get(migration.newKey);

        // If both old and new settings exist, and new setting has default value
        if (oldSetting !== null && oldSetting !== undefined &&
            newSetting !== null && newSetting !== undefined) {

          // Check if new setting has the default value (indicating it wasn't properly migrated)
          const hasDefaultValue = this.isDefaultValue(migration.newKey, newSetting);

          if (hasDefaultValue) {
            logger.debug(`Removing new setting ${migration.newKey} with default value to force migration`);
            await this.configService.delete(migration.newKey);
          }
        }
      } catch (error) {
        logger.error(`Error during force migration for ${migration.newKey}:`, error);
      }
    }
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
      "voicechannels.channel.suffix": "",
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
      "quotes.cooldown": 60
    };

    return defaultValues[key] === value;
  }

  /**
   * Ensure all expected settings exist with default values
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
   * Migrate a single setting from old format to new format
   */
  private async migrateSetting(migration: ConfigMigration): Promise<boolean> {
    try {
      logger.debug(`Checking if old setting exists: ${migration.oldKey}`);
      // Check if old setting exists
      const oldSetting = await this.configService.get(migration.oldKey);
      if (oldSetting === null || oldSetting === undefined) {
        // Old setting doesn't exist, skip
        logger.debug(`Old setting ${migration.oldKey} doesn't exist, skipping`);
        return false;
      }

      logger.debug(`Old setting ${migration.oldKey} exists with value: ${oldSetting}`);

      logger.debug(`Checking if new setting already exists: ${migration.newKey}`);
      // Check if new setting already exists
      const newSetting = await this.configService.get(migration.newKey);
      if (newSetting !== null && newSetting !== undefined) {
        // New setting already exists, but we should update it with the old value if they're different
        if (newSetting !== oldSetting) {
          logger.debug(`New setting ${migration.newKey} exists but has different value (${newSetting} vs ${oldSetting}), updating with old value`);

          // Update the new setting with the old value
          await this.configService.set(
            migration.newKey,
            oldSetting,
            migration.description,
            migration.category,
          );
          return true;
        } else {
          logger.debug(`New setting ${migration.newKey} already exists with same value (${newSetting}), skipping`);
          return false;
        }
      }

      // New setting doesn't exist, create it with the old value
      logger.debug(`Creating new setting ${migration.newKey} with value from old setting: ${oldSetting}`);
      await this.configService.set(
        migration.newKey,
        oldSetting,
        migration.description,
        migration.category,
      );
      return true;
    } catch (error) {
      logger.error(`Failed to migrate setting ${migration.oldKey}:`, error);
      return false;
    }
  }

  /**
   * Clean up old settings that are no longer needed
   */
  private async cleanupOldSettings(): Promise<void> {
    logger.info("Cleaning up old settings...");
    let deletedCount = 0;

    for (const migration of configMigrations) {
      try {
        // Only delete old setting if new setting exists and has been migrated
        const oldSetting = await this.configService.get(migration.oldKey);
        const newSetting = await this.configService.get(migration.newKey);

        if (oldSetting !== null && oldSetting !== undefined &&
            newSetting !== null && newSetting !== undefined) {

          // Verify the new setting has the correct value (from old setting)
          if (newSetting === oldSetting) {
            logger.info(`Deleting old setting: ${migration.oldKey} (value: ${oldSetting}) -> ${migration.newKey} (value: ${newSetting})`);
            await this.configService.delete(migration.oldKey);
            deletedCount++;
          } else {
            logger.warn(`Skipping deletion of ${migration.oldKey}: new setting ${migration.newKey} has different value (${newSetting} vs ${oldSetting})`);
          }
        }
      } catch (error) {
        logger.error(`Failed to delete old setting ${migration.oldKey}:`, error);
      }
    }

    if (deletedCount > 0) {
      logger.info(`Old settings cleanup completed: ${deletedCount} old settings deleted`);
    } else {
      logger.info("No old settings to clean up");
    }
  }

  /**
   * Get all available migrations for reference
   */
  public getMigrations(): ConfigMigration[] {
    return [...configMigrations];
  }
}

