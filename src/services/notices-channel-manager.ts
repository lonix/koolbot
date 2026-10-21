import {
  NOTICES_BOT,
  NOTICES_EVERYONE,
  toOverwriteOptions,
} from "../utils/channel-permissions.js";
import { Client, TextChannel, EmbedBuilder } from "discord.js";
import { CronJob } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import { waitForClientReady } from "../utils/discord.js";
import Notice, { INotice } from "../models/notice.js";
import { NOTICE_CATEGORIES } from "../content/notice-categories.js";
import { BOT_FEATURES, BotFeatureInfo } from "../content/bot-features.js";
import { defaultConfig, hasOwn, settingsMetadata } from "./config-schema.js";
import { getBotVersion } from "../utils/version.js";
import { embedColor } from "../utils/embed-style.js";

// Internal sweep interval for purging unauthorised messages from the
// notices channel. Demoted from `notices.cleanup_interval` config key in
// #442 — operators never tuned it; the cadence is an implementation
// detail of the channel-cleanup loop.
const CLEANUP_INTERVAL_MINUTES = 5;

// Mirrors the `maxlength` on `Notice.content` (models/notice.ts).
const NOTICE_CONTENT_MAX_LENGTH = 4000;

// Discord API error code for "Unknown Message": the message is already gone.
const UNKNOWN_MESSAGE_CODE = 10008;

// A top-level feature gate: exactly `<feature>.enabled`. Sub-feature toggles
// (`voicetracking.seen.enabled`) and the `core.*` logging categories have
// three or more segments and are deliberately not listed as features.
const FEATURE_ENABLED_KEY = /^([a-z0-9_]+)\.enabled$/;

/**
 * Every top-level `<feature>.enabled` key in the schema, in schema order.
 * Read from `defaultConfig` on each call so the list can never drift from
 * the features that actually exist.
 *
 * A key only counts as a feature gate when it lives in the category of its
 * own prefix (`quotes.enabled` in `quotes`). A toggle that belongs to another
 * feature's category (`aka.enabled`, the /aka sub-toggle of `namehistory`,
 * #1119) is not a feature of its own. This is the same rule
 * `pickCascadeMasterKey` uses to find a category's master switch.
 */
export function getFeatureEnabledKeys(): string[] {
  const meta = settingsMetadata as Record<
    string,
    { category?: string } | undefined
  >;
  return Object.keys(defaultConfig).filter((key) => {
    const feature = FEATURE_ENABLED_KEY.exec(key)?.[1];
    return feature !== undefined && meta[key]?.category === feature;
  });
}

// Settings saves arrive one key at a time (the Web UI and the wizard write
// each key separately), so wait for the burst to settle before regenerating.
const FEATURE_NOTICE_REFRESH_DEBOUNCE_MS = 2000;

/**
 * The notice copy for a feature gate, or `undefined` when the feature is not
 * listed. A feature is listed only when `BOT_FEATURES` has an entry for it
 * with `listed: true` (#1131), so a feature nobody has classified yet stays
 * out of the post instead of appearing with a generic fallback.
 */
export function getListedFeature(key: string): BotFeatureInfo | undefined {
  const feature = FEATURE_ENABLED_KEY.exec(key)?.[1];
  if (feature === undefined || !hasOwn(BOT_FEATURES, feature)) return undefined;
  const info = BOT_FEATURES[feature];
  return info.listed ? info : undefined;
}

/** One notice line for a listed feature (see `getListedFeature`). */
export function formatFeatureLine(info: BotFeatureInfo): string {
  return `**${info.emoji} ${info.label}** - ${info.description}`;
}

export class NoticesChannelManager {
  private static instance: NoticesChannelManager;
  private client: Client;
  private configService: ConfigService;
  private isInitialized: boolean = false;
  private cleanupJob: CronJob | null = null;
  // Regenerates the features notice on `/config reload` so toggling a
  // feature updates it without a restart (#1007). Registered once the
  // manager is initialized, removed again in stop().
  private reloadCallbackRegistered = false;
  private readonly onConfigReload = async (): Promise<void> => {
    if (!this.isInitialized) return;
    const enabled = await this.configService.getBoolean(
      "notices.enabled",
      false,
    );
    if (!enabled) return;
    await this.ensureBotInfoNotice();
  };

