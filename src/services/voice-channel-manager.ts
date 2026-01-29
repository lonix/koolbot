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
  PermissionFlagsBits,
} from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelTracker } from "../services/voice-channel-tracker.js";
import { ConfigService } from "./config-service.js";

const configService = ConfigService.getInstance();

export class VoiceChannelManager {
  private static instance: VoiceChannelManager;
  private userChannels: Map<string, VoiceChannel> = new Map();
  private ownershipQueue: Map<string, string[]> = new Map(); // channelId -> array of userIds
  private customChannelNames: Map<string, string> = new Map(); // channelId -> custom name
  private channelsBeingDeleted: Set<string> = new Set(); // channelIds currently being deleted
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private ownershipTransferTimers: Map<
    string,
    { timer: ReturnType<typeof setTimeout>; originalOwnerId: string }
  > = new Map(); // channelId -> timer and original owner info
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

  /**
   * Mark a channel as having a custom name
   */
  public setCustomChannelName(channelId: string, name: string): void {
    this.customChannelNames.set(channelId, name);
  }

  /**
   * Check if a channel has a custom name
   */
  public hasCustomName(channelId: string): boolean {
    return this.customChannelNames.has(channelId);
  }

  /**
   * Get custom channel name
   */
  public getCustomChannelName(channelId: string): string | undefined {
    return this.customChannelNames.get(channelId);
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
        // Owner is still in the channel, cancel any pending ownership transfer
        this.cancelOwnershipTransfer(channel.id);
        return;
      }

      // Get grace period from config
      const gracePeriodSeconds = await this.configService.getNumber(
        "voicechannels.ownership.grace_period_seconds",
        30,
      );

      // Check if there's already a pending ownership transfer for this channel
      if (this.ownershipTransferTimers.has(channel.id)) {
        logger.info(
          `Ownership transfer already scheduled for channel ${channel.name}`,
        );
        return;
      }

      logger.info(
        `Owner ${currentOwnerId} left channel ${channel.name}. Scheduling ownership transfer in ${gracePeriodSeconds} seconds...`,
      );

