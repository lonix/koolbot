import {
  VoiceState,
  VoiceChannel,
  CategoryChannel,
  ChannelType,
  GuildMember,
  Guild,
  Client,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextChannel,
} from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelTracker } from "../services/voice-channel-tracker.js";
import { ConfigService } from "./config-service.js";

const configService = ConfigService.getInstance();

export class VoiceChannelManager {
  private static instance: VoiceChannelManager;
  private userChannels: Map<string, VoiceChannel> = new Map();
  private ownershipQueue: Map<string, string[]> = new Map(); // channelId -> array of userIds
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private client: Client;
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
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

  /**
   * Get the voice channel owned by a specific user
   */
  public getUserChannel(userId: string): VoiceChannel | undefined {
    return this.userChannels.get(userId);
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

      // Check if voice channel management is enabled using correct config keys
      const isEnabled =
        (await configService.getBoolean("voicechannels.enabled")) ||
        (await configService.getBoolean("voice_channel.enabled")) ||
        (await configService.getBoolean("ENABLE_VC_MANAGEMENT"));

      if (!isEnabled) {
        logger.info(
          "Voice channel management is disabled, skipping initialization",
        );
        return;
      }

      const guild = await this.getGuild(guildId);
      if (!guild) {
        logger.error("Guild not found during initialization");
        return;
      }

      // Try correct config keys first, then fall back to old ones
      const categoryName =
        (await configService.getString("voicechannels.category.name")) ||
        (await configService.getString("voice_channel.category_name")) ||
        (await configService.getString(
          "VC_CATEGORY_NAME",
          "Dynamic Voice Channels",
        ));

      const lobbyChannelName =
        (await configService.getString("voicechannels.lobby.name")) ||
        (await configService.getString("voice_channel.lobby_channel_name")) ||
        (await configService.getString("LOBBY_CHANNEL_NAME", "Lobby"));

      const offlineLobbyName =
        (await configService.getString("voicechannels.lobby.offlinename")) ||
        (await configService.getString(
          "voice_channel.lobby_channel_name_offline",
        ));

      if (!offlineLobbyName) {
        logger.error(
          "voicechannels.lobby.offlinename is not set in configuration",
        );
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
      // Check if voice channel management is enabled
      const isEnabled = await configService.getBoolean(
        "voicechannels.enabled",
        false,
      );
      if (!isEnabled) {
        return; // Voice channel management is disabled
      }

      const member = newState.member;
      if (!member) {
        logger.error("No member found in voice state update");
        return;
      }

      const oldChannel = oldState.channel;
      const newChannel = newState.channel;

      logger.info(`Voice state update for ${member.displayName}:`);
      logger.info(
        `Old channel: ${oldChannel?.name || "none"} (${oldChannel?.id || "none"})`,
      );
      logger.info(
        `New channel: ${newChannel?.name || "none"} (${newChannel?.id || "none"})`,
      );

      // User joined a channel
      if (!oldChannel && newChannel) {
        const lobbyChannelName =
          (await configService.getString("voicechannels.lobby.name")) ||
          (await configService.getString("voice_channel.lobby_channel_name")) ||
          (await configService.getString("LOBBY_CHANNEL_NAME", "Lobby"));
        logger.info(
          `User joined channel. Lobby name: "${lobbyChannelName}", Channel name: "${newChannel.name}"`,
        );
        if (newChannel.name === lobbyChannelName) {
          logger.info(
            `Creating channel for ${member.displayName} who joined the lobby`,
          );
          await this.createUserChannel(member);
        } else if (newChannel.name === "➕ New Channel") {
          // If user joins the "New Channel", create a personal channel for them
          logger.info(
            `Creating personal channel for ${member.displayName} who joined the new channel`,
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
          "voicechannels.lobby.name",
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
        // If user is moving to the "New Channel", create a personal channel
        else if (newChannel.name === "➕ New Channel") {
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

      // Try new config keys first, then fall back to old ones
      const categoryName =
        (await configService.getString("voicechannels.category.name")) ||
        (await configService.getString("voice_channel.category_name")) ||
        (await configService.getString(
          "VC_CATEGORY_NAME",
          "Dynamic Voice Channels",
        ));

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found`);
        return;
      }

      // Determine channel name using default naming
      const suffix =
        (await configService.getString("voicechannels.channel.suffix")) ||
        (await configService.getString("voice_channel.suffix")) ||
        (await configService.getString("VC_SUFFIX")) ||
        "'s Room";
      const prefix = await configService.getString(
        "voicechannels.channel.prefix",
        "🎮",
      );
      const channelName = `${prefix} ${member.displayName}${suffix}`;

      // Create channel with default settings
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: category,
        userLimit: 0, // 0 = unlimited by default
      });

      this.userChannels.set(member.id, channel);
      await member.voice.setChannel(channel);
      logger.info(
        `Created voice channel ${channelName} for ${member.displayName}`,
      );

      // Send control panel if enabled
      await this.sendControlPanel(channel, member.id);
    } catch (error) {
      logger.error("Error creating user channel:", error);
    }
  }

  /**
   * Send control panel to voice channel's text chat
   */
  private async sendControlPanel(
    channel: VoiceChannel,
    ownerId: string,
  ): Promise<void> {
    try {
      // Check if control panel is enabled
      const controlPanelEnabled = await configService.getBoolean(
        "voicechannels.controlpanel.enabled",
        true,
      );

      if (!controlPanelEnabled) {
        logger.info("Control panel is disabled, skipping");
        return;
      }

      // Find the text channel associated with this voice channel
      // Discord creates a text channel with the same name when a voice channel is created in a stage/voice category
      // However, for dynamic voice channels, we need to check if there's a text channel
      // For now, we'll look for a text channel with a similar name or in the same category
      const category = channel.parent;
      if (!category) {
        logger.warn(
          `No category found for channel ${channel.name}, cannot send control panel`,
        );
        return;
      }

      // Try to find the text channel in the category
      let textChannel: TextChannel | null = null;

      // Option 1: Look for a text channel with the same name
      const sameNameChannel = category.children.cache.find(
        (ch) =>
          ch.type === ChannelType.GuildText && ch.name === channel.name,
      );
      if (sameNameChannel && sameNameChannel.type === ChannelType.GuildText) {
        textChannel = sameNameChannel as TextChannel;
      }

      // Option 2: Since Discord voice channels don't automatically have text channels,
      // we should send the control panel to a designated control/bot channel
      // For now, log that we can't find a text channel
      if (!textChannel) {
        logger.info(
          `No text channel found for voice channel ${channel.name}, control panel will be sent via DM or ephemeral message`,
        );
        // In Discord, voice channels can have associated text channels if they're in a community server
        // Since this is a dynamic voice channel, we'll skip sending to a text channel
        // Users can use slash commands instead
        return;
      }

      // Create the control panel embed
      const embed = new EmbedBuilder()
        .setTitle("🎮 Voice Channel Controls")
        .setDescription(
          `Welcome to your voice channel: **${channel.name}**\n\n` +
            `Use the buttons below to customize your channel!`,
        )
        .setColor(0x00ff00)
        .setFooter({ text: "Only you can see and use these controls" });

      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`vc_control_name_${channel.id}_${ownerId}`)
          .setLabel("Rename")
          .setStyle(ButtonStyle.Primary)
          .setEmoji("✏️"),
        new ButtonBuilder()
          .setCustomId(`vc_control_privacy_${channel.id}_${ownerId}`)
          .setLabel("Make Private")
          .setStyle(ButtonStyle.Danger)
          .setEmoji("🔒"),
        new ButtonBuilder()
          .setCustomId(`vc_control_invite_${channel.id}_${ownerId}`)
          .setLabel("Invite")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("👥")
          .setDisabled(true), // Disabled until channel is private
        new ButtonBuilder()
          .setCustomId(`vc_control_transfer_${channel.id}_${ownerId}`)
          .setLabel("Transfer")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("👑"),
      );

      await textChannel.send({
        content: `<@${ownerId}>`,
        embeds: [embed],
        components: [buttons],
      });

      logger.info(
        `Sent control panel for channel ${channel.name} to text channel ${textChannel.name}`,
      );
    } catch (error) {
      logger.error("Error sending control panel:", error);
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

  /**
   * Handle when a user joins a lobby channel - create a dynamic channel for them
   */
  public async handleLobbyJoin(
    member: GuildMember,
    channel: VoiceChannel,
  ): Promise<void> {
    try {
      const lobbyName = await configService.getString(
        "voicechannels.lobby.name",
        "Lobby",
      );

      // Check if this is the online lobby channel (not offline)
      if (channel.name === lobbyName) {
        logger.info(
          `User ${member.user.username} joined lobby channel: ${channel.name}`,
        );

        // Create a dynamic channel for them
        const dynamicChannel = await this.createDynamicChannel(
          member.guild,
          member.id,
        );

        if (dynamicChannel) {
          // Move the user to the new channel
          try {
            await member.voice.setChannel(dynamicChannel.id);
            logger.info(
              `Moved user ${member.user.username} to dynamic channel: ${dynamicChannel.name}`,
            );
          } catch (error) {
            logger.error(`Failed to move user to dynamic channel:`, error);
          }
        }
      }
    } catch (error) {
      logger.error("Error handling lobby join:", error);
    }
  }

  /**
   * Create a new dynamic voice channel when a user joins the lobby
   */
  public async createDynamicChannel(
    guild: Guild,
    userId: string,
    channelName?: string,
  ): Promise<VoiceChannel | null> {
    try {
      const categoryName = await configService.getString(
        "voicechannels.category.name",
        "Voice Channels",
      );

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(
          `Category ${categoryName} not found for dynamic channel creation`,
        );
        return null;
      }

      const member = await guild.members.fetch(userId);

      // Determine channel name
      let finalChannelName: string;
      if (channelName) {
        finalChannelName = channelName;
      } else {
        // Use default naming
        const channelPrefix = await configService.getString(
          "voicechannels.channel.prefix",
          "🎮",
        );
        const channelSuffix = await configService.getString(
          "voicechannels.channel.suffix",
          "'s Room",
        );
        finalChannelName = member
          ? `${channelPrefix} ${member.displayName}${channelSuffix}`
          : `${channelPrefix} ${userId}`;
      }

      // Create the dynamic channel with default settings
      const newChannel = await guild.channels.create({
        name: finalChannelName,
        type: ChannelType.GuildVoice,
        parent: category,
        userLimit: 0, // Default unlimited
        permissionOverwrites: [
          {
            id: userId,
            allow: ["ManageChannels", "Connect", "Speak", "ViewChannel"],
          },
          {
            id: guild.roles.everyone.id,
            allow: ["Connect", "Speak", "ViewChannel"],
          },
        ],
      });

      // Store ownership
      this.userChannels.set(userId, newChannel);

      // Send control panel
      await this.sendControlPanel(newChannel, userId);

      logger.info(
        `Created dynamic voice channel: ${newChannel.name} for user ${userId}`,
      );
      return newChannel;
    } catch (error) {
      logger.error("Error creating dynamic voice channel:", error);
      return null;
    }
  }

  /**
   * Rename lobby channel to offline name when bot shuts down
   */
  public async renameLobbyToOffline(guild: Guild): Promise<void> {
    try {
      const categoryName = await configService.getString(
        "voicechannels.category.name",
        "Voice Channels",
      );
      const lobbyName = await configService.getString(
        "voicechannels.lobby.name",
        "Lobby",
      );
      const offlineLobbyName = await configService.getString(
        "voicechannels.lobby.offlinename",
        "🔴 Lobby",
      );

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found for lobby renaming`);
        return;
      }

      // Find the lobby channel
      const lobbyChannel = category.children.cache.find(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice && channel.name === lobbyName,
      );

      if (lobbyChannel) {
        await lobbyChannel.setName(offlineLobbyName, "Bot shutting down");
        logger.info(`Renamed lobby channel to offline: ${offlineLobbyName}`);
      }
    } catch (error) {
      logger.error("Error renaming lobby to offline:", error);
    }
  }

  /**
   * Rename offline lobby channel back to normal name when bot starts up
   * Also creates dynamic channels for any users currently in the offline lobby
   */
  public async renameLobbyToOnline(guild: Guild): Promise<void> {
    try {
      const categoryName = await configService.getString(
        "voicechannels.category.name",
        "Voice Channels",
      );
      const lobbyName = await configService.getString(
        "voicechannels.lobby.name",
        "Lobby",
      );
      const offlineLobbyName = await configService.getString(
        "voicechannels.lobby.offlinename",
        "🔴 Lobby",
      );

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found for lobby renaming`);
        return;
      }

      // Find the offline lobby channel
      const offlineLobbyChannel = category.children.cache.find(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice &&
          channel.name === offlineLobbyName,
      );

      if (offlineLobbyChannel) {
        // Check if anyone is currently in the offline lobby
        const usersInOfflineLobby = offlineLobbyChannel.members.filter(
          (member) => !member.user.bot,
        );

        if (usersInOfflineLobby.size > 0) {
          logger.info(
            `Found ${usersInOfflineLobby.size} users in offline lobby, creating dynamic channels for them`,
          );

          // Create dynamic channels for each user and move them
          for (const [userId, member] of usersInOfflineLobby) {
            try {
              const dynamicChannel = await this.createDynamicChannel(
                guild,
                userId,
              );
              if (dynamicChannel) {
                await member.voice.setChannel(dynamicChannel.id);
                logger.info(
                  `Created dynamic channel and moved user ${member.displayName} from offline lobby`,
                );
              }
            } catch (error) {
              logger.error(
                `Failed to create dynamic channel for user ${member.displayName}:`,
                error,
              );
            }
          }
        }

        // Now rename the channel back to online
        await offlineLobbyChannel.setName(lobbyName, "Bot starting up");
        logger.info(`Renamed offline lobby channel to online: ${lobbyName}`);
      } else {
        // No offline lobby found, ensure we have a lobby channel
        logger.info("No offline lobby found, ensuring lobby channel exists");
        await this.ensureLobbyChannelExists(guild);
      }
    } catch (error) {
      logger.error("Error renaming offline lobby to online:", error);
    }
  }

  /**
   * Ensure lobby channel exists for normal startup operations
   * This method is gentle and tries to reuse existing offline lobby channels
   */
  public async ensureLobbyChannelExists(guild: Guild): Promise<void> {
    try {
      const categoryName = await configService.getString(
        "voicechannels.category.name",
        "Voice Channels",
      );
      const lobbyName = await configService.getString(
        "voicechannels.lobby.name",
        "Lobby",
      );
      const offlineLobbyName = await configService.getString(
        "voicechannels.lobby.offlinename",
        "🔴 Lobby",
      );

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found for lobby creation`);
        return;
      }

      // First, try to find an existing online lobby
      const existingLobby = category.children.cache.find(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice && channel.name === lobbyName,
      );

      if (existingLobby) {
        logger.debug(`Lobby channel already exists: ${existingLobby.name}`);
        return; // We're good, lobby already exists
      }

      // Check if there's an offline lobby we can rename
      const offlineLobbyChannel = category.children.cache.find(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice &&
          channel.name === offlineLobbyName,
      );

      if (offlineLobbyChannel) {
        // Rename the offline lobby back to online
        try {
          await offlineLobbyChannel.setName(
            lobbyName,
            "Bot starting up - renaming offline lobby",
          );
          logger.info(
            `Renamed offline lobby channel back to online: ${lobbyName}`,
          );
          return; // We're done
        } catch (error) {
          logger.error(`Failed to rename offline lobby channel:`, error);
          // Fall through to creation if renaming fails
        }
      }

      // If no lobby exists at all, create one
      try {
        const newLobby = await guild.channels.create({
          name: lobbyName,
          type: ChannelType.GuildVoice,
          parent: category,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: ["Connect", "Speak", "ViewChannel"],
            },
          ],
        });
        logger.info(`Created new lobby channel: ${newLobby.name}`);
      } catch (error) {
        logger.error(`Failed to create lobby channel:`, error);
      }
    } catch (error) {
      logger.error("Error ensuring lobby channel exists:", error);
    }
  }

  /**
   * Ensure lobby channel exists, create it if it doesn't
   * Also removes duplicate lobby channels
   * WARNING: This method is aggressive and will delete ALL existing lobby channels
   * Use ensureLobbyChannelExists for normal startup operations
   */
  public async ensureLobbyChannels(guild: Guild): Promise<void> {
    try {
      const categoryName = await configService.getString(
        "voicechannels.category.name",
        "Voice Channels",
      );
      const lobbyName = await configService.getString(
        "voicechannels.lobby.name",
        "Lobby",
      );

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) {
        logger.error(`Category ${categoryName} not found for lobby creation`);
        return;
      }

      // Find ALL lobby channels (including duplicates and offline ones)
      const allLobbyChannels = category.children.cache.filter(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice &&
          (channel.name === lobbyName || channel.name.includes("Lobby")),
      );

      // Check if there's an offline lobby that we can rename back to online
      const offlineLobbyChannel = allLobbyChannels.find(
        (channel) =>
          channel.name !== lobbyName && channel.name.includes("Lobby"),
      );

      if (offlineLobbyChannel) {
        // Rename the offline lobby back to online instead of deleting it
        try {
          await offlineLobbyChannel.setName(
            lobbyName,
            "Bot starting up - renaming offline lobby",
          );
          logger.info(
            `Renamed offline lobby channel back to online: ${lobbyName}`,
          );
          return; // We're done, no need to create a new channel
        } catch (error) {
          logger.error(`Failed to rename offline lobby channel:`, error);
          // Fall through to deletion if renaming fails
        }
      }

      // Remove ALL existing lobby channels first
      for (const channel of allLobbyChannels.values()) {
        try {
          await channel.delete(
            "Bot cleanup - removing duplicate lobby channels",
          );
          logger.info(`Removed duplicate lobby channel: ${channel.name}`);
        } catch (error) {
          logger.error(
            `Failed to remove lobby channel ${channel.name}:`,
            error,
          );
        }
      }

      // Create exactly ONE lobby channel
      try {
        const newLobby = await guild.channels.create({
          name: lobbyName,
          type: ChannelType.GuildVoice,
          parent: category,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: ["Connect", "Speak", "ViewChannel"],
            },
          ],
        });
        logger.info(`Created lobby channel: ${newLobby.name}`);
      } catch (error) {
        logger.error(`Failed to create lobby channel:`, error);
      }
    } catch (error) {
      logger.error("Error ensuring lobby channels:", error);
    }
  }

  public async cleanupEmptyChannels(): Promise<void> {
    try {
      // Check if voice channel management is enabled using correct config keys
      const isEnabled =
        (await configService.getBoolean("voicechannels.enabled")) ||
        (await configService.getBoolean("voice_channel.enabled")) ||
        (await configService.getBoolean("ENABLE_VC_MANAGEMENT"));

      if (!isEnabled) {
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

      // Try correct config keys first, then fall back to old ones
      const categoryName =
        (await configService.getString("voicechannels.category.name")) ||
        (await configService.getString("voice_channel.category_name")) ||
        (await configService.getString(
          "VC_CATEGORY_NAME",
          "Dynamic Voice Channels",
        ));

      const lobbyChannelName =
        (await configService.getString("voicechannels.lobby.name")) ||
        (await configService.getString("voice_channel.lobby_channel_name")) ||
        (await configService.getString("LOBBY_CHANNEL_NAME", "Lobby"));

      const offlineLobbyName =
        (await configService.getString("voicechannels.lobby.offlinename")) ||
        (await configService.getString(
          "voice_channel.lobby_channel_name_offline",
        ));

      if (!offlineLobbyName) {
        logger.error(
          "voicechannels.lobby.offlinename is not set in configuration",
        );
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

      // Get all channels in the category
      const allChannels = category.children.cache.filter(
        (channel): channel is VoiceChannel =>
          channel.type === ChannelType.GuildVoice,
      );

      // Get managed channel names (lobby names + any channels with our prefix)
      const channelPrefix = await configService.getString(
        "voicechannels.channel.prefix",
        "🎮",
      );

      // Channels the bot manages - only count UNIQUE names
      const managedChannelNames = new Set([
        lobbyChannelName,
        // Note: offlineLobbyName is NOT managed - it's just a temporary state
      ]);

      // Add any channels that start with our prefix
      for (const channel of allChannels.values()) {
        if (channel.name.startsWith(channelPrefix)) {
          managedChannelNames.add(channel.name);
        }
      }

      // Clean up channels the bot doesn't manage
      for (const channel of allChannels.values()) {
        try {
          // Skip if it's a managed channel
          if (managedChannelNames.has(channel.name)) {
            logger.debug(`Skipping managed channel: ${channel.name}`);
            continue;
          }

          // Delete unmanaged channels (empty or not)
          await channel.delete("Bot cleanup - unmanaged channel");
          logger.info(`Deleted unmanaged channel: ${channel.name}`);
        } catch (error) {
          logger.error(`Error deleting channel ${channel.name}:`, error);
        }
      }

      // Also clean up empty managed channels (except lobby)
      const emptyManagedChannels = allChannels.filter(
        (channel) =>
          managedChannelNames.has(channel.name) &&
          channel.name !== lobbyChannelName &&
          channel.name !== offlineLobbyName &&
          channel.members.size === 0,
      );

      for (const channel of emptyManagedChannels.values()) {
        try {
          await channel.delete("Bot cleanup - empty managed channel");
          logger.info(`Deleted empty managed channel: ${channel.name}`);
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
      if (!(await configService.getBoolean("voicechannels.enabled", false))) {
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
        "voicechannels.category.name",
        "Dynamic Voice Channels",
      );
      const lobbyChannelName = (
        await configService.getString("voicechannels.lobby.name", "Lobby")
      ).replace(/["']/g, "");
      const offlineLobbyName = await configService.getString(
        "voicechannels.lobby.offlinename",
      );

      if (!offlineLobbyName) {
        logger.error(
          "voicechannels.lobby.offlinename is not set in configuration",
        );
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

  /**
   * Get the total number of users currently in voice channels
   */
  public async getTotalVcUserCount(): Promise<number> {
    try {
      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) return 0;

      const guild = await this.getGuild(guildId);
      if (!guild) return 0;

      // Get the voice channel category
      const categoryName = await this.configService.getString(
        "voicechannels.category.name",
        "Voice Channels",
      );

      const category = guild.channels.cache.find(
        (channel): channel is CategoryChannel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === categoryName,
      );

      if (!category) return 0;

      // Count all users in voice channels within the category
      let totalUsers = 0;
      for (const channel of category.children.cache.values()) {
        if (channel.type === ChannelType.GuildVoice) {
          totalUsers += channel.members.size;
        }
      }

      return totalUsers;
    } catch (error) {
      logger.error("Error getting total VC user count:", error);
      return 0;
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
