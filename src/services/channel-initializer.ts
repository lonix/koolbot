import {
  Guild,
  ChannelType,
  CategoryChannel,
  VoiceChannel,
  TextChannel,
  Client,
} from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";

export class ChannelInitializer {
  private static instance: ChannelInitializer;
  private client: Client;
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
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

      const isVoiceChannelManagementEnabled = await this.configService.get("ENABLE_VC_MANAGEMENT");
      if (!isVoiceChannelManagementEnabled) {
        logger.info("Voice channel management is disabled, skipping initialization");
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
      if (!(await this.configService.get("ENABLE_VC_MANAGEMENT"))) {
        logger.info(
          "Voice channel management is disabled, skipping channel initialization",
        );
        return;
      }

      const categoryName = await this.configService.getString(
        "VC_CATEGORY_NAME",
        "Dynamic Voice Channels",
      );
      const lobbyChannelName = (
        await this.configService.getString("LOBBY_CHANNEL_NAME", "Lobby")
      ).replace(/["']/g, "");

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

      // Find or create the lobby channel
      let lobbyChannel = guild.channels.cache.find(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice &&
          channel.name === lobbyChannelName &&
          channel.parentId === category.id,
      );

      if (!lobbyChannel) {
        logger.info(`Creating lobby channel: ${lobbyChannelName}`);
        lobbyChannel = await guild.channels.create({
          name: lobbyChannelName,
          type: ChannelType.GuildVoice,
          parent: category,
          position: 0,
        });
        logger.info(`Created lobby channel: ${lobbyChannelName}`);
      } else {
        logger.info(`Found existing lobby channel: ${lobbyChannelName}`);
      }

      // Find or create the announcement channel
      const announcementChannelName = await this.configService.getString(
        "VC_ANNOUNCEMENT_CHANNEL",
        "voice-stats",
      );
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
}
