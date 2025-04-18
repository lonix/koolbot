import {
  VoiceState,
  GuildMember,
  VoiceChannel,
  Client,
  ButtonInteraction,
} from "discord.js";
import Logger from "../utils/logger.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";

const logger = Logger.getInstance();

export type TimePeriod = "week" | "month" | "alltime";

interface IAggregatedUserStats {
  userId: string;
  username: string;
  totalTime: number;
  lastSeen: Date;
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

export class VoiceChannelTracker {
  private static instance: VoiceChannelTracker;
  private activeSessions: Map<
    string,
    { startTime: Date; channelId: string; channelName: string }
  > = new Map();
  private userChannels: Map<string, VoiceChannel> = new Map();
  private client: Client;

  private constructor(client: Client) {
    this.client = client;
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
        if (process.env.DEBUG === "true") {
          logger.info(`[DEBUG] No member found in voice state update`);
        }
        return;
      }

      const oldChannel = oldState.channel;
      const newChannel = newState.channel;

      if (process.env.DEBUG === "true") {
        logger.info(
          `[DEBUG] Voice state update for ${member.displayName} (${member.id}):`,
        );
        logger.info(
          `[DEBUG] Old channel: ${oldChannel ? oldChannel.name : "none"} (${oldChannel?.id || "none"})`,
        );
        logger.info(
          `[DEBUG] New channel: ${newChannel ? newChannel.name : "none"} (${newChannel?.id || "none"})`,
        );
        logger.info(
          `[DEBUG] Active session exists: ${this.activeSessions.has(member.id)}`,
        );
      }

      // User joined a channel (including initial join)
      if (!oldChannel && newChannel) {
        if (process.env.DEBUG === "true") {
          logger.info(
            `[DEBUG] Starting tracking for user ${member.displayName} (${member.id}) in channel ${newChannel.name}`,
          );
        }
        await this.startTracking(member, newChannel.id, newChannel.name);
      }
      // User switched channels
      else if (oldChannel && newChannel) {
        if (process.env.DEBUG === "true") {
          logger.info(
            `[DEBUG] Ending tracking for user ${member.displayName} (${member.id}) in old channel ${oldChannel.name}`,
          );
        }
        await this.endTracking(member.id);
        if (process.env.DEBUG === "true") {
          logger.info(
            `[DEBUG] Starting tracking for user ${member.displayName} (${member.id}) in new channel ${newChannel.name}`,
          );
        }
        await this.startTracking(member, newChannel.id, newChannel.name);
      }
      // User left a channel (disconnect) - handle both cases:
      // 1. oldChannel exists but newChannel is null (direct disconnect)
      // 2. both channels are null but we have an active session (final disconnect state)
      else if (
        (oldChannel && !newChannel) ||
        (!oldChannel && !newChannel && this.activeSessions.has(member.id))
      ) {
        if (process.env.DEBUG === "true") {
          logger.info(
            `[DEBUG] User disconnected - Ending tracking for user ${member.displayName} (${member.id})`,
          );
          const activeSession = this.activeSessions.get(member.id);
          if (activeSession) {
            logger.info(
              `[DEBUG] Found active session in channel ${activeSession.channelName} (${activeSession.channelId})`,
            );
          }
        }
        await this.endTracking(member.id);
      }
    } catch (error) {
      logger.error("Error handling voice state update in tracker:", error);
    }
  }

  private async startTracking(
    member: GuildMember,
    channelId: string,
    channelName: string,
  ): Promise<void> {
    try {
      const startTime = new Date();
      this.activeSessions.set(member.id, { startTime, channelId, channelName });

      // Update last seen and add new session
      await VoiceChannelTracking.findOneAndUpdate(
        { userId: member.id },
        {
          $set: {
            username: member.displayName,
            lastSeen: startTime,
          },
          $push: {
            sessions: {
              startTime,
              channelId,
              channelName,
              endTime: null, // Initialize as null
              duration: null, // Initialize as null
            },
          },
        },
        { upsert: true, new: true },
      );
    } catch (error) {
      logger.error("Error starting voice tracking:", error);
    }
  }

  private async endTracking(userId: string): Promise<void> {
    try {
      const session = this.activeSessions.get(userId);
      if (!session) {
        if (process.env.DEBUG === "true") {
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

      if (process.env.DEBUG === "true") {
        logger.info(
          `[DEBUG] Ending session for user ${userId} in channel ${session.channelName} (${session.channelId})`,
        );
        logger.info(`[DEBUG] Session duration: ${duration} seconds`);
      }

      // Update both total time and the specific session in one operation
      const result = await VoiceChannelTracking.findOneAndUpdate(
        {
          userId,
          "sessions.startTime": session.startTime,
          "sessions.endTime": null, // Only match sessions that haven't ended
        },
        {
          $inc: { totalTime: duration },
          $set: {
            "sessions.$.endTime": endTime,
            "sessions.$.duration": duration,
          },
        },
      );

      if (process.env.DEBUG === "true") {
        if (result) {
          logger.info(
            `[DEBUG] Successfully updated session for user ${userId}`,
          );
        } else {
          logger.info(
            `[DEBUG] Failed to find and update session for user ${userId}`,
          );
        }
      }

      this.activeSessions.delete(userId);
    } catch (error) {
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
                lastSeen: { $max: "$sessions.startTime" },
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
                lastSeen: { $max: "$sessions.startTime" },
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
          users = await VoiceChannelTracking.find()
            .sort({ totalTime: -1 })
            .limit(limit);
          break;
      }

      return users.map((user) => ({
        userId: user._id || user.userId,
        username: user.username,
        totalTime: user.totalTime,
        lastSeen: user.lastSeen,
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
}
