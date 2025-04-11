import { Guild, ChannelType, VoiceChannel, CategoryChannel } from 'discord.js';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export class ChannelInitializer {
  private static instance: ChannelInitializer;

  private constructor() {}

  public static getInstance(): ChannelInitializer {
    if (!ChannelInitializer.instance) {
      ChannelInitializer.instance = new ChannelInitializer();
    }
    return ChannelInitializer.instance;
  }

  public async initializeChannels(guild: Guild): Promise<void> {
    try {
      if (process.env.ENABLE_VC_MANAGEMENT !== 'true') {
        logger.info('Voice channel management is disabled, skipping channel initialization');
        return;
      }

      const categoryName = process.env.VC_CATEGORY_NAME || 'Dynamic Voice Channels';
      const lobbyChannelName = process.env.LOBBY_CHANNEL_NAME?.replace(/["']/g, '') || 'Lobby';

      logger.info(`Initializing channels with category: ${categoryName} and lobby: ${lobbyChannelName}`);

      // Find or create the category
      let category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName
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
          channel.parentId === category.id
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

      logger.info('Channel initialization completed successfully');
    } catch (error) {
      logger.error('Error initializing channels:', error);
      throw error;
    }
  }
} 