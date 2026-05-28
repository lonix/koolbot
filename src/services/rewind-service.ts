import { Client } from "discord.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { UserAchievements } from "../models/user-achievements.js";
import { ACCOLADE_METADATA } from "../content/accolades.js";
import { ACHIEVEMENT_METADATA } from "../content/achievements.js";
import logger from "../utils/logger.js";

/**
 * Year-in-review aggregation service (#484).
 *
 * Pure read service — no cron, no DM. Given `(userId, guildId, year)`
 * it returns a `RewindSummary` the WebUI renders at `/me/rewind`. All
 * aggregates come from existing collections (`VoiceChannelTracking`,
 * `UserAchievements`); nothing new is persisted.
 *
 * v1 is on-demand and uncached, per the issue spec. If real data shows
 * the queries are too slow, a `RewindCache` collection keyed by
 * `(userId, guildId, year)` is the planned follow-up.
 */

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RewindChannel {
  channelId: string;
  channelName: string;
  totalSeconds: number;
}

export interface RewindAchievement {
  type: string;
  emoji: string;
  name: string;
  description: string;
  earnedAt: Date;
}

export interface RewindWeeklyRank {
  isoYear: number;
  isoWeek: number;
  rank: number;
}

export interface RewindSummary {
  userId: string;
  guildId: string;
  year: number;
  hasData: boolean;
  totalSeconds: number;
  sessionCount: number;
  daysActive: number;
  topChannels: RewindChannel[];
  peakDay: { date: string; totalSeconds: number } | null; // ISO date (YYYY-MM-DD)
  longestStreakDays: number;
  longestStreakRange: { startDate: string; endDate: string } | null;
  accolades: RewindAchievement[];
  achievements: RewindAchievement[];
  annualRank: number | null;
  annualGuildMembers: number;
  percentAboveMedian: number | null;
  weeklyJourney: {
    first: RewindWeeklyRank | null;
    last: RewindWeeklyRank | null;
    best: RewindWeeklyRank | null;
  };
  // Years for which the user has any data (sessions or achievements).
  // Used by the page to render a small year picker.
  availableYears: number[];
}

interface RawSession {
  startTime: Date;
  endTime?: Date;
  duration?: number;
  channelId: string;
  channelName?: string;
}

// --------------------------------------------------------------------
// Pure helpers (exported for unit tests).
// --------------------------------------------------------------------

export function yearBounds(year: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0)),
  };
}

export function toIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function sessionSeconds(session: RawSession): number {
  if (typeof session.duration === "number" && session.duration > 0) {
    return Math.floor(session.duration);
  }
  if (session.endTime && session.startTime) {
    return Math.max(
      0,
      Math.floor(
        (session.endTime.getTime() - session.startTime.getTime()) / 1000,
      ),
    );
  }
  return 0;
}

export function computeTopChannels(
  sessions: RawSession[],
  limit = 3,
): RewindChannel[] {
  const totals = new Map<
    string,
    { channelId: string; channelName: string; totalSeconds: number }
  >();
  for (const s of sessions) {
    const key = s.channelId;
    const seconds = sessionSeconds(s);
    if (seconds <= 0) continue;
    const existing = totals.get(key);
    if (existing) {
      existing.totalSeconds += seconds;
      // Prefer the most recent non-empty name (handles renames).
      if (s.channelName) existing.channelName = s.channelName;
    } else {
      totals.set(key, {
        channelId: key,
        channelName: s.channelName ?? "Unknown channel",
        totalSeconds: seconds,
      });
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, limit);
}

export function computePeakDay(
  sessions: RawSession[],
): { date: string; totalSeconds: number } | null {
  const byDay = new Map<string, number>();
  for (const s of sessions) {
    const seconds = sessionSeconds(s);
    if (seconds <= 0) continue;
    const key = toIsoDate(s.startTime);
    byDay.set(key, (byDay.get(key) ?? 0) + seconds);
  }
  if (byDay.size === 0) return null;
  let bestDate: string | null = null;
  let bestSeconds = 0;
  for (const [date, totalSeconds] of byDay) {
    if (totalSeconds > bestSeconds) {
      bestDate = date;
      bestSeconds = totalSeconds;
    }
  }
  return bestDate ? { date: bestDate, totalSeconds: bestSeconds } : null;
}

/**
 * Longest run of consecutive UTC days that contain ≥1 session. Returns
 * the day count and the start/end ISO dates of the winning run. A single
 * day of activity counts as a streak of 1.
 */
export function computeLongestStreak(sessions: RawSession[]): {
  days: number;
  startDate: string | null;
  endDate: string | null;
} {
  const days = new Set<string>();
  for (const s of sessions) {
    if (sessionSeconds(s) <= 0) continue;
    days.add(toIsoDate(s.startTime));
  }
  if (days.size === 0) return { days: 0, startDate: null, endDate: null };
  const sorted = [...days].sort();
  let bestLen = 1;
  let bestStart = sorted[0];
  let bestEnd = sorted[0];
  let runLen = 1;
  let runStart = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = new Date(`${sorted[i - 1]}T00:00:00Z`).getTime();
    const cur = new Date(`${sorted[i]}T00:00:00Z`).getTime();
    if (cur - prev === MS_PER_DAY) {
      runLen += 1;
    } else {
      runLen = 1;
      runStart = sorted[i];
    }
    if (runLen > bestLen) {
      bestLen = runLen;
      bestStart = runStart;
      bestEnd = sorted[i];
    }
  }
  return { days: bestLen, startDate: bestStart, endDate: bestEnd };
}

