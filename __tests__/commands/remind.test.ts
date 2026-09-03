import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction } from "discord.js";

const mockGetBoolean =
  jest.fn<(key: string, fallback: boolean) => Promise<boolean>>();
const mockGetNumber =
  jest.fn<(key: string, fallback: number) => Promise<number>>();
const mockGetTimezone =
  jest.fn<(userId: string, guildId: string) => Promise<string | null>>();

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

jest.unstable_mockModule(
  "../../src/services/user-notification-prefs-service.js",
  () => ({
    UserNotificationPrefsService: {
      getInstance: jest.fn(() => ({ getTimezone: mockGetTimezone })),
    },
  }),
);

// The command drives the real ReminderService, so only the model is mocked —
// that keeps the validation path and the service's guards under test together.
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

const { Reminder } = await import("../../src/models/reminder.js");
const ReminderMock = Reminder as unknown as {
  find: jest.Mock;
  create: jest.Mock;
  countDocuments: jest.Mock;
  deleteOne: jest.Mock;
};

const { ReminderService } =
  await import("../../src/services/reminder-service.js");
const { data, execute } = await import("../../src/commands/remind.js");

/** A syntactically valid Mongo ObjectId, for the cancel path. */
const VALID_ID = "507f1f77bcf86cd799439011";

// One shared client: ReminderService.getInstance refuses to hand back an
// instance built for a different client.
const CLIENT = { users: { fetch: jest.fn() }, channels: { fetch: jest.fn() } };

type MockInteraction = ChatInputCommandInteraction & {
  deferReply: jest.Mock;
  editReply: jest.Mock;
  reply: jest.Mock;
};

function makeInteraction(
  subcommand: string,
  options: Record<string, string | null> = {},
  overrides: Record<string, unknown> = {},
): MockInteraction {
  return {
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string) => options[name] ?? null,
    },
    user: { id: "user-1", username: "alice" },
    guildId: "guild-1",
    channelId: "chan-1",
    client: CLIENT,
    replied: false,
    deferred: true,
    deferReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    editReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MockInteraction;
}

