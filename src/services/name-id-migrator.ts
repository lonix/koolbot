import { Client, ChannelType, Guild } from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";

/**
 * Resolve a stored Discord entity reference from a name to an ID against the
 * live guild cache, write the ID under a new key, and delete the legacy
 * name-keyed row.
 *
 * Several config keys historically stored Discord entity references as
 * **names** (e.g. `voicetracking.announcements.channel = "voice-stats"`).
 * Names aren't unique and aren't selector-friendly: the v1.0 WebUI work
 * renders these fields as `<select>` dropdowns populated from the guild
 * cache, which fundamentally requires the stored value to be an ID.
 *
 * This module is the one-shot translator. It runs once per bot start, after
 * Discord is ready (so the guild cache is hydrated) and before services
 * that read the new keys initialise.
 *
 * Failure modes:
 *  - Old key empty / already migrated: silent no-op.
 *  - New key already populated: silent no-op (idempotent on repeat starts).
 *  - Name doesn't resolve in the guild cache: warning logged; old key
 *    kept in place so the operator can fix it via the WebUI without
 *    losing the only hint at what they originally configured.
 */
interface RenameSpec {
  oldKey: string;
  newKey: string;
  description: string; // human-readable for log lines
  resolve: (guild: Guild, oldValue: string) => string | null;
}

const RENAMES: RenameSpec[] = [
  {
    oldKey: "voicetracking.announcements.channel",
    newKey: "voicetracking.announcements.channel_id",
    description: "voice-stats announcement channel",
    resolve: (guild, name): string | null => {
      // Match the downstream reader (VoiceChannelAnnouncer uses
      // `instanceof TextChannel`): in discord.js v14, NewsChannel
      // (GuildAnnouncement) extends TextChannel, so operators legitimately
      // configure announcement-type channels here. Accepting both types
      // keeps the migrator's tolerance aligned with runtime use.
      const channel = guild.channels.cache.find(
        (ch) =>
          (ch.type === ChannelType.GuildText ||
            ch.type === ChannelType.GuildAnnouncement) &&
          ch.name === name,
      );
      return channel ? channel.id : null;
    },
  },
  {
    oldKey: "voicechannels.category.name",
    newKey: "voicechannels.category_id",
    description: "managed voice-channel category",
    resolve: (guild, name): string | null => {
      const category = guild.channels.cache.find(
        (ch) => ch.type === ChannelType.GuildCategory && ch.name === name,
      );
      return category ? category.id : null;
    },
  },
];

export async function runNameToIdMigrations(
  client: Client,
  guildId: string,
  configService: ConfigService,
): Promise<void> {
  if (!guildId) {
    logger.warn("Name→ID migration skipped: GUILD_ID not configured");
    return;
  }

  let guild: Guild;
  try {
    guild = await client.guilds.fetch(guildId);
  } catch (err) {
    logger.warn(
      `Name→ID migration skipped: could not fetch guild ${guildId}`,
      err,
    );
    return;
  }

  // Make sure the channels/roles caches are populated; otherwise resolve()
  // would silently return null on a cold start.
  await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);

  for (const spec of RENAMES) {
    try {
      const existingNewValue = await configService.getString(spec.newKey, "");
      if (existingNewValue) {
        // Already migrated; drop the legacy row if it's still hanging
        // around (cleanup whitelist preserves it across restarts).
        const legacy = await configService.getString(spec.oldKey, "");
        if (legacy) {
          await configService.delete(spec.oldKey);
          logger.info(
            `Name→ID migration: removed stale ${spec.oldKey} (${spec.description} already populated as ${spec.newKey}=${existingNewValue})`,
          );
        }
        continue;
      }

      const oldValue = await configService.getString(spec.oldKey, "");
      if (!oldValue) {
        // Nothing to migrate.
        continue;
      }

      const resolvedId = spec.resolve(guild, oldValue);
      if (!resolvedId) {
        logger.warn(
          `Name→ID migration: could not resolve ${spec.description} "${oldValue}" in guild ${guild.name}. Leaving ${spec.oldKey} in place for manual reconfiguration.`,
        );
        continue;
      }

      await configService.set(
        spec.newKey,
        resolvedId,
        `Migrated from ${spec.oldKey}="${oldValue}"`,
        spec.newKey.split(".")[0],
      );
      await configService.delete(spec.oldKey);
      logger.info(
        `Name→ID migration: ${spec.description} "${oldValue}" → ${resolvedId} (stored under ${spec.newKey}, old ${spec.oldKey} removed)`,
      );
    } catch (err) {
      logger.error(
        `Name→ID migration failed for ${spec.oldKey} → ${spec.newKey}:`,
        err,
      );
    }
  }
}
