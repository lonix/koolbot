import { CommandMetrics } from "../models/command-metrics.js";

/**
 * Aggregated, per-command rollup of the persisted daily metric buckets over a
 * trailing window (issue #648). Powers the Admin → Command Metrics dashboard.
 */
export interface CommandMetricSummaryRow {
  command: string;
  usageCount: number;
  errorCount: number;
  /** errorCount / usageCount, in the range 0..1 (0 when usageCount is 0). */
  errorRate: number;
  /** totalResponseMs / usageCount (0 when usageCount is 0). */
  avgResponseMs: number;
  totalResponseMs: number;
  lastUsedAt: string | null;
}

/** Per-day totals across all commands, for the usage-trend chart. */
export interface CommandMetricsDailyTotal {
  date: string;
  usageCount: number;
  errorCount: number;
}

export interface CommandMetricsSummary {
  windowDays: number;
  /** Inclusive lower bound of the window, as a "YYYY-MM-DD" key. */
  fromDate: string;
  /** Per-command rows, sorted by usage descending. */
  rows: CommandMetricSummaryRow[];
  /** Per-day totals, sorted by date ascending. */
  dailyTotals: CommandMetricsDailyTotal[];
  totalUsage: number;
  totalErrors: number;
}

interface RawCommandGroup {
  _id: string;
  usageCount: number;
  errorCount: number;
  totalResponseMs: number;
  lastUsedAt: Date | string | null;
}

interface RawDailyGroup {
  _id: string;
  usageCount: number;
  errorCount: number;
}

/** "YYYY-MM-DD" key for `daysAgo` days before `now` (UTC). */
export function dayKeyDaysAgo(daysAgo: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Roll up the persisted command-metric buckets for a guild over the trailing
 * `windowDays` days into per-command and per-day summaries. Kept free of any
 * Discord/HTTP concerns so the route stays thin and this is unit-testable by
 * stubbing the model's `aggregate`.
 */
export async function getCommandMetricsSummary(
  guildId: string,
  windowDays: number,
): Promise<CommandMetricsSummary> {
  // Window is inclusive of today, so a 7-day window covers today plus the
  // previous 6 days.
  const fromDate = dayKeyDaysAgo(Math.max(0, windowDays - 1));
  const match = { guildId, date: { $gte: fromDate } };

  const [byCommand, byDay] = await Promise.all([
    CommandMetrics.aggregate<RawCommandGroup>([
      { $match: match },
      {
        $group: {
          _id: "$command",
          usageCount: { $sum: "$usageCount" },
          errorCount: { $sum: "$errorCount" },
          totalResponseMs: { $sum: "$totalResponseMs" },
          lastUsedAt: { $max: "$lastUsedAt" },
        },
      },
      { $sort: { usageCount: -1, _id: 1 } },
    ]),
    CommandMetrics.aggregate<RawDailyGroup>([
      { $match: match },
      {
        $group: {
          _id: "$date",
          usageCount: { $sum: "$usageCount" },
          errorCount: { $sum: "$errorCount" },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const rows: CommandMetricSummaryRow[] = byCommand.map((g) => {
    const usageCount = g.usageCount ?? 0;
    const errorCount = g.errorCount ?? 0;
    const totalResponseMs = g.totalResponseMs ?? 0;
    return {
      command: g._id,
      usageCount,
      errorCount,
      errorRate: usageCount > 0 ? errorCount / usageCount : 0,
      avgResponseMs: usageCount > 0 ? totalResponseMs / usageCount : 0,
      totalResponseMs,
      lastUsedAt: g.lastUsedAt ? new Date(g.lastUsedAt).toISOString() : null,
    };
  });

  const dailyTotals: CommandMetricsDailyTotal[] = byDay.map((g) => ({
    date: g._id,
    usageCount: g.usageCount ?? 0,
    errorCount: g.errorCount ?? 0,
  }));

  const totalUsage = rows.reduce((sum, r) => sum + r.usageCount, 0);
  const totalErrors = rows.reduce((sum, r) => sum + r.errorCount, 0);

  return {
    windowDays,
    fromDate,
    rows,
    dailyTotals,
    totalUsage,
    totalErrors,
  };
}
