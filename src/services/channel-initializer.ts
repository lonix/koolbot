import {
  Guild,
  ChannelType,
  CategoryChannel,
  TextChannel,
  Client,
} from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";
import { VoiceChannelManager } from "./voice-channel-manager.js";

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

  async initialize(guildId: string) {
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

      // Try correct config keys first, then fall back to old ones
      const categoryName =
        (await this.configService.getString("voicechannels.category.name")) ||
        (await this.configService.getString("voice_channel.category_name")) ||
        (await this.configService.getString(
          "VC_CATEGORY_NAME",
          "Dynamic Voice Channels",
        ));

      const lobbyChannelName =
        (await this.configService.getString("voicechannels.lobby.name")) ||
        (await this.configService.getString(
          "voice_channel.lobby_channel_name",
        )) ||
        (await this.configService.getString("LOBBY_CHANNEL_NAME", "Lobby"));

      logger.info(
        `Initializing channels with category: ${categoryName} and lobby: ${lobbyChannelName}`,
      );

      // Find or create the category
      let category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.info(`Creating category: ${categoryName}`);
        category = await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory,
          position: 0,
        });
        logger.info(`Created category: ${categoryName}`);
      }

      // Use the voice channel manager to ensure lobby channels exist
      const voiceChannelManager = VoiceChannelManager.getInstance(this.client);
      await voiceChannelManager.ensureLobbyChannelExists(guild);

      // Find or create the announcement channel
      const announcementChannelName =
        (await this.configService.getString(
          "voicetracking.announcements.channel",
        )) ||
        (await this.configService.getString(
          "tracking.weekly_announcement_channel",
        )) ||
        (await this.configService.getString(
          "VC_ANNOUNCEMENT_CHANNEL",
          "voice-stats",
        ));
      let announcementChannel = guild.channels.cache.find(
        (channel) =>
          channel instanceof TextChannel &&
          channel.name === announcementChannelName,
      ) as TextChannel;

      if (!announcementChannel) {
        logger.info(
          `Creating announcement channel: ${announcementChannelName}`,
        );
        announcementChannel = await guild.channels.create({
          name: announcementChannelName,
          type: ChannelType.GuildText,
          parent: category,
        });
        logger.info(`Created announcement channel: ${announcementChannelName}`);
      } else {
        logger.info(
          `Found existing announcement channel: ${announcementChannelName}`,
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
