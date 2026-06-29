import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { resolveTimezone } from "../utils/timezone.js";
import logger from "../utils/logger.js";

/**
 * Guild-wide voice-activity heatmap (#675, Part B). Aggregates the
 * already-stored `VoiceChannelTracking` sessions into a 24×7 (hour × weekday)
 * matrix of total voice minutes, so admins can see when the guild is busiest
 * and schedule digests / announcements / polls for maximum reach.
 *
 * Pure read path — no new persistence, no new writes. The aggregation buckets
 * each session by its **start** hour/weekday in the supplied timezone and
 * weights the cell by the whole session duration. (Unlike the per-member
 * Rewind heatmap, which splits a session across the hour/midnight boundaries
 * it crosses, this guild aggregate keeps a single indexed group-by so it
 * stays cheap across every member's full session history — the start-bucket
 * approximation is fine for a scheduling aid.)
 */

const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const SECONDS_PER_MINUTE = 60;

export interface GuildVoiceHeatmap {
  /** Total minutes per [weekday 0=Sun…6=Sat][hour 0…23]. */
  matrix: number[][];
  /** Column totals: minutes per hour-of-day across all weekdays (length 24). */
  byHour: number[];
  /** Row totals: minutes per weekday across all hours (length 7). */
  byDay: number[];
  /** Sum of every cell, in minutes. */
  totalMinutes: number;
  /** The single busiest cell, or null when there is no activity. */
  peak: { day: number; hour: number; minutes: number } | null;
  /** IANA zone the buckets were evaluated in (resolved from the server zone). */
  timeZone: string;
}

/** One `$group` row from the aggregation below. */
interface HeatmapAggregateRow {
  _id: { dow?: number; hour?: number };
  totalSeconds?: number;
}

/** An empty heatmap (all-zero matrix), used for the no-data / error paths. */
export function emptyGuildHeatmap(timeZone: string): GuildVoiceHeatmap {
  return {
    matrix: Array.from({ length: DAYS_PER_WEEK }, () =>
      new Array<number>(HOURS_PER_DAY).fill(0),
    ),
    byHour: new Array<number>(HOURS_PER_DAY).fill(0),
    byDay: new Array<number>(DAYS_PER_WEEK).fill(0),
    totalMinutes: 0,
    peak: null,
    timeZone,
  };
}

/**
 * Fold raw `(dow, hour) → totalSeconds` aggregation rows into the heatmap
 * shape. Kept pure (no DB) so the bucketing maths is unit-testable. `$dayOfWeek`
 * is 1 (Sunday)…7 (Saturday), so we shift it to a 0=Sunday index; out-of-range
 * rows are skipped defensively.
 */
export function buildGuildHeatmap(
  rows: HeatmapAggregateRow[],
  timeZone: string,
): GuildVoiceHeatmap {
  const result = emptyGuildHeatmap(timeZone);
  for (const row of rows) {
    const day = (row._id?.dow ?? 0) - 1; // 1..7 → 0..6
    const hour = row._id?.hour ?? -1;
    if (day < 0 || day >= DAYS_PER_WEEK) continue;
    if (hour < 0 || hour >= HOURS_PER_DAY) continue;
    const minutes = Math.round((row.totalSeconds ?? 0) / SECONDS_PER_MINUTE);
    if (minutes <= 0) continue;
    result.matrix[day][hour] += minutes;
    result.byDay[day] += minutes;
    result.byHour[hour] += minutes;
    result.totalMinutes += minutes;
    if (!result.peak || minutes > result.peak.minutes) {
      result.peak = { day, hour, minutes };
    }
  }
  return result;
}

/**
 * Run the guild-wide heatmap aggregation over sessions whose `startTime`
 * falls in `[start, end)`, bucketed in the resolved server timezone. A query
 * failure degrades to an empty heatmap so the admin page still renders.
 */
export async function getGuildVoiceHeatmap(
  start: Date,
  end: Date,
  timeZone?: string | null,
): Promise<GuildVoiceHeatmap> {
  const zone = resolveTimezone(timeZone);
  try {
    const rows = await VoiceChannelTracking.aggregate<HeatmapAggregateRow>([
      { $unwind: "$sessions" },
      {
        $match: {
          "sessions.startTime": { $gte: start, $lt: end },
          "sessions.duration": { $gt: 0 },
        },
      },
      {
        $group: {
          _id: {
            dow: {
              $dayOfWeek: { date: "$sessions.startTime", timezone: zone },
            },
            hour: { $hour: { date: "$sessions.startTime", timezone: zone } },
          },
          totalSeconds: { $sum: "$sessions.duration" },
        },
      },
    ]);
    return buildGuildHeatmap(rows, zone);
  } catch (error) {
    logger.error("getGuildVoiceHeatmap aggregation failed:", error);
    return emptyGuildHeatmap(zone);
  }
}
