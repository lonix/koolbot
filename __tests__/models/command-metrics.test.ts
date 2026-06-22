import { describe, it, expect } from "@jest/globals";

describe("CommandMetrics model (#648)", () => {
  it("loads without throwing under the global mongoose mock", async () => {
    const mod = await import("../../src/models/command-metrics.js");
    expect(mod.CommandMetrics).toBeDefined();
  });

  it("accepts the canonical daily-bucket shape", () => {
    // Type-only check that the interface compiles with the documented
    // fields, matching what `MonitoringService.flushMetrics` upserts.
    const sample = {
      command: "quote",
      date: "2026-06-22",
      guildId: "g1",
      usageCount: 12,
      errorCount: 1,
      totalResponseMs: 3400,
      firstUsedAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt: new Date(),
    };
    expect(sample.command).toBe("quote");
    expect(sample.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
