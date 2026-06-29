import { Client, TextChannel } from "discord.js";
import {
  UserAchievements,
  IAccolade,
  IAchievement,
} from "../models/user-achievements.js";
import {
  VoiceChannelTracking,
  type IVoiceChannelTracking,
} from "../models/voice-channel-tracking.js";
import { ConfigService } from "./config-service.js";
import { UserNotificationPrefsService } from "./user-notification-prefs-service.js";
import {
  dayOfWeekInZone,
  hourInZone,
  isoDateInZone,
  isValidTimezone,
  secondsIntoHourInZone,
} from "../utils/timezone.js";
import logger from "../utils/logger.js";
import mongoose from "mongoose";
import { quoteService } from "./quote-service.js";
import {
  ACCOLADE_METADATA,
  isMilestoneAccolade,
  type AccoladeType,
} from "../content/accolades.js";
import {
  ACHIEVEMENT_METADATA,
  type AchievementType,
} from "../content/achievements.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

export type { AccoladeType, AchievementType };

interface BadgeLogic {
  // `timeZone` is the IANA zone the time-sensitive accolades bucket in
  // (#658) — the acting user's `UserNotificationPrefs.timezone`, or "UTC"
  // when unset. Hour/day-agnostic checks (total hours, social, quote)
  // simply omit the parameter.
  checkFunction: (
    userId: string,
    userData: IVoiceChannelTracking | null,
    timeZone: string,
  ) => Promise<boolean>;
  metadataFunction?: (
    userId: string,
    userData: IVoiceChannelTracking | null,
    timeZone: string,
  ) => Promise<{ value?: number; description?: string; unit?: string }>;
}

interface BadgeDefinition extends BadgeLogic {
  emoji: string;
  name: string;
  description: string;
}

export class AchievementsService {
  private static instance: AchievementsService;
  private client: Client;
  private configService: ConfigService;
  private isConnected: boolean = false;

  // Accolade/achievement evaluation is driven entirely by the session-end
  // flow, whose hard dependency is voice tracking (#659): most badges score
  // tracked voice sessions, and the few quote-based accolades are only
  // evaluated here too (piggybacked on session end). When voice tracking is
  // off we short-circuit the whole flow. Those checks fire once per session
  // end (per user), so we throttle the "tracking disabled" warning instead of
  // logging it for every user.
  private static readonly VOICE_DISABLED_LOG_INTERVAL_MS = 60 * 60 * 1000; // 1h
  private lastVoiceTrackingDisabledLogAt = 0;

  // Minimum duration threshold for consecutive days (5 minutes in seconds)
  private static readonly MIN_DAILY_DURATION_SECONDS = 300;

