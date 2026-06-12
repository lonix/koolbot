import {
  Client,
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
} from "discord.js";
import logger, { isDebugMode } from "../utils/logger.js";
import { ReactionActivityTracking } from "../models/reaction-activity-tracking.js";
import mongoose from "mongoose";
import { ConfigService } from "./config-service.js";

/**
 * Tracks reaction activity the same way `MessageActivityTracker` tracks
 * text messages: a `messageReactionAdd` listener bumps per-user "given" and
 * "received" counters (plus per-year buckets) in the
 * `ReactionActivityTracking` collection.
 *
 * Reactions are high-volume, so each event is at most two single-document
 * upserts (one for the reactor, one for the message author) and we keep no
 * per-reaction detail — only lifetime totals and per-year counts. This is
 * the data-capture foundation only (see #570 / #495); nothing is surfaced on
 * Rewind or the WebUI yet. Writes are gated on `reactiontracking.enabled`.
 */
export class ReactionActivityTracker {
  private static instance: ReactionActivityTracker;
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
        "MongoDB connection established for reaction activity tracker",
      );
    });

    mongoose.connection.on("disconnected", () => {
      this.isConnected = false;
      logger.warn("MongoDB connection lost for reaction activity tracker");
    });

    mongoose.connection.on("error", (error: Error) => {
      this.isConnected = false;
      logger.error(
        "MongoDB connection error in reaction activity tracker:",
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
        logger.info("Reconnected to MongoDB for reaction activity tracker");
      } catch (error: unknown) {
        logger.error("Error reconnecting to MongoDB:", error);
        throw error;
      }
    }
  }

  public static getInstance(client: Client): ReactionActivityTracker {
    if (!ReactionActivityTracker.instance) {
      ReactionActivityTracker.instance = new ReactionActivityTracker(client);
    }
    return ReactionActivityTracker.instance;
  }

  /**
   * Returns true when the given channel ID is listed in
   * `reactiontracking.excluded_channels`. Mirrors the comma-separated-ID
   * convention used by `messagetracking.excluded_channels`.
   */
  private async isChannelExcluded(channelId: string): Promise<boolean> {
    try {
      const excludedChannels = await this.configService.get(
        "reactiontracking.excluded_channels",
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
      logger.error("Error checking excluded reaction channels:", error);
      return false;
    }
  }

  /**
   * Handle a `messageReactionAdd` event. Writes are gated on
   * `reactiontracking.enabled = true`; bot reactors, DMs (non-guild
   * messages), and excluded channels are skipped. The reactor's "given"
   * counter and the message author's "received" counter are bumped.
   */
  public async handleReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    try {
      const isEnabled = await this.configService.getBoolean(
        "reactiontracking.enabled",
        false,
      );
      if (!isEnabled) {
        return;
      }

      // Resolve partial reactions/users so message author + channel are known.
      // Reactions on uncached (old) messages arrive partial.
      if (reaction.partial) {
        reaction = await reaction.fetch();
      }
      if (user.partial) {
        user = await user.fetch();
      }

      // Ignore reactions added by bots (including ourselves).
      if (user.bot) {
        return;
      }

      const message = reaction.message;

      // Guild-scoped only — ignore DM reactions.
      if (!message.guild) {
        return;
      }

      const channelId = message.channelId;
      if (await this.isChannelExcluded(channelId)) {
        if (isDebugMode()) {
          logger.info(
            `[DEBUG] Channel ${channelId} is excluded from reaction tracking`,
          );
        }
        return;
      }

      const guildId = message.guild.id;
      const year = String(new Date().getFullYear());

      // The reactor "gives" a reaction.
      await this.recordReaction(
        user.id,
        guildId,
        user.username ?? "unknown",
        "given",
        year,
      );

      // The message author "receives" a reaction. Skip when the author is a
      // bot, missing, or the reactor themselves (don't inflate own totals).
      const author = message.author;
      if (author && !author.bot && author.id !== user.id) {
        await this.recordReaction(
          author.id,
          guildId,
          author.username ?? "unknown",
          "received",
          year,
        );
      }

      if (isDebugMode()) {
        logger.info(
          `[DEBUG] Recorded reaction given by ${user.username} (${user.id}) in channel ${channelId}`,
        );
      }
    } catch (error: unknown) {
      logger.error("Error handling messageReactionAdd in tracker:", error);
    }
  }

  /**
   * Atomically upsert one user's reaction counters. A Mongo `Map` field lets
   * us `$inc` the per-year bucket on a dotted path in a single operation, so
   * a brand-new user, a new year, and the steady state are all one write —
   * no seed-then-increment slow path is needed.
   */
  private async recordReaction(
    userId: string,
    guildId: string,
    username: string,
    kind: "given" | "received",
    year: string,
  ): Promise<void> {
    await this.ensureConnection();

    const totalField = kind === "given" ? "totalGiven" : "totalReceived";
    const yearField = kind === "given" ? "yearlyGiven" : "yearlyReceived";

    await ReactionActivityTracking.updateOne(
      { userId, guildId },
      {
        $setOnInsert: { userId, guildId },
        $set: { username, lastReactionAt: new Date() },
        $inc: { [totalField]: 1, [`${yearField}.${year}`]: 1 },
      },
      { upsert: true },
    );
  }

  public async initialize(): Promise<void> {
    try {
      await this.ensureConnection();
      logger.info("ReactionActivityTracker initialized");
    } catch (error) {
      logger.error("Error initializing ReactionActivityTracker:", error);
      throw error;
    }
  }
}
