import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// The service registers a config reload callback and touches a Mongoose
// model at import time, so mock the heavy dependencies (mirrors the event
// and birthday service tests).
const mockGetBoolean =
  jest.fn<(key: string, fallback: boolean) => Promise<boolean>>();
const mockGetNumber =
  jest.fn<(key: string, fallback: number) => Promise<number>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: jest.fn(),
      getBoolean: mockGetBoolean,
      getNumber: mockGetNumber,
      getString: jest.fn(),
    })),
  },
}));

jest.unstable_mockModule("../../src/models/reminder.js", () => ({
  Reminder: {
    find: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
    deleteOne: jest.fn(),
  },
  DELIVERED_RETENTION_SECONDS: 7 * 24 * 60 * 60,
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the scheduler so no real interval is ever armed by a test.
const mockJobStart = jest.fn();
const mockJobStop = jest.fn();
const mockCronJob = jest.fn(() => ({ start: mockJobStart, stop: mockJobStop }));

jest.unstable_mockModule("cron", () => ({
  CronJob: mockCronJob,
  CronTime: jest.fn(),
}));

const { Reminder } = await import("../../src/models/reminder.js");
const ReminderMock = Reminder as unknown as {
  find: jest.Mock;
  findOneAndUpdate: jest.Mock;
  create: jest.Mock;
  countDocuments: jest.Mock;
  deleteOne: jest.Mock;
};

const {
  ReminderService,
  checkRemindAt,
  discordTimestamp,
  resolvePendingLimit,
  MAX_HORIZON_MS,
} = await import("../../src/services/reminder-service.js");

/** A syntactically valid Mongo ObjectId, for the cancel path. */
const VALID_ID = "507f1f77bcf86cd799439011";

const NOW = new Date("2026-09-01T12:00:00Z");
const MINUTE = 60 * 1000;

/** The fields of a stored reminder the service actually reads. */
interface ReminderView {
  _id: string;
  userId: string;
  guildId: string;
  channelId: string;
  message: string;
  remindAt: Date;
  timezone: string;
  delivered: boolean;
}

function dueReminder(overrides: Partial<ReminderView> = {}): ReminderView {
  return {
    _id: "rem-1",
    userId: "user-1",
    guildId: "guild-1",
    channelId: "chan-1",
    message: "check the oven",
    remindAt: new Date(NOW.getTime() - MINUTE),
    timezone: "",
    delivered: false,
    ...overrides,
  };
}

function makeClient(): {
  client: never;
  userSend: jest.Mock;
  channelSend: jest.Mock;
  usersFetch: jest.Mock;
  channelsFetch: jest.Mock;
} {
  const userSend = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const channelSend = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const usersFetch = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({ send: userSend });
  const channelsFetch = jest.fn<() => Promise<unknown>>().mockResolvedValue({
    isTextBased: () => true,
    isSendable: () => true,
    send: channelSend,
  });
  return {
    client: {
      users: { fetch: usersFetch },
      channels: { fetch: channelsFetch },
    } as never,
    userSend,
    channelSend,
    usersFetch,
    channelsFetch,
  };
}

/**
 * Point the scan at `rows`, and make the claiming update echo back the row
 * it claimed — mirroring `findOneAndUpdate({ new: true })`.
 */
function setDue(rows: ReminderView[]): void {
  ReminderMock.find.mockResolvedValue(rows);
  ReminderMock.findOneAndUpdate.mockImplementation(
    async (filter: { _id: string }) =>
      rows.find((row) => row._id === filter._id) ?? null,
  );
}

/** A Discord API error shaped like the one discord.js throws. */
function discordError(code: number): Error {
  return Object.assign(new Error(`discord ${code}`), { code });
}

beforeEach(() => {
  // Reset before clearing: reset() destroys the previous test's instance,
  // and that teardown must not land in this test's call counts.
  ReminderService.reset();
  jest.clearAllMocks();
  mockGetBoolean.mockResolvedValue(true);
  mockGetNumber.mockResolvedValue(10);
  // Default: nothing due.
  setDue([]);
});

describe("checkRemindAt", () => {
  it("accepts an instant in the future", () => {
    expect(checkRemindAt(new Date(NOW.getTime() + MINUTE), NOW)).toBeNull();
  });

  it("rejects an instant in the past", () => {
    expect(checkRemindAt(new Date(NOW.getTime() - MINUTE), NOW)).toBe("past");
  });

  it("rejects the present instant, which would fire on the next scan", () => {
    expect(checkRemindAt(new Date(NOW.getTime()), NOW)).toBe("past");
  });

  it("rejects an invalid date", () => {
    expect(checkRemindAt(new Date("nonsense"), NOW)).toBe("past");
  });

  it("accepts an instant exactly on the horizon", () => {
    const at = new Date(NOW.getTime() + MAX_HORIZON_MS);
    expect(checkRemindAt(at, NOW)).toBeNull();
  });

  it("rejects an instant beyond the horizon", () => {
    const at = new Date(NOW.getTime() + MAX_HORIZON_MS + 1);
    expect(checkRemindAt(at, NOW)).toBe("too-far");
  });

  it("honours an explicit shorter horizon", () => {
    const at = new Date(NOW.getTime() + 2 * MINUTE);
    expect(checkRemindAt(at, NOW, MINUTE)).toBe("too-far");
  });
});

describe("discordTimestamp", () => {
  it("renders the long form by default", () => {
    expect(discordTimestamp(NOW)).toBe("<t:1788264000:F>");
  });

  it("renders the relative form on request", () => {
    expect(discordTimestamp(NOW, "R")).toBe("<t:1788264000:R>");
  });
});

describe("ReminderService.createReminder", () => {
  it("stores a reminder when the member is under the cap", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);
    ReminderMock.countDocuments.mockResolvedValue(3);
    ReminderMock.create.mockResolvedValue(dueReminder());

    const remindAt = new Date(NOW.getTime() + 60 * MINUTE);
    const result = await service.createReminder({
      userId: "user-1",
      guildId: "guild-1",
      channelId: "chan-1",
      message: "check the oven",
      remindAt,
      timezone: "Europe/London",
    });

    expect(result.ok).toBe(true);
    expect(ReminderMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        guildId: "guild-1",
        message: "check the oven",
        remindAt,
        delivered: false,
      }),
    );
  });

  it("refuses once the member is at the cap", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);
    mockGetNumber.mockResolvedValue(10);
    ReminderMock.countDocuments.mockResolvedValue(10);

    const result = await service.createReminder({
      userId: "user-1",
      guildId: "guild-1",
      channelId: "chan-1",
      message: "one too many",
      remindAt: new Date(NOW.getTime() + MINUTE),
      timezone: "",
    });

    expect(result).toEqual({ ok: false, reason: "cap", limit: 10 });
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("still enforces a cap when the configured value is unusable", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);
    // A value only reachable by writing straight to Mongo; unchecked it
    // would make `pending >= limit` false forever.
    mockGetNumber.mockResolvedValue(Number.NaN);
    ReminderMock.countDocuments.mockResolvedValue(10);

    const result = await service.createReminder({
      userId: "user-1",
      guildId: "guild-1",
      channelId: "chan-1",
      message: "one too many",
      remindAt: new Date(NOW.getTime() + MINUTE),
      timezone: "",
    });

    expect(result).toEqual({ ok: false, reason: "cap", limit: 10 });
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("does not block every create when the configured cap is zero", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);
    mockGetNumber.mockResolvedValue(0);
    ReminderMock.countDocuments.mockResolvedValue(0);
    ReminderMock.create.mockResolvedValue(dueReminder());

    const result = await service.createReminder({
      userId: "user-1",
      guildId: "guild-1",
      channelId: "chan-1",
      message: "first one",
      remindAt: new Date(NOW.getTime() + MINUTE),
      timezone: "",
    });

    expect(result.ok).toBe(true);
  });
});

