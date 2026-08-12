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

jest.unstable_mockModule("cron", () => ({
  CronJob: class {
    start(): void {}
    stop(): void {}
  },
}));

const { ModerationLogCleanupService } = await import(
  "../../src/services/moderation-log-cleanup.js"
);

describe("ModerationLogCleanupService", () => {
  beforeEach(() => {
    ModerationLogCleanupService.reset();
    mockGetBoolean.mockReset();
    mockGetNumber.mockReset();
    mockDeleteMany.mockReset();
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
