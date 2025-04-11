import { VoiceState, VoiceChannel, CategoryChannel, ChannelType, GuildMember } from 'discord.js';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export class VoiceChannelManager {
  private static instance: VoiceChannelManager;
  private userChannels: Map<string, VoiceChannel> = new Map();

  private constructor() {}

  public static getInstance(): VoiceChannelManager {
    if (!VoiceChannelManager.instance) {
      VoiceChannelManager.instance = new VoiceChannelManager();
    }
    return VoiceChannelManager.instance;
  }

  public async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    try {
      const member = newState.member;
      if (!member) return;

      // User joined a channel
      if (!oldState.channelId && newState.channelId) {
        const lobbyChannel = newState.guild.channels.cache.get(newState.channelId);
        if (lobbyChannel?.name === process.env.LOBBY_CHANNEL_NAME) {
          await this.createUserChannel(member);
        }
      }

      // User left a channel
      if (oldState.channelId && !newState.channelId) {
        await this.cleanupUserChannel(member.id);
      }

      // User switched channels
      if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        const oldChannel = oldState.guild.channels.cache.get(oldState.channelId);
        if (oldChannel && this.userChannels.has(oldChannel.id)) {
          await this.cleanupUserChannel(member.id);
        }
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
        userLimit: 10,
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
} 