/** The text of the first editReply, whatever payload shape was used. */
function replyText(interaction: MockInteraction): string {
  const payload = interaction.editReply.mock.calls[0]?.[0];
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

beforeEach(() => {
  jest.clearAllMocks();
  ReminderService.reset();
  mockGetBoolean.mockResolvedValue(true);
  mockGetNumber.mockResolvedValue(10);
  mockGetTimezone.mockResolvedValue(null);
  ReminderMock.countDocuments.mockResolvedValue(0);
  ReminderMock.create.mockImplementation(
    async (doc: Record<string, unknown>) => ({
      ...doc,
      _id: VALID_ID,
    }),
  );
});

describe("remind command metadata", () => {
  it("is named remind", () => {
    expect(data.name).toBe("remind");
  });

  it("has a description", () => {
    expect(data.description.length).toBeGreaterThan(0);
  });

  it("exposes set, list and cancel subcommands", () => {
    const json = data.toJSON();
    const names = (json.options ?? []).map((o) => o.name);
    expect(names).toEqual(["set", "list", "cancel"]);
  });

  it("caps the reminder message length", () => {
    const json = data.toJSON();
    const set = (json.options ?? []).find((o) => o.name === "set") as {
      options: Array<{ name: string; max_length?: number; required?: boolean }>;
    };
    const message = set.options.find((o) => o.name === "message");
    expect(message?.required).toBe(true);
    expect(message?.max_length).toBe(500);
  });
});

describe("remind command gating", () => {
  it("acknowledges the interaction before doing any work", async () => {
    const interaction = makeInteraction("list");
    ReminderMock.find.mockReturnValue({ sort: async () => [] });

    await execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });

  it("refuses when the feature is disabled", async () => {
    mockGetBoolean.mockResolvedValue(false);
    const interaction = makeInteraction("set", { message: "hi", in: "2h" });

    await execute(interaction);

    expect(replyText(interaction)).toContain("disabled");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("refuses outside a guild", async () => {
    const interaction = makeInteraction(
      "set",
      { message: "hi", in: "2h" },
      { guildId: null },
    );

    await execute(interaction);

    expect(replyText(interaction)).toContain("guild");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });
});

describe("/remind set", () => {
  it("stores a reminder given a relative duration", async () => {
    const interaction = makeInteraction("set", {
      message: "check the oven",
      in: "2h",
    });

    await execute(interaction);

    expect(ReminderMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        guildId: "guild-1",
        channelId: "chan-1",
        message: "check the oven",
        delivered: false,
      }),
    );
    const stored = ReminderMock.create.mock.calls[0][0] as { remindAt: Date };
    const deltaMs = stored.remindAt.getTime() - Date.now();
    // ~2 hours out, allowing for test execution time.
    expect(deltaMs).toBeGreaterThan(2 * 60 * 60 * 1000 - 5000);
    expect(deltaMs).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  it("confirms with a Discord timestamp and the cancel id", async () => {
    const interaction = makeInteraction("set", {
      message: "check the oven",
      in: "2h",
    });

    await execute(interaction);

    const text = replyText(interaction);
    expect(text).toMatch(/<t:\d+:F>/);
    expect(text).toContain(VALID_ID);
  });

  it("reads a wall-clock date and time in the member's own timezone", async () => {
    // Freeze only the clock (timers stay real, so awaits still resolve) so a
    // fixed target date stays inside the one-year horizon forever.
    jest.useFakeTimers({
      doNotFake: [
        "nextTick",
        "queueMicrotask",
        "setImmediate",
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "performance",
      ],
      now: new Date("2026-09-01T00:00:00Z"),
    });
    try {
      mockGetTimezone.mockResolvedValue("Europe/London");
      const interaction = makeInteraction("set", {
        message: "renew the sub",
        date: "2026-09-15",
        time: "18:00",
      });

      await execute(interaction);

      const stored = ReminderMock.create.mock.calls[0][0] as {
        remindAt: Date;
        timezone: string;
      };
      expect(stored.timezone).toBe("Europe/London");
      // London is on BST (UTC+1) in mid-September, so 18:00 local is 17:00Z.
      expect(stored.remindAt.toISOString()).toBe("2026-09-15T17:00:00.000Z");
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects giving both a relative and an absolute time", async () => {
    const interaction = makeInteraction("set", {
      message: "hi",
      in: "2h",
      date: "2099-09-01",
      time: "18:00",
    });

    await execute(interaction);

    expect(replyText(interaction)).toContain("not both");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("rejects giving no time at all", async () => {
    const interaction = makeInteraction("set", { message: "hi" });

    await execute(interaction);

    expect(replyText(interaction)).toContain("Tell me when");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("rejects a date without a time", async () => {
    const interaction = makeInteraction("set", {
      message: "hi",
      date: "2099-09-01",
    });

    await execute(interaction);

    expect(replyText(interaction)).toContain("go together");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("rejects an unparseable duration", async () => {
    const interaction = makeInteraction("set", {
      message: "hi",
      in: "soonish",
    });

    await execute(interaction);

    expect(replyText(interaction)).toContain("couldn't read that duration");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("rejects an impossible calendar date", async () => {
    const interaction = makeInteraction("set", {
      message: "hi",
      date: "2099-02-30",
      time: "18:00",
    });

    await execute(interaction);

    expect(replyText(interaction)).toContain("didn't parse");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("rejects a time already in the past", async () => {
    const interaction = makeInteraction("set", {
      message: "hi",
      date: "2020-01-01",
      time: "18:00",
    });

    await execute(interaction);

    expect(replyText(interaction)).toContain("already passed");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("rejects a time beyond the one-year horizon", async () => {
    const interaction = makeInteraction("set", { message: "hi", in: "100w" });

    await execute(interaction);

    expect(replyText(interaction)).toContain("more than a year");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });

  it("refuses once the member is at the pending cap", async () => {
    ReminderMock.countDocuments.mockResolvedValue(10);
    const interaction = makeInteraction("set", { message: "hi", in: "2h" });

    await execute(interaction);

    expect(replyText(interaction)).toContain("10 pending reminders");
    expect(ReminderMock.create).not.toHaveBeenCalled();
  });
});

describe("/remind list", () => {
  it("says so when there is nothing pending", async () => {
    ReminderMock.find.mockReturnValue({ sort: async () => [] });
    const interaction = makeInteraction("list");

    await execute(interaction);

    expect(replyText(interaction)).toContain("no pending reminders");
  });

  it("lists only the member's own pending reminders", async () => {
    ReminderMock.find.mockReturnValue({
      sort: async () => [
        {
          _id: VALID_ID,
          message: "check the oven",
          remindAt: new Date("2099-01-01T00:00:00Z"),
        },
      ],
    });
    const interaction = makeInteraction("list");

    await execute(interaction);

    expect(ReminderMock.find).toHaveBeenCalledWith({
      userId: "user-1",
      guildId: "guild-1",
      delivered: false,
    });
    const text = replyText(interaction);
    expect(text).toContain("check the oven");
    expect(text).toContain(VALID_ID);
  });
});

describe("/remind cancel", () => {
  it("rejects a malformed id before querying", async () => {
    const interaction = makeInteraction("cancel", { id: "not-an-id" });

    await execute(interaction);

    expect(replyText(interaction)).toContain("doesn't look like a reminder ID");
    expect(ReminderMock.deleteOne).not.toHaveBeenCalled();
  });

  it("cancels a reminder scoped to the caller", async () => {
    ReminderMock.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const interaction = makeInteraction("cancel", { id: VALID_ID });

    await execute(interaction);

    expect(ReminderMock.deleteOne).toHaveBeenCalledWith({
      _id: VALID_ID,
      userId: "user-1",
      guildId: "guild-1",
      delivered: false,
    });
    expect(replyText(interaction)).toContain("cancelled");
  });

  it("reports when nothing matched", async () => {
    ReminderMock.deleteOne.mockResolvedValue({ deletedCount: 0 });
    const interaction = makeInteraction("cancel", { id: VALID_ID });

    await execute(interaction);

    expect(replyText(interaction)).toContain("No pending reminder");
  });
});
