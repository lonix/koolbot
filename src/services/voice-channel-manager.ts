import {
  VoiceState,
  VoiceChannel,
  CategoryChannel,
  ChannelType,
  GuildMember,
  Guild,
  Client,
} from "discord.js";
import { Logger } from "../utils/logger";

const logger = Logger.getInstance();

export class VoiceChannelManager {
  private static instance: VoiceChannelManager;
  private userChannels: Map<string, VoiceChannel> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private client: Client;

  private constructor(client: Client) {
    this.client = client;
    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  public static getInstance(client?: Client): VoiceChannelManager {
    if (!VoiceChannelManager.instance) {
      if (!client) {
        throw new Error("Client instance is required for first initialization");
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

  private startPeriodicCleanup(): void {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupEmptyChannels().catch((error) => {
          logger.error("Error during periodic channel cleanup:", error);
        });
      },
      5 * 60 * 1000,
    );
  }

  public async initialize(guildId: string): Promise<void> {
    try {
      logger.info("Initializing voice channel manager...");
      const guild = await this.getGuild(guildId);
      if (!guild) {
        logger.error("Guild not found during initialization");
        return;
      }

      const categoryName =
        process.env.VC_CATEGORY_NAME || "Dynamic Voice Channels";
      const lobbyChannelName =
        process.env.LOBBY_CHANNEL_NAME?.replace(/["']/g, "") || "Lobby";
      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(
          `Category ${categoryName} not found during initialization`,
        );
        return;
      }

      // Clean up any empty channels in the category, except the lobby channel
      for (const channel of category.children.cache.values()) {
        if (
          channel.type === ChannelType.GuildVoice &&
          channel.members.size === 0 &&
          channel.name !== lobbyChannelName
        ) {
          try {
            await channel.delete();
            logger.info(
              `Cleaned up empty channel ${channel.name} during initialization`,
            );
          } catch (error) {
            logger.error(
              `Error cleaning up channel ${channel.name} during initialization:`,
              error,
            );
          }
        }
      }

      logger.info("Voice channel manager initialization completed");
    } catch (error) {
      logger.error("Error during voice channel manager initialization:", error);
    }
  }

  public async handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
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
      // User left a channel
      else if (oldChannel && !newChannel) {
        await this.cleanupUserChannel(member.id);
      }
      // User switched channels
      else if (oldChannel && newChannel) {
        // If user is moving to the Lobby, create a new channel
        if (newChannel.name === process.env.LOBBY_CHANNEL_NAME) {
          // Clean up the old channel if it was a personal channel
          if (this.userChannels.has(member.id)) {
            await this.cleanupUserChannel(member.id);
          }
          await this.createUserChannel(member);
        }
        // If user is moving from their personal channel to another channel, clean up the old one
        else if (
          this.userChannels.has(member.id) &&
          oldChannel.id === this.userChannels.get(member.id)?.id
        ) {
          await this.cleanupUserChannel(member.id);
        }
      }
    } catch (error) {
      logger.error("Error handling voice state update:", error);
    }
  }

  private async createUserChannel(member: GuildMember): Promise<void> {
    try {
      // Check if user already has a channel
      if (this.userChannels.has(member.id)) {
        logger.info(
          `User ${member.displayName} already has a channel, skipping creation`,
        );
        return;
      }

      const guild = member.guild;
      const categoryName =
        process.env.VC_CATEGORY_NAME || "Dynamic Voice Channels";
      const suffix = process.env.VC_SUFFIX || "'s Room";

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found`);
        return;
      }

      const channelName = `${member.displayName}${suffix}`;
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: category,
      });

      this.userChannels.set(member.id, channel);
      await member.voice.setChannel(channel);
      logger.info(
        `Created voice channel ${channelName} for ${member.displayName}`,
      );
    } catch (error) {
      logger.error("Error creating user channel:", error);
    }
  }

  private async cleanupUserChannel(userId: string): Promise<void> {
    try {
      const channel = this.userChannels.get(userId);
      if (channel && channel.members.size === 0) {
        await channel.delete();
        this.userChannels.delete(userId);
        logger.info(`Cleaned up voice channel ${channel.name}`);
      }
    } catch (error) {
      logger.error("Error cleaning up user channel:", error);
    }
  }

  private async cleanupEmptyChannels(): Promise<void> {
    try {
      for (const [userId, channel] of this.userChannels.entries()) {
        if (channel.members.size === 0) {
          await channel.delete();
          this.userChannels.delete(userId);
          logger.info(`Cleaned up empty voice channel ${channel.name}`);
        }
      }
    } catch (error) {
      logger.error("Error during channel cleanup:", error);
    }
  }

  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.userChannels.clear();
  }
}
