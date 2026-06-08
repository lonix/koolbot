import { Guild, TextChannel, Client } from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";
import {
  VoiceChannelManager,
  resolveManagedCategory,
} from "./voice-channel-manager.js";

export class ChannelInitializer {
  private static instance: ChannelInitializer;
  private client: Client;
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    // Register configuration reload callback to reinitialize channels when voice channel settings change
    this.configService.registerReloadCallback(async () => {
      try {
        const guildId = await this.configService.getString("GUILD_ID", "");
        if (guildId) {
          logger.info(
            "Voice channel configuration changed, reinitializing channels...",
          );
          await this.initialize(guildId);
        }
      } catch (error) {
        logger.error(
          "Error reinitializing channels after configuration change:",
          error,
        );
      }
    });
  }

  public static getInstance(client: Client): ChannelInitializer {
    if (!ChannelInitializer.instance) {
      ChannelInitializer.instance = new ChannelInitializer(client);
    }
    return ChannelInitializer.instance;
  }

  async initialize(guildId: string): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        throw new Error(`Guild ${guildId} not found`);
      }

      const isVoiceChannelManagementEnabled =
        (await this.configService.getBoolean("voicechannels.enabled", false)) ||
        (await this.configService.getBoolean("voice_channel.enabled", false));
      if (!isVoiceChannelManagementEnabled) {
        logger.info(
          "Voice channel management is disabled, skipping initialization",
        );
        return;
      }

      // Initialize channels
      await this.initializeChannels(guild);
      logger.info(`ChannelInitializer initialized for guild ${guild.name}`);
    } catch (error) {
      logger.error("Error initializing ChannelInitializer:", error);
      throw error;
    }
  }

  public async initializeChannels(guild: Guild): Promise<void> {
    try {
      // Check if voice channel management is enabled using correct config keys
      const isEnabled =
        (await this.configService.getBoolean("voicechannels.enabled")) ||
        (await this.configService.getBoolean("voice_channel.enabled")) ||
        (await this.configService.getBoolean("ENABLE_VC_MANAGEMENT"));

      if (!isEnabled) {
        logger.info(
          "Voice channel management is disabled, skipping channel initialization",
        );
        return;
      }

      const lobbyChannelName =
        (await this.configService.getString("voicechannels.lobby.name")) ||
        (await this.configService.getString(
          "voice_channel.lobby_channel_name",
        )) ||
        (await this.configService.getString("LOBBY_CHANNEL_NAME", "Lobby"));

      // Verify the configured managed-VC category exists. We no longer
      // auto-create one: operators pick an existing category via the
      // admin panel (now stored as a Discord channel ID, not a name).
      const category = await resolveManagedCategory(guild);
      if (category) {
        logger.info(
          `Initializing channels with category: ${category.name} (${category.id}) and lobby: ${lobbyChannelName}`,
        );
      } else {
        logger.warn(
          "voicechannels.category_id is not set or doesn't resolve to a category in this guild; lobby + child-channel management cannot proceed",
        );
        return;
      }

      // Use the voice channel manager to ensure lobby channels exist
      const voiceChannelManager = VoiceChannelManager.getInstance(this.client);
      await voiceChannelManager.ensureLobbyChannelExists(guild);

      // Verify the configured announcement channel exists. We no longer
      // auto-create one: operators pick an existing channel via the
      // admin panel (now stored as a Discord channel ID, not a name).
      const announcementChannelId = await this.configService.getString(
        "voicetracking.announcements.channel_id",
        "",
      );
      if (announcementChannelId) {
        const announcementChannel = guild.channels.cache.get(
          announcementChannelId,
        );
        if (announcementChannel && announcementChannel instanceof TextChannel) {
          logger.info(
            `Found announcement channel: #${announcementChannel.name} (${announcementChannel.id})`,
          );
        } else {
          logger.warn(
            `voicetracking.announcements.channel_id=${announcementChannelId} does not resolve to a text channel in guild ${guild.name}`,
          );
        }
      } else {
        logger.debug(
          "voicetracking.announcements.channel_id is not set; skipping announcement channel verification",
        );
      }

      logger.info("Channel initialization completed successfully");
    } catch (error) {
      logger.error("Error initializing channels:", error);
      throw error;
    }
  }

  /**
   * Force reinitialize channels - useful when configuration changes
   */
  public async forceReinitialize(guildId: string): Promise<void> {
    try {
      logger.info("Force reinitializing channels...");
      await this.initialize(guildId);
      logger.info("Channel reinitialization completed");
    } catch (error) {
      logger.error("Error force reinitializing channels:", error);
      throw error;
    }
  }
}
