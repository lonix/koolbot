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

    let migratedCount = 0;
    let skippedCount = 0;

    for (const migration of configMigrations) {
      try {
        const wasMigrated = await this.migrateSetting(migration);
        if (wasMigrated) {
          migratedCount++;
        } else {
          skippedCount++;
        }
      } catch (error) {
        logger.error(`Failed to migrate setting ${migration.oldKey}:`, error);
      }
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
   * Migrate a single setting from old format to new format
   */
  private async migrateSetting(migration: ConfigMigration): Promise<boolean> {
    try {
      // Check if old setting exists
      const oldSetting = await this.configService.get(migration.oldKey);
      if (oldSetting === null || oldSetting === undefined) {
        // Old setting doesn't exist, skip
        return false;
      }

      // Check if new setting already exists
      const newSetting = await this.configService.get(migration.newKey);
      if (newSetting !== null && newSetting !== undefined) {
        // New setting already exists, skip
        return false;
      }

      // Migrate the setting
      logger.info(
        `Migrating setting: ${migration.oldKey} -> ${migration.newKey}`,
      );

      // Create new setting with old value
      await this.configService.set(
        migration.newKey,
        oldSetting,
        migration.category,
        migration.description,
      );

      // Delete old setting
      await this.configService.delete(migration.oldKey);

      logger.info(
        `Successfully migrated: ${migration.oldKey} -> ${migration.newKey}`,
      );
      return true;
    } catch (error) {
      logger.error(`Failed to migrate setting ${migration.oldKey}:`, error);
      return false;
    }
  }

  /**
   * Get all available migrations for reference
   */
  public getMigrations(): ConfigMigration[] {
    return [...configMigrations];
  }
}