describe("ReminderService.cancelReminder", () => {
  it("scopes the delete to the caller's own pending reminders", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);
    ReminderMock.deleteOne.mockResolvedValue({ deletedCount: 1 });

    const cancelled = await service.cancelReminder(
      VALID_ID,
      "user-1",
      "guild-1",
    );

    expect(cancelled).toBe(true);
    expect(ReminderMock.deleteOne).toHaveBeenCalledWith({
      _id: VALID_ID,
      userId: "user-1",
      guildId: "guild-1",
      delivered: false,
    });
  });

  it("reports false when nothing matched", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);
    ReminderMock.deleteOne.mockResolvedValue({ deletedCount: 0 });

    expect(await service.cancelReminder(VALID_ID, "user-1", "guild-1")).toBe(
      false,
    );
  });

  it("returns false for a malformed id instead of throwing a CastError", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);

    expect(await service.cancelReminder("not-an-id", "user-1", "guild-1")).toBe(
      false,
    );
    expect(ReminderMock.deleteOne).not.toHaveBeenCalled();
  });
});

describe("resolvePendingLimit", () => {
  it("keeps a sane configured value", () => {
    expect(resolvePendingLimit(25)).toBe(25);
  });

  it("floors a fractional value", () => {
    expect(resolvePendingLimit(7.9)).toBe(7);
  });

  it.each([
    ["zero, which would block every create", 0],
    ["a negative", -1],
    ["NaN, which would remove the cap entirely", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("falls back to the default for %s", (_label, raw) => {
    expect(resolvePendingLimit(raw)).toBe(10);
  });
});

describe("ReminderService delivery scan", () => {
  it("does nothing when the feature is disabled", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);
    mockGetBoolean.mockResolvedValue(false);

    await service.runNow();

    expect(ReminderMock.find).not.toHaveBeenCalled();
  });

  it("queries only undelivered rows that are now due", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);

    await service.runNow();

    expect(ReminderMock.find).toHaveBeenCalledWith({
      delivered: false,
      remindAt: { $lte: expect.any(Date) },
    });
  });

  it("claims a row before sending, so a racing scan cannot double-send", async () => {
    const { client, userSend } = makeClient();
    const service = ReminderService.getInstance(client);
    setDue([dueReminder()]);

    await service.runNow();

    expect(ReminderMock.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "rem-1", delivered: false },
      { $set: { delivered: true, deliveredAt: expect.any(Date) } },
      { new: true },
    );
    expect(userSend).toHaveBeenCalledTimes(1);
  });

  it("does not send when another scan already claimed the row", async () => {
    const { client, userSend, channelSend } = makeClient();
    const service = ReminderService.getInstance(client);
    setDue([dueReminder()]);
    ReminderMock.findOneAndUpdate.mockResolvedValue(null);

    await service.runNow();

    expect(userSend).not.toHaveBeenCalled();
    expect(channelSend).not.toHaveBeenCalled();
  });

  it("DMs the member without letting the reminder text ping anyone", async () => {
    const { client, userSend, channelSend } = makeClient();
    const service = ReminderService.getInstance(client);
    setDue([dueReminder({ message: "@everyone free pizza" })]);

    await service.runNow();

    expect(userSend).toHaveBeenCalledWith({
      content: "⏰ **Reminder:** @everyone free pizza",
      allowedMentions: { parse: [] },
    });
    expect(channelSend).not.toHaveBeenCalled();
  });

  it("falls back to the channel when the member's DMs are closed", async () => {
    const { client, userSend, channelSend } = makeClient();
    userSend.mockRejectedValue(discordError(50007));
    const service = ReminderService.getInstance(client);
    setDue([dueReminder()]);

    await service.runNow();

    expect(channelSend).toHaveBeenCalledWith({
      content: "<@user-1> ⏰ **Reminder:** check the oven",
      allowedMentions: { users: ["user-1"] },
    });
  });

  it("pins the channel fallback's mentions to the one member", async () => {
    const { client, userSend, channelSend } = makeClient();
    userSend.mockRejectedValue(discordError(50007));
    const service = ReminderService.getInstance(client);
    setDue([dueReminder({ message: "ping @everyone" })]);

    await service.runNow();

    const payload = channelSend.mock.calls[0][0] as {
      allowedMentions: { users: string[] };
    };
    expect(payload.allowedMentions).toEqual({ users: ["user-1"] });
  });

  it("skips a channel that cannot be sent to", async () => {
    const { client, userSend, channelSend, channelsFetch } = makeClient();
    userSend.mockRejectedValue(discordError(50007));
    channelsFetch.mockResolvedValue({
      isTextBased: () => true,
      isSendable: () => false,
      send: channelSend,
    });
    const service = ReminderService.getInstance(client);
    setDue([dueReminder()]);

    await service.runNow();

    expect(channelSend).not.toHaveBeenCalled();
  });

  it("keeps going when one reminder fails", async () => {
    const { client, userSend } = makeClient();
    const service = ReminderService.getInstance(client);
    setDue([dueReminder({ _id: "rem-1" }), dueReminder({ _id: "rem-2" })]);
    ReminderMock.findOneAndUpdate.mockRejectedValueOnce(
      new Error("mongo is down"),
    );

    await expect(service.runNow()).resolves.toBeUndefined();
    expect(userSend).toHaveBeenCalledTimes(1);
  });
});

