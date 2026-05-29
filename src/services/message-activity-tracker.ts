import { Client, Message } from "discord.js";
import logger, { isDebugMode } from "../utils/logger.js";
import { MessageActivityTracking } from "../models/message-activity-tracking.js";
import mongoose from "mongoose";
import { ConfigService } from "./config-service.js";

/**
 * Tracks text-message activity the same way `VoiceChannelTracker` tracks
 * voice activity: a `messageCreate` listener writes per-(user, guild,
 * channel) counts and a bounded array of lightweight per-message
 * timestamps into the `MessageActivityTracking` collection.
 *
 * This is the data-capture foundation only — it does not surface anything
 * on Rewind or the WebUI. See issue #495.
 */
export class MessageActivityTracker {
  private static instance: MessageActivityTracker;
  private client: Client;
  private isConnected: boolean = false;
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.setupMongoConnectionHandlers();
  }

  private setupMongoConnectionHandlers(): void {
    mongoose.connection.on("connected", () => {
      this.isConnected = true;
      logger.info(
        "MongoDB connection established for message activity tracker",
      );
    });

    mongoose.connection.on("disconnected", () => {
      this.isConnected = false;
      logger.warn("MongoDB connection lost for message activity tracker");
    });

    mongoose.connection.on("error", (error: Error) => {
      this.isConnected = false;
      logger.error(
        "MongoDB connection error in message activity tracker:",
        error,
      );
    });
  }

  private async ensureConnection(): Promise<void> {
    if (!this.isConnected) {
      try {
        await mongoose.connect(
          await this.configService.getString(
            "MONGODB_URI",
            "mongodb://mongodb:27017/koolbot",
          ),
        );
        logger.info("Reconnected to MongoDB for message activity tracker");
      } catch (error: unknown) {
        logger.error("Error reconnecting to MongoDB:", error);
        throw error;
      }
    }
  }

  public static getInstance(client: Client): MessageActivityTracker {
    if (!MessageActivityTracker.instance) {
      MessageActivityTracker.instance = new MessageActivityTracker(client);
    }
    return MessageActivityTracker.instance;
  }

  /**
   * Returns true when the given channel ID is listed in
   * `messagetracking.excluded_channels`. Mirrors the comma-separated-ID
   * convention used by `voicetracking.excluded_channels`.
   */
  private async isChannelExcluded(channelId: string): Promise<boolean> {
    try {
      const excludedChannels = await this.configService.get(
        "messagetracking.excluded_channels",
      );

      if (!excludedChannels) return false;

      if (typeof excludedChannels === "string") {
        return excludedChannels
          .split(",")
          .map((id) => id.trim())
          .includes(channelId);
      }

      if (Array.isArray(excludedChannels)) {
        return excludedChannels.includes(channelId);
      }

      return false;
    } catch (error: unknown) {
      logger.error("Error checking excluded message channels:", error);
      return false;
    }
  }

  /**
   * Handle a `messageCreate` event. Writes are gated on
   * `messagetracking.enabled = true`; bot messages, DMs (non-guild
   * messages), and excluded channels are skipped.
   */
  public async handleMessageCreate(message: Message): Promise<void> {
    try {
      // Master switch — turning this off stops tracking entirely.
      const isEnabled = await this.configService.getBoolean(
        "messagetracking.enabled",
        false,
      );
      if (!isEnabled) {
        return;
      }

      // Ignore bot messages (and our own).
      if (message.author?.bot) {
        return;
      }

      // Guild-scoped only — ignore DMs.
      if (!message.guild) {
        return;
      }

      const channelId = message.channelId;

      // Skip excluded channels.
      if (await this.isChannelExcluded(channelId)) {
        if (isDebugMode()) {
          logger.info(
            `[DEBUG] Channel ${channelId} is excluded from message tracking`,
          );
        }
        return;
      }

      await this.recordMessage(message);
    } catch (error: unknown) {
      logger.error("Error handling messageCreate in tracker:", error);
    }
  }

  /**
   * Atomically increments the per-channel and total counters and appends a
   * thin timestamp entry. Uses a match-then-upsert pair so the per-channel
   * counter is created on first sight of a channel without losing the
   * increment, mirroring the non-transactional approach the voice tracker
   * already takes.
   */
  private async recordMessage(message: Message): Promise<void> {
    await this.ensureConnection();

    const userId = message.author.id;
    const guildId = message.guild!.id;
    const channelId = message.channelId;
    const username = message.author.username;
    const sentAt = message.createdAt ?? new Date();

    // Fast path: the user already has a counter for this channel — bump it.
    const result = await MessageActivityTracking.updateOne(
      { userId, guildId, "channels.channelId": channelId },
      {
        $set: { username, lastMessageAt: sentAt },
        $inc: { totalCount: 1, "channels.$.count": 1 },
        $push: { recentMessages: { sentAt, channelId } },
      },
    );

    // No matching channel sub-document (new user or new channel for this
    // user): upsert the document and push a fresh channel counter.
    if (result.matchedCount === 0) {
      await MessageActivityTracking.updateOne(
        { userId, guildId },
        {
          $set: { username, lastMessageAt: sentAt },
          $inc: { totalCount: 1 },
          $push: {
            channels: { channelId, count: 1 },
            recentMessages: { sentAt, channelId },
          },
        },
        { upsert: true },
      );
    }

    if (isDebugMode()) {
      logger.info(
        `[DEBUG] Recorded message for ${username} (${userId}) in channel ${channelId}`,
      );
    }
  }

  public async initialize(): Promise<void> {
    try {
      await this.ensureConnection();
      logger.info("MessageActivityTracker initialized");
    } catch (error) {
      logger.error("Error initializing MessageActivityTracker:", error);
      throw error;
    }
  }
}
