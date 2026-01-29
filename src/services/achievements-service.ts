import { Client } from "discord.js";
import {
  UserAchievements,
  IAccolade,
  IAchievement,
} from "../models/user-achievements.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import mongoose from "mongoose";

// Badge type definitions
export type AccoladeType =
  | "first_hour"
  | "voice_veteran_100"
  | "voice_veteran_500"
  | "voice_veteran_1000"
  | "voice_legend_8765"
  | "marathon_runner"
  | "ultra_marathoner"
  | "social_butterfly"
  | "connector"
  | "night_owl"
  | "early_bird"
  | "weekend_warrior"
  | "weekday_warrior"
  | "consistent_week"
  | "consistent_fortnight"
  | "consistent_month";

export type AchievementType =
  | "weekly_champion"
  | "weekly_night_owl"
  | "weekly_marathon"
  | "weekly_social_butterfly"
  | "weekly_active"
  | "weekly_consistent";

interface BadgeDefinition {
  emoji: string;
  name: string;
  description: string;
  checkFunction: (userId: string, userData: any | null) => Promise<boolean>;
  metadataFunction?: (
    userId: string,
    userData: any | null,
  ) => Promise<{ value?: number; description?: string; unit?: string }>;
}

export class AchievementsService {
  private static instance: AchievementsService;
  private client: Client;
  private configService: ConfigService;
  private isConnected: boolean = false;

  // Minimum duration threshold for consecutive days (5 minutes in seconds)
  private static readonly MIN_DAILY_DURATION_SECONDS = 300;