  // Regenerates the features notice when a feature gate is saved from the
  // Web UI. Those saves call `ConfigService.set()` only and never fire the
  // reload callbacks, so without this the notice kept listing a feature until
  // the next `/config reload` or restart (#1120).
  private changeListenerRegistered = false;
  private initializing = false;
  // stop() bumps the generation; work started under an older one bails out
  // at its next checkpoint instead of registering jobs or posting after
  // shutdown. The in-flight promises let stop() wait for that to happen.
  private generation = 0;
  private initPromise: Promise<void> | null = null;
  private noticeRun: Promise<void> | null = null;
  private noticeRerunPending = false;
  // Status messages the bot posted or replaced but could not delete (the
  // delete failed, typically alongside a failed save during an outage). Nothing
  // else tracks them and the cleanup job skips bot messages, so each sync pass
  // retries them. In memory only: a restart reposts every notice anyway.
  private readonly orphanedMessageIds = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onConfigChange = (key: string): void => {
    // Before the manager is running, only enabling it (or pointing it at a
    // channel) matters; once running, feature gates change the notice.
    const relevant = this.isInitialized
      ? key === "notices.enabled" || getFeatureEnabledKeys().includes(key)
      : key === "notices.enabled" || key === "notices.channel_id";
    if (!relevant) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      // Not running yet (started with notices off): bring it up now that
      // the setting may be on. When already running, an off value makes
      // onConfigReload a no-op, so a disabled notice is never refreshed.
      const task = this.isInitialized
        ? this.onConfigReload()
        : this.initialize();
      void task.catch((error) => {
        logger.error("Error refreshing features notice after change:", error);
      });
    }, FEATURE_NOTICE_REFRESH_DEBOUNCE_MS);
    this.refreshTimer.unref?.();
  };

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

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Notices channel manager already initialized, skipping...");
      return;
    }

    if (this.initializing) return;
    this.initializing = true;
    const generation = this.generation;
    this.initPromise = this.runInitialize(generation);
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
      this.initializing = false;
    }
  }

  private async runInitialize(generation: number): Promise<void> {
    const stopped = (): boolean => generation !== this.generation;
    // Subscribe before the enabled check so an instance that starts with
    // notices off still hears `notices.enabled` being turned on in the Web UI.
    if (!this.changeListenerRegistered) {
      this.configService.addChangeListener(this.onConfigChange);
      this.changeListenerRegistered = true;
    }

    logger.info("Initializing notices channel manager...");

    try {
      await waitForClientReady(this.client, "NoticesChannelManager");
      if (stopped()) return;

      const enabled = await this.configService.getBoolean(
        "notices.enabled",
        false,
      );
      if (stopped()) return;
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
      if (stopped()) return;
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
      if (stopped()) return;

      // Ensure header post exists
      await this.ensureHeaderPost(channel);
      if (stopped()) return;

      // Ensure bot info notice exists
      await this.ensureBotInfoNotice();
      if (stopped()) return;

      // Sync all notices to channel
      await this.syncNotices();
      if (stopped()) return;

      // Start cleanup job to remove non-bot messages
      this.startCleanupJob();

      this.configService.registerReloadCallback(this.onConfigReload);
      this.reloadCallbackRegistered = true;
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
      await channel.permissionOverwrites.edit(
        guild.roles.everyone,
        toOverwriteOptions(NOTICES_EVERYONE),
      );

      // Ensure bot can send messages and manage the channel
      await channel.permissionOverwrites.edit(
        botMember,
        toOverwriteOptions(NOTICES_BOT),
      );

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
        .setColor(embedColor("brand"))
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
        .setFooter({ text: "KoolBot · Notices" })
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
    // One run at a time: two overlapping runs could both delete and repost
    // the notice and leave an orphan message. A call that arrives mid-run
    // asks for exactly one more pass once the current one finishes.
    if (this.noticeRun) {
      this.noticeRerunPending = true;
      return this.noticeRun;
    }
    const generation = this.generation;
    this.noticeRun = (async (): Promise<void> => {
      try {
        do {
          this.noticeRerunPending = false;
          await this.syncBotInfoNotice(generation);
        } while (this.noticeRerunPending && generation === this.generation);
      } finally {
        this.noticeRun = null;
        this.noticeRerunPending = false;
      }
    })();
    return this.noticeRun;
  }

  private async retryOrphanedMessages(generation: number): Promise<void> {
    for (const messageId of [...this.orphanedMessageIds]) {
      if (generation !== this.generation) return;
      // true also when Discord says the message is already gone, so an id
      // never loops once it no longer exists.
      if (await this.deleteNoticeMessage(messageId)) {
        this.orphanedMessageIds.delete(messageId);
      }
    }
  }

  private async syncBotInfoNotice(generation: number): Promise<void> {
    try {
      await this.retryOrphanedMessages(generation);
      if (generation !== this.generation) return;

      // Check if a bot info notice already exists
      const existingNotice = await Notice.findOne({
        title: "KoolBot Features & Commands",
        category: "help",
      });

      // Generate current bot info content
      const botInfoContent = await this.generateBotInfoContent();
      if (generation !== this.generation) return;

      if (existingNotice) {
        // Update existing notice if content changed
        if (existingNotice.content !== botInfoContent) {
          // The generation was checked just above, with no await since: once
          // stop() has landed, leave the old message and the stored content
          // alone. The next start reposts from the saved content.
          //
          // Post the new message before deleting the old one, so a pass that
          // fails or is cut short never leaves the channel without a status
          // message. The new content is stored only once the post has
          // succeeded: saving it first would make a failed post look like an
          // up-to-date notice and suppress every later retry.
          const previousContent = existingNotice.content;
          const previousUpdatedAt = existingNotice.updatedAt;
          const previousMessageId = existingNotice.messageId;
          existingNotice.content = botInfoContent; // postNotice reads it
          const messageId = await this.postNotice(existingNotice);
          if (!messageId) {
            existingNotice.content = previousContent;
            return;
          }

          // A post already in flight cannot be recalled: once it has landed
          // the swap is finished (stop() waits for this pass), which keeps
          // exactly one message and a stored id that points at it.
          existingNotice.messageId = messageId;
          existingNotice.updatedAt = new Date();
          try {
            await existingNotice.save();
          } catch (error) {
            // Content and id are stored together or not at all: take the new
            // message back down so the old one stays the single status post.
            existingNotice.content = previousContent;
            existingNotice.messageId = previousMessageId;
            existingNotice.updatedAt = previousUpdatedAt;
            if (!(await this.deleteNoticeMessage(messageId))) {
              this.orphanedMessageIds.add(messageId);
            }
            throw error;
          }
          logger.info("Updated bot info notice with current features");
          if (previousMessageId) {
            if (!(await this.deleteNoticeMessage(previousMessageId))) {
              this.orphanedMessageIds.add(previousMessageId);
            }
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
        if (generation !== this.generation) return;

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
   * Generate bot info content: the running version plus every enabled feature
   * that is classified as member-facing and worth knowing about (#1131). The
   * candidates come from the schema's top-level `<feature>.enabled` keys
   * (#1007); `BOT_FEATURES` decides which of them are listed, and a drift test
   * forces that decision when a feature ships.
   */
  private async generateBotInfoContent(): Promise<string> {
    const features: string[] = [];

    for (const key of getFeatureEnabledKeys()) {
      const info = getListedFeature(key);
      if (!info) continue;
      if (await this.configService.getBoolean(key, false)) {
        features.push(formatFeatureLine(info));
      }
    }

    let content = `🤖 **KoolBot v${getBotVersion()}**\n\n`;
    content +=
      "Welcome! Here are the features currently available on this server:\n\n";

    if (features.length > 0) {
      content += features.join("\n");
      content += "\n**❓ Help** - Use `/help` to see all available commands";
    } else {
      content += "**❓ Help** - Use `/help` to see all available commands\n\n";
      content += "*More features can be enabled by server administrators.*";
    }

    content += "\n\n📚 **Getting Started:**\n";
    content += "• Use `/help` to see detailed command information\n";
    content += "• Commands are organized by feature category\n";
    content += "• Some features may require specific roles or permissions";

    // Notice.content is capped at 4000 chars; never let a long feature list
    // make the save fail and leave the notice stale.
    if (content.length > NOTICE_CONTENT_MAX_LENGTH) {
      content = `${content.slice(0, NOTICE_CONTENT_MAX_LENGTH - 1)}…`;
    }

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
    this.generation++;
    this.orphanedMessageIds.clear();
    if (this.reloadCallbackRegistered) {
      this.configService.removeReloadCallback(this.onConfigReload);
      this.reloadCallbackRegistered = false;
    }
    if (this.changeListenerRegistered) {
      this.configService.removeChangeListener(this.onConfigChange);
      this.changeListenerRegistered = false;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.cleanupJob) {
      this.cleanupJob.stop();
      logger.info("Stopped notices channel cleanup job");
    }
    // Let in-flight work notice the new generation and wind down, so nothing
    // is registered or posted once stop() has returned.
    await Promise.allSettled([this.initPromise, this.noticeRun]);
    // A pass that was winding down may have remembered one more orphan.
    this.orphanedMessageIds.clear();
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
          text: `KoolBot · Notices · ${categoryInfo.label}`,
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
   * Delete a notice message from the channel. Resolves true when the message
   * is gone (deleted now, or Discord reports it no longer exists) and false
   * when it may still be there, so callers can retry.
   */
  public async deleteNoticeMessage(messageId: string): Promise<boolean> {
    try {
      const channel = await this.getNoticesChannel();
      if (!channel) {
        return false;
      }

      const message = await channel.messages.fetch(messageId);
      if (message) {
        await message.delete();
        logger.info(`Deleted notice message ${messageId}`);
      }
      return true;
    } catch (error) {
      if ((error as { code?: unknown })?.code === UNKNOWN_MESSAGE_CODE) {
        return true;
      }
      logger.error(`Error deleting notice message ${messageId}:`, error);
      return false;
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
