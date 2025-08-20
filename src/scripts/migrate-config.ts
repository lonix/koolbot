import { ConfigService } from "../services/config-service.js";
import logger from "../utils/logger.js";
import { connectToDatabase } from "../utils/database.js";

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
    defaultValue: "",
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
    defaultValue: "voice-stats",
  },
  {
    oldKey: "VC_TRACKING_ADMIN_ROLES",
    newKey: "voicetracking.admin_roles",
    category: "voicetracking",
    description: "Comma-separated role names that can manage tracking",
    defaultValue: "",
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
    newKey: "amikool.role.name",
    category: "amikool",
    description: "Role name required to use amikool command",
    defaultValue: "",
  },
  {
    oldKey: "ENABLE_PLEX_PRICE",
    newKey: "plexprice.enabled",
    category: "plexprice",
    description: "Enable/disable PLEX price checker",
    defaultValue: "true",
  },

  // Quote System (if they exist in old format)
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
    description: "Maximum length for quotes",
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

async function migrateConfiguration(): Promise<void> {
  try {
    logger.info("Starting configuration migration...");

    // Connect to database
    await connectToDatabase();

    const configService = ConfigService.getInstance();
    await configService.initialize();

    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const migration of configMigrations) {
      try {
        // Check if new key already exists
        const existingConfig = await configService.get(migration.newKey);
        if (existingConfig !== null) {
          logger.info(
            `Configuration ${migration.newKey} already exists, skipping`,
          );
          skippedCount++;
          continue;
        }

        // Get value from old environment variable
        const envValue = process.env[migration.oldKey];
        if (!envValue) {
          logger.info(
            `Environment variable ${migration.oldKey} not set, using default value`,
          );
        }

        // Use environment value or default
        const value = envValue || migration.defaultValue;

        // Convert value to appropriate type
        let finalValue: unknown = value;
        if (value === "true" || value === "false") {
          finalValue = value === "true";
        } else if (!isNaN(Number(value))) {
          finalValue = Number(value);
        }

        // Set the new configuration
        await configService.set(
          migration.newKey,
          finalValue,
          migration.description,
          migration.category,
        );

        logger.info(
          `Migrated ${migration.oldKey} -> ${migration.newKey} with value: ${finalValue}`,
        );
        migratedCount++;
      } catch (error) {
        logger.error(
          `Error migrating ${migration.oldKey} -> ${migration.newKey}:`,
          error,
        );
        errorCount++;
      }
    }

    logger.info(
      `Migration completed: ${migratedCount} migrated, ${skippedCount} skipped, ${errorCount} errors`,
    );

    if (errorCount === 0) {
      logger.info("All configurations migrated successfully!");
    } else {
      logger.warn(
        `Some configurations failed to migrate. Check the logs above.`,
      );
    }
  } catch (error) {
    logger.error("Fatal error during configuration migration:", error);
    process.exit(1);
  }
}

// Run migration if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateConfiguration();
}

export { migrateConfiguration };