function lookupAccolade(type: string): {
  emoji: string;
  name: string;
  description: string;
} | null {
  const meta = (
    ACCOLADE_METADATA as Record<
      string,
      { emoji: string; name: string; description: string }
    >
  )[type];
  return meta
    ? { emoji: meta.emoji, name: meta.name, description: meta.description }
    : null;
}

function lookupAchievement(type: string): {
  emoji: string;
  name: string;
  description: string;
} | null {
  const meta = (
    ACHIEVEMENT_METADATA as Record<
      string,
      { emoji: string; name: string; description: string }
    >
  )[type];
  return meta
    ? { emoji: meta.emoji, name: meta.name, description: meta.description }
    : null;
}

// --------------------------------------------------------------------
// Service
// --------------------------------------------------------------------

export class RewindService {
  private static instance: RewindService;
  private client: Client;

  private constructor(client: Client) {
    this.client = client;
  }

  public static getInstance(client: Client): RewindService {
    if (!RewindService.instance) {
      RewindService.instance = new RewindService(client);
    } else if (RewindService.instance.client !== client) {
      throw new Error(
        "RewindService already initialised with a different client",
      );
    }
    return RewindService.instance;
  }

  public static reset(): void {
    RewindService.instance = undefined as unknown as RewindService;
  }

