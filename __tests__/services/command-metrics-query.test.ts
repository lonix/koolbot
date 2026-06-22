import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockAggregate = jest.fn<(pipeline: unknown[]) => Promise<unknown[]>>();
jest.unstable_mockModule("../../src/models/command-metrics.js", () => ({
  CommandMetrics: { aggregate: mockAggregate },
}));

const { getCommandMetricsSummary, dayKeyDaysAgo } =
  await import("../../src/services/command-metrics-query.js");

describe("getCommandMetricsSummary (#648)", () => {
  beforeEach(() => {
    mockAggregate.mockReset();
  });

  it("matches the guild and a window-bounded date range", async () => {
    mockAggregate.mockResolvedValue([]);
    await getCommandMetricsSummary("guild-1", 7);

    expect(mockAggregate).toHaveBeenCalledTimes(2);
    const pipeline = mockAggregate.mock.calls[0]?.[0] as Array<{
      $match?: { guildId: string; date: { $gte: string } };
    }>;
    const match = pipeline[0]?.$match;
    expect(match?.guildId).toBe("guild-1");
    // A 7-day window is inclusive of today, so the lower bound is 6 days ago.
    expect(match?.date.$gte).toBe(dayKeyDaysAgo(6));
  });

  it("derives error rate and average response time per command", async () => {
    mockAggregate
      .mockResolvedValueOnce([
        {
          _id: "quote",
          usageCount: 10,
          errorCount: 2,
          totalResponseMs: 1000,
          lastUsedAt: new Date("2026-06-20T12:00:00Z"),
        },
        {
          _id: "ping",
          usageCount: 4,
          errorCount: 0,
          totalResponseMs: 200,
          lastUsedAt: new Date("2026-06-21T08:00:00Z"),
        },
      ])
      .mockResolvedValueOnce([
        { _id: "2026-06-20", usageCount: 8, errorCount: 2 },
        { _id: "2026-06-21", usageCount: 6, errorCount: 0 },
      ]);

    const summary = await getCommandMetricsSummary("guild-1", 30);

    expect(summary.rows).toHaveLength(2);
    const quote = summary.rows[0];
    expect(quote.command).toBe("quote");
    expect(quote.errorRate).toBeCloseTo(0.2);
    expect(quote.avgResponseMs).toBe(100);
    expect(quote.lastUsedAt).toBe("2026-06-20T12:00:00.000Z");

    const ping = summary.rows[1];
    expect(ping.errorRate).toBe(0);
    expect(ping.avgResponseMs).toBe(50);

    expect(summary.totalUsage).toBe(14);
    expect(summary.totalErrors).toBe(2);
    expect(summary.dailyTotals).toEqual([
      { date: "2026-06-20", usageCount: 8, errorCount: 2 },
      { date: "2026-06-21", usageCount: 6, errorCount: 0 },
    ]);
  });

  it("guards against divide-by-zero for empty buckets", async () => {
    mockAggregate
      .mockResolvedValueOnce([
        {
          _id: "idle",
          usageCount: 0,
          errorCount: 0,
          totalResponseMs: 0,
          lastUsedAt: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const summary = await getCommandMetricsSummary("guild-1", 30);
    expect(summary.rows[0].errorRate).toBe(0);
    expect(summary.rows[0].avgResponseMs).toBe(0);
    expect(summary.rows[0].lastUsedAt).toBeNull();
  });
});
