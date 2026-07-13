import { Client, TextChannel, EmbedBuilder } from "discord.js";
import { CronJob } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import Notice, { INotice } from "../models/notice.js";
import { NOTICE_CATEGORIES } from "../content/notice-categories.js";

// Internal sweep interval for purging unauthorised messages from the
// notices channel. Demoted from `notices.cleanup_interval` config key in
// #442 — operators never tuned it; the cadence is an implementation
// detail of the channel-cleanup loop.
const CLEANUP_INTERVAL_MINUTES = 5;

export class NoticesChannelManager {
  private static instance: NoticesChannelManager;
  private client: Client;
  private configService: ConfigService;
  private isInitialized: boolean = false;
  private cleanupJob: CronJob | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): NoticesChannelManager {
    if (!NoticesChannelManager.instance) {
      NoticesChannelManager.instance = new NoticesChannelManager(client);
    } else if (NoticesChannelManager.instance.client !== client) {
      throw new Error(
        "NoticesChannelManager already initialised with a different client",
      );
    }
    return NoticesChannelManager.instance;
  }

  public static reset(): void {
    if (NoticesChannelManager.instance) {
      void NoticesChannelManager.instance.stop();
    }
    NoticesChannelManager.instance =
      undefined as unknown as NoticesChannelManager;
  }

  private async waitForClientReady(): Promise<void> {
    if (this.client.isReady()) {
      return;
    }

    return new Promise((resolve) => {
      const checkReady = (): void => {
        if (this.client.isReady()) {
          resolve();
        } else {
          setTimeout(checkReady, 100).unref?.();
        }
      };
      checkReady();
    });
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Notices channel manager already initialized, skipping...");
      return;
    }

    logger.info("Initializing notices channel manager...");

    try {
      await this.waitForClientReady();

      const enabled = await this.configService.getBoolean(
        "notices.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Notices system is disabled");
        return;
      }

      const channelId = await this.configService.getString(
        "notices.channel_id",
        "",
      );
      if (!channelId) {
        logger.warn(
          "Notices channel ID not configured. Set notices.channel_id to enable notices channel.",
        );
        return;
      }

      // Verify channel exists
      const channel = await this.getNoticesChannel();
      if (!channel) {
        logger.error(`Notices channel with ID ${channelId} not found`);
        return;
      }

      logger.info(
        `Notices channel manager initialized with channel: ${channel.name}`,
      );
      this.isInitialized = true;

      // Setup strict permissions on the channel
      await this.setupChannelPermissions(channel);

      // Ensure header post exists
      await this.ensureHeaderPost(channel);

      // Ensure bot info notice exists
      await this.ensureBotInfoNotice();

      // Sync all notices to channel
      await this.syncNotices();

      // Start cleanup job to remove non-bot messages
      this.startCleanupJob();
    } catch (error) {
      logger.error("Error initializing notices channel manager:", error);
    }
  }

  private async setupChannelPermissions(channel: TextChannel): Promise<void> {
    try {
      const guild = channel.guild;
      const botMember = guild.members.me;

      if (!botMember) {
        logger.error("Bot member not found in guild");
        return;
      }

      // Set permissions to prevent everyone from sending messages
      await channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false,
        SendMessagesInThreads: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        AddReactions: true, // Allow reactions
        ViewChannel: true,
        ReadMessageHistory: true,
      });

      // Ensure bot can send messages and manage the channel
      await channel.permissionOverwrites.edit(botMember, {
        SendMessages: true,
        ManageMessages: true,
        ManageChannels: true,
        AddReactions: true,
        ViewChannel: true,
        ReadMessageHistory: true,
      });

      logger.info(`Set strict permissions on notices channel: ${channel.name}`);
    } catch (error) {
      logger.error("Error setting up channel permissions:", error);
    }
  }

  /**
   * Ensure the informational header post exists in the notices channel
   * Follows the bot-controlled channel header pattern from QuoteChannelManager
   */
  private async ensureHeaderPost(channel: TextChannel): Promise<void> {
    try {
      // Check if header is enabled
      const headerEnabled = await this.configService.getBoolean(
        "notices.header_enabled",
        true,
      );
      if (!headerEnabled) {
        logger.debug("Notices channel header is disabled");
        return;
      }

      // Get stored header message ID
      const storedHeaderId = await this.configService.getString(
        "notices.header_message_id",
        "",
      );

      // Try to fetch existing header message
      let headerExists = false;
      if (storedHeaderId) {
        try {
          const existingMessage = await channel.messages.fetch(storedHeaderId);
          if (
            existingMessage &&
            existingMessage.author.id === this.client.user?.id
          ) {
            headerExists = true;
            logger.debug("Notices channel header post already exists");
            return;
          }
        } catch {
          logger.debug("Stored header message not found, will recreate");
        }
      }

      // Create header post if it doesn't exist
      if (!headerExists) {
        await this.createHeaderPost(channel);
      }
    } catch (error) {
      logger.error("Error ensuring header post:", error);
    }
  }

  /**
   * Create the header post with information about the notices channel
   */
  private async createHeaderPost(channel: TextChannel): Promise<void> {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2) // Discord blurple
        .setTitle("📢 Server Notices")
        .setDescription(
          "This channel contains important server information, rules, and helpful resources. All posts are managed by KoolBot.",
        )
        .addFields(
          {
            name: "📋 What's Here",
            value:
              "• Server rules and guidelines\n• Game server connection info\n• Bot feature help and guides\n• Important announcements",
            inline: false,
          },
          {
            name: "🔒 Channel Rules",
            value:
              "• This is a read-only channel\n• Only bot messages are allowed\n• All other messages will be automatically removed",
            inline: false,
          },
        )
        .setFooter({ text: "KoolBot Notices System" })
        .setTimestamp();

      const headerMessage = await channel.send({ embeds: [embed] });
      logger.info(`Created notices channel header post: ${headerMessage.id}`);

      // Pin the message if enabled
      const pinEnabled = await this.configService.getBoolean(
        "notices.header_pin_enabled",
        true,
      );
      if (pinEnabled) {
        try {
          await headerMessage.pin();
          logger.info("Pinned notices channel header post");
        } catch (error) {
          logger.warn(
            "Failed to pin header post (missing permissions?):",
            error,
          );
        }
      }

      // Store the header message ID
      await this.configService.set(
        "notices.header_message_id",
        headerMessage.id,
        "Message ID of the notices channel header post",
        "notices",
      );
    } catch (error) {
      logger.error("Error creating header post:", error);
    }
  }
  /**
   * Ensure the bot info notice exists with current enabled features
   * This auto-generates a notice listing bot features with examples
   */
  private async ensureBotInfoNotice(): Promise<void> {
    try {
      // Check if a bot info notice already exists
      const existingNotice = await Notice.findOne({
        title: "KoolBot Features & Commands",
        category: "help",
      });

      // Generate current bot info content
      const botInfoContent = await this.generateBotInfoContent();

      if (existingNotice) {
        // Update existing notice if content changed
        if (existingNotice.content !== botInfoContent) {
          existingNotice.content = botInfoContent;
          existingNotice.updatedAt = new Date();
          await existingNotice.save();
          logger.info("Updated bot info notice with current features");

          // Delete old message and post new one
          if (existingNotice.messageId) {
            await this.deleteNoticeMessage(existingNotice.messageId);
          }
          const messageId = await this.postNotice(existingNotice);
          if (messageId) {
            existingNotice.messageId = messageId;
            await existingNotice.save();
          }
        }
      } else {
        // Create new bot info notice
        const botInfoNotice = new Notice({
          title: "KoolBot Features & Commands",
          content: botInfoContent,
          category: "help",
          order: -1000, // Display first in help category
          createdBy: this.client.user?.id || "system",
        });
        await botInfoNotice.save();
        logger.info("Created bot info notice");

        // Post to channel
        const messageId = await this.postNotice(botInfoNotice);
        if (messageId) {
          botInfoNotice.messageId = messageId;
          await botInfoNotice.save();
        }
      }
    } catch (error) {
      logger.error("Error ensuring bot info notice:", error);
    }
  }

  /**
   * Generate bot info content based on enabled features
   */
  private async generateBotInfoContent(): Promise<string> {
    const features: string[] = [];

    // Check for enabled features and add descriptions
    const quotesEnabled = await this.configService.getBoolean(
      "quotes.enabled",
      false,
    );
    if (quotesEnabled) {
      features.push(
        '**📝 Quotes** - Save memorable quotes with `/quote text:"..." author:@user`',
      );
    }

    const voiceChannelsEnabled = await this.configService.getBoolean(
      "voicechannels.enabled",
      false,
    );
    if (voiceChannelsEnabled) {
      features.push(
        "**🎤 Voice Channels** - Dynamic voice channel creation (join lobby to create)",
      );
    }

    const voiceTrackingEnabled = await this.configService.getBoolean(
      "voicetracking.enabled",
      false,
    );
    if (voiceTrackingEnabled) {
      features.push(
        "**📊 Voice Tracking** - Track your voice activity with `/voicestats`",
      );
    }

    const achievementsEnabled = await this.configService.getBoolean(
      "achievements.enabled",
      false,
    );
    if (achievementsEnabled) {
      features.push(
        "**🏆 Achievements** - Earn badges for voice activity milestones",
      );
    }

    const announcementsEnabled = await this.configService.getBoolean(
      "announcements.enabled",
      false,
    );
    if (announcementsEnabled) {
      features.push("**📢 Announcements** - Scheduled automated announcements");
    }

    const reactionRolesEnabled = await this.configService.getBoolean(
      "reactionroles.enabled",
      false,
    );
    if (reactionRolesEnabled) {
      features.push(
        "**⭐ Reaction Roles** - Self-assign roles by reacting to messages",
      );
    }

    // Always available commands
    features.push("**❓ Help** - Use `/help` to see all available commands");

    // Build the content
    let content =
      "Welcome! Here are the features currently available on this server:\n\n";

    if (features.length > 1) {
      // More than just help
      content += features.join("\n\n");
    } else {
      content += "**❓ Help** - Use `/help` to see all available commands\n\n";
      content += "*More features can be enabled by server administrators.*";
    }

    content += "\n\n📚 **Getting Started:**\n";
    content += "• Use `/help` to see detailed command information\n";
    content += "• Commands are organized by feature category\n";
    content += "• Some features may require specific roles or permissions";

    return content;
  }

  private async startCleanupJob(): Promise<void> {
    // Convert to cron expression (*/N * * * * means every N minutes)
    const cronExpression = `*/${CLEANUP_INTERVAL_MINUTES} * * * *`;

    this.cleanupJob = new CronJob(
      cronExpression,
      async () => {
        await this.cleanupUnauthorizedMessages();
      },
      null,
      true,
      "UTC",
    );

    logger.info(
      `Started notices channel cleanup job (every ${CLEANUP_INTERVAL_MINUTES} minutes)`,
    );
  }

  private async cleanupUnauthorizedMessages(): Promise<void> {
    try {
      const channel = await this.getNoticesChannel();
      if (!channel) {
        return;
      }

      // Ensure header post exists (recreate if missing)
      await this.ensureHeaderPost(channel);

      // Fetch recent messages (up to 100)
      const messages = await channel.messages.fetch({ limit: 100 });
      const botId = this.client.user?.id;

      if (!botId) {
        return;
      }

      // Find messages not sent by the bot
      const unauthorizedMessages = messages.filter(
        (msg) => msg.author.id !== botId,
      );

      if (unauthorizedMessages.size > 0) {
        logger.info(
          `Found ${unauthorizedMessages.size} unauthorized messages in notices channel, cleaning up...`,
        );

        // Delete unauthorized messages
        for (const message of unauthorizedMessages.values()) {
          try {
            await message.delete();
            logger.debug(
              `Deleted unauthorized message from ${message.author.tag}`,
            );
          } catch (error) {
            logger.error(
              `Error deleting unauthorized message ${message.id}:`,
              error,
            );
          }
        }

        logger.info(
          `Cleaned up ${unauthorizedMessages.size} unauthorized messages from notices channel`,
        );
      }
    } catch (error) {
      logger.error("Error during notices channel cleanup:", error);
    }
  }

  public async stop(): Promise<void> {
    if (this.cleanupJob) {
      this.cleanupJob.stop();
      logger.info("Stopped notices channel cleanup job");
    }
  }

  private async getNoticesChannel(): Promise<TextChannel | null> {
    try {
      const channelId = await this.configService.getString(
        "notices.channel_id",
        "",
      );
      if (!channelId) {
        return null;
      }

      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        logger.error("Notices channel is not a text channel");
        return null;
      }

      return channel as TextChannel;
    } catch (error) {
      logger.error("Error fetching notices channel:", error);
      return null;
    }
  }

  /**
   * Post a notice to the channel
   */
  public async postNotice(notice: INotice): Promise<string | null> {
    try {
      const channel = await this.getNoticesChannel();
      if (!channel) {
        throw new Error("Notices channel not configured or not found");
      }

      const categoryInfo =
        NOTICE_CATEGORIES[notice.category as keyof typeof NOTICE_CATEGORIES];
      const embed = new EmbedBuilder()
        .setColor(categoryInfo.color)
        .setTitle(`${categoryInfo.emoji} ${notice.title}`)
        .setDescription(notice.content)
        .setFooter({
          text: `${categoryInfo.label} • ID: ${notice._id}`,
        })
        .setTimestamp(notice.createdAt);

      const message = await channel.send({ embeds: [embed] });

      logger.info(
        `Posted notice ${notice._id} to channel as message ${message.id}`,
      );
      return message.id;
    } catch (error) {
      logger.error("Error posting notice to channel:", error);
      return null;
    }
  }

  /**
   * Delete a notice message from the channel
   */
  public async deleteNoticeMessage(messageId: string): Promise<void> {
    try {
      const channel = await this.getNoticesChannel();
      if (!channel) {
        return;
      }

      const message = await channel.messages.fetch(messageId);
      if (message) {
        await message.delete();
        logger.info(`Deleted notice message ${messageId}`);
      }
    } catch (error) {
      logger.error(`Error deleting notice message ${messageId}:`, error);
    }
  }

  /**
   * Sync all notices from database to channel
   * Clears existing notices and reposts all
   */
  public async syncNotices(): Promise<void> {
    try {
      logger.info("Syncing notices to channel...");

      const channel = await this.getNoticesChannel();
      if (!channel) {
        logger.warn("Cannot sync notices: channel not found");
        return;
      }

      // Get all messages in the channel
      const messages = await channel.messages.fetch({ limit: 100 });
      const botId = this.client.user?.id;
      const headerMessageId = await this.configService.getString(
        "notices.header_message_id",
        "",
      );

      // Delete all bot messages except the header
      for (const message of messages.values()) {
        if (message.author.id === botId && message.id !== headerMessageId) {
          try {
            await message.delete();
          } catch (error) {
            logger.error(`Error deleting message ${message.id}:`, error);
          }
        }
      }

      // Get all notices from database, sorted by category and order
      const notices = await Notice.find().sort({ category: 1, order: 1 });

      let postedCount = 0;
      for (const notice of notices) {
        const messageId = await this.postNotice(notice);
        if (messageId) {
          // Update notice with message ID
          notice.messageId = messageId;
          await notice.save();
          postedCount++;
        }
      }

      logger.info(`Synced ${postedCount} notices to channel`);
    } catch (error) {
      logger.error("Error syncing notices:", error);
    }
  }
}