  /**
   * Compute the full Rewind summary for `(userId, guildId, year)`.
   *
   * Returns a summary even when the user has no data — the `hasData`
   * flag drives the empty-state branch in the view layer. Returning
   * `null` is reserved for unexpected DB failure.
   */
  public async getSummary(
    userId: string,
    guildId: string,
    year: number,
  ): Promise<RewindSummary | null> {
    try {
      const { start, end } = yearBounds(year);

      const [userDoc, achievementsDoc] = await Promise.all([
        VoiceChannelTracking.findOne({ userId }).lean<{
          sessions?: RawSession[];
        }>(),
        UserAchievements.findOne({ userId }).lean<{
          accolades?: Array<{ type: string; earnedAt: Date }>;
          achievements?: Array<{ type: string; earnedAt: Date }>;
        }>(),
      ]);

      const availableYears = await this.collectAvailableYears(
        userId,
        achievementsDoc,
      );

      const sessions = (userDoc?.sessions ?? []).filter(
        (s) => s.startTime >= start && s.startTime < end,
      );

      const totalSeconds = sessions.reduce(
        (sum, s) => sum + sessionSeconds(s),
        0,
      );
      const daysActive = new Set(
        sessions
          .filter((s) => sessionSeconds(s) > 0)
          .map((s) => toIsoDate(s.startTime)),
      ).size;

      const topChannels = computeTopChannels(sessions, 3);
      const peakDay = computePeakDay(sessions);
      const streak = computeLongestStreak(sessions);

      const accolades = (achievementsDoc?.accolades ?? [])
        .filter((a) => a.earnedAt >= start && a.earnedAt < end)
        .map((a) => {
          const meta = lookupAccolade(a.type);
          return meta ? { type: a.type, ...meta, earnedAt: a.earnedAt } : null;
        })
        .filter((a): a is RewindAchievement => a !== null);

      const achievements = (achievementsDoc?.achievements ?? [])
        .filter((a) => a.earnedAt >= start && a.earnedAt < end)
        .map((a) => {
          const meta = lookupAchievement(a.type);
          return meta ? { type: a.type, ...meta, earnedAt: a.earnedAt } : null;
        })
        .filter((a): a is RewindAchievement => a !== null);

      const { annualRank, annualGuildMembers, percentAboveMedian } =
        await this.computeAnnualRank(userId, start, end, totalSeconds);

      const weeklyJourney = await this.computeWeeklyJourney(userId, start, end);

      const hasData =
        totalSeconds > 0 || accolades.length > 0 || achievements.length > 0;

      return {
        userId,
        guildId,
        year,
        hasData,
        totalSeconds,
        sessionCount: sessions.filter((s) => sessionSeconds(s) > 0).length,
        daysActive,
        topChannels,
        peakDay,
        longestStreakDays: streak.days,
        longestStreakRange:
          streak.startDate && streak.endDate
            ? { startDate: streak.startDate, endDate: streak.endDate }
            : null,
        accolades,
        achievements,
        annualRank,
        annualGuildMembers,
        percentAboveMedian,
        weeklyJourney,
        availableYears,
      };
    } catch (error) {
      logger.error(
        `RewindService.getSummary failed for user=${userId} year=${year}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Years for which we have any data (sessions or achievements). Used by
   * the year picker so the page only offers years that won't render an
   * empty state. Reuses the already-fetched achievements doc to avoid a
   * second `findOne`.
   */
  private async collectAvailableYears(
    userId: string,
    achievementsDoc: {
      accolades?: Array<{ earnedAt: Date }>;
      achievements?: Array<{ earnedAt: Date }>;
    } | null,
  ): Promise<number[]> {
    const years = new Set<number>();
    try {
      const sessionYears = await VoiceChannelTracking.aggregate<{
        _id: number;
      }>([
        { $match: { userId } },
        { $unwind: "$sessions" },
        { $group: { _id: { $year: "$sessions.startTime" } } },
      ]);
      for (const row of sessionYears) {
        if (typeof row._id === "number") years.add(row._id);
      }
      for (const a of achievementsDoc?.accolades ?? []) {
        if (a.earnedAt) years.add(a.earnedAt.getUTCFullYear());
      }
      for (const a of achievementsDoc?.achievements ?? []) {
        if (a.earnedAt) years.add(a.earnedAt.getUTCFullYear());
      }
    } catch (error) {
      logger.warn(
        `RewindService.collectAvailableYears partial failure for ${userId}:`,
        error,
      );
    }
    return [...years].sort((a, b) => b - a);
  }

  /**
   * Compute the user's rank for the full year against everyone else who
   * had any voice activity in `[start, end)`. Also returns the guild
   * total active members and the percent the user is above the median.
   * If the user has zero time, rank is `null`.
   */
  private async computeAnnualRank(
    userId: string,
    start: Date,
    end: Date,
    userSeconds: number,
  ): Promise<{
    annualRank: number | null;
    annualGuildMembers: number;
    percentAboveMedian: number | null;
  }> {
    if (userSeconds <= 0) {
      return {
        annualRank: null,
        annualGuildMembers: 0,
        percentAboveMedian: null,
      };
    }
    const totals = await VoiceChannelTracking.aggregate<{
      _id: string;
      totalTime: number;
    }>([
      { $unwind: "$sessions" },
      {
        $match: {
          "sessions.startTime": { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: "$userId",
          totalTime: { $sum: "$sessions.duration" },
        },
      },
      { $match: { totalTime: { $gt: 0 } } },
      { $sort: { totalTime: -1 } },
    ]);

    if (totals.length === 0) {
      return {
        annualRank: null,
        annualGuildMembers: 0,
        percentAboveMedian: null,
      };
    }

    const rankIndex = totals.findIndex((row) => row._id === userId);
    const annualRank = rankIndex >= 0 ? rankIndex + 1 : null;

    // Median across active members.
    const sortedTotals = totals.map((t) => t.totalTime).sort((a, b) => a - b);
    const mid = Math.floor(sortedTotals.length / 2);
    const median =
      sortedTotals.length % 2 === 1
        ? sortedTotals[mid]
        : (sortedTotals[mid - 1] + sortedTotals[mid]) / 2;
    const percentAboveMedian =
      median > 0 ? Math.round(((userSeconds - median) / median) * 100) : null;

    return {
      annualRank,
      annualGuildMembers: totals.length,
      percentAboveMedian,
    };
  }

  /**
   * Compute the user's weekly rank for every ISO week of the year and
   * return the first, last and best (lowest rank number) entries.
   *
   * Uses `$setWindowFields` to rank across all users per week in a
   * single aggregation. If the user had zero qualifying weeks, all
   * three are `null`.
   */
  private async computeWeeklyJourney(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<RewindSummary["weeklyJourney"]> {
    try {
      const rows = await VoiceChannelTracking.aggregate<{
        _id: { userId: string; isoYear: number; isoWeek: number };
        totalTime: number;
        rank: number;
      }>([
        { $unwind: "$sessions" },
        {
          $match: {
            "sessions.startTime": { $gte: start, $lt: end },
          },
        },
        {
          $group: {
            _id: {
              userId: "$userId",
              isoYear: { $isoWeekYear: "$sessions.startTime" },
              isoWeek: { $isoWeek: "$sessions.startTime" },
            },
            totalTime: { $sum: "$sessions.duration" },
          },
        },
        { $match: { totalTime: { $gt: 0 } } },
        {
          $setWindowFields: {
            partitionBy: { isoYear: "$_id.isoYear", isoWeek: "$_id.isoWeek" },
            sortBy: { totalTime: -1 },
            output: { rank: { $rank: {} } },
          },
        },
        { $match: { "_id.userId": userId } },
        { $sort: { "_id.isoYear": 1, "_id.isoWeek": 1 } },
      ]);

      if (rows.length === 0) {
        return { first: null, last: null, best: null };
      }
      const journey: RewindWeeklyRank[] = rows.map((r) => ({
        isoYear: r._id.isoYear,
        isoWeek: r._id.isoWeek,
        rank: r.rank,
      }));
      const best = journey.reduce(
        (acc, cur) => (acc === null || cur.rank < acc.rank ? cur : acc),
        null as RewindWeeklyRank | null,
      );
      return {
        first: journey[0],
        last: journey[journey.length - 1],
        best,
      };
    } catch (error) {
      logger.warn(
        `RewindService.computeWeeklyJourney failed for ${userId}:`,
        error,
      );
      return { first: null, last: null, best: null };
    }
  }
}

// --------------------------------------------------------------------
// View-layer formatting helpers (kept in the service module so tests
// and the view share the same source of truth).
// --------------------------------------------------------------------

export function formatHoursMinutes(totalSeconds: number): string {
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

/**
 * Build a short, lightly humorous "≈ X movies / flights" comparison.
 * Picks the largest unit whose value is ≥1 so the line stays readable
 * for both heavy and light users.
 */
export function formatFunComparison(totalSeconds: number): string | null {
  if (totalSeconds <= 0) return null;
  const totalHours = totalSeconds / SECONDS_PER_HOUR;
  // Tuned for chat-friendly comparisons; rough rather than precise.
  const candidates: Array<{ unit: string; hours: number; singular: string }> = [
    {
      unit: "trans-atlantic flights",
      hours: 8,
      singular: "trans-atlantic flight",
    },
    {
      unit: "feature-length movies",
      hours: 2,
      singular: "feature-length movie",
    },
    { unit: "long lunch breaks", hours: 1, singular: "long lunch break" },
    { unit: "songs", hours: 3 / 60, singular: "song" },
  ];
  for (const c of candidates) {
    const count = Math.round(totalHours / c.hours);
    if (count >= 1) {
      return `≈ ${count} ${count === 1 ? c.singular : c.unit}`;
    }
  }
  return null;
}
