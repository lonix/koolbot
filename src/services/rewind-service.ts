import { Client } from "discord.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { UserAchievements } from "../models/user-achievements.js";
import { MessageActivityTracking } from "../models/message-activity-tracking.js";
import { RewindSnapshot } from "../models/rewind-snapshot.js";
import { ConfigService } from "./config-service.js";
import { ACCOLADE_METADATA } from "../content/accolades.js";
import { ACHIEVEMENT_METADATA } from "../content/achievements.js";
import { isValidTimezone, isoDateInZone } from "../utils/timezone.js";
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

/**
 * A voice "companion" for the Rewind summary (#567) — another user the
 * requesting user shared a voice channel with, ranked by co-present
 * seconds. With this server's dynamic VCs the meaningful unit is *who*
 * you spent time with rather than *which* ephemeral room you sat in.
 */
export interface RewindCompanion {
  userId: string;
  displayName: string;
  totalSeconds: number;
}

/**
 * Top text channel for the Rewind summary (#496). Ranked by message count
 * rather than seconds, since text activity is counted per message.
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
  // People the user spent the most voice time with this year (#567).
  // (Top channels was removed from Rewind — with dynamic VCs the ephemeral
  // per-session room names are noise; companions replace it.)
  topCompanions: RewindCompanion[];
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
  // Years for which the user has any data (voice sessions, text-message
  // activity, or achievements). Used by the page to render a small year
  // picker.
  availableYears: number[];
  // How this summary was produced (#574): "live" recomputes from raw
  // activity, "snapshot" is served verbatim from a frozen completed-year
  // record. Optional so older serialised summaries (and tests) omit it.
  source?: "live" | "snapshot";
}

/**
 * Schema version stamped on every snapshot we write (#574). Bump when the
 * `RewindSummary` shape changes in a way worth recording; old snapshots
 * keep their stored version and are rendered tolerantly by
 * `normalizeSnapshotSummary`.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

interface RawSession {
  startTime: Date;
  endTime?: Date;
  duration?: number;
  channelId: string;
  channelName?: string;
  // Union of other user ids encountered during the session (#567).
  otherUsers?: string[];
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

/**
 * The calendar-day key for a timestamp (#524). Defaults to UTC so unset
 * users keep the existing grouping; when a valid IANA `timeZone` is
 * supplied, days are bucketed in that zone instead so "peak day" and
 * streaks reflect the user's local midnight.
 */
