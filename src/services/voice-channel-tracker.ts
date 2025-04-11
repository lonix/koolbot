import { VoiceState, GuildMember } from "discord.js";
import { Logger } from "../utils/logger";
import {
  VoiceChannelTracking,
  IVoiceChannelTracking,
} from "../models/voice-channel-tracking";

const logger = Logger.getInstance();

export class VoiceChannelTracker {
  private static instance: VoiceChannelTracker;
  private activeSessions: Map<
    string,
    { startTime: Date; channelId: string; channelName: string }
  > = new Map();

  private constructor() {}

  public static getInstance(): VoiceChannelTracker {
    if (!VoiceChannelTracker.instance) {
      VoiceChannelTracker.instance = new VoiceChannelTracker();
    }
    return VoiceChannelTracker.instance;
  }

  public async handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ) {
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
  ) {
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

  private async endTracking(userId: string) {
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
  ): Promise<IVoiceChannelTracking | null> {
    try {
      return await VoiceChannelTracking.findOne({ userId });
    } catch (error) {
      logger.error("Error getting user stats:", error);
      return null;
    }
  }

  public async getTopUsers(
    limit: number = 10,
  ): Promise<IVoiceChannelTracking[]> {
    try {
      return await VoiceChannelTracking.find()
        .sort({ totalTime: -1 })
        .limit(limit);
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
}
