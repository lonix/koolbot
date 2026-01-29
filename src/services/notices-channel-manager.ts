import { Client, TextChannel, EmbedBuilder, ColorResolvable } from "discord.js";
import { CronJob } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import Notice, { INotice } from "../models/notice.js";

// Category colors and emojis
const CATEGORY_CONFIG = {
  general: {
    emoji: "📋",
    color: 0x5865f2 as ColorResolvable,
    label: "General",
  },
  rules: { emoji: "📜", color: 0xe74c3c as ColorResolvable, label: "Rules" },
  info: {
    emoji: "ℹ️",
    color: 0x3498db as ColorResolvable,
    label: "Information",
  },
  help: { emoji: "❓", color: 0x9b59b6 as ColorResolvable, label: "Help" },
  "game-servers": {
    emoji: "🎮",
    color: 0x2ecc71 as ColorResolvable,
    label: "Game Servers",
  },
} as const;

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
    }
    return NoticesChannelManager.instance;
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
          setTimeout(checkReady, 100);
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

  private async startCleanupJob(): Promise<void> {
    // Get cleanup interval from config (in minutes)
    const intervalMinutes = await this.configService.getNumber(
      "notices.cleanup_interval",
      5,
    );

    // Convert to cron expression (*/N * * * * means every N minutes)
    const cronExpression = `*/${intervalMinutes} * * * *`;

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
      `Started notices channel cleanup job (every ${intervalMinutes} minutes)`,
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
        CATEGORY_CONFIG[notice.category as keyof typeof CATEGORY_CONFIG];
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
