import { ConfigService } from "../services/config-service.js";
import logger from "../utils/logger.js";
import { connectToDatabase } from "../utils/database.js";

interface SettingReference {
  oldKey: string;
  newKey: string;
  description: string;
}

const settingReferences: SettingReference[] = [
  // Voice Channel Management
  {
    oldKey: "ENABLE_VC_MANAGEMENT",
    newKey: "voice_channel.enabled",
    description: "Enable/disable voice channel management",
  },
  {
    oldKey: "VC_CATEGORY_NAME",
    newKey: "voice_channel.category_name",
    description: "Name of the category for voice channels",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME",
    newKey: "voice_channel.lobby_channel_name",
    description: "Name of the lobby channel",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME_OFFLINE",
    newKey: "voice_channel.lobby_channel_name_offline",
    description: "Name of the offline lobby channel",
  },
  {
    oldKey: "VC_CHANNEL_PREFIX",
    newKey: "voice_channel.channel_prefix",
    description: "Prefix for dynamically created channels",
  },
  {
    oldKey: "VC_SUFFIX",
    newKey: "voice_channel.suffix",
    description: "Suffix for dynamically created channels",
  },

  // Voice Channel Tracking
  {
    oldKey: "ENABLE_VC_TRACKING",
    newKey: "tracking.enabled",
    description: "Enable/disable voice channel tracking",
  },
  {
    oldKey: "ENABLE_SEEN",
    newKey: "tracking.seen_enabled",
    description: "Enable/disable last seen tracking",
  },
  {
    oldKey: "EXCLUDED_VC_CHANNELS",
    newKey: "tracking.excluded_channels",
    description: "Comma-separated list of voice channel IDs to exclude from tracking",
  },
  {
    oldKey: "ENABLE_VC_WEEKLY_ANNOUNCEMENT",
    newKey: "tracking.weekly_announcement_enabled",
    description: "Enable/disable weekly voice channel announcements",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_SCHEDULE",
    newKey: "tracking.weekly_announcement_schedule",
    description: "Cron expression for weekly announcements",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_CHANNEL",
    newKey: "tracking.weekly_announcement_channel",
    description: "Channel name for voice channel announcements",
  },
];

async function updateSettingsReferences(): Promise<void> {
  try {
    logger.info("Starting settings reference update...");

    // Connect to database
    await connectToDatabase();

    const configService = ConfigService.getInstance();
    await configService.initialize();

    logger.info("The following settings should be updated in the codebase:");
    logger.info("========================================================");

    for (const reference of settingReferences) {
      logger.info(`${reference.oldKey} -> ${reference.newKey}`);
      logger.info(`  Description: ${reference.description}`);
      logger.info("");
    }

    logger.info("========================================================");
    logger.info("Please update all code references to use the new dot notation.");
    logger.info("The migration script will handle converting the database values.");
    logger.info("");
    logger.info("Files that likely need updates:");
    logger.info("- src/commands/setup-lobby.ts");
    logger.info("- src/services/channel-initializer.ts");
    logger.info("- src/services/voice-channel-manager.ts");
    logger.info("- src/services/command-manager.ts");
    logger.info("- src/commands/index.ts");
    logger.info("- src/deploy-commands.ts");
    logger.info("- src/index.ts");

  } catch (error) {
    logger.error("Error during settings reference update:", error);
    process.exit(1);
  }
}

// Run if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  updateSettingsReferences();
}

export { updateSettingsReferences };
