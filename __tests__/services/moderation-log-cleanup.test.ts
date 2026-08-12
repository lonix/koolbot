import { describe, it, expect, beforeEach, jest } from "@jest/globals";

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

const mockDeleteMany = jest.fn<() => Promise<{ deletedCount: number }>>();

jest.unstable_mockModule("../../src/models/moderation-log.js", () => ({
  ModerationLog: { deleteMany: mockDeleteMany },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Observable CronJob mock: records every constructed job so the tests can
// assert on the schedule expression and start/stop lifecycle.
interface MockCronJob {
  expression: string;
  started: boolean;
  stopped: boolean;
}
const cronInstances: MockCronJob[] = [];

jest.unstable_mockModule("cron", () => ({
  CronJob: class implements MockCronJob {
    expression: string;
    started = false;
    stopped = false;
    constructor(expression: string) {
      this.expression = expression;
      cronInstances.push(this);
    }
    start(): void {
      this.started = true;
    }
    stop(): void {
      this.stopped = true;
    }
  },
}));

const { ModerationLogCleanupService } =
  await import("../../src/services/moderation-log-cleanup.js");

describe("ModerationLogCleanupService", () => {
  beforeEach(() => {
    ModerationLogCleanupService.reset();
    mockGetBoolean.mockReset();
    mockGetNumber.mockReset();
    mockDeleteMany.mockReset();
    cronInstances.length = 0;
  });

  it("schedules a daily job at 03:30 and start() is idempotent", () => {
    const service = ModerationLogCleanupService.getInstance();
    service.start();
    expect(cronInstances).toHaveLength(1);
    expect(cronInstances[0]?.expression).toBe("30 3 * * *");
    expect(cronInstances[0]?.started).toBe(true);
    // A second start() while a job exists must not schedule a duplicate.
    service.start();
    expect(cronInstances).toHaveLength(1);
  });

  it("destroy() stops the scheduled job and allows a later restart", () => {
    const service = ModerationLogCleanupService.getInstance();
    service.start();
    service.destroy();
    expect(cronInstances[0]?.stopped).toBe(true);
    service.start();
    expect(cronInstances).toHaveLength(2);
    expect(cronInstances[1]?.started).toBe(true);
  });

  it("is a no-op when the moderation feature is disabled", async () => {
    mockGetBoolean.mockResolvedValue(false);
    const service = ModerationLogCleanupService.getInstance();
    const result = await service.runCleanup();
    expect(result).toBeNull();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("is a no-op when retention is non-positive (keep forever)", async () => {
    mockGetBoolean.mockResolvedValue(true);
    mockGetNumber.mockResolvedValue(0);
    const result = await ModerationLogCleanupService.getInstance().runCleanup();
    expect(result).toBeNull();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes rows older than the configured retention window", async () => {
    mockGetBoolean.mockResolvedValue(true);
    mockGetNumber.mockResolvedValue(365);
    mockDeleteMany.mockResolvedValue({ deletedCount: 12 });

    const before = Date.now();
    const result = await ModerationLogCleanupService.getInstance().runCleanup();
    const after = Date.now();

    expect(result).toEqual({ deleted: 12 });
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    const arg = mockDeleteMany.mock.calls[0]?.[0] as {
      createdAt: { $lt: Date };
    };
    const cutoff = arg.createdAt.$lt.getTime();
    const retentionMs = 365 * 24 * 60 * 60 * 1000;
    // Cutoff is "now - 365d" computed inside the service; allow for the
    // tiny wall-clock drift between the test's bounds and the service call.
    expect(cutoff).toBeGreaterThanOrEqual(before - retentionMs);
    expect(cutoff).toBeLessThanOrEqual(after - retentionMs);
  });

  it("returns null and swallows DB errors", async () => {
    mockGetBoolean.mockResolvedValue(true);
    mockGetNumber.mockResolvedValue(30);
    mockDeleteMany.mockRejectedValueOnce(new Error("mongo down"));
    const result = await ModerationLogCleanupService.getInstance().runCleanup();
    expect(result).toBeNull();
  });
});