describe("ReminderService cron lifecycle", () => {
  it("arms a once-a-minute scan when enabled", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);

    await service.start();

    expect(mockCronJob).toHaveBeenCalledTimes(1);
    expect(mockCronJob.mock.calls[0][0]).toBe("* * * * *");
    expect(mockJobStart).toHaveBeenCalledTimes(1);
  });

  it("arms nothing when the feature is disabled", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);
    mockGetBoolean.mockResolvedValue(false);

    await service.start();

    expect(mockCronJob).not.toHaveBeenCalled();
  });

  it("is idempotent — a second start does not arm a second job", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);

    await service.start();
    await service.start();

    expect(mockCronJob).toHaveBeenCalledTimes(1);
  });

  it("stops the job on destroy", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);

    await service.start();
    service.destroy();

    expect(mockJobStop).toHaveBeenCalledTimes(1);
  });

  it("replaces the job on reload rather than stacking one", async () => {
    const { client } = makeClient();
    const service = ReminderService.getInstance(client);

    await service.start();
    await service.reload();

    expect(mockJobStop).toHaveBeenCalledTimes(1);
    expect(mockCronJob).toHaveBeenCalledTimes(2);
    expect(mockJobStart).toHaveBeenCalledTimes(2);
  });

  it("refuses an instance built for a different client", async () => {
    const { client } = makeClient();
    ReminderService.getInstance(client);
    const other = makeClient();

    expect(() => ReminderService.getInstance(other.client)).toThrow(
      /different client/,
    );
  });
});
