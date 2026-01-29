import { Client, TextChannel, EmbedBuilder } from "discord.js";
import { CronJob } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import { quoteService } from "./quote-service.js";

export class QuoteChannelManager {
  private static instance: QuoteChannelManager;
  private client: Client;
  private configService: ConfigService;
  private isInitialized: boolean = false;
  private cleanupJob: CronJob | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): QuoteChannelManager {
    if (!QuoteChannelManager.instance) {
      QuoteChannelManager.instance = new QuoteChannelManager(client);
    }
    return QuoteChannelManager.instance;
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
      logger.warn("Quote channel manager already initialized, skipping...");
      return;
    }

    logger.info("Initializing quote channel manager...");

    try {
      await this.waitForClientReady();

      const enabled = await this.configService.getBoolean(
        "quotes.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Quote system is disabled");
        return;
      }

      const channelId = await this.configService.getString(
        "quotes.channel_id",
        "",
      );
      if (!channelId) {
        logger.warn(
          "Quote channel ID not configured. Set quotes.channel_id to enable quote channel.",
        );
        return;
      }

      // Verify channel exists
      const channel = await this.getQuoteChannel();
      if (!channel) {
        logger.error(`Quote channel with ID ${channelId} not found`);
        return;
      }

      logger.info(
        `Quote channel manager initialized with channel: ${channel.name}`,
      );
      this.isInitialized = true;

      // Setup strict permissions on the channel
      await this.setupChannelPermissions(channel);

      // Ensure header post exists
      await this.ensureHeaderPost(channel);

      // Setup reaction handlers
      this.setupReactionHandlers();

      // Start cleanup job to remove non-bot messages
      this.startCleanupJob();
    } catch (error) {
      logger.error("Error initializing quote channel manager:", error);
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

      logger.info(`Set strict permissions on quote channel: ${channel.name}`);
    } catch (error) {
      logger.error("Error setting up channel permissions:", error);
    }
  }

  /**
   * Ensure the informational header post exists in the quote channel
   * Creates and pins a header post explaining how the quote channel works
   */
  private async ensureHeaderPost(channel: TextChannel): Promise<void> {
    try {
      // Check if header is enabled
      const headerEnabled = await this.configService.getBoolean(
        "quotes.header_enabled",
        true,
      );
      if (!headerEnabled) {
        logger.debug("Quote channel header is disabled");
        return;
      }

      // Get stored header message ID
      const storedHeaderId = await this.configService.getString(
        "quotes.header_message_id",
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
            logger.debug("Quote channel header post already exists");
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
   * Create the header post with information about the quote channel
   */
  private async createHeaderPost(channel: TextChannel): Promise<void> {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2) // Discord blurple
        .setTitle("📝 Welcome to the Quote Channel!")
        .setDescription(
          "This channel is managed by KoolBot to showcase memorable quotes from server members.",
        )
        .addFields(
          {
            name: "📥 How to Add a Quote",
            value:
              'Use the `/quote` command anywhere in the server to submit a quote.\nExample: `/quote text:"Great quote!" author:@Alice`',
            inline: false,
          },
          {
            name: "👍 How to Vote",
            value:
              "React with 👍 or 👎 to show your appreciation (or not!) for quotes.",
            inline: false,
          },
          {
            name: "🔒 Channel Rules",
            value:
              "• Only bot messages are allowed here\n• All other messages will be automatically removed\n• Browse and enjoy past quotes by scrolling up!",
            inline: false,
          },
        )
        .setFooter({ text: "KoolBot Quote System" })
        .setTimestamp();

      const headerMessage = await channel.send({ embeds: [embed] });
      logger.info(`Created quote channel header post: ${headerMessage.id}`);

      // Pin the message if enabled
      const pinEnabled = await this.configService.getBoolean(
        "quotes.header_pin_enabled",
        true,
      );
      if (pinEnabled) {
        try {
          await headerMessage.pin();
          logger.info("Pinned quote channel header post");
        } catch (error) {
          logger.warn(
            "Failed to pin header post (missing permissions?):",
            error,
          );
        }
      }

      // Store the header message ID (this will persist across bot restarts)
      await this.configService.set(
        "quotes.header_message_id",
        headerMessage.id,
        "Message ID of the quote channel header post",
        "quotes",
      );
    } catch (error) {
      logger.error("Error creating header post:", error);
    }
  }

  private async startCleanupJob(): Promise<void> {
    // Get cleanup interval from config (in minutes)
    const intervalMinutes = await this.configService.getNumber(
      "quotes.cleanup_interval",
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
      `Started quote channel cleanup job (every ${intervalMinutes} minutes)`,
    );
  }

  private async cleanupUnauthorizedMessages(): Promise<void> {
    try {
      const channel = await this.getQuoteChannel();
      if (!channel) {
        return;
      }

      // Ensure header post exists (recreate if missing as per requirement)
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
          `Found ${unauthorizedMessages.size} unauthorized messages in quote channel, cleaning up...`,
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
          `Cleaned up ${unauthorizedMessages.size} unauthorized messages from quote channel`,
        );
      }
    } catch (error) {
      logger.error("Error during quote channel cleanup:", error);
    }
  }

  public async stop(): Promise<void> {
    if (this.cleanupJob) {
      this.cleanupJob.stop();
      logger.info("Stopped quote channel cleanup job");
    }
  }

  private async getQuoteChannel(): Promise<TextChannel | null> {
    try {
      const channelId = await this.configService.getString(
        "quotes.channel_id",
        "",
      );
      if (!channelId) {
        return null;
      }

      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        logger.error("Quote channel is not a text channel");
        return null;
      }

      return channel as TextChannel;
    } catch (error) {
      logger.error("Error fetching quote channel:", error);
      return null;
    }
  }

  public async postQuote(
    quoteId: string,
    content: string,
    authorId: string,
    addedById: string,
  ): Promise<string | null> {
    try {
      const channel = await this.getQuoteChannel();
      if (!channel) {
        throw new Error("Quote channel not configured or not found");
      }

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setDescription(`"${content}"`)
        .addFields(
          { name: "Author", value: `<@${authorId}>`, inline: true },
          { name: "Added by", value: `<@${addedById}>`, inline: true },
        )
        .setFooter({ text: `ID: ${quoteId}` })
        .setTimestamp();

      const message = await channel.send({ embeds: [embed] });

      // Add reaction buttons
      await message.react("👍");
      await message.react("👎");

      logger.info(
        `Posted quote ${quoteId} to channel as message ${message.id}`,
      );
      return message.id;
    } catch (error) {
      logger.error("Error posting quote to channel:", error);
      return null;
    }
  }

  public async deleteQuoteMessage(messageId: string): Promise<void> {
    try {
      const channel = await this.getQuoteChannel();
      if (!channel) {
        return;
      }

      const message = await channel.messages.fetch(messageId);
      if (message) {
        await message.delete();
        logger.info(`Deleted quote message ${messageId}`);
      }
    } catch (error) {
      logger.error(`Error deleting quote message ${messageId}:`, error);
    }
  }

  public async updateQuoteReactions(messageId: string): Promise<void> {
    try {
      const channel = await this.getQuoteChannel();
      if (!channel) {
        return;
      }

      const message = await channel.messages.fetch(messageId);
      if (!message) {
        return;
      }

      // Count reactions
      const thumbsUp = message.reactions.cache.get("👍");
      const thumbsDown = message.reactions.cache.get("👎");

      const likes = thumbsUp ? thumbsUp.count - 1 : 0; // -1 to exclude bot's reaction
      const dislikes = thumbsDown ? thumbsDown.count - 1 : 0;

      logger.debug(
        `Quote message ${messageId}: ${likes} likes, ${dislikes} dislikes`,
      );
    } catch (error) {
      logger.error(`Error updating quote reactions for ${messageId}:`, error);
    }
  }

  private setupReactionHandlers(): void {
    // Listen for reactions added
    this.client.on("messageReactionAdd", async (reaction, user) => {
      if (user.bot) return;

      try {
        const channel = await this.getQuoteChannel();
        if (!channel || reaction.message.channelId !== channel.id) {
          return;
        }

        // Update reaction counts
        await this.updateQuoteReactions(reaction.message.id);
      } catch (error) {
        logger.error("Error handling reaction add:", error);
      }
    });

    // Listen for reactions removed
    this.client.on("messageReactionRemove", async (reaction, user) => {
      if (user.bot) return;

      try {
        const channel = await this.getQuoteChannel();
        if (!channel || reaction.message.channelId !== channel.id) {
          return;
        }

        // Update reaction counts
        await this.updateQuoteReactions(reaction.message.id);
      } catch (error) {
        logger.error("Error handling reaction remove:", error);
      }
    });
  }

  private async syncExistingQuotes(): Promise<void> {
    try {
      logger.info("Syncing existing quotes to channel...");

      const channel = await this.getQuoteChannel();
      if (!channel) {
        logger.warn("Cannot sync quotes: channel not found");
        return;
      }

      // Clear channel first (optional)
      const clearChannel = await this.configService.getBoolean(
        "quotes.clear_on_sync",
        false,
      );
      if (clearChannel) {
        let totalDeleted = 0;
        // Discord bulkDelete is limited to 100 messages per call; loop until the channel is cleared.
        // The `true` flag skips messages older than 14 days to avoid API errors.
        // See: https://discord.js.org/#/docs/main/stable/class/TextChannel?scrollTo=bulkDelete
        // Note: this will only delete messages that are not older than 14 days.
        // Older messages (if any) will remain in the channel.
        // If full historical clearing is required, they must be removed individually.
        // This loop focuses on respecting the bulkDelete 100-message limitation.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const messages = await channel.messages.fetch({ limit: 100 });
          if (messages.size === 0) {
            break;
          }
          const deleted = await channel.bulkDelete(messages, true);
          totalDeleted += deleted.size;
          if (messages.size < 100) {
            // Fetched fewer than 100 messages, so there are no more recent messages to delete.
            break;
          }
        }
        logger.info(`Cleared ${totalDeleted} messages from quote channel`);
      }

      // Get all quotes from database
      const { quotes } = await quoteService.listQuotes(1, 1000);

      for (const quote of quotes) {
        const messageId = await this.postQuote(
          quote._id.toString(),
          quote.content,
          quote.authorId,
          quote.addedById,
        );

        if (messageId) {
          // Update quote with message ID in database
          await quoteService.updateQuoteMessageId(
            quote._id.toString(),
            messageId,
          );
        }
      }

      logger.info(`Synced ${quotes.length} quotes to channel`);
    } catch (error) {
      logger.error("Error syncing quotes:", error);
    }
  }
}
