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

jest.unstable_mockModule("cron", () => ({
  CronJob: class {
    start(): void {}
    stop(): void {}
  },
}));

const { WebAuditLogCleanupService } = await import(
  "../../src/services/web-audit-cleanup.js"
);

describe("WebAuditLogCleanupService", () => {
  beforeEach(() => {
    WebAuditLogCleanupService.reset();
    mockGetNumber.mockReset();
    mockDeleteMany.mockReset();
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
