import {
  Client,
  TextChannel,
  EmbedBuilder,
  MessageReaction,
  User,
  PartialMessageReaction,
  PartialUser,
} from "discord.js";
import { CronJob } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import {
  MissingPostError,
  isMissingPostError,
  isUnknownChannelError,
  isUnknownMessageError,
  waitForClientReady,
} from "../utils/discord.js";
import { quoteService } from "./quote-service.js";
import { ANONYMISED_USER_ID } from "./user-data-registry.js";

// Internal sweep interval for purging unauthorised messages from the
// quote channel. Demoted from `quotes.cleanup_interval` config key in
// #442 — operators never tuned it; the cadence is an implementation
// detail of the channel-cleanup loop.
const CLEANUP_INTERVAL_MINUTES = 5;

// Reaction bursts (many users voting at once) would otherwise trigger a DB
// write per reaction event. Coalesce writes per message into a single update
// after this quiet window so a popular quote can't hammer Mongo.
const VOTE_PERSIST_DEBOUNCE_MS = 2000;

// Identifiers used to recognise an existing bot-authored header embed when the
// stored message ID has been lost (e.g. after a reinstall wiped the config
// row). Matching on these prevents the welcome post from being duplicated.
const HEADER_TITLE = "📝 Welcome to the Quote Channel!";
const HEADER_FOOTER = "KoolBot Quote System";

/**
 * Normalize a Discord user ID from various formats to a clean numeric ID
 * Handles: <@123>, <@!123>, @username, or plain 123
 * Returns the numeric ID or the original string if not parseable
 */
function normalizeUserId(input: string): string {
  // Extract ID from mention formats: <@123> or <@!123>
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  // Remove leading @ if present
  const cleanInput = input.replace(/^@/, "");

  // If it's a numeric ID, return it
  if (/^\d+$/.test(cleanInput)) {
    return cleanInput;
  }

  // Return original if we can't parse it (might be a username)
  return input;
}

/**
 * What happened to a post whose saver attribution had to be cleared:
 * re-rendered without them, gone entirely, or still up and still naming
 * them (#916).
 */
export type AttributionRepair = "edited" | "missing" | "failed";

/** A quote-channel post: its message id and the channel it went to (#916). */
export interface QuotePost {
  messageId: string;
  channelId: string;
}

