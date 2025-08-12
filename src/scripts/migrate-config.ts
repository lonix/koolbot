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
    newKey: "voice_channel.enabled",
    category: "voice_channel",
    description: "Enable/disable voice channel management",
    defaultValue: "true",
  },
  {
    oldKey: "VC_CATEGORY_NAME",
    newKey: "voice_channel.category_name",
    category: "voice_channel",
    description: "Name of the category for voice channels",
    defaultValue: "Voice Channels",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME",
    newKey: "voice_channel.lobby_channel_name",
    category: "voice_channel",
    description: "Name of the lobby channel",
    defaultValue: "Lobby",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME_OFFLINE",
    newKey: "voice_channel.lobby_channel_name_offline",
    category: "voice_channel",
    description: "Name of the offline lobby channel",
    defaultValue: "Offline Lobby",
  },
  {
    oldKey: "VC_CHANNEL_PREFIX",
    newKey: "voice_channel.channel_prefix",
    category: "voice_channel",
    description: "Prefix for dynamically created channels",
    defaultValue: "🎮",
  },
  {
    oldKey: "VC_SUFFIX",
    newKey: "voice_channel.suffix",
    category: "voice_channel",
    description: "Suffix for dynamically created channels",
    defaultValue: "",
  },

  // Voice Channel Tracking
  {
    oldKey: "ENABLE_VC_TRACKING",
    newKey: "tracking.enabled",
    category: "tracking",
    description: "Enable/disable voice channel tracking",
    defaultValue: "true",
  },
  {
    oldKey: "ENABLE_SEEN",
    newKey: "tracking.seen_enabled",
    category: "tracking",
    description: "Enable/disable last seen tracking",
    defaultValue: "true",
  },
  {
    oldKey: "EXCLUDED_VC_CHANNELS",
    newKey: "tracking.excluded_channels",
    category: "tracking",
    description:
      "Comma-separated list of voice channel IDs to exclude from tracking",
    defaultValue: "",
  },
  {
    oldKey: "ENABLE_VC_WEEKLY_ANNOUNCEMENT",
    newKey: "tracking.weekly_announcement_enabled",
    category: "tracking",
    description: "Enable/disable weekly voice channel announcements",
    defaultValue: "true",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_SCHEDULE",
    newKey: "tracking.weekly_announcement_schedule",
    category: "tracking",
    description: "Cron expression for weekly announcements",
    defaultValue: "0 16 * * 5",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_CHANNEL",
    newKey: "tracking.weekly_announcement_channel",
    category: "tracking",
    description: "Channel name for voice channel announcements",
    defaultValue: "voice-stats",
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
