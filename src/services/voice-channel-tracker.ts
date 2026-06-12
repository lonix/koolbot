import {
  VoiceState,
  GuildMember,
  VoiceChannel,
  Client,
  ButtonInteraction,
  User,
} from "discord.js";
import logger, { isDebugMode } from "../utils/logger.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import mongoose from "mongoose";
import { ConfigService } from "./config-service.js";
import { AchievementsService } from "./achievements-service.js";

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
  private encounteredUsers: Map<string, Set<string>> = new Map(); // Track all users encountered during each session
  // Precise per-companion co-presence accounting (#570). For each tracked
  // session: `companionSince` holds the epoch-ms start of the *current* open
  // overlap interval with each presently-co-located user, and
  // `companionSeconds` accumulates closed intervals. A companion's interval
  // opens when both are in the channel and closes when either leaves (or the
  // session ends). `sessionFirsts` records the channel's emptiness and the
  // users already present at the tracked user's join.
  private companionSince: Map<string, Map<string, number>> = new Map();
  private companionSeconds: Map<string, Map<string, number>> = new Map();
  private sessionFirsts: Map<
    string,
    { wasFirst: boolean; joinedExisting: string[] }
  > = new Map();
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
      // Check if voice tracking is enabled
      const isEnabled = await this.configService.getBoolean(
        "voicetracking.enabled",
        false,
      );
      if (!isEnabled) {
        return; // Voice tracking is disabled
      }

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

      // Track users joining/leaving channels where we have active sessions
      // This ensures we capture all interactions even if users leave before the session ends.
      // Companion overlap accounting is extra per-update work, so only run it when
      // the feature is enabled (read the gate once for this update).
      const companionsEnabled = await this.configService.getBoolean(
        "voicetracking.companions.enabled",
        false,
      );
      if (oldChannel && !newChannel) {
        // User left a channel - record interaction for all active sessions in that channel
        this.recordUserInteraction(oldChannel.id, member.id);
        if (companionsEnabled) this.companionLeft(oldChannel.id, member.id);
      } else if (!oldChannel && newChannel) {
        // User joined a channel - record interaction for all active sessions in that channel
        this.recordUserInteraction(newChannel.id, member.id);
        if (companionsEnabled) this.companionJoined(newChannel.id, member.id);
      } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
        // User switched channels - record for both
        this.recordUserInteraction(oldChannel.id, member.id);
        this.recordUserInteraction(newChannel.id, member.id);
        if (companionsEnabled) {
          this.companionLeft(oldChannel.id, member.id);
          this.companionJoined(newChannel.id, member.id);
        }
      }
    } catch (error) {
      logger.error("Error handling voice state update in tracker:", error);
    }
  }

  /**
   * Records that a user was encountered in a channel for all active sessions in that channel
   */
  private recordUserInteraction(channelId: string, userId: string): void {
    // Find all active sessions in this channel
    for (const [sessionUserId, session] of this.activeSessions.entries()) {
      if (session.channelId === channelId && sessionUserId !== userId) {
        // Add this user to the encountered users set for this session
        const encounteredSet = this.encounteredUsers.get(sessionUserId);
        if (encounteredSet) {
          encounteredSet.add(userId);
        }
      }
    }
  }

  /**
   * Opens a co-presence interval between `companionId` and every tracked
   * session currently in `channelId`. Called when a user joins a channel.
   * In-memory only — persistence is gated separately in `endTracking`.
   */
  private companionJoined(channelId: string, companionId: string): void {
    const now = Date.now();
    for (const [sessionUserId, session] of this.activeSessions.entries()) {
      if (session.channelId !== channelId || sessionUserId === companionId) {
        continue;
      }
      const since = this.companionSince.get(sessionUserId);
      if (since && !since.has(companionId)) {
        since.set(companionId, now);
      }
    }
  }

  /**
   * Closes the open co-presence interval between `companionId` and every
   * tracked session in `channelId`, accumulating the elapsed seconds. Called
   * when a user leaves a channel.
   */
  private companionLeft(channelId: string, companionId: string): void {
    for (const [sessionUserId, session] of this.activeSessions.entries()) {
      if (session.channelId !== channelId || sessionUserId === companionId) {
        continue;
      }
      this.accumulateCompanion(sessionUserId, companionId);
    }
  }

  /**
   * Folds the currently-open interval for `(sessionUserId, companionId)` into
   * the accumulated total and clears it. Safe to call when no interval is
   * open (no-op).
   */
  private accumulateCompanion(
    sessionUserId: string,
    companionId: string,
  ): void {
    const since = this.companionSince.get(sessionUserId);
    const seconds = this.companionSeconds.get(sessionUserId);
    if (!since || !seconds) return;
    const start = since.get(companionId);
    if (start === undefined) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
    seconds.set(companionId, (seconds.get(companionId) ?? 0) + elapsed);
    since.delete(companionId);
  }

  private async isChannelExcluded(channelId: string): Promise<boolean> {
    try {
      // Try new configuration key first, then fall back to old for backward compatibility
      let excludedChannels = await this.configService.get(
        "voicetracking.excluded_channels",
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
      const debugModeEnabled = isDebugMode();
      await this.ensureConnection();

      // Check if channel is excluded
      if (await this.isChannelExcluded(channelId)) {
        if (debugModeEnabled) {
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

      // Initialize encountered users Set with current channel members
      const encounteredSet = new Set<string>();
      // Companion overlap (#570): open an interval for every user already in
      // the channel at the moment this user joins, and snapshot that set for
      // the "firsts" capture.
      const now = Date.now();
      const since = new Map<string, number>();
      const presentAtJoin: string[] = [];
      const guild = member.guild;
      if (guild) {
        const channel = guild.channels.cache.get(channelId) as VoiceChannel;
        if (channel) {
          this.userChannels.set(member.id, channel);
          // Add all current members except the joining user
          if (channel.members) {
            channel.members.forEach((m) => {
              if (m.id !== member.id) {
                encounteredSet.add(m.id);
                since.set(m.id, now);
                presentAtJoin.push(m.id);
              }
            });
          }
        }
      }
      this.encounteredUsers.set(member.id, encounteredSet);
      this.companionSince.set(member.id, since);
      this.companionSeconds.set(member.id, new Map());
      this.sessionFirsts.set(member.id, {
        wasFirst: presentAtJoin.length === 0,
        joinedExisting: presentAtJoin,
      });

      if (debugModeEnabled) {
        logger.info(
          `[DEBUG] Started tracking user ${member.displayName} (${member.id}) in channel ${channelName}, initial users: ${encounteredSet.size}`,
        );
      }
    } catch (error: unknown) {
      logger.error("Error starting voice tracking:", error);
    }
  }

  private async endTracking(userId: string): Promise<void> {
    try {
      const debugModeEnabled = isDebugMode();
      await this.ensureConnection();

      const session = this.activeSessions.get(userId);
      if (!session) {
        if (debugModeEnabled) {
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

      if (debugModeEnabled) {
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

      // Get accumulated users from the encountered users Set
      const encounteredSet = this.encounteredUsers.get(userId);
      const otherUsers: string[] = encounteredSet
        ? Array.from(encounteredSet)
        : [];

      // Build the optional companion/firsts payload only when the feature is
      // enabled, so disabled deployments persist exactly the legacy shape and
      // skip the interval-closing / map churn entirely.
      const companionsEnabled = await this.configService.getBoolean(
        "voicetracking.companions.enabled",
        false,
      );
      const sessionDoc: Record<string, unknown> = {
        startTime: session.startTime,
        endTime,
        duration,
        channelId: session.channelId,
        channelName: session.channelName,
        otherUsers,
      };
      if (companionsEnabled) {
        // Close any still-open companion intervals so the final session reflects
        // everyone who was co-present right up to the disconnect.
        const stillOpen = this.companionSince.get(userId);
        if (stillOpen) {
          for (const companionId of Array.from(stillOpen.keys())) {
            this.accumulateCompanion(userId, companionId);
          }
        }
        const seconds = this.companionSeconds.get(userId);
        sessionDoc.companions = seconds
          ? Array.from(seconds.entries()).map(([id, secs]) => ({
              userId: id,
              seconds: secs,
            }))
          : [];
        const firsts = this.sessionFirsts.get(userId);
        sessionDoc.wasFirst = firsts
          ? firsts.wasFirst
          : otherUsers.length === 0;
        sessionDoc.joinedExisting = firsts ? firsts.joinedExisting : [];
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
            sessions: sessionDoc,
          },
        },
        { upsert: true, new: true },
      );

      this.activeSessions.delete(userId);
      this.userChannels.delete(userId);
      this.encounteredUsers.delete(userId);
      this.companionSince.delete(userId);
      this.companionSeconds.delete(userId);
      this.sessionFirsts.delete(userId);

      if (debugModeEnabled) {
        logger.info(
          `[DEBUG] Saved voice session for user ${user.username} (${userId}) - Duration: ${duration}s, Other users: ${otherUsers.length}`,
        );
      }

      // Check for accolades and achievements after session ends
      try {
        const achievementsService = AchievementsService.getInstance(
          this.client,
        );
        const newAccolades = await achievementsService.checkAndAwardAccolades(
          userId,
          user.username,
        );

        if (newAccolades.length > 0) {
          // Send DM notification for accolades
          await achievementsService.notifyUserOfAccolades(userId, newAccolades);
        }

        // Check for weekly achievements (these are NOT sent as DM notifications)
        await achievementsService.checkAndAwardAchievements(
          userId,
          user.username,
        );
      } catch (error: unknown) {
        logger.error("Error checking achievements/accolades:", error);
        // Don't let achievement errors break voice tracking
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

      // Server-side safety cap. A positive `limit` (e.g. the user-supplied
      // `/voicestats top` count) is clamped to the configurable maximum so a
      // single request can never materialise an unbounded result set. A
      // non-positive `limit` is the documented "all ranked users" sentinel
      // used by internal aggregation consumers (weekly digest fan-out,
      // leaderboard-role reconcile), which still receive every row.
      //
      // Both values are sanitised to a finite positive integer: `$limit` must
      // be an integer, and a fractional/NaN/Infinity config value would
      // otherwise produce an invalid stage or silently disable the cap.
      const rawMax = await this.configService.getNumber(
        "voicetracking.stats.leaderboard_max_results",
        50,
      );
      const maxResults =
        Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : 50;
      const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
      const effectiveLimit =
        requestedLimit > 0 ? Math.min(requestedLimit, maxResults) : 0;
      const limitStage = effectiveLimit > 0 ? [{ $limit: effectiveLimit }] : [];

      switch (timePeriod) {
        case "week":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          users = await VoiceChannelTracking.aggregate([
            { $unwind: "$sessions" },
            { $match: { "sessions.startTime": { $gte: startDate } } },
            {
              $group: {
                _id: "$userId",
                username: { $first: "$username" },
                totalTime: { $sum: "$sessions.duration" },
              },
            },
            { $sort: { totalTime: -1 } },
            ...limitStage,
          ]);
          break;
        case "month":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          users = await VoiceChannelTracking.aggregate([
            { $unwind: "$sessions" },
            { $match: { "sessions.startTime": { $gte: startDate } } },
            {
              $group: {
                _id: "$userId",
                username: { $first: "$username" },
                totalTime: { $sum: "$sessions.duration" },
              },
            },
            { $sort: { totalTime: -1 } },
            ...limitStage,
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
            { $sort: { totalTime: -1 } },
            ...limitStage,
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

  async initialize(): Promise<void> {
    try {
      await this.ensureConnection();
      logger.info("VoiceChannelTracker initialized");
    } catch (error) {
      logger.error("Error initializing VoiceChannelTracker:", error);
      throw error;
    }
  }
}