  // Accolade definitions (persistent badges)
  private accoladeDefinitions: Record<AccoladeType, BadgeDefinition> = {
    first_hour: {
      emoji: "🎉",
      name: "First Steps",
      description: "Spent your first hour in voice chat",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 3600 : false;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return {
          value: Math.floor((user?.totalTime || 0) / 3600),
          description: "1 hour milestone",
          unit: "hrs",
        };
      },
    },
    voice_veteran_100: {
      emoji: "🎖️",
      name: "Voice Veteran",
      description: "Reached 100 hours in voice chat",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 360000 : false;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return {
          value: Math.floor((user?.totalTime || 0) / 3600),
          description: "100 hours milestone",
          unit: "hrs",
        };
      },
    },
    voice_veteran_500: {
      emoji: "🏅",
      name: "Voice Elite",
      description: "Reached 500 hours in voice chat",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 1800000 : false;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return {
          value: Math.floor((user?.totalTime || 0) / 3600),
          description: "500 hours milestone",
          unit: "hrs",
        };
      },
    },
    voice_veteran_1000: {
      emoji: "🏆",
      name: "Voice Master",
      description: "Reached 1000 hours in voice chat",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 3600000 : false;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return {
          value: Math.floor((user?.totalTime || 0) / 3600),
          description: "1000 hours milestone",
          unit: "hrs",
        };
      },
    },
    voice_legend_8765: {
      emoji: "👑",
      name: "Voice Legend",
      description: "Reached 8765 hours (1 year) in voice chat",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 31554000 : false;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return {
          value: Math.floor((user?.totalTime || 0) / 3600),
          description: "8765 hours (1 year) milestone",
          unit: "hrs",
        };
      },
    },
    marathon_runner: {
      emoji: "🏃",
      name: "Marathon Runner",
      description: "Completed a 4+ hour voice session",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        return user.sessions.some((s: any) => (s.duration || 0) >= 14400);
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        const maxSession = Math.max(
          ...(user?.sessions.map((s: any) => s.duration || 0) || [0]),
        );
        return {
          value: Math.floor(maxSession / 3600),
          description: "4+ hour session",
          unit: "hrs",
        };
      },
    },
    ultra_marathoner: {
      emoji: "🦸",
      name: "Ultra Marathoner",
      description: "Completed an 8+ hour voice session",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        return user.sessions.some((s: any) => (s.duration || 0) >= 28800);
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        const maxSession = Math.max(
          ...(user?.sessions.map((s: any) => s.duration || 0) || [0]),
        );
        return {
          value: Math.floor(maxSession / 3600),
          description: "8+ hour session",
          unit: "hrs",
        };
      },
    },
    social_butterfly: {
      emoji: "🦋",
      name: "Social Butterfly",
      description: "Voiced with 10+ unique users",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const uniqueUsers = new Set(
          user.sessions.flatMap((s: any) => s.otherUsers || []),
        );
        return uniqueUsers.size >= 10;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        const uniqueUsers = new Set(
          user?.sessions.flatMap((s: any) => s.otherUsers || []) || [],
        );
        return {
          value: uniqueUsers.size,
          description: "10+ unique users",
          unit: "users",
        };
      },
    },
    connector: {
      emoji: "🤝",
      name: "Connector",
      description: "Voiced with 25+ unique users",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const uniqueUsers = new Set(
          user.sessions.flatMap((s: any) => s.otherUsers || []),
        );
        return uniqueUsers.size >= 25;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        const uniqueUsers = new Set(
          user?.sessions.flatMap((s: any) => s.otherUsers || []) || [],
        );
        return {
          value: uniqueUsers.size,
          description: "25+ unique users",
          unit: "users",
        };
      },
    },
    night_owl: {
      emoji: "🦉",
      name: "Night Owl",
      description: "Accumulated 50+ hours during late night (10 PM - 6 AM)",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        let lateNightSeconds = 0;
        for (const session of user.sessions) {
          if (session.startTime && session.endTime && session.duration) {
            lateNightSeconds += this.calculateLateNightDuration(
              session.startTime,
              session.endTime,
            );
          }
        }
        return lateNightSeconds >= 180000; // 50 hours
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        let lateNightSeconds = 0;
        if (user) {
          for (const session of user.sessions) {
            if (session.startTime && session.endTime && session.duration) {
              lateNightSeconds += this.calculateLateNightDuration(
                session.startTime,
                session.endTime,
              );
            }
          }
        }
        return {
          value: Math.floor(lateNightSeconds / 3600),
          description: "50+ late-night hours",
          unit: "hrs",
        };
      },
    },
    early_bird: {
      emoji: "🐦",
      name: "Early Bird",
      description: "Accumulated 50+ hours during early morning (6 AM - 10 AM)",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        let earlyMorningSeconds = 0;
        for (const session of user.sessions) {
          if (session.startTime && session.endTime && session.duration) {
            earlyMorningSeconds += this.calculateEarlyMorningDuration(
              session.startTime,
              session.endTime,
            );
          }
        }
        return earlyMorningSeconds >= 180000; // 50 hours
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        let earlyMorningSeconds = 0;
        if (user) {
          for (const session of user.sessions) {
            if (session.startTime && session.endTime && session.duration) {
              earlyMorningSeconds += this.calculateEarlyMorningDuration(
                session.startTime,
                session.endTime,
              );
            }
          }
        }
        return {
          value: Math.floor(earlyMorningSeconds / 3600),
          description: "50+ early-morning hours",
          unit: "hrs",
        };
      },
    },
    weekend_warrior: {
      emoji: "🎮",
      name: "Weekend Warrior",
      description: "Accumulated 100+ hours during weekends",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        let weekendSeconds = 0;
        for (const session of user.sessions) {
          if (session.startTime && session.duration) {
            const day = session.startTime.getDay();
            if (day === 0 || day === 6) {
              weekendSeconds += session.duration;
            }
          }
        }
        return weekendSeconds >= 360000; // 100 hours
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        let weekendSeconds = 0;
        if (user) {
          for (const session of user.sessions) {
            if (session.startTime && session.duration) {
              const day = session.startTime.getDay();
              if (day === 0 || day === 6) {
                weekendSeconds += session.duration;
              }
            }
          }
        }
        return {
          value: Math.floor(weekendSeconds / 3600),
          description: "100+ weekend hours",
          unit: "hrs",
        };
      },
    },
    weekday_warrior: {
      emoji: "💼",
      name: "Weekday Warrior",
      description: "Accumulated 100+ hours during weekdays",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        let weekdaySeconds = 0;
        for (const session of user.sessions) {
          if (session.startTime && session.duration) {
            const day = session.startTime.getDay();
            if (day >= 1 && day <= 5) {
              weekdaySeconds += session.duration;
            }
          }
        }
        return weekdaySeconds >= 360000; // 100 hours
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        let weekdaySeconds = 0;
        if (user) {
          for (const session of user.sessions) {
            if (session.startTime && session.duration) {
              const day = session.startTime.getDay();
              if (day >= 1 && day <= 5) {
                weekdaySeconds += session.duration;
              }
            }
          }
        }
        return {
          value: Math.floor(weekdaySeconds / 3600),
          description: "100+ weekday hours",
          unit: "hrs",
        };
      },
    },
    consistent_week: {
      emoji: "🔥",
      name: "On a Roll",
      description: "Connected for 7 consecutive days (5+ min/day)",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const { longestStreak } = this.calculateConsecutiveDays(
          user.sessions,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return longestStreak >= 7;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) {
          return {
            value: 0,
            description: "7+ day streak",
            unit: "days",
          };
        }
        const { longestStreak } = this.calculateConsecutiveDays(
          user.sessions,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return {
          value: longestStreak,
          description: "7+ day streak",
          unit: "days",
        };
      },
    },
    consistent_fortnight: {
      emoji: "⚡",
      name: "Dedicated AF",
      description: "Connected for 14 consecutive days (5+ min/day)",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const { longestStreak } = this.calculateConsecutiveDays(
          user.sessions,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return longestStreak >= 14;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) {
          return {
            value: 0,
            description: "14+ day streak",
            unit: "days",
          };
        }
        const { longestStreak } = this.calculateConsecutiveDays(
          user.sessions,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return {
          value: longestStreak,
          description: "14+ day streak",
          unit: "days",
        };
      },
    },
    consistent_month: {
      emoji: "💀",
      name: "No-Lifer",
      description: "Connected for 30 consecutive days (5+ min/day)",
      checkFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const { longestStreak } = this.calculateConsecutiveDays(
          user.sessions,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return longestStreak >= 30;
      },
      metadataFunction: async (userId: string, userData: any | null) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) {
          return {
            value: 0,
            description: "30+ day streak",
            unit: "days",
          };
        }
        const { longestStreak } = this.calculateConsecutiveDays(
          user.sessions,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return {
          value: longestStreak,
          description: "30+ day streak",
          unit: "days",
        };
      },
    },
  };

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.setupMongoConnectionHandlers();
  }

  private setupMongoConnectionHandlers(): void {
    mongoose.connection.on("connected", () => {
      this.isConnected = true;
      logger.info("MongoDB connection established for achievements service");
    });

    mongoose.connection.on("disconnected", () => {
      this.isConnected = false;
      logger.warn("MongoDB connection lost for achievements service");
    });

    mongoose.connection.on("error", (error: Error) => {
      this.isConnected = false;
      logger.error("MongoDB connection error in achievements service:", error);
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
        logger.info("Reconnected to MongoDB for achievements service");
      } catch (error: unknown) {
        logger.error("Error reconnecting to MongoDB:", error);
        throw error;
      }
    }
  }

  public static getInstance(client: Client): AchievementsService {
    if (!AchievementsService.instance) {
      AchievementsService.instance = new AchievementsService(client);
    }
    return AchievementsService.instance;
  }

  /**
   * Calculate how much of a session occurred during late night hours (10 PM - 6 AM)
   */
  private calculateLateNightDuration(startTime: Date, endTime: Date): number {
    let totalSeconds = 0;
    const current = new Date(startTime);
    const end = new Date(endTime);

    while (current < end) {
      const hour = current.getHours();
      const isLateNight = hour >= 22 || hour < 6;

      if (isLateNight) {
        const nextHour = new Date(current);
        nextHour.setHours(current.getHours() + 1, 0, 0, 0);
        const segmentEnd = nextHour < end ? nextHour : end;
        totalSeconds += Math.floor(
          (segmentEnd.getTime() - current.getTime()) / 1000,
        );
        current.setTime(segmentEnd.getTime());
      } else {
        current.setHours(current.getHours() + 1, 0, 0, 0);
      }
    }

    return totalSeconds;
  }

  /**
   * Calculate how much of a session occurred during early morning (6 AM - 10 AM)
   */
  private calculateEarlyMorningDuration(
    startTime: Date,
    endTime: Date,
  ): number {
    let totalSeconds = 0;
    const current = new Date(startTime);
    const end = new Date(endTime);

    while (current < end) {
      const hour = current.getHours();
      const isEarlyMorning = hour >= 6 && hour < 10;

      if (isEarlyMorning) {
        const nextHour = new Date(current);
        nextHour.setHours(current.getHours() + 1, 0, 0, 0);
        const segmentEnd = nextHour < end ? nextHour : end;
        totalSeconds += Math.floor(
          (segmentEnd.getTime() - current.getTime()) / 1000,
        );
        current.setTime(segmentEnd.getTime());
      } else {
        current.setHours(current.getHours() + 1, 0, 0, 0);
      }
    }

    return totalSeconds;
  }

  /**
   * Format a date as YYYY-MM-DD string using UTC
   */
  private formatDateKeyUTC(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  /**
   * Calculate the longest streak of consecutive days with at least minDuration seconds per day
   *
   * IMPORTANT: This function relies on session history. The database cleanup job
   * (voicetracking.cleanup.retention.detailed_sessions_days) deletes old sessions.
   * To support longer streaks, ensure retention is configured appropriately:
   * - For 30-day streaks: Set detailed_sessions_days to at least 45 days
   * - For longer streaks: Increase retention accordingly
   *
   * @param sessions Array of user sessions
   * @param minDuration Minimum duration in seconds per day (default: MIN_DAILY_DURATION_SECONDS)
   * @returns Object with currentStreak and longestStreak
   */
  private calculateConsecutiveDays(
    sessions: Array<{ startTime: Date; duration?: number }>,
    minDuration: number = AchievementsService.MIN_DAILY_DURATION_SECONDS,
  ): { currentStreak: number; longestStreak: number } {
    if (!sessions || sessions.length === 0) {
      return { currentStreak: 0, longestStreak: 0 };
    }

    // Group sessions by day (using UTC date)
    const dayTotals = new Map<string, number>();

    for (const session of sessions) {
      if (session.startTime && session.duration) {
        const date = new Date(session.startTime);
        const dayKey = this.formatDateKeyUTC(date);
        const currentTotal = dayTotals.get(dayKey) || 0;
        dayTotals.set(dayKey, currentTotal + session.duration);
      }
    }

    // Filter days that meet minimum duration
    const qualifyingDays = Array.from(dayTotals.entries())
      .filter(([, duration]) => duration >= minDuration)
      .map(([day]) => day)
      .sort();

    if (qualifyingDays.length === 0) {
      return { currentStreak: 0, longestStreak: 0 };
    }

    // Calculate streaks
    let longestStreak = 1;
    let currentStreak = 1;
    const today = new Date();
    const todayKey = this.formatDateKeyUTC(today);
    const yesterday = new Date(today.getTime() - 86400000);
    const yesterdayKey = this.formatDateKeyUTC(yesterday);

    for (let i = 1; i < qualifyingDays.length; i++) {
      const prevDate = new Date(qualifyingDays[i - 1] + "T00:00:00Z");
      const currDate = new Date(qualifyingDays[i] + "T00:00:00Z");
      const diffDays = Math.floor(
        (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (diffDays === 1) {
        currentStreak++;
        longestStreak = Math.max(longestStreak, currentStreak);
      } else {
        currentStreak = 1;
      }
    }

    // Calculate current active streak (if last qualifying day is today or yesterday)
    const lastDay = qualifyingDays[qualifyingDays.length - 1];
    if (lastDay !== todayKey && lastDay !== yesterdayKey) {
      // Streak is broken
      currentStreak = 0;
    } else {
      // The current streak is the streak ending on the last qualifying day
      currentStreak = 1;
      for (let i = qualifyingDays.length - 2; i >= 0; i--) {
        const prevDate = new Date(qualifyingDays[i] + "T00:00:00Z");
        const currDate = new Date(qualifyingDays[i + 1] + "T00:00:00Z");
        const diffDays = Math.floor(
          (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24),
        );

        if (diffDays === 1) {
          currentStreak++;
        } else {
          break;
        }
      }
    }

    return { currentStreak, longestStreak };
  }

  /**
   * Check and award accolades (persistent badges) to a user
   * Returns newly earned accolades
   */
  public async checkAndAwardAccolades(
    userId: string,
    username: string,
  ): Promise<IAccolade[]> {
    try {
      await this.ensureConnection();

      const isEnabled = await this.configService.getBoolean(
        "achievements.enabled",
        false,
      );
      if (!isEnabled) {
        return [];
      }

      // Get or create user achievements record
      let userAchievements = await UserAchievements.findOne({ userId });
      if (!userAchievements) {
        userAchievements = new UserAchievements({
          userId,
          username,
          accolades: [],
          achievements: [],
          statistics: { totalAccolades: 0, totalAchievements: 0 },
        });
      }

      const newAccolades: IAccolade[] = [];
      const existingAccoladeTypes = new Set(
        userAchievements.accolades.map((a) => a.type),
      );

      // Fetch user tracking data once to avoid multiple DB queries
      const userTrackingData = await VoiceChannelTracking.findOne({ userId });

      // Check each accolade type
      for (const [type, definition] of Object.entries(
        this.accoladeDefinitions,
      )) {
        if (existingAccoladeTypes.has(type)) {
          continue; // Already earned
        }

        const earned = await definition.checkFunction(userId, userTrackingData);
        if (earned) {
          const metadata = definition.metadataFunction
            ? await definition.metadataFunction(userId, userTrackingData)
            : {};

          const accolade: IAccolade = {
            type,
            earnedAt: new Date(),
            metadata,
          };

          newAccolades.push(accolade);
          userAchievements.accolades.push(accolade);
          userAchievements.statistics.totalAccolades += 1;

          logger.info(
            `User ${username} (${userId}) earned accolade: ${definition.name}`,
          );
        }
      }

      if (newAccolades.length > 0) {
        await userAchievements.save();
      }

      return newAccolades;
    } catch (error) {
      logger.error("Error checking and awarding accolades:", error);
      return [];
    }
  }

  /**
   * Get all accolades and achievements for a user
   */
  public async getUserAchievements(userId: string): Promise<{
    accolades: IAccolade[];
    achievements: IAchievement[];
    statistics: { totalAccolades: number; totalAchievements: number };
  } | null> {
    try {
      await this.ensureConnection();

      const userAchievements = await UserAchievements.findOne({ userId });
      if (!userAchievements) {
        return null;
      }

      return {
        accolades: userAchievements.accolades,
        achievements: userAchievements.achievements,
        statistics: userAchievements.statistics,
      };
    } catch (error) {
      logger.error("Error getting user achievements:", error);
      return null;
    }
  }

  /**
   * Get badge definition for an accolade type
   */
  public getAccoladeDefinition(type: string): BadgeDefinition | undefined {
    return this.accoladeDefinitions[type as AccoladeType];
  }

  /**
   * Send DM to user about newly earned accolades
   */
  public async notifyUserOfAccolades(
    userId: string,
    accolades: IAccolade[],
  ): Promise<void> {
    try {
      const dmEnabled = await this.configService.getBoolean(
        "achievements.dm_notifications.enabled",
        true,
      );

      if (!dmEnabled || accolades.length === 0) {
        return;
      }

      const user = await this.client.users.fetch(userId);
      if (!user) {
        logger.warn(`Could not find user ${userId} to send DM`);
        return;
      }

      const messages = accolades
        .map((accolade) => {
          const definition = this.getAccoladeDefinition(accolade.type);
          if (!definition) return null;

          const metadataText = accolade.metadata?.description
            ? ` (${accolade.metadata.description})`
            : "";
          return `${definition.emoji} **${definition.name}**${metadataText}\n${definition.description}`;
        })
        .filter(Boolean);

      if (messages.length > 0) {
        const message = [
          "🎉 **Congratulations!** You've earned new accolades:",
          "",
          ...messages,
          "",
          "Use `/achievements` to see all your earned badges!",
        ].join("\n");

        await user.send(message);
        logger.info(
          `Sent accolade notification DM to ${user.username} (${userId})`,
        );
      }
    } catch (error) {
      logger.error("Error sending accolade notification DM:", error);
      // Don't throw - DM failures shouldn't break the flow
    }
  }

  /**
   * Get newly earned accolades since last check
   */
  public async getNewAccoladesSinceLastWeek(): Promise<
    Array<{ userId: string; username: string; accolades: IAccolade[] }>
  > {
    try {
      await this.ensureConnection();

      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const users = await UserAchievements.find({
        "accolades.earnedAt": { $gte: oneWeekAgo },
      });

      return users
        .map((user) => ({
          userId: user.userId,
          username: user.username,
          accolades: user.accolades.filter((a) => a.earnedAt >= oneWeekAgo),
        }))
        .filter((u) => u.accolades.length > 0);
    } catch (error) {
      logger.error("Error getting new accolades since last week:", error);
      return [];
    }
  }
}

// Legacy export for backward compatibility
export const GamificationService = AchievementsService;