export class QuoteChannelManager {
  private static instance: QuoteChannelManager;
  private client: Client;
  private configService: ConfigService;
  private isInitialized: boolean = false;
  private cleanupJob: CronJob | null = null;
  // Pending debounced vote-count writes, keyed by Discord message ID.
  private voteWriteTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();
  private reactionAddHandler:
    | ((
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser,
      ) => Promise<void>)
    | null = null;
  private reactionRemoveHandler:
    | ((
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser,
      ) => Promise<void>)
    | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    // Register configuration reload callback to reinitialize when quotes settings change
    this.configService.registerReloadCallback(async () => {
      try {
        logger.info("Quote channel configuration changed, reinitializing...");

        // Check if the feature is enabled
        const enabled = await this.configService.getBoolean(
          "quotes.enabled",
          false,
        );

        if (!enabled && this.isInitialized) {
          // Feature disabled, clean up
          logger.info("Quote system disabled, cleaning up...");
          await this.stop();
          this.isInitialized = false;
        } else if (enabled) {
          // Feature enabled or still enabled, reinitialize
          // Stop existing resources before reinitializing
          if (this.isInitialized) {
            await this.stop();
          }
          // Reset initialization flag to allow re-initialization
          this.isInitialized = false;
          await this.initialize();
        }
      } catch (error) {
        logger.error(
          "Error reinitializing quote channel after configuration change:",
          error,
        );
      }
    });
  }

  public static getInstance(client: Client): QuoteChannelManager {
    if (!QuoteChannelManager.instance) {
      QuoteChannelManager.instance = new QuoteChannelManager(client);
    }
    return QuoteChannelManager.instance;
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Quote channel manager already initialized, skipping...");
      return;
    }

    logger.info("Initializing quote channel manager...");

    try {
      await waitForClientReady(this.client, "QuoteChannelManager");

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

      // Optionally rebuild the channel from the database on startup. Gated by
      // quotes.clear_on_sync (default off) inside syncExistingQuotes: when off
      // this is a no-op, when on it wipes the channel and re-posts every stored
      // quote so the channel mirrors the database after a manual edit/restore.
      await this.syncExistingQuotes();

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
   *
   * This method validates that a header post exists by checking the stored message ID.
   * If the header is missing or invalid, it creates a new one. The header provides
   * users with context about the channel's purpose and usage.
   *
   * **Pattern for Reuse**: This pattern can be applied to any bot-controlled channel:
   * 1. Check if header is enabled via config
   * 2. Validate existing header by stored message ID
   * 3. Create new header if missing or invalid
   * 4. Store message ID for future validation
   *
   * See DEVELOPER_GUIDE.md "Bot-Controlled Channel Header Posts" for implementation guide.
   *
   * @param channel - The Discord text channel to manage
   * @throws {Error} If channel access fails (logged but doesn't throw)
   * @example
   * // Called during initialization
   * await this.ensureHeaderPost(channel);
   *
   * // Called during cleanup to auto-recreate if deleted
   * await this.ensureHeaderPost(channel);
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
      if (storedHeaderId) {
        try {
          const existingMessage = await channel.messages.fetch(storedHeaderId);
          if (
            existingMessage &&
            existingMessage.author.id === this.client.user?.id
          ) {
            logger.debug("Quote channel header post already exists");
            return;
          }
        } catch {
          logger.debug("Stored header message not found, will recreate");
        }
      }

      // The stored ID is missing or stale (common after a reinstall, which
      // wipes the config row). Before creating a new header, scan the channel
      // for an existing bot-authored header so we don't post a duplicate
      // welcome message. If one is found, adopt its ID instead.
      const existingHeader = await this.findExistingHeader(channel);
      if (existingHeader) {
        logger.info(
          `Adopting existing quote channel header post: ${existingHeader.id}`,
        );
        await this.configService.set(
          "quotes.header_message_id",
          existingHeader.id,
          "Message ID of the quote channel header post",
          "quotes",
        );
        return;
      }

      // No header anywhere — create one.
      await this.createHeaderPost(channel);
    } catch (error) {
      logger.error("Error ensuring header post:", error);
    }
  }

  /**
   * Locate an existing bot-authored header embed in the channel by matching
   * the known title/footer, so a lost `quotes.header_message_id` doesn't cause
   * a duplicate welcome post. Pinned messages are checked first (the header is
   * pinned by default) before falling back to a recent-message scan.
   */
  private async findExistingHeader(
    channel: TextChannel,
  ): Promise<{ id: string } | null> {
    const botId = this.client.user?.id;
    if (!botId) return null;

    const isHeader = (msg: {
      author: { id: string };
      embeds: { title?: string | null; footer?: { text?: string } | null }[];
    }): boolean => {
      if (msg.author.id !== botId) return false;
      return msg.embeds.some(
        (e) => e.title === HEADER_TITLE || e.footer?.text === HEADER_FOOTER,
      );
    };

    try {
      const pinned = await channel.messages.fetchPinned();
      const pinnedHeader = pinned.find((m) => isHeader(m));
      if (pinnedHeader) return { id: pinnedHeader.id };
    } catch (error) {
      logger.debug("Could not fetch pinned messages while scanning for header");
      logger.debug(String(error));
    }

    try {
      const recent = await channel.messages.fetch({ limit: 100 });
      const recentHeader = recent.find((m) => isHeader(m));
      if (recentHeader) return { id: recentHeader.id };
    } catch (error) {
      logger.debug("Could not fetch recent messages while scanning for header");
      logger.debug(String(error));
    }

    return null;
  }

  /**
   * Create the header post with information about the quote channel
   *
   * Generates an embedded message with Discord blurple color that explains:
   * - How to add quotes (via /quote command)
   * - How to vote on quotes (👍/👎 reactions)
   * - Channel rules (bot-only messages, auto-cleanup)
   *
   * The message is pinned (if enabled) and its ID is stored in the config database
   * for validation on subsequent bot restarts.
   *
   * **Customization**: When reusing this pattern, modify the embed content to match
   * your channel's purpose while maintaining the same structure (title, description,
   * fields, footer).
   *
   * @param channel - The Discord text channel to post in
   * @throws {Error} If message creation fails (logged but doesn't throw)
   * @example
   * // Automatically called by ensureHeaderPost when header is missing
   * await this.createHeaderPost(channel);
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
    // Stop existing cleanup job if any
    if (this.cleanupJob) {
      this.cleanupJob.stop();
      this.cleanupJob = null;
      logger.debug("Stopped existing cleanup job before starting new one");
    }

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
      `Started quote channel cleanup job (every ${CLEANUP_INTERVAL_MINUTES} minutes)`,
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
    // Stop cleanup job
    if (this.cleanupJob) {
      this.cleanupJob.stop();
      this.cleanupJob = null;
      logger.info("Stopped quote channel cleanup job");
    }

    // Flush/cancel any pending debounced vote writes so they don't fire after
    // the manager has been torn down.
    for (const timer of this.voteWriteTimers.values()) {
      clearTimeout(timer);
    }
    this.voteWriteTimers.clear();

    // Remove reaction handlers
    if (this.reactionAddHandler) {
      this.client.removeListener("messageReactionAdd", this.reactionAddHandler);
      this.reactionAddHandler = null;
      logger.debug("Removed messageReactionAdd handler");
    }

    if (this.reactionRemoveHandler) {
      this.client.removeListener(
        "messageReactionRemove",
        this.reactionRemoveHandler,
      );
      this.reactionRemoveHandler = null;
      logger.debug("Removed messageReactionRemove handler");
    }
  }

  private async getQuoteChannel(): Promise<TextChannel | null> {
    return (await this.getQuoteChannelDetailed()).channel;
  }

  /**
   * As `getQuoteChannel`, but says *why* there is no channel.
   *
   * A purge has to tell "the channel was deleted, so every quote post went
   * with it" apart from "we could not reach it this time": the first owes
   * nothing, the second leaves the member's words publicly readable (#916).
   */
  private async getQuoteChannelDetailed(postedIn?: string): Promise<{
    channel: TextChannel | null;
    gone: boolean;
  }> {
    try {
      // The channel a post actually went to, when the row recorded one.
      // `quotes.channel_id` is where posts go *now*: an admin who moves the
      // quote channel leaves every older post behind in the old one, and
      // looking for it in the new channel returns Unknown Message — which a
      // purge would read as "already gone" while the post is still on screen
      // (#916). Rows written before the field existed fall back to the
      // configured channel, which is the best guess available for them.
      const channelId =
        postedIn ||
        (await this.configService.getString("quotes.channel_id", ""));
      if (!channelId) {
        return { channel: null, gone: false };
      }

      const channel = await this.client.channels.fetch(channelId);
      if (!channel) return { channel: null, gone: true };
      if (!channel.isTextBased() || channel.isDMBased()) {
        logger.error("Quote channel is not a text channel");
        return { channel: null, gone: false };
      }

      return { channel: channel as TextChannel, gone: false };
    } catch (error) {
      if (isUnknownChannelError(error)) return { channel: null, gone: true };
      logger.error("Error fetching quote channel:", error);
      return { channel: null, gone: false };
    }
  }

  /**
   * Post a quote to the quote channel.
   *
   * Returns the channel it landed in as well as the message id: the caller
   * has to record both, because `quotes.channel_id` can be changed later and
   * this post stays where it was (#916).
   */
  public async postQuote(
    quoteId: string,
    content: string,
    authorId: string,
    addedById: string,
    votes?: { likes: number; dislikes: number },
  ): Promise<QuotePost | null> {
    try {
      const channel = await this.getQuoteChannel();
      if (!channel) {
        throw new Error("Quote channel not configured or not found");
      }

      // Normalize user IDs to handle legacy formats and prevent double @
      const normalizedAuthorId = normalizeUserId(authorId);
      const normalizedAddedById = normalizeUserId(addedById);

      const fields = [
        { name: "Author", value: `<@${normalizedAuthorId}>`, inline: true },
        {
          name: "Added by",
          value: `<@${normalizedAddedById}>`,
          inline: true,
        },
      ];
      // When restoring from a backup the actual user reactions can't be
      // recreated (a bot can't react on a user's behalf), so surface the
      // historical tally in the embed itself instead of losing it.
      if (votes && votes.likes + votes.dislikes > 0) {
        fields.push({
          name: "Votes",
          value: `👍 ${votes.likes} · 👎 ${votes.dislikes}`,
          inline: true,
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setDescription(`"${content}"`)
        .addFields(fields)
        .setFooter({ text: `ID: ${quoteId}` })
        .setTimestamp();

      const message = await channel.send({ embeds: [embed] });

      // Add reaction buttons. A failure here must not discard the
      // successfully-posted message id — otherwise the message is orphaned in
      // the channel and its messageId is never persisted (see issue #776).
      try {
        await message.react("👍");
        await message.react("👎");
      } catch (reactionError) {
        logger.error(
          `Posted quote ${quoteId} as message ${message.id} but failed to add reactions:`,
          reactionError,
        );
      }

      logger.info(
        `Posted quote ${quoteId} to channel as message ${message.id}`,
      );
      return { messageId: message.id, channelId: channel.id };
    } catch (error) {
      logger.error("Error posting quote to channel:", error);
      return null;
    }
  }

  /**
   * Delete a post from the quote channel.
   *
   * Returns whether the message is now *gone*, which is not the same as "no
   * exception escaped" (#916). A per-user purge reports this number back to
   * the member as posts removed, so swallowing a failed delete and counting
   * it anyway would tell someone their words are gone from Discord while
   * they are still on screen.
   *
   * A deleted quote channel counts as gone too — it took every post with
   * it. A message that is already missing counts as gone: `messageId` is
   * overloaded (it starts life as the *original* message id and is
   * overwritten by `updateQuoteMessageId` with the quote-channel post id), so
   * a miss is the expected case for older rows, not a failure. Anything
   * else — an unreachable channel, a permissions error, a failed delete —
   * is a real failure, because the post may well still be visible.
   */
  public async deleteQuoteMessage(
    messageId: string,
    postedIn?: string,
  ): Promise<boolean> {
    const { channel, gone } = await this.getQuoteChannelDetailed(postedIn);
    if (!channel) {
      // A deleted channel took every post in it, this one included, so
      // there is nothing left to remove and nothing to report.
      if (gone) return true;
      logger.warn(
        `Could not delete quote message ${messageId}: quote channel unavailable`,
      );
      return false;
    }

    try {
      const message = await channel.messages.fetch(messageId);
      if (!message) return true;
      await message.delete();
      logger.info(`Deleted quote message ${messageId}`);
      return true;
    } catch (error) {
      // The message, or the channel holding it, can go between the fetch
      // above and here. Either proves the post is gone, which is what this
      // reports — the same call `updateQuoteMessage` makes below (#916).
      if (isUnknownMessageError(error) || isUnknownChannelError(error)) {
        // Nothing to delete — see the `messageId` note above.
        return true;
      }
      logger.error(`Error deleting quote message ${messageId}:`, error);
      return false;
    }
  }

  public async updateQuoteMessage(
    messageId: string,
    quoteId: string,
    content: string,
    authorId: string,
    addedById: string,
    postedIn?: string,
  ): Promise<void> {
    const { channel, gone } = await this.getQuoteChannelDetailed(postedIn);
    if (!channel) {
      if (gone) {
        // The channel was deleted and took this post with it, so there is
        // nothing left to re-render — and nothing left on screen either.
        throw new MissingPostError(
          `Quote channel is gone, so message ${messageId} is too`,
        );
      }
      throw new Error("Quote channel not configured or not found");
    }

    try {
      const message = await channel.messages.fetch(messageId);
      if (!message) {
        throw new MissingPostError(`Quote message ${messageId} not found`);
      }

      // Normalize user IDs to handle legacy formats and prevent double @
      const normalizedAuthorId = normalizeUserId(authorId);
      const normalizedAddedById = normalizeUserId(addedById);

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setDescription(`"${content}"`)
        .addFields(
          {
            name: "Author",
            value: `<@${normalizedAuthorId}>`,
            inline: true,
          },
          {
            name: "Added by",
            value: `<@${normalizedAddedById}>`,
            inline: true,
          },
        )
        .setFooter({ text: `ID: ${quoteId}` })
        .setTimestamp();

      await message.edit({ embeds: [embed] });
      logger.info(`Updated quote message ${messageId}`);
    } catch (error) {
      if (isUnknownMessageError(error) || isUnknownChannelError(error)) {
        // Already gone: the caller is told apart from a real failure so a
        // purge does not report a post that no longer exists as one that
        // still names the member (#916).
        throw new MissingPostError(
          `Quote message ${messageId} no longer exists`,
        );
      }
      logger.error(`Error updating quote message ${messageId}:`, error);
      throw error;
    }
  }

  /**
   * Strip the saver attribution from a post that was published into a purge
   * (#916).
   *
   * The purge anonymises the row and re-renders the post it can see; a post
   * that went up moments later is invisible to it, and the row now holds the
   * sentinel so no later purge will find it. Redrawing it here is the only
   * remaining chance — and if the redraw fails the post is taken down
   * instead, because a post naming an erased member is worse than a missing
   * quote.
   *
   * Says which of the two happened, because the callers report it to
   * someone: `"edited"` means the post is still up without the
   * attribution, `"missing"` means there is no post any more, and
   * `"failed"` means it is up and still names them. Collapsing the first
   * two into one boolean let `/quote add` tell a member their quote was
   * posted when it had just been deleted.
   */
  public async clearSaverAttribution(
    messageId: string,
    quoteId: string,
    content: string,
    authorId: string,
    postedIn?: string,
  ): Promise<AttributionRepair> {
    try {
      await this.updateQuoteMessage(
        messageId,
        quoteId,
        content,
        authorId,
        ANONYMISED_USER_ID,
        postedIn,
      );
      return "edited";
    } catch (error) {
      if (isMissingPostError(error)) return "missing";
      logger.warn(
        `Could not re-render quote post ${messageId} after its saver was erased; removing it instead:`,
        error,
      );
      return (await this.deleteQuoteMessage(messageId, postedIn))
        ? "missing"
        : "failed";
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

      const likes = Math.max(0, thumbsUp ? thumbsUp.count - 1 : 0); // -1 to exclude bot's seed reaction
      const dislikes = Math.max(0, thumbsDown ? thumbsDown.count - 1 : 0);

      logger.debug(
        `Quote message ${messageId}: ${likes} likes, ${dislikes} dislikes`,
      );

      // Persist the tally so it survives a channel re-sync / reinstall.
      this.scheduleVotePersist(messageId, likes, dislikes);
    } catch (error) {
      logger.error(`Error updating quote reactions for ${messageId}:`, error);
    }
  }

  /**
   * Debounce vote-count writes per message so a burst of reactions collapses
   * into a single DB update once the activity settles.
   */
  private scheduleVotePersist(
    messageId: string,
    likes: number,
    dislikes: number,
  ): void {
    const existing = this.voteWriteTimers.get(messageId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.voteWriteTimers.delete(messageId);
      quoteService
        .setVoteCountsByMessageId(messageId, likes, dislikes)
        .catch((error) =>
          logger.error(
            `Failed to persist vote counts for message ${messageId}:`,
            error,
          ),
        );
    }, VOTE_PERSIST_DEBOUNCE_MS);

    // Don't keep the event loop alive solely for a pending vote write.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.voteWriteTimers.set(messageId, timer);
  }

  private setupReactionHandlers(): void {
    // Remove existing handlers if any to prevent duplicates
    if (this.reactionAddHandler) {
      this.client.removeListener("messageReactionAdd", this.reactionAddHandler);
    }
    if (this.reactionRemoveHandler) {
      this.client.removeListener(
        "messageReactionRemove",
        this.reactionRemoveHandler,
      );
    }

    // Create and store handler for reactions added
    this.reactionAddHandler = async (reaction, user): Promise<void> => {
      if (user.bot) return;

      try {
        // Fetch partial data if needed
        if (reaction.partial) {
          await reaction.fetch();
        }
        if (user.partial) {
          await user.fetch();
        }

        const channel = await this.getQuoteChannel();
        if (!channel || reaction.message.channelId !== channel.id) {
          return;
        }

        // Update reaction counts
        await this.updateQuoteReactions(reaction.message.id);
      } catch (error) {
        logger.error("Error handling reaction add:", error);
      }
    };

    // Create and store handler for reactions removed
    this.reactionRemoveHandler = async (reaction, user): Promise<void> => {
      if (user.bot) return;

      try {
        // Fetch partial data if needed
        if (reaction.partial) {
          await reaction.fetch();
        }
        if (user.partial) {
          await user.fetch();
        }

        const channel = await this.getQuoteChannel();
        if (!channel || reaction.message.channelId !== channel.id) {
          return;
        }

        // Update reaction counts
        await this.updateQuoteReactions(reaction.message.id);
      } catch (error) {
        logger.error("Error handling reaction remove:", error);
      }
    };

    // Register handlers
    this.client.on("messageReactionAdd", this.reactionAddHandler);
    this.client.on("messageReactionRemove", this.reactionRemoveHandler);
  }

  /**
   * Delete every message in the channel. Discord's bulkDelete is capped at 100
   * messages per call and refuses messages older than 14 days, so anything it
   * skips is removed individually — otherwise a rebuild would re-post quotes on
   * top of surviving old messages and create duplicates. Returns the number of
   * messages deleted.
   */
  private async clearChannel(channel: TextChannel): Promise<number> {
    let totalDeleted = 0;
    // See: https://discord.js.org/#/docs/main/stable/class/TextChannel?scrollTo=bulkDelete
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100 });
      if (messages.size === 0) {
        break;
      }

      let deletedThisRound = 0;
      let bulkDeletedIds: { has: (id: string) => boolean } = {
        has: () => false,
      };
      try {
        // The `true` flag tells bulkDelete to skip (rather than error on)
        // messages older than 14 days.
        const deleted = await channel.bulkDelete(messages, true);
        deletedThisRound += deleted.size;
        bulkDeletedIds = deleted;
      } catch (error) {
        logger.error("Error bulk-deleting quote channel messages:", error);
      }

      // Anything bulkDelete skipped (too old) must be removed individually so
      // the channel is genuinely emptied before quotes are re-posted.
      const remaining = messages.filter((m) => !bulkDeletedIds.has(m.id));
      for (const message of remaining.values()) {
        try {
          await message.delete();
          deletedThisRound++;
        } catch (error) {
          logger.error(
            `Error deleting old quote channel message ${message.id}:`,
            error,
          );
        }
      }

      totalDeleted += deletedThisRound;
      if (deletedThisRound === 0) {
        // Nothing in this batch could be deleted (e.g. missing permissions) —
        // stop instead of refetching the same messages forever.
        break;
      }
    }
    logger.info(`Cleared ${totalDeleted} messages from quote channel`);
    return totalDeleted;
  }

  /**
   * Wipe the quote channel and rebuild it from the database: clear every
   * message, re-create the header, then re-post every stored quote with its
   * saved vote tally restored and the stored message IDs updated.
   *
   * The rebuild only runs when a clear was requested — either explicitly via
   * `clearFirst` (the /quote reset path) or by the operator opting into
   * `quotes.clear_on_sync` (the startup-rebuild path in `initialize()`). A
   * sync that clears nothing is a no-op: `postQuote` always sends a fresh
   * message, so re-posting on top of the existing ones would just duplicate
   * every quote in the channel.
   */
  private async syncExistingQuotes(clearFirst = false): Promise<number> {
    try {
      const channel = await this.getQuoteChannel();
      if (!channel) {
        logger.warn("Cannot sync quotes: channel not found");
        return 0;
      }

      const shouldClear =
        clearFirst ||
        (await this.configService.getBoolean("quotes.clear_on_sync", false));
      if (!shouldClear) {
        // Nothing to do: re-posting without first clearing would duplicate the
        // messages already in the channel.
        return 0;
      }

      logger.info("Syncing existing quotes to channel...");

      await this.clearChannel(channel);
      // The header was just deleted; drop the stale stored ID so exactly one
      // fresh header is created rather than a search turning up nothing.
      await this.configService.set(
        "quotes.header_message_id",
        "",
        "Message ID of the quote channel header post",
        "quotes",
      );
      await this.ensureHeaderPost(channel);

      // Get every stored quote (unbounded): a rebuild must include all quotes,
      // not just the first page.
      const quotes = await quoteService.getAllQuotes();

      // Counted separately: a quote purged mid-rebuild whose post could not
      // be taken down — or whose post still names an erased saver — is not
      // "reposted", it is an orphan (#916).
      let reposted = 0;
      let orphaned = 0;

      for (const quote of quotes) {
        const post = await this.postQuote(
          quote._id.toString(),
          quote.content,
          quote.authorId,
          quote.addedById,
          { likes: quote.likes ?? 0, dislikes: quote.dislikes ?? 0 },
        );

        if (post) {
          const { messageId, channelId } = post;
          // Update quote with message ID in database
          const { stillExists, attributionCleared, recorded } =
            await quoteService.updateQuoteMessageId(
              quote._id.toString(),
              messageId,
              channelId,
            );
          if (!stillExists) {
            // A per-user purge removed the row after this rebuild
            // snapshotted it, so the post just made has nothing pointing at
            // it and nothing would ever collect it (#916). Same compensation
            // as `/quote add`.
            logger.warn(
              `Quote ${quote._id} was purged mid-sync; removing the post just created`,
            );
            if (await this.deleteQuoteMessage(messageId, channelId)) {
              // Cleaned up: this quote is simply not part of the rebuild.
              continue;
            }
            // Still public, with no row pointing at it. Counting it as
            // reposted would report a clean rebuild over an orphan, so the
            // sync says how many it could not account for instead.
            orphaned++;
            continue;
          }
          if (!recorded) {
            // Nothing points at the post just made, and nothing ever will:
            // the sweep ignores bot messages. Same compensation as a purged
            // row (#916).
            logger.warn(
              `Quote ${quote._id} could not record its new post; removing the post just created`,
            );
            if (await this.deleteQuoteMessage(messageId, channelId)) continue;
            orphaned++;
            continue;
          }
          if (attributionCleared && quote.addedById !== ANONYMISED_USER_ID) {
            // The saver was purged after this rebuild snapshotted the row,
            // so the post above was drawn from a stale attribution (#916).
            logger.warn(
              `Quote ${quote._id} lost its saver attribution mid-sync; repairing the post just created`,
            );
            const repair = await this.clearSaverAttribution(
              messageId,
              quote._id.toString(),
              quote.content,
              quote.authorId,
              channelId,
            );
            if (repair === "failed") {
              orphaned++;
              continue;
            }
            if (repair === "missing") {
              // The post had to be taken down rather than redrawn, so this
              // quote is not part of the rebuild — counting it as reposted
              // would report a post that is not there.
              logger.warn(
                `Quote ${quote._id} could not be redrawn after its saver was erased and was removed from the channel`,
              );
              continue;
            }
          }
          reposted++;
        }
      }

      if (orphaned > 0) {
        logger.error(
          `Synced ${reposted} quote(s) to channel, but ${orphaned} post(s) affected by a concurrent data reset remain publicly visible`,
        );
      } else {
        logger.info(`Synced ${reposted} quotes to channel`);
      }
      return reposted;
    } catch (error) {
      logger.error("Error syncing quotes:", error);
      return 0;
    }
  }

  /**
   * Purge the quote channel and rebuild it from the database: clear all
   * messages, re-create a single header post, and re-post every stored quote
   * with its saved vote tally restored. Used by the admin `/quote reset`
   * command to recover a channel left in a bad state (e.g. after a reinstall).
   */
  public async resetChannel(): Promise<{ reposted: number }> {
    const channel = await this.getQuoteChannel();
    if (!channel) {
      throw new Error("Quote channel not configured or not found");
    }
    const reposted = await this.syncExistingQuotes(true);
    return { reposted };
  }
}
