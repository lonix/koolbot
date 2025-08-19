import {
  VoiceState,
  GuildMember,
  VoiceChannel,
  Client,
  ButtonInteraction,
  User,
} from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import mongoose from "mongoose";
import { ConfigService } from "./config-service.js";
import { connectToDatabase } from "../utils/database.js";

export type TimePeriod = "week" | "month" | "alltime";

interface IAggregatedUserStats {
  userId: string;
  username: string;
  totalTime: number;
}

interface IUserStats {
  userId: string;
  username: string;
  totalTime: number;
  lastSeen: Date;
  sessions: Array<{
    startTime: Date;
    endTime?: Date;
    duration?: number;
    channelId: string;
    channelName: string;
  }>;
}

interface VoiceSession {
  startTime: Date;
  channelId: string;
  channelName: string;
}

export class VoiceChannelTracker {
  private static instance: VoiceChannelTracker;
  private activeSessions: Map<string, VoiceSession> = new Map();
  private userChannels: Map<string, VoiceChannel> = new Map();
  private client: Client;
  private isConnected: boolean = false;
  private configService: ConfigService;
  private db: any;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.setupMongoConnectionHandlers();
  }

  private setupMongoConnectionHandlers(): void {
    mongoose.connection.on("connected", () => {
      this.isConnected = true;
      logger.info("MongoDB connection established for voice channel tracker");
    });

    mongoose.connection.on("disconnected", () => {
      this.isConnected = false;
      logger.warn("MongoDB connection lost for voice channel tracker");
    });

    mongoose.connection.on("error", (error: Error) => {
      this.isConnected = false;
      logger.error("MongoDB connection error in voice channel tracker:", error);
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
        logger.info("Reconnected to MongoDB for voice channel tracker");
      } catch (error: unknown) {
        logger.error("Error reconnecting to MongoDB:", error);
        throw error;
      }
    }
  }

  public static getInstance(client: Client): VoiceChannelTracker {
    if (!VoiceChannelTracker.instance) {
      VoiceChannelTracker.instance = new VoiceChannelTracker(client);
    }
    return VoiceChannelTracker.instance;
  }

  public getActiveSession(userId: string): { channelName: string } | null {
    const session = this.activeSessions.get(userId);
    return session ? { channelName: session.channelName } : null;
  }

  public async handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    try {
      const member = newState.member || oldState.member; // Try to get member from either state
      if (!member) {
        logger.info(`No member found in voice state update`);
        return;
      }

      const oldChannel = oldState.channel;
      const newChannel = newState.channel;

      logger.info(
        `Voice state update for ${member.displayName} (${member.id}):`,
      );
      logger.info(
        `Old channel: ${oldChannel ? oldChannel.name : "none"} (${oldChannel?.id || "none"})`,
      );
      logger.info(
        `New channel: ${newChannel ? newChannel.name : "none"} (${newChannel?.id || "none"})`,
      );
      logger.info(
        `Active session exists: ${this.activeSessions.has(member.id)}`,
      );

      // User joined a channel (including initial join)
      if (!oldChannel && newChannel) {
        logger.info(
          `Starting tracking for user ${member.displayName} (${member.id}) in channel ${newChannel.name}`,
        );
        await this.startTracking(member, newChannel.id, newChannel.name);
      }
      // User switched channels
      else if (oldChannel && newChannel) {
        logger.info(
          `Ending tracking for user ${member.displayName} (${member.id}) in old channel ${oldChannel.name}`,
        );
        await this.endTracking(member.id);
        logger.info(
          `Starting tracking for user ${member.displayName} (${member.id}) in new channel ${newChannel.name}`,
        );
        await this.startTracking(member, newChannel.id, newChannel.name);
      }
      // User left a channel (disconnect) - handle both cases:
      // 1. oldChannel exists but newChannel is null (direct disconnect)
      // 2. both channels are null but we have an active session (final disconnect state)
      else if (
        (oldChannel && !newChannel) ||
        (!oldChannel && !newChannel && this.activeSessions.has(member.id))
      ) {
        logger.info(
          `User disconnected - Ending tracking for user ${member.displayName} (${member.id})`,
        );
        const activeSession = this.activeSessions.get(member.id);
        if (activeSession) {
          logger.info(
            `Found active session in channel ${activeSession.channelName} (${activeSession.channelId})`,
          );
        }
        await this.endTracking(member.id);
      }
    } catch (error) {
      logger.error("Error handling voice state update in tracker:", error);
    }
  }

  private async isChannelExcluded(channelId: string): Promise<boolean> {
    try {
      // Try new configuration key first, then fall back to old for backward compatibility
      let excludedChannels = await this.configService.get(
        "tracking.excluded_channels",
      );

      if (!excludedChannels) {
        // Fallback to old key
        excludedChannels = await this.configService.get("EXCLUDED_VC_CHANNELS");
      }

      if (!excludedChannels) return false;

      // Handle both string (comma-separated) and array formats
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
      logger.error("Error checking excluded channels:", error);
      return false;
    }
  }

  private async startTracking(
    member: GuildMember,
    channelId: string,
    channelName: string,
  ): Promise<void> {
    try {
      await this.ensureConnection();

      // Check if channel is excluded
      if (await this.isChannelExcluded(channelId)) {
        if (await this.configService.get("DEBUG")) {
          logger.info(
            `[DEBUG] Channel ${channelName} (${channelId}) is excluded from tracking`,
          );
        }
        return;
      }

      this.activeSessions.set(member.id, {
        startTime: new Date(),
        channelId,
        channelName,
      });

      if (await this.configService.get("DEBUG")) {
        logger.info(
          `[DEBUG] Started tracking user ${member.displayName} (${member.id}) in channel ${channelName}`,
        );
      }
    } catch (error: unknown) {
      logger.error("Error starting voice tracking:", error);
    }
  }

  private async endTracking(userId: string): Promise<void> {
    try {
      await this.ensureConnection();

      const session = this.activeSessions.get(userId);
      if (!session) {
        if (await this.configService.get("DEBUG")) {
          logger.info(
            `[DEBUG] No active session found for user ${userId} when attempting to end tracking`,
          );
        }
        return;
      }

      const endTime = new Date();
      const duration = Math.floor(
        (endTime.getTime() - session.startTime.getTime()) / 1000,
      );

      if (await this.configService.get("DEBUG")) {
        logger.info(
          `[DEBUG] Ending session for user ${userId} in channel ${session.channelName} (${session.channelId})`,
        );
      }

      // Get user info from Discord
      const user: User = await this.client.users.fetch(userId);
      if (!user) {
        logger.error(`Could not find user ${userId} when ending tracking`);
        return;
      }

      // Update or create user tracking record
      await VoiceChannelTracking.findOneAndUpdate(
        { userId },
        {
          $set: {
            username: user.username,
            lastSeen: endTime,
          },
          $inc: { totalTime: duration },
          $push: {
            sessions: {
              startTime: session.startTime,
              endTime,
              duration,
              channelId: session.channelId,
              channelName: session.channelName,
            },
          },
        },
        { upsert: true, new: true },
      );

      this.activeSessions.delete(userId);

      if (await this.configService.get("DEBUG")) {
        logger.info(
          `[DEBUG] Saved voice session for user ${user.username} (${userId}) - Duration: ${duration}s`,
        );
      }
    } catch (error: unknown) {
      logger.error("Error ending voice tracking:", error);
    }
  }

  public async getUserStats(
    userId: string,
    timePeriod: TimePeriod = "alltime",
  ): Promise<IUserStats | null> {
    try {
      const user = await VoiceChannelTracking.findOne({ userId });
      if (!user) return null;

      const now = new Date();
      let startDate: Date;
      let filteredSessions;
      let totalTime;

      switch (timePeriod) {
        case "week":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          filteredSessions = user.sessions.filter(
            (session) => session.startTime >= startDate,
          );
          totalTime = filteredSessions.reduce(
            (total, session) => total + (session.duration || 0),
            0,
          );
          break;
        case "month":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          filteredSessions = user.sessions.filter(
            (session) => session.startTime >= startDate,
          );
          totalTime = filteredSessions.reduce(
            (total, session) => total + (session.duration || 0),
            0,
          );
          break;
        case "alltime":
          return {
            userId: user.userId,
            username: user.username,
            totalTime: user.totalTime,
            lastSeen: user.lastSeen,
            sessions: user.sessions,
          };
      }

      return {
        userId: user.userId,
        username: user.username,
        totalTime: totalTime || 0,
        lastSeen: user.lastSeen,
        sessions: filteredSessions || [],
      };
    } catch (error) {
      logger.error("Error getting user stats:", error);
      return null;
    }
  }

  public async getTopUsers(
    limit: number = 10,
    timePeriod: TimePeriod = "alltime",
  ): Promise<IAggregatedUserStats[]> {
    try {
      const now = new Date();
      let startDate: Date;
      let users;

      switch (timePeriod) {
        case "week":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          users = await VoiceChannelTracking.aggregate([
            {
              $unwind: "$sessions",
            },
            {
              $match: {
                "sessions.startTime": { $gte: startDate },
              },
            },
            {
              $group: {
                _id: "$userId",
                username: { $first: "$username" },
                totalTime: { $sum: "$sessions.duration" },
              },
            },
            {
              $sort: { totalTime: -1 },
            },
            {
              $limit: limit,
            },
          ]);
          break;
        case "month":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          users = await VoiceChannelTracking.aggregate([
            {
              $unwind: "$sessions",
            },
            {
              $match: {
                "sessions.startTime": { $gte: startDate },
              },
            },
            {
              $group: {
                _id: "$userId",
                username: { $first: "$username" },
                totalTime: { $sum: "$sessions.duration" },
              },
            },
            {
              $sort: { totalTime: -1 },
            },
            {
              $limit: limit,
            },
          ]);
          break;
        case "alltime":
          users = await VoiceChannelTracking.aggregate([
            {
              $group: {
                _id: "$userId",
                username: { $first: "$username" },
                totalTime: { $sum: "$totalTime" },
              },
            },
            {
              $sort: { totalTime: -1 },
            },
            {
              $limit: limit,
            },
          ]);
          break;
      }

      return users.map((user) => ({
        userId: user._id,
        username: user.username,
        totalTime: user.totalTime || 0,
      }));
    } catch (error) {
      logger.error("Error getting top users:", error);
      return [];
    }
  }

  public async getUserLastSeen(userId: string): Promise<Date | null> {
    try {
      const user = await VoiceChannelTracking.findOne({ userId });
      return user?.lastSeen || null;
    } catch (error) {
      logger.error("Error getting user last seen:", error);
      return null;
    }
  }

  private async handleButtonInteraction(
    interaction: ButtonInteraction,
  ): Promise<void> {
    try {
      if (!interaction.guild) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          ephemeral: true,
        });
        return;
      }

      const channel = await this.client.channels.fetch(interaction.channelId);
      if (!channel || !(channel instanceof VoiceChannel)) {
        return;
      }

      const entries = Array.from(this.userChannels.entries());
      const foundEntry = entries.find(([, vc]) => vc.id === channel.id);
      const userId = foundEntry ? foundEntry[0] : null;

      if (!userId || userId !== interaction.user.id) {
        return;
      }

      let response;
      switch (interaction.customId) {
        case "rename":
          response = "Please enter the new name for your channel:";
          break;
        case "public":
          await channel.permissionOverwrites.edit(
            interaction.guild.roles.everyone,
            {
              ViewChannel: true,
              Connect: true,
            },
          );
          response = "Channel is now public.";
          break;
        case "private":
          await channel.permissionOverwrites.edit(
            interaction.guild.roles.everyone,
            {
              ViewChannel: false,
              Connect: false,
            },
          );
          response = "Channel is now private.";
          break;
        case "invite":
          response = "Please mention the user you want to invite:";
          break;
        case "kick":
          response = "Please mention the user you want to kick:";
          break;
        default:
          response = "Unknown action.";
      }

      await interaction.reply({
        content: response,
        ephemeral: true,
      });
    } catch (error) {
      logger.error("Error handling button interaction:", error);
      await interaction.reply({
        content: "An error occurred while processing your request.",
        ephemeral: true,
      });
    }
  }

  async initialize() {
    try {
      this.db = await connectToDatabase();
      logger.info("VoiceChannelTracker initialized");
    } catch (error) {
      logger.error("Error initializing VoiceChannelTracker:", error);
      throw error;
    }
  }
}
