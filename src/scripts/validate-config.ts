import { ConfigService } from "../services/config-service.js";
import logger from "../utils/logger.js";
import { connectToDatabase } from "../utils/database.js";

interface ConfigValidation {
  key: string;
  required: boolean;
  type: "string" | "boolean" | "number";
  defaultValue?: unknown;
  description: string;
}

const requiredConfigs: ConfigValidation[] = [
  // Critical settings
  {
    key: "GUILD_ID",
    required: true,
    type: "string",
    description: "Discord guild/server ID",
  },
  {
    key: "CLIENT_ID",
    required: true,
    type: "string",
    description: "Discord bot client ID",
  },
  {
    key: "DISCORD_TOKEN",
    required: true,
    type: "string",
    description: "Discord bot token",
  },
  {
    key: "MONGODB_URI",
    required: true,
    type: "string",
    description: "MongoDB connection URI",
  },

  // Voice Channel Management
  {
    key: "voice_channel.enabled",
    required: false,
    type: "boolean",
    defaultValue: true,
    description: "Enable voice channel management",
  },
  {
    key: "voice_channel.category_name",
    required: false,
    type: "string",
    defaultValue: "Voice Channels",
    description: "Voice channel category name",
  },
  {
    key: "voice_channel.lobby_channel_name",
    required: false,
    type: "string",
    defaultValue: "Lobby",
    description: "Lobby channel name",
  },
  {
    key: "voice_channel.lobby_channel_name_offline",
    required: false,
    type: "string",
    defaultValue: "Offline Lobby",
    description: "Offline lobby channel name",
  },

  // Voice Channel Tracking
  {
    key: "tracking.enabled",
    required: false,
    type: "boolean",
    defaultValue: true,
    description: "Enable voice channel tracking",
  },
  {
    key: "tracking.weekly_announcement_channel",
    required: false,
    type: "string",
    defaultValue: "voice-stats",
    description: "Voice stats announcement channel",
  },
];

async function validateConfiguration(): Promise<void> {
  try {
    logger.info("Starting configuration validation...");

    // Connect to database
    await connectToDatabase();

    const configService = ConfigService.getInstance();
    await configService.initialize();

    let validCount = 0;
    let warningCount = 0;
    let errorCount = 0;

    for (const config of requiredConfigs) {
      try {
        let value: unknown = null;

        // Try to get from database first
        value = await configService.get(config.key);

        // If not in database, try environment variable
        if (value === null) {
          value = process.env[config.key];
        }

        // Validate the value
        if (config.required && (value === null || value === undefined || value === "")) {
          logger.error(`❌ Missing required configuration: ${config.key} - ${config.description}`);
          errorCount++;
          continue;
        }

        if (value !== null && value !== undefined) {
          // Type validation
          let typeValid = true;
          switch (config.type) {
            case "boolean":
              if (typeof value !== "boolean" && value !== "true" && value !== "false") {
                typeValid = false;
              }
              break;
            case "number":
              if (typeof value !== "number" && isNaN(Number(value))) {
                typeValid = false;
              }
              break;
            case "string":
              if (typeof value !== "string") {
                typeValid = false;
              }
              break;
          }

          if (!typeValid) {
            logger.warn(`⚠️  Type mismatch for ${config.key}: expected ${config.type}, got ${typeof value}`);
            warningCount++;
          } else {
            logger.info(`✅ ${config.key}: ${value} (${config.description})`);
            validCount++;
          }
        } else {
          // Use default value
          if (config.defaultValue !== undefined) {
            logger.info(`✅ ${config.key}: ${config.defaultValue} (default) - ${config.description}`);
            validCount++;
          } else {
            logger.warn(`⚠️  ${config.key}: not set - ${config.description}`);
            warningCount++;
          }
        }

      } catch (error) {
        logger.error(`❌ Error validating ${config.key}:`, error);
        errorCount++;
      }
    }

    logger.info(`\nValidation Summary:`);
    logger.info(`✅ Valid: ${validCount}`);
    logger.info(`⚠️  Warnings: ${warningCount}`);
    logger.info(`❌ Errors: ${errorCount}`);

    if (errorCount === 0) {
      logger.info("🎉 All required configurations are valid!");
    } else {
      logger.error("❌ Some configurations have errors. Please fix them before starting the bot.");
    }

    if (warningCount > 0) {
      logger.warn("⚠️  Some configurations have warnings. The bot may not work as expected.");
    }

  } catch (error) {
    logger.error("Fatal error during configuration validation:", error);
    process.exit(1);
  }
}

// Run validation if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  validateConfiguration();
}

export { validateConfiguration };
