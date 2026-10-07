import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockGetNumber = jest.fn<(key: string, def: number) => Promise<number>>();
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: jest.fn(),
      getNumber: mockGetNumber,
      registerReloadCallback: jest.fn(),
    })),
  },
}));
const mockDeleteMany =
  jest.fn<(f: Record<string, unknown>) => Promise<{ deletedCount: number }>>();
jest.unstable_mockModule("../../src/models/adoption-snapshot.js", () => ({
  AdoptionSnapshot: { deleteMany: mockDeleteMany },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
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

const { AdoptionSnapshotCleanupService } =
  await import("../../src/services/adoption-snapshot-cleanup.js");
const client = {};
const svc = () => AdoptionSnapshotCleanupService.getInstance(client as never);

describe("AdoptionSnapshotCleanupService", () => {
  beforeEach(() => {
    AdoptionSnapshotCleanupService.reset();
    mockGetNumber.mockReset();
    mockDeleteMany.mockReset();
    cronExpressions.length = 0;
  });

  it("arms a daily job at 04:00 with no enable gate", async () => {
    await svc().start();
    expect(cronExpressions).toEqual(["0 4 * * *"]);
  });

  it("prunes finished snapshots older than the retention", async () => {
    mockGetNumber.mockResolvedValue(30);
    mockDeleteMany.mockResolvedValue({ deletedCount: 4 });
    expect(await svc().runCleanup()).toEqual({ deleted: 4 });
    const filter = mockDeleteMany.mock.calls[0][0] as {
      createdAt: { $lt: Date };
      status: unknown;
    };
    expect(filter.status).toEqual({ $ne: "applying" });
    const ageDays = (Date.now() - filter.createdAt.$lt.getTime()) / 86_400_000;
    expect(Math.round(ageDays)).toBe(30);
  });

  it("keeps everything when retention is 0 or negative", async () => {
    mockGetNumber.mockResolvedValue(0);
    expect(await svc().runCleanup()).toBeNull();
    mockGetNumber.mockResolvedValue(-1);
    expect(await svc().runCleanup()).toBeNull();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("returns null when the delete fails", async () => {
    mockGetNumber.mockResolvedValue(30);
    mockDeleteMany.mockRejectedValue(new Error("db"));
    expect(await svc().runCleanup()).toBeNull();
  });
});
