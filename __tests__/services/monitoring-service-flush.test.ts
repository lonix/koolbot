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
const mockFindOneAndUpdate =
  jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule("../../src/models/command-metrics.js", () => ({
  CommandMetrics: { findOneAndUpdate: mockFindOneAndUpdate },
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
const { MonitoringService } = await import(
  "../../src/services/monitoring-service.js"
);

describe("MonitoringService — metrics persistence (#648)", () => {
  let service: InstanceType<typeof MonitoringService>;

  beforeEach(() => {
    jest.useFakeTimers();
    (MonitoringService as unknown as { instance: unknown }).instance =
      undefined;
    mockFindOneAndUpdate.mockReset().mockResolvedValue(null);
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
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("only buffers invocations that carry a guildId", async () => {
    // No guildId → in-memory only, nothing to persist.
    service.trackCommandStart("ping");
    service.trackCommandEnd("ping", "tid", Date.now() - 10, true);
    await service.flushMetrics();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("batches accumulated counters into a single upsert per bucket", async () => {
    service.trackCommandStart("quote");
    service.trackCommandEnd("quote", "t1", Date.now() - 100, true, "guild-1");
    service.trackCommandEnd("quote", "t2", Date.now() - 50, false, "guild-1");

    await service.flushMetrics();

    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = mockFindOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, Record<string, unknown>>,
      Record<string, unknown>,
    ];
    expect(filter.command).toBe("quote");
    expect(filter.guildId).toBe("guild-1");
    expect(typeof filter.date).toBe("string");
    expect(update.$inc.usageCount).toBe(2);
    expect(update.$inc.errorCount).toBe(1);
    expect(update.$inc.totalResponseMs as number).toBeGreaterThan(0);
    expect(update.$min.firstUsedAt).toBeInstanceOf(Date);
    expect(update.$max.lastUsedAt).toBeInstanceOf(Date);
    expect(update.$max.expiresAt).toBeInstanceOf(Date);
    expect(options.upsert).toBe(true);

    // The expiry anchor sits ~retentionDays after lastUsedAt.
    const last = update.$max.lastUsedAt as Date;
    const expires = update.$max.expiresAt as Date;
    const deltaDays = (expires.getTime() - last.getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(deltaDays)).toBe(30);
  });

  it("clears the buffer after a successful flush", async () => {
    service.trackCommandEnd("quote", "t1", Date.now() - 10, true, "guild-1");
    await service.flushMetrics();
    mockFindOneAndUpdate.mockClear();
    await service.flushMetrics();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("skips writing while the DB is disconnected and keeps the buffer", async () => {
    mongoose.connection.readyState = 0;
    service.trackCommandEnd("quote", "t1", Date.now() - 10, true, "guild-1");
    await service.flushMetrics();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();

    // Reconnect — the buffered counts should now flush.
    mongoose.connection.readyState = 1;
    await service.flushMetrics();
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("drops the buffer when persistence is disabled", async () => {
    mockGetBoolean.mockResolvedValue(false);
    service.trackCommandEnd("quote", "t1", Date.now() - 10, true, "guild-1");
    await service.flushMetrics();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();

    // Re-enable: nothing should remain to flush.
    mockGetBoolean.mockResolvedValue(true);
    await service.flushMetrics();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("re-queues a bucket when its write fails", async () => {
    mockFindOneAndUpdate.mockRejectedValueOnce(new Error("mongo down"));
    service.trackCommandEnd("quote", "t1", Date.now() - 10, true, "guild-1");

    await service.flushMetrics();
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);

    // The failed batch was re-buffered, so a retry writes it again.
    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    await service.flushMetrics();
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });
});
