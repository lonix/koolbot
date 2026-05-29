import mongoose from "mongoose";
import { ConfigService } from "../services/config-service.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";

interface SettingReference {
  oldKey: string;
  newKey: string;
  description: string;
}

const settingReferences: SettingReference[] = [
  // Voice Channel Management
  {
    oldKey: "ENABLE_VC_MANAGEMENT",
    newKey: "voicechannels.enabled",
    description: "Enable/disable dynamic voice channel management",
  },
  {
    oldKey: "VC_CATEGORY_NAME",
    newKey: "voicechannels.category.name",
    description: "Name of the category for voice channels",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME",
    newKey: "voicechannels.lobby.name",
    description: "Name of the lobby channel",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME_OFFLINE",
    newKey: "voicechannels.lobby.offlinename",
    description: "Name of the offline lobby channel",
  },
  {
    oldKey: "VC_CHANNEL_PREFIX",
    newKey: "voicechannels.channel.prefix",
    description: "Prefix for dynamically created channels",
  },
  {
    oldKey: "VC_SUFFIX",
    newKey: "voicechannels.channel.suffix",
    description: "Suffix for dynamically created channels",
  },

  // Voice Activity Tracking
  {
    oldKey: "ENABLE_VC_TRACKING",
    newKey: "voicetracking.enabled",
    description: "Enable/disable voice activity tracking",
  },
  {
    oldKey: "ENABLE_SEEN",
    newKey: "voicetracking.seen.enabled",
    description: "Enable/disable last seen tracking",
  },
  {
    oldKey: "EXCLUDED_VC_CHANNELS",
    newKey: "voicetracking.excluded_channels",
    description:
      "Comma-separated list of voice channel IDs to exclude from tracking",
  },
  {
    oldKey: "ENABLE_VC_WEEKLY_ANNOUNCEMENT",
    newKey: "voicetracking.announcements.enabled",
    description: "Enable/disable weekly voice channel announcements",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_SCHEDULE",
    newKey: "voicetracking.announcements.schedule",
    description: "Cron expression for weekly announcements",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_CHANNEL",
    newKey: "voicetracking.announcements.channel",
    description: "Channel name for voice channel announcements",
  },
  // Individual Features
  {
    oldKey: "ENABLE_PING",
    newKey: "ping.enabled",
    description: "Enable/disable ping command",
  },
];

async function updateSettingsReferences(): Promise<void> {
  try {
    logger.info("Starting settings reference update...");

    await mongoose.connect(env.mongoUri);

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
    logger.info(
      "Please update all code references to use the new dot notation.",
    );
    logger.info(
      "The migration script will handle converting the database values.",
    );
    logger.info("");
    logger.info("Files that likely need updates:");
    logger.info("- src/services/channel-initializer.ts");
    logger.info("- src/services/voice-channel-manager.ts");
    logger.info("- src/services/command-manager.ts");
    logger.info("- src/commands/index.ts");
    logger.info("- src/deploy-commands.ts");
    logger.info("- src/index.ts");
  } catch (error) {
    logger.error("Error during settings reference update:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

// Run if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  updateSettingsReferences();
}

export { updateSettingsReferences };
