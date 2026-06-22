import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockFetch = jest.fn<typeof fetch>();
const mockPollItemFindOne = jest.fn();
const mockPollItemCreate = jest.fn();
const mockPollItemFindById = jest.fn();
const mockPollScheduleFindById = jest.fn();
const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetNumber = jest.fn();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: mockRegisterReloadCallback,
      getBoolean: mockConfigGetBoolean,
      getNumber: mockConfigGetNumber,
    })),
  },
}));

jest.unstable_mockModule("../../src/models/poll-item.js", () => ({
  PollItem: {
    findOne: mockPollItemFindOne,
    create: mockPollItemCreate,
    findById: mockPollItemFindById,
  },
}));

jest.unstable_mockModule("../../src/models/poll-schedule.js", () => ({
  PollSchedule: {
    findById: mockPollScheduleFindById,
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

const { PollService } = await import("../../src/services/poll-service.js");

describe("PollService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (PollService as unknown as { instance: unknown }).instance = undefined;
    mockConfigGetBoolean.mockResolvedValue(false);
    mockConfigGetNumber.mockResolvedValue(7);
    mockPollItemFindOne.mockResolvedValue(null);
    mockPollItemCreate.mockResolvedValue({});
    mockPollItemFindById.mockResolvedValue(null);
    mockPollScheduleFindById.mockResolvedValue(null);
    // Imports never touch the network (#646); a stub lets the paste-path tests
    // assert fetch is never called.
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  describe("importFromString (paste/upload path)", () => {
    it("imports a valid pasted YAML library without any network call", async () => {
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        `polls:
  - question: Favorite color?
    answers:
      - Blue
      - Green
    tags: [fun]
`,
        "guild-1",
        "user-1",
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockPollItemFindOne).toHaveBeenCalledWith({
        guildId: "guild-1",
        question: "Favorite color?",
      });
      expect(mockPollItemCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          guildId: "guild-1",
          question: "Favorite color?",
          answers: ["Blue", "Green"],
          tags: ["fun"],
          createdBy: "user-1",
          source: "paste",
        }),
      );
      expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    });

    it("imports a valid pasted JSON library", async () => {
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        JSON.stringify({
          polls: [{ question: "Tea or coffee?", answers: ["Tea", "Coffee"] }],
        }),
        "guild-1",
        "user-1",
      );

      expect(mockPollItemCreate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    });

    it("rejects content larger than the import size cap before parsing", async () => {
      const service = PollService.getInstance({} as never);
      const oversized = "x".repeat(2 * 1024 * 1024 + 1);

      const result = await service.importFromString(
        oversized,
        "guild-1",
        "user-1",
      );

      expect(result).toEqual({
        imported: 0,
        skipped: 0,
        errors: ["Content too large (max 2 MB)"],
      });
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });

    it("reports an invalid-format error for malformed YAML", async () => {
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        "polls:\n  - question: 'unterminated\n",
        "guild-1",
        "user-1",
      );

      expect(result.imported).toBe(0);
      expect(result.errors).toEqual([
        "Invalid format: could not parse content as YAML or JSON",
      ]);
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });

    it("skips a poll whose answer exceeds the 55-character cap", async () => {
      const service = PollService.getInstance({} as never);
      const longAnswer = "a".repeat(56);

      const result = await service.importFromString(
        JSON.stringify({
          polls: [{ question: "Too long?", answers: ["Yes", longAnswer] }],
        }),
        "guild-1",
        "user-1",
      );

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toEqual(["Poll 1: Answer too long (max 55 chars)"]);
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });

    it("rejects a non-string question instead of querying with it (NoSQL injection guard)", async () => {
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        JSON.stringify({
          polls: [{ question: { $ne: null }, answers: ["A", "B"] }],
        }),
        "guild-1",
        "user-1",
      );

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toEqual(["Poll 1: Missing question or answers"]);
      // The operator object must never reach the duplicate-check query.
      expect(mockPollItemFindOne).not.toHaveBeenCalled();
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });

    it("skips a duplicate question that already exists", async () => {
      mockPollItemFindOne.mockResolvedValue({ _id: "existing" });
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        JSON.stringify({
          polls: [{ question: "Existing?", answers: ["A", "B"] }],
        }),
        "guild-1",
        "user-1",
      );

      expect(result).toEqual({ imported: 0, skipped: 1, errors: [] });
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });
  });

  describe("updatePollItem", () => {
    it("changes only the editable fields and preserves usage stats/provenance", async () => {
      const save = jest.fn<() => Promise<void>>().mockResolvedValue();
      const item = {
        _id: { toString: () => "item-1" },
        guildId: "guild-1",
        question: "Old question?",
        answers: ["A", "B"],
        multiSelect: false,
        tags: ["old"],
        usageCount: 7,
        lastUsed: new Date("2026-01-01T00:00:00Z"),
        createdBy: "creator-1",
        source: "manual",
        save,
      };
      mockPollItemFindById.mockResolvedValue(item);
      const service = PollService.getInstance({} as never);

      const result = await service.updatePollItem(
        "item-1",
        {
          question: "New question?",
          answers: ["Yes", "No", "Maybe"],
          multiSelect: true,
          tags: ["new", "fun"],
        },
        "guild-1",
      );

      expect(result).toBe(item);
      expect(save).toHaveBeenCalledTimes(1);
      // Editable fields changed.
      expect(item.question).toBe("New question?");
      expect(item.answers).toEqual(["Yes", "No", "Maybe"]);
      expect(item.multiSelect).toBe(true);
      expect(item.tags).toEqual(["new", "fun"]);
      // Stats and provenance are untouched.
      expect(item.usageCount).toBe(7);
      expect(item.lastUsed).toEqual(new Date("2026-01-01T00:00:00Z"));
      expect(item.createdBy).toBe("creator-1");
      expect(item.source).toBe("manual");
    });

    it("refuses to edit an item belonging to another guild", async () => {
      const save = jest.fn<() => Promise<void>>().mockResolvedValue();
      mockPollItemFindById.mockResolvedValue({
        _id: { toString: () => "item-1" },
        guildId: "other-guild",
        save,
      });
      const service = PollService.getInstance({} as never);

      const result = await service.updatePollItem(
        "item-1",
        { question: "Q?", answers: ["A", "B"], multiSelect: false, tags: [] },
        "guild-1",
      );

      expect(result).toBeNull();
      expect(save).not.toHaveBeenCalled();
    });

    it("returns null when the item does not exist", async () => {
      mockPollItemFindById.mockResolvedValue(null);
      const service = PollService.getInstance({} as never);

      const result = await service.updatePollItem(
        "missing",
        { question: "Q?", answers: ["A", "B"], multiSelect: false, tags: [] },
        "guild-1",
      );

      expect(result).toBeNull();
    });
  });

  describe("updateSchedule", () => {
    it("rejects an invalid cron expression before touching the database", async () => {
      const service = PollService.getInstance({} as never);

      await expect(
        service.updateSchedule(
          "sched-1",
          {
            channelId: "chan-1",
            cronSchedule: "not a cron",
            pollDuration: 12,
            roleIdToPing: null,
          },
          "guild-1",
        ),
      ).rejects.toThrow("Invalid cron expression");
      expect(mockPollScheduleFindById).not.toHaveBeenCalled();
    });

    it("saves the new fields and re-arms the running cron job in place", async () => {
      const save = jest.fn<() => Promise<void>>().mockResolvedValue();
      const schedule = {
        _id: { toString: () => "sched-1" },
        guildId: "guild-1",
        channelId: "old-chan",
        cronSchedule: "0 9 * * *",
        pollDuration: 24,
        roleIdToPing: null as string | null,
        enabled: true,
        save,
      };
      mockPollScheduleFindById.mockResolvedValue(schedule);

      const service = PollService.getInstance({} as never);
      // Simulate a running service with an existing job for this schedule.
      const oldStop = jest.fn();
      const oldJob = { stop: oldStop };
      const internals = service as unknown as {
        isInitialized: boolean;
        jobs: Map<string, { schedule: unknown; job: { stop: () => void } }>;
      };
      internals.isInitialized = true;
      internals.jobs.set("sched-1", {
        schedule,
        job: oldJob,
      });

      const result = await service.updateSchedule(
        "sched-1",
        {
          channelId: "new-chan",
          cronSchedule: "0 12 * * 1",
          pollDuration: 6,
          roleIdToPing: "role-9",
        },
        "guild-1",
      );

      expect(result).toBe(schedule);
      expect(save).toHaveBeenCalledTimes(1);
      expect(schedule.channelId).toBe("new-chan");
      expect(schedule.cronSchedule).toBe("0 12 * * 1");
      expect(schedule.pollDuration).toBe(6);
      expect(schedule.roleIdToPing).toBe("role-9");
      // Old job stopped, a fresh job armed in its place (a different object).
      expect(oldStop).toHaveBeenCalledTimes(1);
      const rearmed = internals.jobs.get("sched-1");
      expect(rearmed).toBeDefined();
      expect(rearmed?.job).not.toBe(oldJob);

      // Stop the real CronJob so it does not leak a live timer.
      service.destroy();
    });

    it("refuses to edit a schedule belonging to another guild", async () => {
      const save = jest.fn<() => Promise<void>>().mockResolvedValue();
      mockPollScheduleFindById.mockResolvedValue({
        _id: { toString: () => "sched-1" },
        guildId: "other-guild",
        save,
      });
      const service = PollService.getInstance({} as never);

      const result = await service.updateSchedule(
        "sched-1",
        {
          channelId: "chan-1",
          cronSchedule: "0 12 * * 1",
          pollDuration: 12,
          roleIdToPing: null,
        },
        "guild-1",
      );

      expect(result).toBeNull();
      expect(save).not.toHaveBeenCalled();
    });
  });
});
