import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockGetBoolean =
  jest.fn<(key: string, def: boolean) => Promise<boolean>>();
const mockGetNumber = jest.fn<(key: string, def: number) => Promise<number>>();
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getNumber: mockGetNumber,
      registerReloadCallback: jest.fn(),
    })),
  },
}));

const mockDeleteMany = jest.fn<() => Promise<{ deletedCount: number }>>();
jest.unstable_mockModule("../../src/models/user-name-history.js", () => ({
  UserNameHistory: { deleteMany: mockDeleteMany },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Keep the real `CronTime` so the expression is validated for real; only
// `CronJob` is stubbed so no live timer is armed.
const { CronTime } = await import("cron");
const cronExpressions: string[] = [];
jest.unstable_mockModule("cron", () => ({
  CronTime,
  CronJob: class {
    constructor(expression: string) {
      cronExpressions.push(expression);
    }
    start(): void {}
    stop(): void {}
    nextDate(): Date {
      return new Date();
    }
  },
}));

const { NameHistoryCleanupService } =
  await import("../../src/services/name-history-cleanup.js");

let client: object = {};
const svc = (): InstanceType<typeof NameHistoryCleanupService> =>
  NameHistoryCleanupService.getInstance(client as never);

describe("NameHistoryCleanupService", () => {
  beforeEach(() => {
    NameHistoryCleanupService.reset();
    client = {};
    mockGetBoolean.mockReset();
    mockGetNumber.mockReset();
    mockDeleteMany.mockReset();
    cronExpressions.length = 0;
  });

  it("schedules a daily job at 03:45 when enabled", async () => {
    mockGetBoolean.mockResolvedValue(true);
    await svc().start();
    expect(cronExpressions).toEqual(["45 3 * * *"]);
  });

  it("does not arm the job while name history is disabled", async () => {
    mockGetBoolean.mockResolvedValue(false);
    await svc().start();
    expect(cronExpressions).toEqual([]);
  });

  it("is a no-op when name history is disabled", async () => {
    mockGetBoolean.mockResolvedValue(false);
    expect(await svc().runCleanup()).toBeNull();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("keeps everything when retention is 0", async () => {
    mockGetBoolean.mockResolvedValue(true);
    mockGetNumber.mockResolvedValue(0);
    expect(await svc().runCleanup()).toBeNull();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("prunes rows whose lastSeenAt is older than the window", async () => {
    mockGetBoolean.mockResolvedValue(true);
    mockGetNumber.mockResolvedValue(30);
    mockDeleteMany.mockResolvedValue({ deletedCount: 4 });
    const result = await svc().runCleanup();
    expect(result).toEqual({ deleted: 4 });
    const arg = (mockDeleteMany.mock.calls[0] as unknown[])[0] as {
      lastSeenAt: { $lt: Date };
    };
    const ageDays = (Date.now() - arg.lastSeenAt.$lt.getTime()) / 86_400_000;
    expect(Math.round(ageDays)).toBe(30);
  });
});