      // Schedule ownership transfer after grace period
      const timer = setTimeout(async () => {
        try {
          // Double-check that the owner hasn't rejoined
          const channelNow = (await this.client.channels.fetch(
            channel.id,
          )) as VoiceChannel;
          if (!channelNow) {
            logger.warn(
              `Channel ${channel.id} no longer exists, skipping ownership transfer`,
            );
            this.ownershipTransferTimers.delete(channel.id);
            return;
          }

          // Check if the original owner has rejoined
          if (channelNow.members.has(currentOwnerId)) {
            logger.info(
              `Original owner ${currentOwnerId} rejoined channel ${channelNow.name}, canceling ownership transfer`,
            );
            this.ownershipTransferTimers.delete(channel.id);
            return;
          }

          // Get members in the channel
          const members = Array.from(channelNow.members.values());
          if (members.length === 0) {
            logger.info(
              `Channel ${channelNow.name} is now empty, no ownership transfer needed`,
            );
            this.ownershipTransferTimers.delete(channel.id);
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
          await this.updateChannelOwnership(channelNow, newOwner);
          logger.info(
            `Channel ${channelNow.name} ownership transferred to ${newOwner.displayName} based on voice time`,
          );

          // Clear the timer from the map
          this.ownershipTransferTimers.delete(channel.id);
        } catch (error) {
          logger.error("Error during scheduled ownership transfer:", error);
          this.ownershipTransferTimers.delete(channel.id);
        }
      }, gracePeriodSeconds * 1000);

      // Store the timer and original owner info
      this.ownershipTransferTimers.set(channel.id, {
        timer,
        originalOwnerId: currentOwnerId,
      });
    } catch (error) {
      logger.error("Error handling channel ownership change:", error);
    }
  }

  /**
   * Cancel a pending ownership transfer for a channel
   */
  private cancelOwnershipTransfer(channelId: string): void {
    const timerInfo = this.ownershipTransferTimers.get(channelId);
    if (timerInfo) {
      clearTimeout(timerInfo.timer);
      this.ownershipTransferTimers.delete(channelId);
      logger.info(
        `Canceled pending ownership transfer for channel ${channelId}`,
      );
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

      logger.info(
        `[Manual Transfer] Starting manual ownership transfer for channel ${channel.name} (${channelId})`,
      );
      logger.info(`[Manual Transfer] Current owner: ${currentOwnerId}`);
      logger.info(
        `[Manual Transfer] New owner: ${newOwner.displayName} (${newOwnerId})`,
      );

      // Update permissions: grant ManageChannels to new owner
      logger.info(
        `[Manual Transfer] Granting ManageChannels permission to new owner ${newOwnerId}`,
      );
      await channel.permissionOverwrites.create(newOwnerId, {
        ManageChannels: true,
        Connect: true,
        Speak: true,
        ViewChannel: true,
      });

      // Remove ManageChannels from previous owner (keep other permissions)
      logger.info(
        `[Manual Transfer] Removing ManageChannels permission from previous owner ${currentOwnerId}`,
      );
      await channel.permissionOverwrites.create(currentOwnerId, {
        ManageChannels: false,
        Connect: true,
        Speak: true,
        ViewChannel: true,
      });

      // Only rename if channel doesn't have a custom name
      if (!this.hasCustomName(channelId)) {
        const newChannelName = `${newOwner.displayName}'s Channel`;
        logger.info(`[Manual Transfer] Renaming channel to: ${newChannelName}`);
        await channel.setName(newChannelName);
      } else {
        logger.info(
          `[Manual Transfer] Channel has custom name, skipping rename`,
        );
      }

      // Update ownership tracking
      this.userChannels.delete(currentOwnerId);
      this.userChannels.set(newOwnerId, channel);
      logger.info(`[Manual Transfer] Updated ownership tracking map`);

      // Clear the ownership queue for this channel
      this.ownershipQueue.delete(channelId);

      // Update control panel message with new owner
      logger.info(`[Manual Transfer] Updating control panel message`);
      await this.updateControlPanelOwnership(channel, newOwnerId);

      // Notify channel members
      logger.info(
        `[Manual Transfer] Sending ownership change notification to channel`,
      );
      await channel.send(
        `Channel ownership has been transferred to ${newOwner.displayName}`,
      );

      logger.info(
        `[Manual Transfer] Successfully completed manual ownership transfer for channel ${channel.name} from ${currentOwnerId} to ${newOwnerId}`,
      );
    } catch (error) {
      logger.error(
        "[Manual Transfer] Error transferring channel ownership:",
        error,
      );
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

        // Always check if the old channel is now empty and should be cleaned up
        // This handles the case where ownership was transferred but the channel is now empty
        if (oldChannel.type === ChannelType.GuildVoice) {
          await this.cleanupEmptyChannel(oldChannel);
        }
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
          // Check if old channel is now empty
          if (oldChannel.type === ChannelType.GuildVoice) {
            await this.cleanupEmptyChannel(oldChannel);
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
          // Check if old channel is now empty
          if (oldChannel.type === ChannelType.GuildVoice) {
            await this.cleanupEmptyChannel(oldChannel);
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
          // Check if old channel is now empty
          if (oldChannel.type === ChannelType.GuildVoice) {
            await this.cleanupEmptyChannel(oldChannel);
          }
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

      // Create the control panel embed
      const embed = new EmbedBuilder()
        .setTitle("🎮 Voice Channel Controls")
        .setDescription(
          `Welcome to your voice channel: **${channel.name}**\n\n` +
            `Use the buttons below to customize your channel!`,
        )
        .setColor(0x00ff00)
        .setFooter({ text: "Only the channel owner can use these controls" });

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

      // In Discord, voice channels can have built-in text chat enabled
      // This feature is available in some servers but not all
      // Try to send to the voice channel if it supports messaging
      if ("send" in channel && typeof channel.send === "function") {
        try {
          await channel.send({
            content: `<@${ownerId}>`,
            embeds: [embed],
            components: [buttons],
          });

          logger.info(
            `Sent control panel for channel ${channel.name} to voice channel text chat`,
          );
          return;
        } catch (error) {
          logger.debug(
            `Failed to send control panel to voice channel ${channel.name}, trying fallback`,
            error,
          );
        }
      }

      // Fallback: Look for a separate text channel in the same category
      const category = channel.parent;
      if (!category) {
        logger.info(
          `No category found for channel ${channel.name}, cannot send control panel`,
        );
        return;
      }

      // Try to find a text channel in the same category with the same name
      const textChannel = category.children.cache.find(
        (ch) => ch.type === ChannelType.GuildText && ch.name === channel.name,
      ) as TextChannel | undefined;

      if (textChannel) {
        await textChannel.send({
          content: `<@${ownerId}>`,
          embeds: [embed],
          components: [buttons],
        });

        logger.info(
          `Sent control panel for channel ${channel.name} to text channel ${textChannel.name}`,
        );
      } else {
        logger.info(
          `No text channel found for voice channel ${channel.name}, control panel not sent. Users can use /vc commands instead.`,
        );
      }
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
        // Clean up custom name tracking
        this.customChannelNames.delete(channel.id);
        // Clean up ownership queue
        this.ownershipQueue.delete(channel.id);
        logger.info(`Cleaned up voice channel ${channel.name}`);
      }
    } catch (error) {
      logger.error("Error cleaning up user channel:", error);
    }
  }

  /**
   * Clean up a channel if it's empty, regardless of who the current owner is
   * This is needed when ownership has been transferred but the channel becomes empty
   */
  private async cleanupEmptyChannel(channel: VoiceChannel): Promise<void> {
    try {
      // Only clean up if the channel is empty
      if (channel.members.size !== 0) {
        return;
      }

      // Check if channel is already being deleted to prevent race conditions
      if (this.channelsBeingDeleted.has(channel.id)) {
        return;
      }

      // Check if this is a managed channel and find the owner in one pass
      let ownerId: string | null = null;
      for (const [userId, userChannel] of this.userChannels.entries()) {
        if (userChannel.id === channel.id) {
          ownerId = userId;
          break;
        }
      }

      const isManaged = ownerId !== null || this.hasCustomName(channel.id);

      if (!isManaged) {
        // Not a managed channel, don't clean up
        return;
      }

      // Mark channel as being deleted
      this.channelsBeingDeleted.add(channel.id);

      // Delete the channel
      await channel.delete();
      logger.info(`Cleaned up empty voice channel ${channel.name}`);

      // Clean up all tracking for this channel
      if (ownerId) {
        this.userChannels.delete(ownerId);
      }

      // Clean up custom name tracking
      this.customChannelNames.delete(channel.id);

      // Clean up ownership queue
      this.ownershipQueue.delete(channel.id);

      // Remove from deletion tracking
      this.channelsBeingDeleted.delete(channel.id);
    } catch (error) {
      logger.error("Error cleaning up empty channel:", error);
      // Ensure we remove from deletion tracking even if there was an error
      this.channelsBeingDeleted.delete(channel.id);
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
          // Clean up custom name tracking
          this.customChannelNames.delete(channel.id);
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
          // Clean up custom name tracking
          this.customChannelNames.delete(channel.id);
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
      // Get current owner ID
      const currentOwnerId = Array.from(this.userChannels.entries()).find(
        ([, userChannel]) => userChannel.id === channel.id,
      )?.[0];

      logger.info(
        `[Ownership Transfer] Starting ownership transfer for channel ${channel.name} (${channel.id})`,
      );
      logger.info(
        `[Ownership Transfer] Current owner: ${currentOwnerId || "unknown"}`,
      );
      logger.info(
        `[Ownership Transfer] New owner: ${newOwner.displayName} (${newOwner.id})`,
      );

      // Update permissions: grant ManageChannels to new owner
      logger.info(
        `[Ownership Transfer] Granting ManageChannels permission to new owner ${newOwner.id}`,
      );
      await channel.permissionOverwrites.create(newOwner.id, {
        ManageChannels: true,
        Connect: true,
        Speak: true,
        ViewChannel: true,
      });

      // Remove ManageChannels from previous owner if exists
      if (currentOwnerId) {
        logger.info(
          `[Ownership Transfer] Removing ManageChannels permission from previous owner ${currentOwnerId}`,
        );
        await channel.permissionOverwrites.create(currentOwnerId, {
          ManageChannels: false,
          Connect: true,
          Speak: true,
          ViewChannel: true,
        });
      }

      // Only rename if channel doesn't have a custom name
      if (!this.hasCustomName(channel.id)) {
        const newChannelName = `${newOwner.displayName}'s Channel`;
        logger.info(
          `[Ownership Transfer] Renaming channel to: ${newChannelName}`,
        );
        await channel.setName(newChannelName);
      } else {
        logger.info(
          `[Ownership Transfer] Channel has custom name, skipping rename`,
        );
      }

      // Update ownership tracking
      if (currentOwnerId) {
        this.userChannels.delete(currentOwnerId);
      }
      this.userChannels.set(newOwner.id, channel);
      logger.info(`[Ownership Transfer] Updated ownership tracking map`);

      // Update control panel message with new owner
      logger.info(`[Ownership Transfer] Updating control panel message`);
      await this.updateControlPanelOwnership(channel, newOwner.id);

      // Notify channel members about the ownership change
      try {
        logger.info(
          `[Ownership Transfer] Sending ownership change notification to channel`,
        );
        await channel.send(
          `Channel ownership has been transferred to ${newOwner.displayName} based on voice time in the last 7 days`,
        );
      } catch (error) {
        logger.error(
          "[Ownership Transfer] Error sending ownership change notification:",
          error,
        );
      }

      logger.info(
        `[Ownership Transfer] Successfully completed ownership transfer for channel ${channel.name} to ${newOwner.displayName} (${newOwner.id})`,
      );
    } catch (error) {
      logger.error(
        "[Ownership Transfer] Error updating channel ownership:",
        error,
      );
    }
  }

  /**
   * Update control panel message to reflect new owner
   */
  private async updateControlPanelOwnership(
    channel: VoiceChannel,
    newOwnerId: string,
  ): Promise<void> {
    try {
      // Check if control panel is enabled
      const controlPanelEnabled = await configService.getBoolean(
        "voicechannels.controlpanel.enabled",
        true,
      );

      if (!controlPanelEnabled) {
        logger.info(
          "[Control Panel] Control panel is disabled, skipping update",
        );
        return;
      }

      // Try to find the control panel message in the voice channel
      if (
        "messages" in channel &&
        typeof channel.messages?.fetch === "function"
      ) {
        try {
          logger.info(
            `[Control Panel] Fetching messages from voice channel ${channel.name}`,
          );
          const messages = await channel.messages.fetch({ limit: 50 });

          // Find the control panel message (look for the embed with specific title)
          const controlPanelMessage = messages.find(
            (msg) =>
              msg.author.id === this.client.user?.id &&
              msg.embeds.length > 0 &&
              msg.embeds[0].title === "🎮 Voice Channel Controls",
          );

          if (controlPanelMessage) {
            logger.info(
              `[Control Panel] Found control panel message ${controlPanelMessage.id}, updating with new owner ${newOwnerId}`,
            );

            // Get current privacy state
            const guild = channel.guild;
            const everyoneRole = guild.roles.everyone;
            const permissions = channel.permissionOverwrites.cache.get(
              everyoneRole.id,
            );
            const isPrivate = permissions?.deny.has(
              PermissionFlagsBits.Connect,
            );

            // Recreate the embed and buttons with new owner ID
            const embed = new EmbedBuilder()
              .setTitle("🎮 Voice Channel Controls")
              .setDescription(
                `Welcome to your voice channel: **${channel.name}**\n\n` +
                  `Use the buttons below to customize your channel!\n` +
                  `Privacy: ${isPrivate ? "🔒 Invite-Only" : "🌐 Public"}`,
              )
              .setColor(isPrivate ? 0xff0000 : 0x00ff00)
              .setFooter({
                text: "Only the channel owner can use these controls",
              });

            const privacyButton = new ButtonBuilder()
              .setCustomId(`vc_control_privacy_${channel.id}_${newOwnerId}`)
              .setLabel(isPrivate ? "Make Public" : "Make Private")
              .setStyle(isPrivate ? ButtonStyle.Success : ButtonStyle.Danger)
              .setEmoji(isPrivate ? "🌐" : "🔒");

            const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`vc_control_name_${channel.id}_${newOwnerId}`)
                .setLabel("Rename")
                .setStyle(ButtonStyle.Primary)
                .setEmoji("✏️"),
              privacyButton,
              new ButtonBuilder()
                .setCustomId(`vc_control_invite_${channel.id}_${newOwnerId}`)
                .setLabel("Invite")
                .setStyle(ButtonStyle.Secondary)
                .setEmoji("👥")
                .setDisabled(!isPrivate),
              new ButtonBuilder()
                .setCustomId(`vc_control_transfer_${channel.id}_${newOwnerId}`)
                .setLabel("Transfer")
                .setStyle(ButtonStyle.Secondary)
                .setEmoji("👑"),
            );

            // Update the message
            await controlPanelMessage.edit({
              content: `<@${newOwnerId}>`,
              embeds: [embed],
              components: [buttons],
            });

            logger.info(
              `[Control Panel] Successfully updated control panel message for new owner ${newOwnerId}`,
            );
          } else {
            logger.warn(
              `[Control Panel] Control panel message not found in voice channel ${channel.name}, creating new one`,
            );
            // If no control panel exists, create a new one
            await this.sendControlPanel(channel, newOwnerId);
          }
        } catch (error) {
          logger.error(
            "[Control Panel] Error updating control panel message:",
            error,
          );
        }
      } else {
        logger.info(
          "[Control Panel] Voice channel doesn't support text messages, skipping control panel update",
        );
      }
    } catch (error) {
      logger.error(
        "[Control Panel] Error in updateControlPanelOwnership:",
        error,
      );
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
    this.customChannelNames.clear();
    this.ownershipQueue.clear();
    this.channelsBeingDeleted.clear();
  }
}
