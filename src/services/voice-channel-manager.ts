import {
  VoiceState,
  VoiceChannel,
  CategoryChannel,
  ChannelType,
  GuildMember,
  Guild,
  Client,
} from "discord.js";
import Logger from "../utils/logger.js";
import { VoiceChannelTracker } from "../services/voice-channel-tracker.js";
import { ConfigService } from "./config-service.js";

const logger = Logger.getInstance();
const configService = ConfigService.getInstance();

export class VoiceChannelManager {
  private static instance: VoiceChannelManager;
  private userChannels: Map<string, VoiceChannel> = new Map();
  private ownershipQueue: Map<string, string[]> = new Map(); // channelId -> array of userIds
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private client: Client;

  private constructor(client: Client) {
    this.client = client;
    // Start periodic cleanup and health checks
    this.startPeriodicCleanup();
    this.startHealthChecks();
  }

  public static getInstance(client: Client): VoiceChannelManager {
    if (!VoiceChannelManager.instance) {
      VoiceChannelManager.instance = new VoiceChannelManager(client);
    }
    return VoiceChannelManager.instance;
  }

  private async getGuild(guildId: string): Promise<Guild | null> {
    try {
      if (!this.client) {
        logger.error("Client not initialized");
        return null;
      }
      return await this.client.guilds.fetch(guildId);
    } catch (error) {
      logger.error("Error fetching guild:", error);
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

  private startHealthChecks(): void {
    // Run health check every 15 minutes
    this.healthCheckInterval = setInterval(
      () => {
        this.checkLobbyHealth().catch((error) => {
          logger.error("Error during lobby health check:", error);
        });
      },
      15 * 60 * 1000, // 15 minutes
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

      const categoryName = await configService.getString(
        "VC_CATEGORY_NAME",
        "Dynamic Voice Channels",
      );
      const lobbyChannelName = (
        await configService.getString("LOBBY_CHANNEL_NAME", "Lobby")
      ).replace(/["']/g, "");
      const offlineLobbyName = await configService.getString(
        "LOBBY_CHANNEL_NAME_OFFLINE",
      );

      if (!offlineLobbyName) {
        logger.error("LOBBY_CHANNEL_NAME_OFFLINE is not set in configuration");
        return;
      }

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

      // Clean up any empty channels in the category, except the lobby channels
      for (const channel of category.children.cache.values()) {
        if (
          channel.type === ChannelType.GuildVoice &&
          channel.members.size === 0 &&
          channel.name !== lobbyChannelName &&
          channel.name !== offlineLobbyName
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

  private async handleChannelOwnershipChange(
    channel: VoiceChannel,
  ): Promise<void> {
    try {
      if (channel.members.size === 0) {
        // Channel is empty, no need to change ownership
        return;
      }

      // Get current owner from channel name
      const currentOwnerId = Array.from(this.userChannels.entries()).find(
        ([, userChannel]) => userChannel.id === channel.id,
      )?.[0];

      if (!currentOwnerId) {
        logger.error(`Could not find owner for channel ${channel.name}`);
        return;
      }

      // Check if current owner is still in the channel
      const currentOwner = channel.members.get(currentOwnerId);
      if (currentOwner) {
        // Owner is still in the channel, no need to change
        return;
      }

      // Get members in the channel
      const members = Array.from(channel.members.values());
      if (members.length === 0) {
        logger.error(`No members found in channel ${channel.name}`);
        return;
      }

      // Get voice channel tracker instance
      const tracker = VoiceChannelTracker.getInstance(this.client);

      // Get voice time stats for all members in the channel for the last 7 days
      const memberStats = await Promise.all(
        members.map(async (member) => {
          const stats = await tracker.getUserStats(member.id, "week");
          return {
            member,
            totalTime: stats?.totalTime || 0,
          };
        }),
      );

      // Sort members by their voice time in the last 7 days
      memberStats.sort((a, b) => b.totalTime - a.totalTime);

      // Select the member with the most voice time
      const newOwner = memberStats[0].member;

      // Update channel ownership
      await this.updateChannelOwnership(channel, newOwner);
      logger.info(
        `Channel ${channel.name} ownership transferred to ${newOwner.displayName} based on voice time`,
      );
    } catch (error) {
      logger.error("Error handling channel ownership change:", error);
    }
  }

  public async requestOwnership(
    channelId: string,
    userId: string,
  ): Promise<void> {
    try {
      const queue = this.ownershipQueue.get(channelId) || [];
      if (!queue.includes(userId)) {
        queue.push(userId);
        this.ownershipQueue.set(channelId, queue);

        // Notify the current owner
        const channel = this.client.channels.cache.get(
          channelId,
        ) as VoiceChannel;
        if (channel) {
          const currentOwnerId = Array.from(this.userChannels.entries()).find(
            ([, userChannel]) => userChannel.id === channelId,
          )?.[0];

          if (currentOwnerId) {
            const currentOwner = channel.members.get(currentOwnerId);
            if (currentOwner) {
              await channel.send(
                `<@${userId}> has requested ownership of this channel. They will receive ownership when you leave.`,
              );
            }
          }
        }
      }
    } catch (error) {
      logger.error("Error requesting channel ownership:", error);
    }
  }

  public async transferOwnership(
    channelId: string,
    currentOwnerId: string,
    newOwnerId: string,
  ): Promise<void> {
    try {
      const channel = this.client.channels.cache.get(channelId) as VoiceChannel;
      if (!channel) {
        throw new Error("Channel not found");
      }

      const newOwner = channel.members.get(newOwnerId);
      if (!newOwner) {
        throw new Error("New owner is not in the channel");
      }

      // Update channel name
      const newChannelName = `${newOwner.displayName}'s Channel`;
      await channel.setName(newChannelName);

      // Update ownership tracking
      this.userChannels.delete(currentOwnerId);
      this.userChannels.set(newOwnerId, channel);

      // Clear the ownership queue for this channel
      this.ownershipQueue.delete(channelId);

      // Notify channel members
      await channel.send(
        `Channel ownership has been transferred to ${newOwner.displayName}`,
      );

      logger.info(
        `Ownership of channel ${channel.name} manually transferred from ${currentOwnerId} to ${newOwnerId}`,
      );
    } catch (error) {
      logger.error("Error transferring channel ownership:", error);
      throw error;
    }
  }

  public async handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    try {
      const member = newState.member;
      if (!member) {
        logger.error("No member found in voice state update");
        return;
      }

      const oldChannel = oldState.channel;
      const newChannel = newState.channel;

      logger.info(`Voice state update for ${member.displayName}:`);
      logger.info(`Old channel: ${oldChannel?.name || "none"}`);
      logger.info(`New channel: ${newChannel?.name || "none"}`);

      // User joined a channel
      if (!oldChannel && newChannel) {
        const lobbyChannelName = await configService.getString(
          "LOBBY_CHANNEL_NAME",
          "Lobby",
        );
        logger.info(
          `User joined channel. Lobby name: "${lobbyChannelName}", Channel name: "${newChannel.name}"`,
        );
        if (newChannel.name === lobbyChannelName) {
          logger.info(
            `Creating channel for ${member.displayName} who joined the lobby`,
          );
          await this.createUserChannel(member);
        }
      }
      // User left a channel
      else if (oldChannel && !newChannel) {
        // Check if the user was the owner of a channel
        if (this.userChannels.has(member.id)) {
          const channel = this.userChannels.get(member.id);
          if (channel && channel.type === ChannelType.GuildVoice) {
            await this.handleChannelOwnershipChange(channel);
          }
        }
        await this.cleanupUserChannel(member.id);
      }
      // User switched channels
      else if (oldChannel && newChannel) {
        const lobbyChannelName = await configService.getString(
          "LOBBY_CHANNEL_NAME",
          "Lobby",
        );
        // If user is moving to the Lobby, create a new channel
        if (newChannel.name === lobbyChannelName) {
          // Clean up the old channel if it was a personal channel
          if (this.userChannels.has(member.id)) {
            const oldUserChannel = this.userChannels.get(member.id);
            if (
              oldUserChannel &&
              oldUserChannel.type === ChannelType.GuildVoice
            ) {
              await this.handleChannelOwnershipChange(oldUserChannel);
            }
            await this.cleanupUserChannel(member.id);
          }
          await this.createUserChannel(member);
        }
        // If user is moving from their personal channel to another channel, clean up the old one
        else if (
          this.userChannels.has(member.id) &&
          oldChannel.id === this.userChannels.get(member.id)?.id
        ) {
          if (oldChannel.type === ChannelType.GuildVoice) {
            await this.handleChannelOwnershipChange(oldChannel);
          }
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
      const categoryName = await configService.getString(
        "VC_CATEGORY_NAME",
        "Dynamic Voice Channels",
      );
      const suffix = (await configService.getString("VC_SUFFIX")) || "'s Room";

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
      if (!(await configService.get("ENABLE_VC_MANAGEMENT"))) {
        return;
      }

      const guildId = await configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("GUILD_ID not set in configuration");
        return;
      }

      const guild = await this.getGuild(guildId);
      if (!guild) {
        logger.error("Guild not found during cleanup");
        return;
      }

      const categoryName = await configService.getString(
        "VC_CATEGORY_NAME",
        "Dynamic Voice Channels",
      );
      const lobbyChannelName = (
        await configService.getString("LOBBY_CHANNEL_NAME", "Lobby")
      ).replace(/["']/g, "");
      const offlineLobbyName = await configService.getString(
        "LOBBY_CHANNEL_NAME_OFFLINE",
      );

      if (!offlineLobbyName) {
        logger.error("LOBBY_CHANNEL_NAME_OFFLINE is not set in configuration");
        return;
      }

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found during cleanup`);
        return;
      }

      // Delete all empty voice channels except lobby channels
      const emptyChannels = category.children.cache.filter(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice &&
          channel.members.size === 0 &&
          channel.name !== lobbyChannelName &&
          channel.name !== offlineLobbyName,
      );

      for (const channel of emptyChannels.values()) {
        try {
          await channel.delete("Bot cleanup");
          logger.info(`Deleted empty voice channel: ${channel.name}`);
        } catch (error) {
          logger.error(`Error deleting channel ${channel.name}:`, error);
        }
      }
    } catch (error) {
      logger.error("Error during voice channel cleanup:", error);
    }
  }

  private async checkLobbyHealth(): Promise<void> {
    try {
      if (!(await configService.get("ENABLE_VC_MANAGEMENT"))) {
        return;
      }

      const guildId = await configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("GUILD_ID not set in configuration");
        return;
      }

      const guild = await this.getGuild(guildId);
      if (!guild) {
        logger.error("Guild not found during health check");
        return;
      }

      const categoryName = await configService.getString(
        "VC_CATEGORY_NAME",
        "Dynamic Voice Channels",
      );
      const lobbyChannelName = (
        await configService.getString("LOBBY_CHANNEL_NAME", "Lobby")
      ).replace(/["']/g, "");
      const offlineLobbyName = await configService.getString(
        "LOBBY_CHANNEL_NAME_OFFLINE",
      );

      if (!offlineLobbyName) {
        logger.error("LOBBY_CHANNEL_NAME_OFFLINE is not set in configuration");
        return;
      }

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found during health check`);
        return;
      }

      // Check for offline lobby
      const offlineLobby = category.children.cache.find(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice &&
          channel.name === offlineLobbyName,
      );

      if (offlineLobby) {
        logger.warn(
          "Offline lobby detected, attempting to restore normal lobby...",
        );

        // If there are users in the offline lobby, create new channels for them
        if (offlineLobby.members.size > 0) {
          for (const member of offlineLobby.members.values()) {
            try {
              await this.createUserChannel(member);
            } catch (error) {
              logger.error(
                `Error creating channel for member ${member.user.tag}:`,
                error,
              );
            }
          }
        }

        // Delete the offline lobby
        try {
          await offlineLobby.delete("Health check cleanup");
          logger.info("Deleted offline lobby channel during health check");
        } catch (error) {
          logger.error(
            "Error deleting offline lobby channel during health check:",
            error,
          );
        }
      }

      // Ensure normal lobby exists
      const lobbyChannel = category.children.cache.find(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice &&
          channel.name === lobbyChannelName,
      );

      if (!lobbyChannel) {
        logger.warn("Normal lobby not found, creating it...");
        try {
          await guild.channels.create({
            name: lobbyChannelName,
            type: ChannelType.GuildVoice,
            parent: category,
            position: 0,
          });
          logger.info("Created normal lobby channel during health check");
        } catch (error) {
          logger.error(
            "Error creating normal lobby channel during health check:",
            error,
          );
        }
      }
    } catch (error) {
      logger.error("Error during lobby health check:", error);
    }
  }

  private async updateChannelOwnership(
    channel: VoiceChannel,
    newOwner: GuildMember,
  ): Promise<void> {
    try {
      // Update channel name
      const newChannelName = `${newOwner.displayName}'s Channel`;
      await channel.setName(newChannelName);

      // Update ownership tracking
      const currentOwnerId = Array.from(this.userChannels.entries()).find(
        ([, userChannel]) => userChannel.id === channel.id,
      )?.[0];
      if (currentOwnerId) {
        this.userChannels.delete(currentOwnerId);
      }
      this.userChannels.set(newOwner.id, channel);

      // Notify channel members about the ownership change
      try {
        await channel.send(
          `Channel ownership has been transferred to ${newOwner.displayName} based on voice time in the last 7 days`,
        );
      } catch (error) {
        logger.error("Error sending ownership change notification:", error);
      }

      logger.info(
        `Changed ownership of channel ${channel.name} to ${newOwner.id}`,
      );
    } catch (error) {
      logger.error("Error updating channel ownership:", error);
    }
  }

  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.userChannels.clear();
  }
}
