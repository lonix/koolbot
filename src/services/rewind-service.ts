import { Client } from "discord.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { UserAchievements } from "../models/user-achievements.js";
import { MessageActivityTracking } from "../models/message-activity-tracking.js";
import { ConfigService } from "./config-service.js";
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

/**
 * Top text channel for the Rewind summary (#496). Mirrors `RewindChannel`
 * but ranked by message count rather than seconds, since text activity is
 * counted per message.
 */
export interface RewindTextChannel {
  channelId: string;
  channelName: string;
  count: number;
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
  // Text-message activity (#496). Mirrors the voice aggregates above and
  // reads as zero / empty when message tracking is disabled or absent.
  messagesSent: number;
  topTextChannels: RewindTextChannel[];
  peakMessageDay: { date: string; count: number } | null; // ISO date (YYYY-MM-DD)
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

interface RawTextMessage {
  sentAt: Date;
  channelId: string;
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
 * Filter text messages to those sent within `[start, end)`. Used to scope
 * the retained `recentMessages` detail to a single year. The window is
 * half-open so the year boundary (and, in practice, the retention cutoff
 * the cleanup pass enforces) is handled consistently with the voice flow.
 */
export function messagesInWindow(
  messages: RawTextMessage[],
  start: Date,
  end: Date,
): RawTextMessage[] {
  return messages.filter((m) => m.sentAt >= start && m.sentAt < end);
}

/**
 * Count messages per channel, sorted by count desc and capped at `limit`.
 * Returns ids + counts; the service resolves channel names so this stays
 * pure and testable.
 */
export function computeTopTextChannels(
  messages: RawTextMessage[],
  limit = 3,
): Array<{ channelId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of messages) {
    counts.set(m.channelId, (counts.get(m.channelId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([channelId, count]) => ({ channelId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** The UTC day with the most messages, or null when there are none. */
export function computePeakMessageDay(
  messages: RawTextMessage[],
): { date: string; count: number } | null {
  const byDay = new Map<string, number>();
  for (const m of messages) {
    const key = toIsoDate(m.sentAt);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  if (byDay.size === 0) return null;
  let bestDate: string | null = null;
  let bestCount = 0;
  for (const [date, count] of byDay) {
    if (count > bestCount) {
      bestDate = date;
      bestCount = count;
    }
  }
  return bestDate ? { date: bestDate, count: bestCount } : null;
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
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
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

      const text = await this.computeTextActivity(userId, guildId, start, end);

      // The picker should offer any year the user has either kind of data.
      const mergedYears = [
        ...new Set([...availableYears, ...text.years]),
      ].sort((a, b) => b - a);

      const hasData =
        totalSeconds > 0 ||
        accolades.length > 0 ||
        achievements.length > 0 ||
        text.messagesSent > 0;

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
        messagesSent: text.messagesSent,
        topTextChannels: text.topTextChannels,
        peakMessageDay: text.peakMessageDay,
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
        availableYears: mergedYears,
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
   * Aggregate text-message activity for the year from the retained
   * `recentMessages` detail. Returns zero / empty when message tracking
   * is disabled (per the feature gate) or the user has no document, so
   * the view can hide the card without special-casing.
   *
   * `years` reflects every year present in the retained detail (bounded
   * by `messagetracking.retention_days`) so the year picker can offer
   * them even when the requested year itself has no text data.
   */
  private async computeTextActivity(
    userId: string,
    guildId: string,
    start: Date,
    end: Date,
  ): Promise<{
    messagesSent: number;
    topTextChannels: RewindTextChannel[];
    peakMessageDay: { date: string; count: number } | null;
    years: number[];
  }> {
    const empty = {
      messagesSent: 0,
      topTextChannels: [] as RewindTextChannel[],
      peakMessageDay: null,
      years: [] as number[],
    };
    try {
      const enabled = await this.configService.getBoolean(
        "messagetracking.enabled",
        false,
      );
      if (!enabled) return empty;

      const doc = await MessageActivityTracking.findOne({
        userId,
        guildId,
      }).lean<{ recentMessages?: RawTextMessage[] }>();
      const all = doc?.recentMessages ?? [];
      const years = [
        ...new Set(all.map((m) => m.sentAt.getUTCFullYear())),
      ];

      const inYear = messagesInWindow(all, start, end);
      if (inYear.length === 0) {
        return { ...empty, years };
      }

      const topTextChannels = computeTopTextChannels(inYear, 3).map((c) => ({
        channelId: c.channelId,
        channelName: this.resolveChannelName(c.channelId),
        count: c.count,
      }));

      return {
        messagesSent: inYear.length,
        topTextChannels,
        peakMessageDay: computePeakMessageDay(inYear),
        years,
      };
    } catch (error) {
      logger.warn(
        `RewindService.computeTextActivity failed for ${userId}:`,
        error,
      );
      return empty;
    }
  }

  /**
   * Resolve a channel id to its current name via the client cache,
   * falling back to a placeholder for deleted / uncached channels.
   */
  private resolveChannelName(channelId: string): string {
    const channel = this.client.channels.cache.get(channelId);
    if (channel && "name" in channel && typeof channel.name === "string") {
      return channel.name;
    }
    return "Unknown channel";
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
