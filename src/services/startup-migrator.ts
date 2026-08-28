import { ConfigService } from "./config-service.js";
import { type ConfigSchema, defaultConfig, hasOwn } from "./config-schema.js";
import { hasEnv } from "../config/env.js";
import logger from "../utils/logger.js";

/**
 * A legacy flat env-var key and the dot-notation schema key that replaced it.
 *
 * Deliberately carries **no** default value of its own: the defaults this
 * migrator backfills come from `config-schema.ts` (see
 * {@link resolveSchemaDefault}). Hardcoding them here is what caused #867 —
 * six opt-in features (`voicechannels.enabled`, `voicetracking.enabled`,
 * `voicetracking.seen.enabled`, `voicetracking.announcements.enabled`,
 * `ping.enabled`, `quotes.enabled`) were persisted as `true` on every fresh
 * install, silently contradicting `SETTINGS.md` and `defaultConfig`, which
 * document them as `false`.
 */
interface ConfigMigration {
  oldKey: string;
  newKey: keyof ConfigSchema;
  category: string;
  description: string;
}

/**
 * Resolve the value to backfill for a migrated key from `config-schema.ts`,
 * the single source of truth for defaults.
 *
 * Returns `undefined` for a key that is not in the schema, so the caller skips
 * it rather than inventing a value — a guessed default is exactly the failure
 * mode this replaces.
 */
function resolveSchemaDefault(
  newKey: string,
): ConfigSchema[keyof ConfigSchema] | undefined {
  return hasOwn(defaultConfig, newKey)
    ? defaultConfig[newKey as keyof ConfigSchema]
    : undefined;
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

  // Individual Features
  {
    oldKey: "ENABLE_PING",
    newKey: "ping.enabled",
    category: "ping",
    description: "Enable/disable ping command",
  },

  // Quote System
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
    description: "Maximum quote length",
  },
  {
    oldKey: "QUOTE_COOLDOWN",
    newKey: "quotes.cooldown",
    category: "quotes",
    description: "Cooldown in seconds between quote additions",
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
    return hasEnv(key);
  }

  /**
   * Ensure all expected settings exist with default values
   * Only creates settings that are truly missing (not just migrated)
   *
   * Values come from `config-schema.ts` (`defaultConfig`) and nowhere else, so
   * this can never persist a default that contradicts the documented schema or
   * `SETTINGS.md` (#867).
   */
  private async ensureDefaultSettings(): Promise<void> {
    logger.info("Ensuring all expected settings exist with default values...");

    let createdCount = 0;

    for (const migration of configMigrations) {
      try {
        // Check if the new setting exists
        const existingSetting = await this.configService.get(migration.newKey);

        if (existingSetting === null || existingSetting === undefined) {
          // Setting doesn't exist, create it with its schema default
          const defaultValue = resolveSchemaDefault(migration.newKey);

          if (defaultValue === undefined) {
            logger.warn(
              `Skipping backfill of ${migration.newKey}: no default declared in config-schema.ts`,
            );
            continue;
          }

          logger.info(
            `Creating missing setting: ${migration.newKey} with schema default: ${defaultValue}`,
          );

          // Startup migration backfills missing schema keys with their
          // defaults; it isn't an operator enabling a feature, so it must
          // never be blocked by dependency validation (#663).
          await this.configService.set(
            migration.newKey,
            defaultValue,
            migration.description,
            migration.category,
            { skipDependencyCheck: true },
          );

          createdCount++;
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
