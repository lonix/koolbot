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

// Cases (#908) decide what the log prune must leave alone.
const mockCaseDeleteMany = jest.fn<() => Promise<{ deletedCount: number }>>();
const mockCaseDistinct =
  jest.fn<(field: string, filter: unknown) => Promise<unknown[]>>();
const mockCaseFind = jest.fn<(filter: unknown) => unknown>();
let protectedCases: Array<{ guildId: string; userId: string }> = [];

jest.unstable_mockModule("../../src/models/moderation-case.js", () => ({
  ModerationCase: {
    deleteMany: mockCaseDeleteMany,
    distinct: mockCaseDistinct,
    find: mockCaseFind,
  },
  LIVE_CASE_STATUSES: ["open", "under_review"],
  TERMINAL_CASE_STATUSES: ["upheld", "lifted", "expired"],
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
    mockCaseDeleteMany.mockReset();
    mockCaseDistinct.mockReset();
    mockCaseFind.mockReset();
    protectedCases = [];
    mockCaseDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockCaseDistinct.mockResolvedValue([]);
    mockCaseFind.mockImplementation(() => {
      const q: Record<string, unknown> = {};
      q.select = jest.fn(() => q);
      q.lean = jest.fn(() => q);
      q.exec = jest.fn(async () => protectedCases);
      return q;
    });
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
    expect(mockCaseDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes rows older than the configured retention window", async () => {
    mockGetBoolean.mockResolvedValue(true);
    mockGetNumber.mockImplementation(async (key, def) =>
      key === "moderation.retention_days" ? 365 : def,
    );
    mockDeleteMany.mockResolvedValue({ deletedCount: 12 });

    const before = Date.now();
    const result = await ModerationLogCleanupService.getInstance().runCleanup();
    const after = Date.now();

    expect(result).toEqual({ deleted: 12, casesDeleted: 0 });
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

  describe("moderation cases (#908)", () => {
    const DAY = 24 * 60 * 60 * 1000;

    function config(values: Record<string, number>): void {
      mockGetBoolean.mockResolvedValue(true);
      mockGetNumber.mockImplementation(async (key, def) =>
        key in values ? values[key] : def,
      );
    }

    function logFilter(): Record<string, any> {
      return mockDeleteMany.mock.calls[0]?.[0] as Record<string, any>;
    }

    it("adds no exemption to the log prune while there are no cases", async () => {
      config({ "moderation.retention_days": 365 });
      mockDeleteMany.mockResolvedValue({ deletedCount: 0 });
      await ModerationLogCleanupService.getInstance().runCleanup();
      expect(Object.keys(logFilter()).sort()).toEqual(["createdAt"]);
    });

    it("never prunes an entry a case references (a day-1 kick reviewed at day 400)", async () => {
      config({ "moderation.retention_days": 365 });
      mockCaseDistinct.mockImplementation(async (field) =>
        field === "originEntryId" ? ["kick-entry"] : [],
      );
      mockDeleteMany.mockResolvedValue({ deletedCount: 0 });
      await ModerationLogCleanupService.getInstance().runCleanup();

      // The kick is 365+ days old, so the cutoff alone would delete it;
      // the case's reference is what keeps it.
      expect(logFilter().createdAt.$lt).toBeInstanceOf(Date);
      expect(logFilter()._id).toEqual({ $nin: ["kick-entry"] });
      expect(mockCaseDistinct).toHaveBeenCalledWith("originEntryId", {});
    });

    it("also protects the entry that resolved a case", async () => {
      config({ "moderation.retention_days": 365 });
      mockCaseDistinct.mockImplementation(async (field) =>
        field === "resolutionEntryId" ? ["unban-entry"] : [],
      );
      mockDeleteMany.mockResolvedValue({ deletedCount: 0 });
      await ModerationLogCleanupService.getInstance().runCleanup();
      expect(logFilter()._id).toEqual({ $nin: ["unban-entry"] });
    });

    it("keeps a protected member's unrelated history, once per member", async () => {
      config({ "moderation.retention_days": 365 });
      protectedCases = [
        { guildId: "g1", userId: "u1" },
        { guildId: "g1", userId: "u1" },
        { guildId: "g2", userId: "u1" },
      ];
      mockDeleteMany.mockResolvedValue({ deletedCount: 0 });
      await ModerationLogCleanupService.getInstance().runCleanup();
      expect(logFilter().$nor).toEqual([
        { guildId: "g1", userId: "u1" },
        { guildId: "g2", userId: "u1" },
      ]);
    });

    it("protects members with a live case or one resolved inside the grace window", async () => {
      config({
        "moderation.retention_days": 365,
        "moderation.cases.history_grace_days": 30,
      });
      mockDeleteMany.mockResolvedValue({ deletedCount: 0 });
      const before = Date.now();
      await ModerationLogCleanupService.getInstance().runCleanup();

      const filter = mockCaseFind.mock.calls[0]?.[0] as {
        $or: Array<Record<string, any>>;
      };
      expect(filter.$or[0]).toEqual({
        status: { $in: ["open", "under_review"] },
      });
      // A case resolved beyond the window matches neither branch, so its
      // member's history prunes normally.
      const since = filter.$or[1].updatedAt.$gte.getTime();
      expect(since).toBeGreaterThanOrEqual(before - 30 * DAY - 1000);
      expect(since).toBeLessThanOrEqual(Date.now() - 30 * DAY);
    });

    it("protects every case's member when the grace window is 0", async () => {
      config({
        "moderation.retention_days": 365,
        "moderation.cases.history_grace_days": 0,
      });
      mockDeleteMany.mockResolvedValue({ deletedCount: 0 });
      await ModerationLogCleanupService.getInstance().runCleanup();
      expect(mockCaseFind.mock.calls[0]?.[0]).toEqual({});
    });

    it("keeps cases forever by default and prunes resolved ones from their last decision", async () => {
      config({ "moderation.retention_days": 365 });
      mockDeleteMany.mockResolvedValue({ deletedCount: 0 });
      await ModerationLogCleanupService.getInstance().runCleanup();
      expect(mockCaseDeleteMany).not.toHaveBeenCalled();

      config({
        "moderation.retention_days": 365,
        "moderation.cases.retention_days": 90,
      });
      mockCaseDeleteMany.mockResolvedValue({ deletedCount: 2 });
      const result =
        await ModerationLogCleanupService.getInstance().runCleanup();
      expect(result).toEqual({ deleted: 0, casesDeleted: 2 });

      const filter = mockCaseDeleteMany.mock.calls[0]?.[0] as Record<
        string,
        any
      >;
      // Terminal only: a live case is the queue and is never pruned. Measured
      // from the last decision, not from when the case was opened.
      expect(filter.status).toEqual({ $in: ["upheld", "lifted", "expired"] });
      expect(filter.updatedAt.$lt).toBeInstanceOf(Date);
      expect(filter.openedAt).toBeUndefined();
    });

    it("prunes cases on their own rule even when the log is kept forever", async () => {
      config({
        "moderation.retention_days": 0,
        "moderation.cases.retention_days": 90,
      });
      mockCaseDeleteMany.mockResolvedValue({ deletedCount: 1 });
      const result =
        await ModerationLogCleanupService.getInstance().runCleanup();
      expect(result).toEqual({ deleted: 0, casesDeleted: 1 });
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });

    it("prunes cases before reading the exemptions, so a pruned case protects nothing", async () => {
      config({
        "moderation.retention_days": 365,
        "moderation.cases.retention_days": 90,
      });
      const order: string[] = [];
      mockCaseDeleteMany.mockImplementation(async () => {
        order.push("cases");
        return { deletedCount: 1 };
      });
      mockCaseDistinct.mockImplementation(async () => {
        order.push("protect");
        return [];
      });
      mockDeleteMany.mockImplementation(async () => {
        order.push("log");
        return { deletedCount: 0 };
      });
      await ModerationLogCleanupService.getInstance().runCleanup();
      expect(order[0]).toBe("cases");
      expect(order.at(-1)).toBe("log");
    });

    it("stays a no-op while moderation is off, whatever cases exist", async () => {
      mockGetBoolean.mockResolvedValue(false);
      expect(
        await ModerationLogCleanupService.getInstance().runCleanup(),
      ).toBeNull();
      expect(mockCaseDeleteMany).not.toHaveBeenCalled();
      expect(mockDeleteMany).not.toHaveBeenCalled();
    });
  });
});
