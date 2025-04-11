import { VoiceState, VoiceChannel, CategoryChannel, ChannelType, GuildMember, Guild, Client } from 'discord.js';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export class VoiceChannelManager {
  private static instance: VoiceChannelManager;
  private userChannels: Map<string, VoiceChannel> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private client: Client;

  private constructor(client: Client) {
    this.client = client;
    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  public static getInstance(client?: Client): VoiceChannelManager {
    if (!VoiceChannelManager.instance) {
      if (!client) {
        throw new Error('Client instance is required for first initialization');
      }
      VoiceChannelManager.instance = new VoiceChannelManager(client);
    }
    return VoiceChannelManager.instance;
  }

  private async getGuild(guildId: string): Promise<Guild | null> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      return guild;
    } catch (error) {
      logger.error(`Error fetching guild ${guildId}:`, error);
      return null;
    }
  }

  private startPeriodicCleanup() {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupEmptyChannels().catch(error => {
        logger.error('Error during periodic channel cleanup:', error);
      });
    }, 5 * 60 * 1000);
  }

  public async initialize(guildId: string) {
    try {
      logger.info('Initializing voice channel manager...');
      const guild = await this.getGuild(guildId);
      if (!guild) {
        logger.error('Guild not found during initialization');
        return;
      }

      const categoryName = process.env.VC_CATEGORY_NAME || 'Dynamic Voice Channels';
      const lobbyChannelName = process.env.LOBBY_CHANNEL_NAME?.replace(/["']/g, '') || 'Lobby';
      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel => 
          channel.type === ChannelType.GuildCategory && 
          channel.name === categoryName
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found during initialization`);
        return;
      }

      // Clean up any empty channels in the category, except the lobby channel
      for (const channel of category.children.cache.values()) {
        if (channel.type === ChannelType.GuildVoice && 
            channel.members.size === 0 && 
            channel.name !== lobbyChannelName) {
          try {
            await channel.delete();
            logger.info(`Cleaned up empty channel ${channel.name} during initialization`);
          } catch (error) {
            logger.error(`Error cleaning up channel ${channel.name} during initialization:`, error);
          }
        }
      }

      logger.info('Voice channel manager initialization completed');
    } catch (error) {
      logger.error('Error during voice channel manager initialization:', error);
    }
  }

  public async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    try {
      const member = newState.member;
      if (!member) return;

      const oldChannel = oldState.channel;
      const newChannel = newState.channel;

      // User joined a channel
      if (!oldChannel && newChannel) {
        if (newChannel.name === process.env.LOBBY_CHANNEL_NAME) {
          await this.createUserChannel(member);
        }
      }
      // User switched channels
      else if (oldChannel && newChannel) {
        // If user is moving from their dynamic channel to lobby
        if (this.userChannels.has(oldChannel.id) && newChannel.name === process.env.LOBBY_CHANNEL_NAME) {
          await this.cleanupUserChannel(member.id);
          await this.createUserChannel(member);
        }
        // If user is moving from lobby to another channel
        else if (oldChannel.name === process.env.LOBBY_CHANNEL_NAME && newChannel.name !== process.env.LOBBY_CHANNEL_NAME) {
          await this.cleanupUserChannel(member.id);
        }
        // If user is moving from their dynamic channel to another channel
        else if (this.userChannels.has(oldChannel.id)) {
          await this.cleanupUserChannel(member.id);
        }
      }
      // User left a channel
      else if (oldChannel && !newChannel) {
        await this.cleanupUserChannel(member.id);
      }
    } catch (error) {
      logger.error('Error handling voice state update:', error);
    }
  }

  private async createUserChannel(member: GuildMember) {
    try {
      const categoryName = process.env.VC_CATEGORY_NAME || 'Dynamic Voice Channels';
      const category = member.guild.channels.cache.find(
        (channel): channel is CategoryChannel => 
          channel.type === ChannelType.GuildCategory && 
          channel.name === categoryName
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found`);
        return;
      }

      const channelName = `${member.displayName}'s Channel`;
      const userChannel = await member.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: category,
      });

      this.userChannels.set(member.id, userChannel);
      await member.voice.setChannel(userChannel);
      logger.info(`Created voice channel for ${member.displayName}`);
    } catch (error) {
      logger.error('Error creating user channel:', error);
    }
  }

  private async cleanupUserChannel(userId: string) {
    try {
      const channel = this.userChannels.get(userId);
      if (channel) {
        if (channel.members.size === 0) {
          await channel.delete();
          this.userChannels.delete(userId);
          logger.info(`Deleted voice channel for user ${userId}`);
        }
      }
    } catch (error) {
      logger.error('Error cleaning up user channel:', error);
    }
  }

  private async cleanupEmptyChannels() {
    try {
      logger.debug('Starting periodic cleanup of empty channels');
      const channelsToDelete: string[] = [];

      // Find all empty channels
      for (const [userId, channel] of this.userChannels.entries()) {
        if (channel.members.size === 0) {
          channelsToDelete.push(userId);
        }
      }

      // Delete empty channels
      for (const userId of channelsToDelete) {
        const channel = this.userChannels.get(userId);
        if (channel) {
          try {
            await channel.delete();
            this.userChannels.delete(userId);
            logger.info(`Deleted empty voice channel for user ${userId}`);
          } catch (error) {
            logger.error(`Error deleting channel for user ${userId}:`, error);
          }
        }
      }

      logger.debug(`Periodic cleanup completed. Deleted ${channelsToDelete.length} empty channels`);
    } catch (error) {
      logger.error('Error during periodic channel cleanup:', error);
    }
  }

  public destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
} 