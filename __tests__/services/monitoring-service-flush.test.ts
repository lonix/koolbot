import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

// Mock the persisted-metrics model so we can assert on the batched upserts
// without a real Mongo connection (issue #648).
const mockBulkWrite = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule("../../src/models/command-metrics.js", () => ({
  CommandMetrics: { bulkWrite: mockBulkWrite },
}));

const mockGetBoolean =
  jest.fn<(key: string, def: boolean) => Promise<boolean>>();
const mockGetNumber = jest.fn<(key: string, def: number) => Promise<number>>();
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getNumber: mockGetNumber,
    })),
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mongoose = (await import("mongoose")).default as unknown as {
  connection: { readyState: number };
};
const { MonitoringService, MAX_PENDING_BUCKETS } =
  await import("../../src/services/monitoring-service.js");

describe("MonitoringService — metrics persistence (#648)", () => {
  let service: InstanceType<typeof MonitoringService>;

  beforeEach(() => {
    jest.useFakeTimers();
    (MonitoringService as unknown as { instance: unknown }).instance =
      undefined;
    mockBulkWrite.mockReset().mockResolvedValue(null);
    mockGetBoolean.mockReset().mockResolvedValue(true);
    mockGetNumber.mockReset().mockResolvedValue(30);
    mongoose.connection.readyState = 1;
    service = MonitoringService.getInstance();
  });

  afterEach(() => {
    service.destroy();
    (MonitoringService as unknown as { instance: unknown }).instance =
      undefined;
    jest.useRealTimers();
  });

  it("does not write when there is nothing pending", async () => {
    await service.flushMetrics();
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("only buffers invocations that carry a guildId", async () => {
    // No guildId → in-memory only, nothing to persist.
    service.trackCommandStart("ping");
    service.trackCommandEnd("ping", "tid", Date.now() - 10, true);
    await service.flushMetrics();
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("writes one bulk batch with an upsert op per bucket", async () => {
    service.trackCommandStart("quote");
    service.trackCommandEnd("quote", "t1", Date.now() - 100, true, "guild-1");
    service.trackCommandEnd("quote", "t2", Date.now() - 50, false, "guild-1");
    service.trackCommandEnd("ping", "t3", Date.now() - 5, true, "guild-1");

    await service.flushMetrics();

    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
    const [ops, options] = mockBulkWrite.mock.calls[0] as [
      Array<{
        updateOne: {
          filter: Record<string, unknown>;
          update: Record<string, Record<string, unknown>>;
          upsert: boolean;
        };
      }>,
      Record<string, unknown>,
    ];
    expect(options.ordered).toBe(false);
    // Two distinct commands → two upsert ops; the two quote calls merged.
    expect(ops).toHaveLength(2);

    const quoteOp = ops.find((o) => o.updateOne.filter.command === "quote")!;
    expect(quoteOp.updateOne.filter.guildId).toBe("guild-1");
    expect(typeof quoteOp.updateOne.filter.date).toBe("string");
    expect(quoteOp.updateOne.upsert).toBe(true);
    const update = quoteOp.updateOne.update;
    expect(update.$inc.usageCount).toBe(2);
    expect(update.$inc.errorCount).toBe(1);
    expect(update.$inc.totalResponseMs as number).toBeGreaterThan(0);
    expect(update.$min.firstUsedAt).toBeInstanceOf(Date);
    expect(update.$max.lastUsedAt).toBeInstanceOf(Date);
    expect(update.$max.expiresAt).toBeInstanceOf(Date);

    // The expiry anchor sits ~retentionDays after lastUsedAt.
    const last = update.$max.lastUsedAt as Date;
    const expires = update.$max.expiresAt as Date;
    const deltaDays =
      (expires.getTime() - last.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(deltaDays)).toBe(30);
  });

  it("clears the buffer after a successful flush", async () => {
    service.trackCommandEnd("quote", "t1", Date.now() - 10, true, "guild-1");
    await service.flushMetrics();
    mockBulkWrite.mockClear();
    await service.flushMetrics();
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("skips writing while the DB is disconnected and keeps the buffer", async () => {
    mongoose.connection.readyState = 0;
    service.trackCommandEnd("quote", "t1", Date.now() - 10, true, "guild-1");
    await service.flushMetrics();
    expect(mockBulkWrite).not.toHaveBeenCalled();

    // Reconnect — the buffered counts should now flush.
    mongoose.connection.readyState = 1;
    await service.flushMetrics();
    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
  });

  it("drops the buffer when persistence is disabled", async () => {
    mockGetBoolean.mockResolvedValue(false);
    service.trackCommandEnd("quote", "t1", Date.now() - 10, true, "guild-1");
    await service.flushMetrics();
    expect(mockBulkWrite).not.toHaveBeenCalled();

    // Re-enable: nothing should remain to flush.
    mockGetBoolean.mockResolvedValue(true);
    await service.flushMetrics();
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("re-queues the batch when the write fails", async () => {
    mockBulkWrite.mockRejectedValueOnce(new Error("mongo down"));
    service.trackCommandEnd("quote", "t1", Date.now() - 10, true, "guild-1");

    await service.flushMetrics();
    expect(mockBulkWrite).toHaveBeenCalledTimes(1);

    // The failed batch was re-buffered, so a retry writes it again.
    mockBulkWrite.mockResolvedValueOnce(null);
    await service.flushMetrics();
    expect(mockBulkWrite).toHaveBeenCalledTimes(2);
  });

  it("caps the pending buffer so a DB outage can't grow it without bound", () => {
    // Pre-fill the buffer to its cap directly (cheaper than driving
    // MAX_PENDING_BUCKETS real invocations), then prove new buckets are
    // shed while merges into existing buckets still apply.
    const map = (service as unknown as { pendingBuckets: Map<string, unknown> })
      .pendingBuckets;
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    // Mirror the service's internal `${guildId}<NUL>${command}<NUL>${date}`
    // key so a merge actually finds the pre-seeded bucket.
    const key = (cmd: string): string => `g\u0000${cmd}\u0000${dateKey}`;
    for (let i = 0; i < MAX_PENDING_BUCKETS; i++) {
      map.set(key(`cmd${i}`), {
        command: `cmd${i}`,
        guildId: "g",
        date: dateKey,
        usageCount: 1,
        errorCount: 0,
        totalResponseMs: 1,
        firstUsedAt: now,
        lastUsedAt: now,
      });
    }
    expect(map.size).toBe(MAX_PENDING_BUCKETS);

    // A brand-new bucket is dropped at the cap.
    service.trackCommandEnd("brand-new", "t", Date.now() - 1, true, "g");
    expect(map.size).toBe(MAX_PENDING_BUCKETS);

    // But an invocation of an already-tracked bucket still merges.
    const before = (map.get(key("cmd0")) as { usageCount: number }).usageCount;
    service.trackCommandEnd("cmd0", "t", Date.now() - 1, true, "g");
    const after = (map.get(key("cmd0")) as { usageCount: number }).usageCount;
    expect(after).toBe(before + 1);
  });
});