function dayKey(date: Date, timeZone?: string): string {
  return timeZone ? isoDateInZone(date, timeZone) : toIsoDate(date);
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

/**
 * Aggregate co-present voice seconds per other user (#567) and return the
 * top `limit` ranked desc. For each session, every id in `otherUsers[]` is
 * credited the *whole* session's duration.
 *
 * Caveat: `otherUsers[]` is the union of everyone encountered during the
 * session, not a per-moment overlap, so a companion who only dropped in
 * for a minute is still credited the full session. That over-counts, but
 * it's an acceptable approximation for a fun year-in-review stat; precise
 * overlap would need interval tracking (out of scope here).
 *
 * Returns ids + seconds; the service resolves ids → display names, mirroring
 * how `computeTopTextChannels` defers name resolution.
 */
export function computeTopCompanions(
  sessions: RawSession[],
  limit = 5,
): Array<{ userId: string; totalSeconds: number }> {
  const totals = new Map<string, number>();
  for (const s of sessions) {
    const seconds = sessionSeconds(s);
    if (seconds <= 0) continue;
    for (const userId of s.otherUsers ?? []) {
      if (!userId) continue;
      totals.set(userId, (totals.get(userId) ?? 0) + seconds);
    }
  }
  return [...totals.entries()]
    .map(([userId, totalSeconds]) => ({ userId, totalSeconds }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, limit);
}

export function computePeakDay(
  sessions: RawSession[],
  timeZone?: string,
): { date: string; totalSeconds: number } | null {
  const byDay = new Map<string, number>();
  for (const s of sessions) {
    const seconds = sessionSeconds(s);
    if (seconds <= 0) continue;
    const key = dayKey(s.startTime, timeZone);
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

/**
 * The day with the most messages, or null when there are none. Days are
 * bucketed in UTC by default; passing a valid IANA `timeZone` buckets
 * them in that zone instead (#524).
 */
export function computePeakMessageDay(
  messages: RawTextMessage[],
  timeZone?: string,
): { date: string; count: number } | null {
  const byDay = new Map<string, number>();
  for (const m of messages) {
    const key = dayKey(m.sentAt, timeZone);
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
 * Longest run of consecutive days that contain ≥1 session. Returns the
 * day count and the start/end ISO dates of the winning run. A single day
 * of activity counts as a streak of 1. Days are bucketed in UTC by
 * default; passing a valid IANA `timeZone` buckets them in that zone
 * instead, so the run reflects the user's local midnight (#524).
 */
export function computeLongestStreak(
  sessions: RawSession[],
  timeZone?: string,
): {
  days: number;
  startDate: string | null;
  endDate: string | null;
} {
  const days = new Set<string>();
  for (const s of sessions) {
    if (sessionSeconds(s) <= 0) continue;
    days.add(dayKey(s.startTime, timeZone));
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

/**
 * Coerce a stored snapshot summary into a complete `RewindSummary` for
 * rendering (#574). Snapshots are frozen as-generated, so a snapshot
 * written under an older schema may be missing fields the current view
 * expects. We fill every field with a safe default and stamp the identity
 * from the request so a partial / corrupt stored payload still renders the
 * empty-state branch rather than throwing in the view layer.
 */
export function normalizeSnapshotSummary(
  stored: Partial<RewindSummary> | null | undefined,
  identity: { userId: string; guildId: string; year: number },
): RewindSummary {
  const s = stored ?? {};
  return {
    userId: s.userId ?? identity.userId,
    guildId: s.guildId ?? identity.guildId,
    year: s.year ?? identity.year,
    hasData: s.hasData ?? false,
    totalSeconds: s.totalSeconds ?? 0,
    sessionCount: s.sessionCount ?? 0,
    daysActive: s.daysActive ?? 0,
    // Older snapshots predate companions (#567) and any that recorded the
    // since-removed topChannels are simply dropped here.
    topCompanions: s.topCompanions ?? [],
    peakDay: s.peakDay ?? null,
    messagesSent: s.messagesSent ?? 0,
    topTextChannels: s.topTextChannels ?? [],
    peakMessageDay: s.peakMessageDay ?? null,
    longestStreakDays: s.longestStreakDays ?? 0,
    longestStreakRange: s.longestStreakRange ?? null,
    accolades: s.accolades ?? [],
    achievements: s.achievements ?? [],
    annualRank: s.annualRank ?? null,
    annualGuildMembers: s.annualGuildMembers ?? 0,
    percentAboveMedian: s.percentAboveMedian ?? null,
    weeklyJourney: s.weeklyJourney ?? { first: null, last: null, best: null },
    availableYears: s.availableYears ?? [],
    source: "snapshot",
  };
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
    timeZone?: string | null,
  ): Promise<RewindSummary | null> {
    try {
      // Completed years are served from their immutable snapshot when one
      // exists, so the recap is unaffected by later voice-session /
      // message-detail truncation (#574). The in-progress current year
      // always recomputes live. A past year predating the snapshot
      // feature has no record and falls through to the live path below.
      const currentYear = new Date().getUTCFullYear();
      if (year < currentYear) {
        const snapshot = await this.loadSnapshot(userId, guildId, year);
        if (snapshot) return snapshot;
      }

      const { start, end } = yearBounds(year);

      // Only bucket days in a user zone when one is actually set and
      // valid; otherwise keep the existing UTC grouping so unconfigured
      // users see no change (#524).
      const dayZone =
        timeZone && isValidTimezone(timeZone) ? timeZone : undefined;

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
          .map((s) => dayKey(s.startTime, dayZone)),
      ).size;

      // Top voice companions (#567) replace the old "Top channels" card:
      // with dynamic VCs the ephemeral per-session room names are noise, so
      // we surface *who* the user spent time with instead.
      const topCompanions: RewindCompanion[] = computeTopCompanions(
        sessions,
        5,
      ).map((c) => ({
        userId: c.userId,
        displayName: this.resolveUserName(guildId, c.userId),
        totalSeconds: c.totalSeconds,
      }));
      const peakDay = computePeakDay(sessions, dayZone);
      const streak = computeLongestStreak(sessions, dayZone);

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

      // These reads are independent — run them concurrently so the
      // on-demand /me/rewind render doesn't pay their latency in series.
      const [
        { annualRank, annualGuildMembers, percentAboveMedian },
        weeklyJourney,
        text,
        snapshotYears,
      ] = await Promise.all([
        this.computeAnnualRank(userId, start, end, totalSeconds),
        this.computeWeeklyJourney(userId, start, end),
        this.computeTextActivity(userId, guildId, start, end, dayZone),
        this.collectSnapshotYears(userId, guildId),
      ]);

      // The picker should offer any year the user has either kind of data,
      // plus any snapshotted year — those must stay navigable even after
      // their raw sessions/messages have been truncated away (#574).
      const mergedYears = [
        ...new Set([...availableYears, ...text.years, ...snapshotYears]),
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
        topCompanions,
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
        source: "live",
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
   * Resolve the year the bare `/me/rewind` route should land on (#573): the
   * most recent year the user actually has data for, falling back to the
   * current UTC year for brand-new users with nothing to recap (so they
   * still see today's empty state).
   *
   * Reuses the same lightweight year-collection queries that back
   * `availableYears` so we never pay for a full summary build just to pick
   * the landing year. The explicit `/rewind/:year` route bypasses this and
   * honours the requested year, empty or not.
   */
  public async getDefaultRewindYear(
    userId: string,
    guildId: string,
  ): Promise<number> {
    const currentYear = new Date().getUTCFullYear();
    try {
      const achievementsDoc = await UserAchievements.findOne({
        userId,
      }).lean<{
        accolades?: Array<{ earnedAt: Date }>;
        achievements?: Array<{ earnedAt: Date }>;
      }>();

      const [sessionAndAchievementYears, textYears, snapshotYears] =
        await Promise.all([
          this.collectAvailableYears(userId, achievementsDoc),
          this.collectTextActivityYears(userId, guildId),
          this.collectSnapshotYears(userId, guildId),
        ]);

      // Guard against a non-finite year slipping through any collector
      // (e.g. a corrupt `sentAt`/`earnedAt` yielding `NaN` — which passes a
      // `typeof === "number"` check). An unfiltered `NaN` would make
      // `Math.max` return `NaN` and, for the bare route, flow straight
      // through `parseYearParam` into `getSummary` as "Rewind NaN".
      const years = [
        ...sessionAndAchievementYears,
        ...textYears,
        ...snapshotYears,
      ].filter((y) => Number.isFinite(y));
      // No data anywhere → land on the (empty) current year, preserving
      // the brand-new-user experience. Otherwise pick the newest year with
      // data, which is the current year when it already has activity.
      return years.length === 0 ? currentYear : Math.max(...years);
    } catch (error) {
      logger.warn(
        `RewindService.getDefaultRewindYear failed for ${userId}, defaulting to current year:`,
        error,
      );
      return currentYear;
    }
  }

  /**
   * Freeze a user's completed-year recap into an immutable `RewindSnapshot`
   * (#574). Called by the end-of-year cron once the year has wrapped up.
   *
   * Idempotent: an existing snapshot is never duplicated or mutated, so a
   * re-run (or a manual replay) is a no-op. We compute the summary live —
   * at snapshot time the year is the just-completing current year, so
   * `getSummary` recomputes from raw data rather than short-circuiting.
   * Users with nothing worth freezing are skipped instead of storing an
   * empty record.
   *
   * Returns the outcome so the caller can roll it into a run summary.
   */
  public async snapshotYear(
    userId: string,
    guildId: string,
    year: number,
    timeZone?: string | null,
  ): Promise<"created" | "exists" | "skipped" | "failed"> {
    try {
      const existing = await RewindSnapshot.findOne({
        userId,
        guildId,
        year,
      }).lean();
      if (existing) return "exists";

      const summary = await this.getSummary(userId, guildId, year, timeZone);
      if (!summary) return "failed";
      if (!summary.hasData) return "skipped";

      await RewindSnapshot.create({
        guildId,
        userId,
        year,
        summary,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        generatedAt: new Date(),
      });
      return "created";
    } catch (error) {
      // A concurrent run may have inserted the row between our existence
      // check and the create — treat the unique-index violation as a
      // benign "already exists" rather than a failure.
      if ((error as { code?: number }).code === 11000) return "exists";
      logger.error(
        `RewindService.snapshotYear failed for user=${userId} year=${year}:`,
        error,
      );
      return "failed";
    }
  }

  /**
   * Load and normalise the frozen snapshot for a completed year, or return
   * `null` when none exists (so the caller falls back to live compute).
   *
   * The stored summary carries the `availableYears` it had at freeze time;
   * we union in the full set of snapshotted years so every preserved year
   * stays reachable from the picker even after the source data is gone.
   * A lookup failure is swallowed to `null` — better to compute live than
   * to error the page.
   */
  private async loadSnapshot(
    userId: string,
    guildId: string,
    year: number,
  ): Promise<RewindSummary | null> {
    try {
      const doc = await RewindSnapshot.findOne({
        userId,
        guildId,
        year,
      }).lean<{ summary?: Partial<RewindSummary> }>();
      if (!doc) return null;

      const summary = normalizeSnapshotSummary(doc.summary, {
        userId,
        guildId,
        year,
      });
      const snapshotYears = await this.collectSnapshotYears(userId, guildId);
      summary.availableYears = [
        ...new Set([...summary.availableYears, ...snapshotYears]),
      ].sort((a, b) => b - a);
      return summary;
    } catch (error) {
      logger.warn(
        `RewindService.loadSnapshot failed for user=${userId} year=${year}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Distinct years for which this user has a frozen snapshot. Used to keep
   * the year picker offering preserved years after their raw data is
   * truncated (#574). A failure degrades to an empty list.
   */
  private async collectSnapshotYears(
    userId: string,
    guildId: string,
  ): Promise<number[]> {
    try {
      const rows = await RewindSnapshot.find(
        { userId, guildId },
        { year: 1 },
      ).lean<Array<{ year: number }>>();
      return rows
        .map((r) => r.year)
        .filter((y): y is number => typeof y === "number");
    } catch (error) {
      logger.warn(
        `RewindService.collectSnapshotYears failed for ${userId}:`,
        error,
      );
      return [];
    }
  }

  /**
   * Distinct years present in the user's retained message detail (#573). A
   * lighter cousin of `computeTextActivity` used purely for landing-year
   * resolution — it skips channel resolution and the in-window aggregation,
   * and respects the same `messagetracking.enabled` gate. A failure (or a
   * disabled feature) degrades to an empty list.
   */
  private async collectTextActivityYears(
    userId: string,
    guildId: string,
  ): Promise<number[]> {
    try {
      const enabled = await this.configService.getBoolean(
        "messagetracking.enabled",
        false,
      );
      if (!enabled) return [];

      const doc = await MessageActivityTracking.findOne(
        { userId, guildId },
        { recentMessages: 1 },
      ).lean<{ recentMessages?: RawTextMessage[] }>();
      const all = doc?.recentMessages ?? [];
      return [
        ...new Set(
          all
            .map((m) => m.sentAt.getUTCFullYear())
            .filter((y) => Number.isFinite(y)),
        ),
      ];
    } catch (error) {
      logger.warn(
        `RewindService.collectTextActivityYears failed for ${userId}:`,
        error,
      );
      return [];
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
   * by `messagetracking.cleanup.retention.detailed_days`) so the year
   * picker can offer them even when the requested year itself has no
   * text data.
   */
  private async computeTextActivity(
    userId: string,
    guildId: string,
    start: Date,
    end: Date,
    timeZone?: string,
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

      const doc = await MessageActivityTracking.findOne(
        { userId, guildId },
        // Only the per-message detail is needed here — skip channels[] /
        // totalCount to keep the payload small.
        { recentMessages: 1 },
      ).lean<{ recentMessages?: RawTextMessage[] }>();
      const all = doc?.recentMessages ?? [];
      const years = [...new Set(all.map((m) => m.sentAt.getUTCFullYear()))];

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
        peakMessageDay: computePeakMessageDay(inYear, timeZone),
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
   * Resolve a companion's user id to a display name (#567), preferring the
   * guild nickname, then the global username, both read from the client
   * cache like `resolveChannelName`. A cache miss can mean the user left
   * the guild, but also simply that partial member caching (gateway
   * intents / cache limits) never populated them — so we fall back to a
   * neutral placeholder rather than asserting they've gone.
   */
  private resolveUserName(guildId: string, userId: string): string {
    const member = this.client.guilds?.cache
      ?.get(guildId)
      ?.members?.cache?.get(userId);
    if (member?.displayName) return member.displayName;
    const user = this.client.users?.cache?.get(userId);
    if (user?.username) return user.username;
    return "Unknown user";
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