  // Awarding logic per accolade (display metadata lives in
  // src/content/accolades.ts). Keys must match ACCOLADE_METADATA exactly.
  private accoladeLogic: Record<AccoladeType, BadgeLogic> = {
    first_hour: {
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 3600 : false;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 360000 : false;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 1800000 : false;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 3600000 : false;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        return user ? user.totalTime >= 31554000 : false;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        return user.sessions.some((s) => (s.duration || 0) >= 14400);
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        const maxSession = (user?.sessions ?? []).reduce(
          (max, session) => Math.max(max, session.duration || 0),
          0,
        );
        return {
          value: Math.floor(maxSession / 3600),
          description: "4+ hour session",
          unit: "hrs",
        };
      },
    },
    ultra_marathoner: {
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        return user.sessions.some((s) => (s.duration || 0) >= 28800);
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        const maxSession = (user?.sessions ?? []).reduce(
          (max, session) => Math.max(max, session.duration || 0),
          0,
        );
        return {
          value: Math.floor(maxSession / 3600),
          description: "8+ hour session",
          unit: "hrs",
        };
      },
    },
    social_butterfly: {
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const uniqueUsers = new Set(
          user.sessions.flatMap((s) => s.otherUsers || []),
        );
        return uniqueUsers.size >= 10;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        const uniqueUsers = new Set(
          user?.sessions.flatMap((s) => s.otherUsers || []) || [],
        );
        return {
          value: uniqueUsers.size,
          description: "10+ unique users",
          unit: "users",
        };
      },
    },
    connector: {
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const uniqueUsers = new Set(
          user.sessions.flatMap((s) => s.otherUsers || []),
        );
        return uniqueUsers.size >= 25;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        const uniqueUsers = new Set(
          user?.sessions.flatMap((s) => s.otherUsers || []) || [],
        );
        return {
          value: uniqueUsers.size,
          description: "25+ unique users",
          unit: "users",
        };
      },
    },
    night_owl: {
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        let lateNightSeconds = 0;
        for (const session of user.sessions) {
          if (session.startTime && session.endTime && session.duration) {
            lateNightSeconds += this.calculateLateNightDuration(
              session.startTime,
              session.endTime,
              timeZone,
            );
          }
        }
        return lateNightSeconds >= 180000; // 50 hours
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        let lateNightSeconds = 0;
        if (user) {
          for (const session of user.sessions) {
            if (session.startTime && session.endTime && session.duration) {
              lateNightSeconds += this.calculateLateNightDuration(
                session.startTime,
                session.endTime,
                timeZone,
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        let earlyMorningSeconds = 0;
        for (const session of user.sessions) {
          if (session.startTime && session.endTime && session.duration) {
            earlyMorningSeconds += this.calculateEarlyMorningDuration(
              session.startTime,
              session.endTime,
              timeZone,
            );
          }
        }
        return earlyMorningSeconds >= 180000; // 50 hours
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        let earlyMorningSeconds = 0;
        if (user) {
          for (const session of user.sessions) {
            if (session.startTime && session.endTime && session.duration) {
              earlyMorningSeconds += this.calculateEarlyMorningDuration(
                session.startTime,
                session.endTime,
                timeZone,
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        let weekendSeconds = 0;
        for (const session of user.sessions) {
          if (session.startTime && session.duration) {
            const day = dayOfWeekInZone(session.startTime, timeZone);
            if (day === 0 || day === 6) {
              weekendSeconds += session.duration;
            }
          }
        }
        return weekendSeconds >= 360000; // 100 hours
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        let weekendSeconds = 0;
        if (user) {
          for (const session of user.sessions) {
            if (session.startTime && session.duration) {
              const day = dayOfWeekInZone(session.startTime, timeZone);
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        let weekdaySeconds = 0;
        for (const session of user.sessions) {
          if (session.startTime && session.duration) {
            const day = dayOfWeekInZone(session.startTime, timeZone);
            if (day >= 1 && day <= 5) {
              weekdaySeconds += session.duration;
            }
          }
        }
        return weekdaySeconds >= 360000; // 100 hours
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        let weekdaySeconds = 0;
        if (user) {
          for (const session of user.sessions) {
            if (session.startTime && session.duration) {
              const day = dayOfWeekInZone(session.startTime, timeZone);
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const { longestStreak } = this.calculateConsecutiveDays(
          user.sessions,
          timeZone,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return longestStreak >= 7;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
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
          timeZone,
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const { longestStreak } = this.calculateConsecutiveDays(
          user.sessions,
          timeZone,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return longestStreak >= 14;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
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
          timeZone,
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
      checkFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
        const user =
          userData || (await VoiceChannelTracking.findOne({ userId }));
        if (!user) return false;
        const { longestStreak } = this.calculateConsecutiveDays(
          user.sessions,
          timeZone,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return longestStreak >= 30;
      },
      metadataFunction: async (
        userId: string,
        userData: IVoiceChannelTracking | null,
        timeZone: string,
      ) => {
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
          timeZone,
          AchievementsService.MIN_DAILY_DURATION_SECONDS,
        );
        return {
          value: longestStreak,
          description: "30+ day streak",
          unit: "days",
        };
      },
    },
    quotable: {
      checkFunction: async (userId: string) => {
        return (await quoteService.getQuotesAuthoredByUser(userId)) >= 1;
      },
      metadataFunction: async (userId: string) => {
        const count = await quoteService.getQuotesAuthoredByUser(userId);
        return {
          value: count,
          description: "First quote",
          unit: "quotes",
        };
      },
    },
    quote_master: {
      checkFunction: async (userId: string) => {
        return (await quoteService.getQuotesAddedByUser(userId)) >= 10;
      },
      metadataFunction: async (userId: string) => {
        const count = await quoteService.getQuotesAddedByUser(userId);
        return {
          value: count,
          description: "10+ quotes added",
          unit: "quotes",
        };
      },
    },
    quote_collector: {
      checkFunction: async (userId: string) => {
        return (await quoteService.getQuotesAddedByUser(userId)) >= 50;
      },
      metadataFunction: async (userId: string) => {
        const count = await quoteService.getQuotesAddedByUser(userId);
        return {
          value: count,
          description: "50+ quotes added",
          unit: "quotes",
        };
      },
    },
    quote_legend: {
      checkFunction: async (userId: string) => {
        return (await quoteService.getQuotesAddedByUser(userId)) >= 100;
      },
      metadataFunction: async (userId: string) => {
        const count = await quoteService.getQuotesAddedByUser(userId);
        return {
          value: count,
          description: "100+ quotes added",
          unit: "quotes",
        };
      },
    },
    widely_quoted: {
      checkFunction: async (userId: string) => {
        return (await quoteService.getQuotesAuthoredByUser(userId)) >= 25;
      },
      metadataFunction: async (userId: string) => {
        const count = await quoteService.getQuotesAuthoredByUser(userId);
        return {
          value: count,
          description: "25+ times quoted",
          unit: "quotes",
        };
      },
    },
    quote_icon: {
      checkFunction: async (userId: string) => {
        return (await quoteService.getQuotesAuthoredByUser(userId)) >= 50;
      },
      metadataFunction: async (userId: string) => {
        const count = await quoteService.getQuotesAuthoredByUser(userId);
        return {
          value: count,
          description: "50+ times quoted",
          unit: "quotes",
        };
      },
    },
    viral_quote: {
      checkFunction: async (userId: string) => {
        const mostLikedLikes =
          (await quoteService.getMostLikedQuoteByAuthor(userId))?.likes || 0;
        return mostLikedLikes >= 10;
      },
      metadataFunction: async (userId: string) => {
        const mostLikedLikes =
          (await quoteService.getMostLikedQuoteByAuthor(userId))?.likes || 0;
        return {
          value: mostLikedLikes,
          description: "10+ likes on a quote",
          unit: "likes",
        };
      },
    },
  };

  // Awarding logic per achievement (display metadata lives in
  // src/content/achievements.ts). Only ids present in ACHIEVEMENT_METADATA
  // need an entry here; reserved-but-unimplemented types stay absent.
  private achievementLogic: Partial<Record<AchievementType, BadgeLogic>> = {
    weekly_active: {
      checkFunction: async (userId: string) => {
        const weeklyTime = await this.getWeeklyTimeForUser(userId);
        return weeklyTime >= 36000; // 10 hours = 36000 seconds
      },
      metadataFunction: async (userId: string) => {
        const weeklyTime = await this.getWeeklyTimeForUser(userId);
        return {
          value: Math.floor(weeklyTime / 3600),
          description: "Hours this week",
          unit: "hrs",
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
   * Sum the seconds of `[startTime, endTime)` whose wall-clock hour (in the
   * given IANA `timeZone`) satisfies `inWindow`. The walk aligns each
   * segment to the local-hour boundary in that zone, so it stays correct
   * for zones with sub-hour offsets and honours the user's timezone (#658).
   * Callers pass "UTC" for users with no timezone preference.
   */
  private calculateHourWindowSeconds(
    startTime: Date,
    endTime: Date,
    timeZone: string,
    inWindow: (hour: number) => boolean,
  ): number {
    let totalSeconds = 0;
    let current = startTime.getTime();
    const end = endTime.getTime();

    while (current < end) {
      const at = new Date(current);
      const hour = hourInZone(at, timeZone);
      const secondsToBoundary = 3600 - secondsIntoHourInZone(at, timeZone);
      const segmentEnd = Math.min(current + secondsToBoundary * 1000, end);

      if (inWindow(hour)) {
        totalSeconds += Math.floor((segmentEnd - current) / 1000);
      }

      current = segmentEnd;
    }

    return totalSeconds;
  }

  /**
   * Calculate how much of a session occurred during late night hours
   * (10 PM - 6 AM in the user's timezone, UTC when unset).
   */
  private calculateLateNightDuration(
    startTime: Date,
    endTime: Date,
    timeZone: string,
  ): number {
    return this.calculateHourWindowSeconds(
      startTime,
      endTime,
      timeZone,
      (hour) => hour >= 22 || hour < 6,
    );
  }

  /**
   * Calculate how much of a session occurred during early morning
   * (6 AM - 10 AM in the user's timezone, UTC when unset).
   */
  private calculateEarlyMorningDuration(
    startTime: Date,
    endTime: Date,
    timeZone: string,
  ): number {
    return this.calculateHourWindowSeconds(
      startTime,
      endTime,
      timeZone,
      (hour) => hour >= 6 && hour < 10,
    );
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
   * @param timeZone IANA zone to bucket days in ("UTC" when the user has no
   *   timezone preference) so streaks reflect the user's local midnight (#658)
   * @param minDuration Minimum duration in seconds per day (default: MIN_DAILY_DURATION_SECONDS)
   * @returns Object with currentStreak and longestStreak
   */
  private calculateConsecutiveDays(
    sessions: Array<{ startTime: Date; duration?: number }>,
    timeZone: string,
    minDuration: number = AchievementsService.MIN_DAILY_DURATION_SECONDS,
  ): { currentStreak: number; longestStreak: number } {
    if (!sessions || sessions.length === 0) {
      return { currentStreak: 0, longestStreak: 0 };
    }

    // Group sessions by day, bucketed in the user's timezone (UTC default).
    const dayTotals = new Map<string, number>();

    for (const session of sessions) {
      if (session.startTime && session.duration) {
        const date = new Date(session.startTime);
        const dayKey = isoDateInZone(date, timeZone);
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
    const todayKey = isoDateInZone(today, timeZone);
    // Derive "yesterday" from the calendar-day key, not by subtracting 24h
    // of wall-clock time: around DST transitions a local day is 23/25 hours,
    // so a fixed 86,400,000ms step can skip or repeat a calendar day and
    // wrongly break an active streak. Anchoring at the date string's UTC
    // midnight makes the minus-one-day arithmetic DST-safe.
    const yesterdayKey = isoDateInZone(
      new Date(new Date(`${todayKey}T00:00:00Z`).getTime() - 86400000),
      "UTC",
    );

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
   * Get total voice time for a user this week
   */
  private async getWeeklyTimeForUser(userId: string): Promise<number> {
    try {
      const user = await VoiceChannelTracking.findOne({ userId });
      if (!user || !user.sessions || user.sessions.length === 0) {
        return 0;
      }

      // Get start of this week (Monday at 00:00:00 UTC)
      const now = new Date();
      const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 1 = Monday, etc.
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // If Sunday, go back 6 days
      const startOfWeek = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - daysToMonday,
          0,
          0,
          0,
          0,
        ),
      );

      // Calculate total time for sessions that overlap with this week
      let weeklyTime = 0;
      for (const session of user.sessions) {
        if (!session.endTime || !session.duration) continue;

        // Check if session overlaps with this week
        const sessionEnd = new Date(session.endTime);
        if (sessionEnd >= startOfWeek) {
          const sessionStart = new Date(session.startTime);

          // If session started before the week, only count time from start of week
          const effectiveStart =
            sessionStart < startOfWeek ? startOfWeek : sessionStart;

          // Calculate the duration within this week
          const durationInWeek = Math.floor(
            (sessionEnd.getTime() - effectiveStart.getTime()) / 1000,
          );
          weeklyTime += Math.max(0, durationInWeek);
        }
      }

      return weeklyTime;
    } catch (error) {
      logger.error("Error getting weekly time for user:", error);
      return 0;
    }
  }

  /**
   * Resolve the acting user's accolade-bucketing timezone (#658), mirroring
   * Rewind's default semantics: the stored `UserNotificationPrefs.timezone`
   * when set and valid, otherwise "UTC" (so unconfigured members keep their
   * existing progress). The guild id comes from bootstrap `GUILD_ID` config,
   * matching `notifyUserOfAccolades`; when it's unset we can't look up prefs,
   * so we fall back to UTC. Any error degrades to UTC rather than failing the
   * whole accolade check.
   */
  private async resolveUserTimezone(userId: string): Promise<string> {
    try {
      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) return "UTC";
      const tz = await UserNotificationPrefsService.getInstance().getTimezone(
        userId,
        guildId,
      );
      return tz && isValidTimezone(tz) ? tz : "UTC";
    } catch (error) {
      logger.warn(
        `Failed to resolve timezone for ${userId}; defaulting to UTC:`,
        error,
      );
      return "UTC";
    }
  }

  /**
   * Whether voice tracking — the hard dependency of the session-end badge
   * evaluation flow (#659) — is enabled. Most accolades/achievements score
   * tracked voice sessions; the few quote-based accolades are voice-agnostic
   * but are only evaluated via this same session-end flow, so when voice
   * tracking is off we short-circuit the whole flow before touching any badge
   * logic, mirroring `voice-channel-announcer.ts`. The warning is throttled
   * (once per {@link VOICE_DISABLED_LOG_INTERVAL_MS}) so the per-user
   * invocations don't spam the logs.
   */
  private async isVoiceTrackingEnabled(): Promise<boolean> {
    const enabled = await this.configService.getBoolean(
      "voicetracking.enabled",
      false,
    );
    if (!enabled) {
      const now = Date.now();
      if (
        now - this.lastVoiceTrackingDisabledLogAt >=
        AchievementsService.VOICE_DISABLED_LOG_INTERVAL_MS
      ) {
        this.lastVoiceTrackingDisabledLogAt = now;
        logger.warn(
          "Accolade/achievement evaluation skipped: voice tracking is disabled (voicetracking.enabled=false).",
        );
      }
    }
    return enabled;
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

      if (!(await this.isVoiceTrackingEnabled())) {
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

      // Resolve the acting user's timezone once per evaluation (#658): the
      // time-of-day / day-of-week / streak accolades bucket sessions in it,
      // falling back to UTC when unset or invalid so unconfigured members'
      // progress doesn't shift. Kept out of the per-accolade loop — and well
      // out of the per-session inner loops — so it costs at most one lookup.
      const timeZone = await this.resolveUserTimezone(userId);

      // Check each accolade type
      for (const type of Object.keys(ACCOLADE_METADATA) as AccoladeType[]) {
        if (existingAccoladeTypes.has(type)) {
          continue; // Already earned
        }

        const logic = this.accoladeLogic[type];
        const earned = await logic.checkFunction(
          userId,
          userTrackingData,
          timeZone,
        );
        if (earned) {
          const metadata = logic.metadataFunction
            ? await logic.metadataFunction(userId, userTrackingData, timeZone)
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
            `User ${username} (${userId}) earned accolade: ${ACCOLADE_METADATA[type].name}`,
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
   * Check and award achievements (time-based) to a user for the current week
   * Returns newly earned achievements
   */
  public async checkAndAwardAchievements(
    userId: string,
    username: string,
  ): Promise<IAchievement[]> {
    try {
      await this.ensureConnection();

      const isEnabled = await this.configService.getBoolean(
        "achievements.enabled",
        false,
      );

      if (!isEnabled) {
        return [];
      }

      if (!(await this.isVoiceTrackingEnabled())) {
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
          lastChecked: new Date(),
          statistics: { totalAccolades: 0, totalAchievements: 0 },
        });
      }

      // Get current week period string (e.g., "2026-W05")
      const now = new Date();
      const weekNumber = this.getWeekNumber(now);
      const currentPeriod = `${now.getFullYear()}-W${String(weekNumber).padStart(2, "0")}`;

      // Check if user already has this week's achievements
      const existingAchievementTypes = userAchievements.achievements
        .filter((a) => a.period === currentPeriod)
        .map((a) => a.type);

      const newAchievements: IAchievement[] = [];

      // Check each achievement type
      for (const type of Object.keys(
        ACHIEVEMENT_METADATA,
      ) as AchievementType[]) {
        if (existingAchievementTypes.includes(type)) {
          continue;
        }

        const logic = this.achievementLogic[type];
        if (!logic) continue;

        // Weekly achievements are time-window aggregates evaluated in UTC
        // (out of scope for #658); the timezone arg is accepted for a
        // uniform BadgeLogic signature but unused by these checks.
        const earned = await logic.checkFunction(userId, null, "UTC");
        if (earned) {
          const metadata = logic.metadataFunction
            ? await logic.metadataFunction(userId, null, "UTC")
            : undefined;

          const achievement: IAchievement = {
            type,
            earnedAt: new Date(),
            period: currentPeriod,
            metadata,
          };

          newAchievements.push(achievement);
          userAchievements.achievements.push(achievement);
          userAchievements.statistics.totalAchievements += 1;

          logger.info(
            `User ${username} (${userId}) earned achievement: ${ACHIEVEMENT_METADATA[type as keyof typeof ACHIEVEMENT_METADATA].name} for ${currentPeriod}`,
          );
        }
      }

      if (newAchievements.length > 0) {
        await userAchievements.save();
      }

      return newAchievements;
    } catch (error) {
      logger.error("Error checking and awarding achievements:", error);
      return [];
    }
  }

  /**
   * Get ISO week number for a date
   */
  private getWeekNumber(date: Date): number {
    const d = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
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
    const meta = ACCOLADE_METADATA[type as AccoladeType];
    const logic = this.accoladeLogic[type as AccoladeType];
    if (!meta || !logic) return undefined;
    return { ...meta, ...logic };
  }

  public getAchievementDefinition(type: string): BadgeDefinition | undefined {
    const meta =
      ACHIEVEMENT_METADATA[type as keyof typeof ACHIEVEMENT_METADATA];
    const logic = this.achievementLogic[type as AchievementType];
    if (!meta || !logic) return undefined;
    return { ...meta, ...logic };
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

      // Per-user opt-out (#482). Single-guild bot: resolve guildId from
      // bootstrap config so this guard works whether or not the caller
      // threaded it through. An empty/unset GUILD_ID falls through to the
      // legacy "always send when global toggle is on" behaviour so a
      // misconfiguration doesn't silence every DM.
      const guildId = await this.configService.getString("GUILD_ID", "");
      if (guildId) {
        const prefs = await UserNotificationPrefsService.getInstance().getPrefs(
          userId,
          guildId,
        );
        if (!prefs.achievements) {
          logger.info(
            `Skipping accolade DM for ${userId}: per-user achievements pref is off`,
          );
          return;
        }
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
          "",
          "Manage notifications: run `/config`.",
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
   * Post a loud, server-wide celebration for any *marquee* accolades the
   * user just earned (#657, Part 2). This is the shared shout-out that
   * complements — and never replaces — the personal DM
   * ({@link notifyUserOfAccolades}) and the weekly round-up: only the
   * curated, rare crossings listed in `MILESTONE_ACCOLADES` are loud
   * enough to warrant pinging the whole channel.
   *
   * Reuses the existing session-end award detection — `accolades` is the
   * exact `newAccolades` array the caller already has — so nothing extra is
   * tracked. Gated behind `celebrations.enabled` (off by default) and a
   * configured `celebrations.channel_id`; when either is missing it no-ops.
   * Failures are swallowed: a celebration must never break the award flow.
   */
  public async announceMilestones(
    userId: string,
    username: string,
    accolades: IAccolade[],
  ): Promise<void> {
    try {
      if (accolades.length === 0) return;

      const enabled = await this.configService.getBoolean(
        "celebrations.enabled",
        false,
      );
      if (!enabled) return;

      // Of the freshly-earned accolades, keep only the marquee ones.
      const milestones = accolades.filter((a) => isMilestoneAccolade(a.type));
      if (milestones.length === 0) return;

      const channelId = await this.configService.getString(
        "celebrations.channel_id",
        "",
      );
      if (!channelId) {
        logger.warn(
          "Milestone celebration skipped: celebrations.channel_id not configured",
        );
        return;
      }

      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.warn("Milestone celebration skipped: GUILD_ID not configured");
        return;
      }

      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        logger.error(
          `Milestone celebration skipped: guild ${sanitizeForLog(guildId)} not found`,
        );
        return;
      }

      const channel = await guild.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.error(
          `Milestone celebration skipped: channel ${sanitizeForLog(channelId)} not found or not a text channel`,
        );
        return;
      }

      for (const accolade of milestones) {
        const definition = this.getAccoladeDefinition(accolade.type);
        if (!definition) continue;

        const message = [
          `${definition.emoji} **Milestone unlocked!** ${definition.emoji}`,
          "",
          `🎉 <@${userId}> just earned **${definition.name}** — ${definition.description}!`,
          "",
          "Huge congratulations from the whole server! 🥳",
        ].join("\n");

        await channel.send({
          content: message,
          allowedMentions: { users: [userId] },
        });
        logger.info(
          `Announced milestone celebration for ${username} (${userId}): ${definition.name}`,
        );
      }
    } catch (error) {
      logger.error("Error announcing milestone celebration:", error);
      // Don't throw — a celebration failure must not break the award flow.
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

      // Stream matching documents via a cursor rather than materialising the
      // whole result set, so this stays bounded as the achievements
      // collection grows. Only the three fields read below are projected, and
      // `.lean()` avoids hydrating full Mongoose documents.
      const cursor = UserAchievements.find({
        "accolades.earnedAt": { $gte: oneWeekAgo },
      })
        .select("userId username accolades")
        .lean()
        .cursor();

      const result: Array<{
        userId: string;
        username: string;
        accolades: IAccolade[];
      }> = [];

      for await (const user of cursor) {
        const accolades = user.accolades.filter(
          (a) => a.earnedAt >= oneWeekAgo,
        );
        if (accolades.length > 0) {
          result.push({
            userId: user.userId,
            username: user.username,
            accolades,
          });
        }
      }

      return result;
    } catch (error) {
      logger.error("Error getting new accolades since last week:", error);
      return [];
    }
  }
}

// Legacy export for backward compatibility
export const GamificationService = AchievementsService;
