import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockGetNumber = jest.fn<(key: string, def: number) => Promise<number>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getNumber: mockGetNumber,
    })),
  },
}));

const mockDeleteMany = jest.fn<() => Promise<{ deletedCount: number }>>();

jest.unstable_mockModule("../../src/models/web-audit-log.js", () => ({
  WebAuditLog: { deleteMany: mockDeleteMany },
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

const { WebAuditLogCleanupService } =
  await import("../../src/services/web-audit-cleanup.js");

describe("WebAuditLogCleanupService", () => {
  beforeEach(() => {
    WebAuditLogCleanupService.reset();
    mockGetNumber.mockReset();
    mockDeleteMany.mockReset();
    cronInstances.length = 0;
  });

  it("schedules a daily job at 03:15 and start() is idempotent", () => {
    const service = WebAuditLogCleanupService.getInstance();
    service.start();
    expect(cronInstances).toHaveLength(1);
    expect(cronInstances[0]?.expression).toBe("15 3 * * *");
    expect(cronInstances[0]?.started).toBe(true);
    // A second start() while a job exists must not schedule a duplicate.
    service.start();
    expect(cronInstances).toHaveLength(1);
  });

  it("destroy() stops the scheduled job and allows a later restart", () => {
    const service = WebAuditLogCleanupService.getInstance();
    service.start();
    service.destroy();
    expect(cronInstances[0]?.stopped).toBe(true);
    service.start();
    expect(cronInstances).toHaveLength(2);
    expect(cronInstances[1]?.started).toBe(true);
  });

  it("is a no-op when retention is zero (keep forever)", async () => {
    mockGetNumber.mockResolvedValue(0);
    const result = await WebAuditLogCleanupService.getInstance().runCleanup();
    expect(result).toBeNull();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("is a no-op when retention is negative", async () => {
    mockGetNumber.mockResolvedValue(-1);
    const result = await WebAuditLogCleanupService.getInstance().runCleanup();
    expect(result).toBeNull();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes rows older than the configured retention window", async () => {
    mockGetNumber.mockResolvedValue(7);
    mockDeleteMany.mockResolvedValue({ deletedCount: 4 });

    const before = Date.now();
    const result = await WebAuditLogCleanupService.getInstance().runCleanup();
    const after = Date.now();

    expect(result).toEqual({ deleted: 4 });
    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    const arg = mockDeleteMany.mock.calls[0]?.[0] as {
      createdAt: { $lt: Date };
    };
    const cutoff = arg.createdAt.$lt.getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // Cutoff is "now - 7d" computed inside the service; allow for the
    // tiny wall-clock drift between the test's bounds and the service call.
    expect(cutoff).toBeGreaterThanOrEqual(before - sevenDaysMs);
    expect(cutoff).toBeLessThanOrEqual(after - sevenDaysMs);
  });

  it("returns null and swallows DB errors", async () => {
    mockGetNumber.mockResolvedValue(30);
    mockDeleteMany.mockRejectedValueOnce(new Error("mongo down"));
    const result = await WebAuditLogCleanupService.getInstance().runCleanup();
    expect(result).toBeNull();
  });
});
