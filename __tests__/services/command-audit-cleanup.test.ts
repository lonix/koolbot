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

jest.unstable_mockModule(
  "../../src/models/discord-command-audit-log.js",
  () => ({
    DiscordCommandAuditLog: { deleteMany: mockDeleteMany },
  }),
);

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

const { CommandAuditCleanupService } =
  await import("../../src/services/command-audit-cleanup.js");

describe("CommandAuditCleanupService", () => {
  beforeEach(() => {
    CommandAuditCleanupService.reset();
    mockGetBoolean.mockReset();
    mockGetNumber.mockReset();
    mockDeleteMany.mockReset();
  });

  it("is a no-op when audit logging is disabled", async () => {
    mockGetBoolean.mockResolvedValue(false);
    const service = CommandAuditCleanupService.getInstance();
    const result = await service.runCleanup();
    expect(result).toBeNull();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("is a no-op when retention is non-positive", async () => {
    mockGetBoolean.mockResolvedValue(true);
    mockGetNumber.mockResolvedValue(0);
    const result = await CommandAuditCleanupService.getInstance().runCleanup();
    expect(result).toBeNull();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes rows older than the configured retention window", async () => {
    mockGetBoolean.mockResolvedValue(true);
    mockGetNumber.mockResolvedValue(7);
    mockDeleteMany.mockResolvedValue({ deletedCount: 3 });

    const before = Date.now();
    const result = await CommandAuditCleanupService.getInstance().runCleanup();
    const after = Date.now();

    expect(result).toEqual({ deleted: 3 });
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
    mockGetBoolean.mockResolvedValue(true);
    mockGetNumber.mockResolvedValue(30);
    mockDeleteMany.mockRejectedValueOnce(new Error("mongo down"));
    const result = await CommandAuditCleanupService.getInstance().runCleanup();
    expect(result).toBeNull();
  });
});
