import mongoose from "mongoose";
import { ConfigService } from "../services/config-service.js";
import {
  type ConfigSchema,
  defaultConfig,
  hasOwn,
} from "../services/config-schema.js";
import { env, getEnv } from "../config/env.js";
import logger from "../utils/logger.js";

/**
 * A legacy flat env-var key and the dot-notation schema key that replaced it.
 *
 * Like the boot-time migrator, this table carries **no** default of its own:
 * when the legacy env var is unset the fallback comes from
 * `config-schema.ts`. Hardcoded defaults here drifted from the schema and
 * force-enabled opt-in features on a fresh database (#867).
 */
interface ConfigMigration {
  oldKey: string;
  newKey: string;
  category: string;
  description: string;
}

const configMigrations: ConfigMigration[] = [
  // Voice Channel Management
  {
    oldKey: "ENABLE_VC_MANAGEMENT",
    newKey: "voicechannels.enabled",
    category: "voicechannels",
    description: "Enable/disable dynamic voice channel management",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME",
    newKey: "voicechannels.lobby.name",
    category: "voicechannels",
    description: "Name of the lobby channel",
  },
  {
    oldKey: "LOBBY_CHANNEL_NAME_OFFLINE",
    newKey: "voicechannels.lobby.offlinename",
    category: "voicechannels",
    description: "Name of the offline lobby channel",
  },
  {
    oldKey: "VC_CHANNEL_PREFIX",
    newKey: "voicechannels.channel.prefix",
    category: "voicechannels",
    description: "Prefix for dynamically created channels",
  },
  {
    oldKey: "VC_SUFFIX",
    newKey: "voicechannels.channel.suffix",
    category: "voicechannels",
    description: "Suffix for dynamically created channels",
  },

  // Voice Activity Tracking
  {
    oldKey: "ENABLE_VC_TRACKING",
    newKey: "voicetracking.enabled",
    category: "voicetracking",
    description: "Enable/disable voice activity tracking",
  },
  {
    oldKey: "ENABLE_SEEN",
    newKey: "voicetracking.seen.enabled",
    category: "voicetracking",
    description: "Enable/disable last seen tracking",
  },
  {
    oldKey: "EXCLUDED_VC_CHANNELS",
    newKey: "voicetracking.excluded_channels",
    category: "voicetracking",
    description:
      "Comma-separated list of voice channel IDs to exclude from tracking",
  },
  {
    oldKey: "ENABLE_VC_WEEKLY_ANNOUNCEMENT",
    newKey: "voicetracking.announcements.enabled",
    category: "voicetracking",
    description: "Enable/disable weekly voice channel announcements",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_SCHEDULE",
    newKey: "voicetracking.announcements.schedule",
    category: "voicetracking",
    description: "Cron expression for weekly announcements",
  },
  {
    oldKey: "VC_ANNOUNCEMENT_CHANNEL",
    newKey: "voicetracking.announcements.channel",
    category: "voicetracking",
    description: "Channel name for voice channel announcements",
  },
  // Individual Features
  {
    oldKey: "ENABLE_PING",
    newKey: "ping.enabled",
    category: "ping",
    description: "Enable/disable ping command",
  },

  // Quote System (if they exist in old format)
  {
    oldKey: "ENABLE_QUOTES",
    newKey: "quotes.enabled",
    category: "quotes",
    description: "Enable/disable quote system",
  },
  {
    oldKey: "QUOTE_DELETE_ROLES",
    newKey: "quotes.delete_roles",
    category: "quotes",
    description: "Comma-separated role IDs that can delete quotes",
  },
  {
    oldKey: "QUOTE_MAX_LENGTH",
    newKey: "quotes.max_length",
    category: "quotes",
    description: "Maximum length for quotes",
  },
  {
    oldKey: "QUOTE_COOLDOWN",
    newKey: "quotes.cooldown",
    category: "quotes",
    description: "Cooldown in seconds between quote additions",
  },
];

/**
 * Coerce a raw string configuration value to a boolean or number where that is
 * unambiguous, otherwise leave it as-is.
 *
 * Empty and whitespace-only strings are deliberately left alone: `Number("")`
 * is `0`, so a generic `isNaN(Number(value))` check would turn an intentional
 * empty-string default (e.g. `voicechannels.channel.suffix`) into the number
 * `0` and corrupt a value every other code path reads back as a string.
 */
function coerceConfigValue(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  if (value.trim() !== "" && !isNaN(Number(value))) {
    return Number(value);
  }
  return value;
}

async function migrateConfiguration(): Promise<void> {
  try {
    logger.info("Starting configuration migration...");

    await mongoose.connect(env.mongoUri);

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

        // Only schema keys can be written: an unknown key would land in the
        // database as an "unknown setting" that startup cleanup then deletes.
        if (!hasOwn(defaultConfig, migration.newKey)) {
          logger.warn(
            `Skipping ${migration.oldKey} -> ${migration.newKey}: key is not declared in config-schema.ts`,
          );
          skippedCount++;
          continue;
        }
        const schemaDefault =
          defaultConfig[migration.newKey as keyof ConfigSchema];

        // Prefer the legacy env value; fall back to the schema default, which
        // is already correctly typed and so needs no coercion. Presence is an
        // explicit `undefined` check (matching ConfigService.migrateFromEnv)
        // so a deliberately-empty env var migrates as the empty string rather
        // than being replaced by the default (#868).
        const envValue = getEnv(migration.oldKey);
        let finalValue: unknown = schemaDefault;
        if (envValue === undefined) {
          logger.info(
            `Environment variable ${migration.oldKey} not set, using the config-schema.ts default`,
          );
        } else {
          finalValue = coerceConfigValue(envValue);
        }

        // Set the new configuration. This offline migration moves stored
        // values to renamed keys; it isn't an operator toggling a feature, so
        // it bypasses dependency validation (#663).
        await configService.set(
          migration.newKey,
          finalValue,
          migration.description,
          migration.category,
          { skipDependencyCheck: true },
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
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

// Run migration if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateConfiguration();
}

export { migrateConfiguration, coerceConfigValue };
