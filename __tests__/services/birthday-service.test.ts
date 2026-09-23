import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { DiscordAPIError, TextChannel, type Client } from "discord.js";

const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetString = jest.fn();
const mockConfigGetNumber = jest.fn();

const mockGetTimezone = jest.fn();
const mockPrefsGetInstance = jest.fn(() => ({
  getTimezone: mockGetTimezone,
}));

const mockLoggerIsReady = jest.fn(() => false);
const mockLogCronSuccess = jest.fn();
const mockDiscordLoggerGetInstance = jest.fn(() => ({
  isReady: mockLoggerIsReady,
  logCronSuccess: mockLogCronSuccess,
}));

const mockBirthdayFindOne = jest.fn();
const mockBirthdayFindOneAndUpdate = jest.fn();
const mockBirthdayDeleteOne = jest.fn();
const mockBirthdayFind = jest.fn();
const mockBirthdayUpdateOne = jest.fn();
const mockBirthdayDeleteMany = jest.fn();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: mockRegisterReloadCallback,
      getBoolean: mockConfigGetBoolean,
      getString: mockConfigGetString,
      getNumber: mockConfigGetNumber,
    })),
  },
}));

jest.unstable_mockModule(
  "../../src/services/user-notification-prefs-service.js",
  () => ({
    UserNotificationPrefsService: { getInstance: mockPrefsGetInstance },
  }),
);

jest.unstable_mockModule("../../src/services/discord-logger.js", () => ({
  DiscordLogger: { getInstance: mockDiscordLoggerGetInstance },
}));

jest.unstable_mockModule("../../src/models/user-birthday.js", () => ({
  UserBirthday: {
    findOne: mockBirthdayFindOne,
    findOneAndUpdate: mockBirthdayFindOneAndUpdate,
    deleteOne: mockBirthdayDeleteOne,
    deleteMany: mockBirthdayDeleteMany,
    find: mockBirthdayFind,
    updateOne: mockBirthdayUpdateOne,
  },
}));

const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: mockLoggerWarn,
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  BirthdayService,
  isLeapYear,
  isValidMonthDay,
  isBirthdayToday,
  shouldAnnounceBirthday,
  localYmdInZone,
  renderBirthdayMessage,
} = await import("../../src/services/birthday-service.js");

type ServiceInstance = InstanceType<typeof BirthdayService>;

function resetSingleton(): void {
  (BirthdayService as unknown as { instance: unknown }).instance = undefined;
}

function makeClient(): Client {
  return {
    guilds: { fetch: jest.fn() },
    channels: { fetch: jest.fn() },
  } as unknown as Client;
}

/** A real `DiscordAPIError` with the given code, as discord.js throws. */
function apiError(code: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "nope" },
    code,
    400,
    "DELETE",
    "",
    {},
  );
}

describe("birthday pure helpers", () => {
  describe("isLeapYear", () => {
    it("classifies common leap and non-leap years", () => {
      expect(isLeapYear(2024)).toBe(true);
      expect(isLeapYear(2023)).toBe(false);
      expect(isLeapYear(2000)).toBe(true); // divisible by 400
      expect(isLeapYear(1900)).toBe(false); // divisible by 100 but not 400
    });
  });

  describe("isValidMonthDay", () => {
    it("accepts valid calendar dates including Feb 29", () => {
      expect(isValidMonthDay(1, 1)).toBe(true);
      expect(isValidMonthDay(2, 29)).toBe(true);
      expect(isValidMonthDay(12, 31)).toBe(true);
    });
    it("rejects out-of-range months and days", () => {
      expect(isValidMonthDay(0, 1)).toBe(false);
      expect(isValidMonthDay(13, 1)).toBe(false);
      expect(isValidMonthDay(1, 0)).toBe(false);
      expect(isValidMonthDay(1, 32)).toBe(false);
      expect(isValidMonthDay(4, 31)).toBe(false); // April has 30 days
      expect(isValidMonthDay(2, 30)).toBe(false);
    });
    it("rejects non-integers", () => {
      expect(isValidMonthDay(1.5, 10)).toBe(false);
      expect(isValidMonthDay(1, 10.2)).toBe(false);
    });
  });

  describe("localYmdInZone — 'is it today' across timezones (#524)", () => {
    it("resolves the local calendar day in the member's zone", () => {
      // 2026-06-15 23:30 UTC is already 2026-06-16 in Tokyo (UTC+9) but
      // still 2026-06-15 in New York (UTC-4).
      const instant = new Date("2026-06-15T23:30:00Z");
      expect(localYmdInZone(instant, "Asia/Tokyo")).toEqual({
        year: 2026,
        month: 6,
        day: 16,
      });
      expect(localYmdInZone(instant, "America/New_York")).toEqual({
        year: 2026,
        month: 6,
        day: 15,
      });
      expect(localYmdInZone(instant, "UTC")).toEqual({
        year: 2026,
        month: 6,
        day: 15,
      });
    });

    it("a birthday fires on the member's local day, not the host's", () => {
      const instant = new Date("2026-06-15T23:30:00Z");
      const birthday = { month: 6, day: 16 };
      // Today in Tokyo it IS June 16 → announce.
      expect(
        isBirthdayToday(birthday, localYmdInZone(instant, "Asia/Tokyo")),
      ).toBe(true);
      // In New York it's still June 15 → not yet.
      expect(
        isBirthdayToday(birthday, localYmdInZone(instant, "America/New_York")),
      ).toBe(false);
    });
  });

  describe("isBirthdayToday", () => {
    it("matches the exact month/day", () => {
      expect(
        isBirthdayToday(
          { month: 3, day: 14 },
          { year: 2026, month: 3, day: 14 },
        ),
      ).toBe(true);
      expect(
        isBirthdayToday(
          { month: 3, day: 14 },
          { year: 2026, month: 3, day: 15 },
        ),
      ).toBe(false);
    });
    it("celebrates a Feb 29 birthday on Mar 1 in non-leap years", () => {
      // 2026 is not a leap year.
      expect(
        isBirthdayToday(
          { month: 2, day: 29 },
          { year: 2026, month: 3, day: 1 },
        ),
      ).toBe(true);
      expect(
        isBirthdayToday(
          { month: 2, day: 29 },
          { year: 2026, month: 2, day: 28 },
        ),
      ).toBe(false);
    });
    it("celebrates a Feb 29 birthday on Feb 29 in leap years (not Mar 1)", () => {
      // 2028 is a leap year.
      expect(
        isBirthdayToday(
          { month: 2, day: 29 },
          { year: 2028, month: 2, day: 29 },
        ),
      ).toBe(true);
      expect(
        isBirthdayToday(
          { month: 2, day: 29 },
          { year: 2028, month: 3, day: 1 },
        ),
      ).toBe(false);
    });
  });

  describe("shouldAnnounceBirthday — double-announce guard", () => {
    const local = { year: 2026, month: 5, day: 10 };
    it("announces when it's the birthday and not yet announced this year", () => {
      expect(shouldAnnounceBirthday({ month: 5, day: 10 }, local)).toBe(true);
      expect(
        shouldAnnounceBirthday(
          { month: 5, day: 10, lastAnnouncedYear: 2025 },
          local,
        ),
      ).toBe(true);
    });
    it("suppresses a second announcement in the same local year", () => {
      expect(
        shouldAnnounceBirthday(
          { month: 5, day: 10, lastAnnouncedYear: 2026 },
          local,
        ),
      ).toBe(false);
    });
    it("does not announce when it isn't the birthday regardless of guard", () => {
      expect(
        shouldAnnounceBirthday(
          { month: 5, day: 11, lastAnnouncedYear: 2025 },
          local,
        ),
      ).toBe(false);
    });
  });

  describe("renderBirthdayMessage", () => {
    it("renders the user mention and age", () => {
      expect(
        renderBirthdayMessage("🎂 {user} turns {age} today!", {
          userId: "123",
          displayName: "Sam",
          age: 30,
        }),
      ).toBe("🎂 <@123> turns 30 today!");
    });
    it("uses the display name for {username} without a ping", () => {
      expect(
        renderBirthdayMessage("Happy birthday {username}!", {
          userId: "123",
          displayName: "Sam",
          age: null,
        }),
      ).toBe("Happy birthday Sam!");
    });
    it("collapses the gap left by {age} when no year is on file", () => {
      expect(
        renderBirthdayMessage("{user} turns {age} today", {
          userId: "9",
          displayName: "X",
          age: null,
        }),
      ).toBe("<@9> turns today");
    });
  });
});

describe("BirthdayService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSingleton();
    mockConfigGetBoolean.mockImplementation(async (key: unknown) => {
      const k = key as string;
      if (k === "birthdays.enabled") return true;
      if (k === "birthdays.mention") return true;
      return false;
    });
    mockConfigGetString.mockImplementation(
      async (key: unknown, def: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "birthdays.cron") return "0 * * * *";
        return (def as string) ?? "";
      },
    );
    mockConfigGetNumber.mockImplementation(
      async (key: unknown, def: unknown) => {
        return (def as number) ?? 0;
      },
    );
    mockGetTimezone.mockResolvedValue(null);
  });

  describe("singleton + lifecycle", () => {
    it("returns the same instance for the same client", () => {
      const client = makeClient();
      expect(BirthdayService.getInstance(client)).toBe(
        BirthdayService.getInstance(client),
      );
    });

    it("registers a reload callback on construction", () => {
      BirthdayService.getInstance(makeClient());
      expect(mockRegisterReloadCallback).toHaveBeenCalledTimes(1);
    });

    it("throws if constructed with a different client", () => {
      BirthdayService.getInstance(makeClient());
      expect(() => BirthdayService.getInstance(makeClient())).toThrow(
        /different client/,
      );
    });
  });

  describe("runNow guards", () => {
    it("returns null when the feature is disabled", async () => {
      mockConfigGetBoolean.mockResolvedValue(false);
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      expect(await svc.runNow()).toBeNull();
      expect(mockBirthdayFind).not.toHaveBeenCalled();
    });

    it("returns null when no announcement channel is configured", async () => {
      // GUILD_ID present, channel id empty.
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      expect(await svc.runNow()).toBeNull();
      expect(mockBirthdayFind).not.toHaveBeenCalled();
    });

    it("aborts rather than throwing when the guild cannot be fetched", async () => {
      // `guilds.fetch` rejects on a stale id or missing access — it does not
      // resolve null — so the abort guard only runs if that is converted.
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "birthdays.channel_id") return "chan-1";
        return "";
      });
      const client = makeClient();
      (client.guilds.fetch as jest.Mock).mockRejectedValue(
        new Error("Unknown Guild"),
      );
      const svc: ServiceInstance = BirthdayService.getInstance(client);

      expect(await svc.runNow()).toBeNull();
      expect(mockBirthdayFind).not.toHaveBeenCalled();
    });

    it("aborts rather than throwing when the channel cannot be fetched", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "birthdays.channel_id") return "chan-1";
        return "";
      });
      const client = makeClient();
      (client.guilds.fetch as jest.Mock).mockResolvedValue({
        channels: {
          fetch: jest.fn(() => Promise.reject(new Error("no access"))),
        },
      });
      const svc: ServiceInstance = BirthdayService.getInstance(client);

      expect(await svc.runNow()).toBeNull();
      expect(mockBirthdayFind).not.toHaveBeenCalled();
    });
  });

  describe("runOnce announcement bookkeeping (#916)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      resetSingleton();
      mockConfigGetBoolean.mockResolvedValue(true);
      mockConfigGetNumber.mockResolvedValue(24);
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "birthdays.channel_id") return "chan-1";
        // No birthday role: this is about the post, not the grant.
        return "";
      });
      mockGetTimezone.mockResolvedValue("UTC");
      mockBirthdayUpdateOne.mockResolvedValue({ matchedCount: 1 });
    });

    it("records the post it made so a later purge can delete it", async () => {
      // Without this the message id lives only in the run's local variable:
      // the row is erased on a purge and the public post — naming the member
      // and often their age — stays up for good.
      const today = new Date();
      const row = {
        _id: "row-1",
        userId: "user-1",
        guildId: "guild-1",
        month: today.getUTCMonth() + 1,
        day: today.getUTCDate(),
      };
      // The sweep queries first (no grants), then the announce loop.
      mockBirthdayFind
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row as never]);

      const channel = Object.create(TextChannel.prototype) as TextChannel & {
        id: string;
        send: jest.Mock;
      };
      channel.id = "chan-1";
      channel.send = jest.fn(async () => ({ id: "msg-9" }));

      const client = makeClient();
      (client.guilds.fetch as jest.Mock).mockResolvedValue({
        channels: { fetch: jest.fn(async () => channel) },
        members: {
          fetch: jest.fn(async () => ({ displayName: "Ada", id: "user-1" })),
        },
      });

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const summary = await svc.runNow();

      expect(summary?.announced).toBe(1);
      expect(mockBirthdayUpdateOne).toHaveBeenCalledWith(
        { _id: "row-1" },
        expect.objectContaining({
          $set: expect.objectContaining({
            announcements: [
              expect.objectContaining({
                channelId: "chan-1",
                messageId: "msg-9",
              }),
            ],
          }),
        }),
      );
    });
  });

  describe("getBirthday / setBirthday storage", () => {
    it("returns null when no row exists", async () => {
      mockBirthdayFindOne.mockResolvedValue(null);
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      expect(await svc.getBirthday("u1", "g1")).toBeNull();
    });

    it("maps a stored row to a plain birthday (year null when absent)", async () => {
      mockBirthdayFindOne.mockResolvedValue({ month: 4, day: 2 });
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      expect(await svc.getBirthday("u1", "g1")).toEqual({
        month: 4,
        day: 2,
        year: null,
      });
    });

    it("degrades to null on a read error", async () => {
      mockBirthdayFindOne.mockRejectedValue(new Error("db down"));
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      expect(await svc.getBirthday("u1", "g1")).toBeNull();
    });

    it("clears the birthday when input is null", async () => {
      mockBirthdayDeleteOne.mockResolvedValue({ deletedCount: 1 });
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      expect(await svc.setBirthday("u1", "g1", null)).toBeNull();
      expect(mockBirthdayDeleteOne).toHaveBeenCalledWith({
        userId: "u1",
        guildId: "g1",
      });
    });

    it("upserts a valid birthday and resets lastAnnouncedYear", async () => {
      mockBirthdayFindOneAndUpdate.mockResolvedValue({
        month: 6,
        day: 16,
        year: 1990,
      });
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      const result = await svc.setBirthday("u1", "g1", {
        month: 6,
        day: 16,
        year: 1990,
      });
      expect(result).toEqual({ month: 6, day: 16, year: 1990 });
      const [, update] = mockBirthdayFindOneAndUpdate.mock.calls[0] as [
        unknown,
        { $set: Record<string, unknown>; $unset: Record<string, unknown> },
      ];
      expect(update.$set).toMatchObject({ month: 6, day: 16, year: 1990 });
      expect(update.$unset).toHaveProperty("lastAnnouncedYear");
    });

    it("$unsets the year when omitted (privacy: date without age)", async () => {
      mockBirthdayFindOneAndUpdate.mockResolvedValue({ month: 6, day: 16 });
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      await svc.setBirthday("u1", "g1", { month: 6, day: 16, year: null });
      const [, update] = mockBirthdayFindOneAndUpdate.mock.calls[0] as [
        unknown,
        { $set: Record<string, unknown>; $unset: Record<string, unknown> },
      ];
      expect(update.$set).not.toHaveProperty("year");
      expect(update.$unset).toHaveProperty("year");
    });

    it("rejects an invalid month/day before writing", async () => {
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      await expect(
        svc.setBirthday("u1", "g1", { month: 2, day: 30 }),
      ).rejects.toThrow(/valid month\/day/);
      expect(mockBirthdayFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects a future or implausible birth year", async () => {
      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      const nextYear = new Date().getUTCFullYear() + 1;
      await expect(
        svc.setBirthday("u1", "g1", { month: 6, day: 16, year: nextYear }),
      ).rejects.toThrow(/valid birth year/);
      await expect(
        svc.setBirthday("u1", "g1", { month: 6, day: 16, year: 1800 }),
      ).rejects.toThrow(/valid birth year/);
      expect(mockBirthdayFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe("sweepExpiredRoles", () => {
    const MS_PER_HOUR = 60 * 60 * 1000;
    const now = new Date("2026-06-16T12:00:00Z");
    const expiredAt = new Date(now.getTime() - 48 * MS_PER_HOUR);

    type SweepFn = (
      guild: unknown,
      guildId: string,
      roleId: string,
      durationMs: number,
      now: Date,
    ) => Promise<number>;

    function sweep(svc: ServiceInstance): SweepFn {
      return (
        svc as unknown as { sweepExpiredRoles: SweepFn }
      ).sweepExpiredRoles.bind(svc);
    }

    function makeGuild(member: unknown): unknown {
      return { members: { fetch: jest.fn().mockResolvedValue(member) } };
    }

    function makeMember(): unknown {
      return {
        roles: {
          cache: { has: jest.fn(() => true) },
          remove: jest.fn().mockResolvedValue(undefined),
        },
      };
    }

    it("logs a warning with the sanitized user id when clearing roleAssignedAt fails to save", async () => {
      const saveError = new Error("mongo down");
      const row = {
        userId: "user-1\nforged log line",
        roleAssignedAt: expiredAt as Date | undefined,
        save: jest.fn().mockRejectedValue(saveError),
      };
      mockBirthdayFind.mockResolvedValue([row]);

      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      const removed = await sweep(svc)(
        makeGuild(makeMember()),
        "guild-1",
        "role-1",
        24 * MS_PER_HOUR,
        now,
      );

      // The role removal itself still counts and the marker is cleared
      // in memory; only the persistence failed.
      expect(removed).toBe(1);
      expect(row.roleAssignedAt).toBeUndefined();

      // The save failure must be logged (regression: it used to be
      // swallowed by a bare `.catch(() => undefined)`), with the user id
      // sanitized so it cannot forge log lines.
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to clear roleAssignedAt"),
        saveError,
      );
      const [message] = mockLoggerWarn.mock.calls.find(
        ([msg]) => typeof msg === "string" && msg.includes("roleAssignedAt"),
      ) as [string, unknown];
      expect(message).toContain("user-1 forged log line");
      expect(message).not.toContain("\n");
    });

    it("does not warn when the save succeeds", async () => {
      const row = {
        userId: "user-2",
        roleAssignedAt: expiredAt as Date | undefined,
        save: jest.fn().mockResolvedValue(undefined),
      };
      mockBirthdayFind.mockResolvedValue([row]);

      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      const removed = await sweep(svc)(
        makeGuild(makeMember()),
        "guild-1",
        "role-1",
        24 * MS_PER_HOUR,
        now,
      );

      expect(removed).toBe(1);
      expect(row.roleAssignedAt).toBeUndefined();
      expect(row.save).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("leaves unexpired grants untouched", async () => {
      const row = {
        userId: "user-3",
        roleAssignedAt: new Date(now.getTime() - 1 * MS_PER_HOUR) as
          Date | undefined,
        save: jest.fn().mockResolvedValue(undefined),
      };
      mockBirthdayFind.mockResolvedValue([row]);

      const svc: ServiceInstance = BirthdayService.getInstance(makeClient());
      const removed = await sweep(svc)(
        makeGuild(makeMember()),
        "guild-1",
        "role-1",
        24 * MS_PER_HOUR,
        now,
      );

      expect(removed).toBe(0);
      expect(row.roleAssignedAt).toBeDefined();
      expect(row.save).not.toHaveBeenCalled();
    });
  });

  /** A purge that had no recorded birthday posts to take down. */
  const NO_POSTS = {
    announcementsAttempted: 0,
    announcementsDeleted: 0,
    announcementsFailed: 0,
  };

  describe("purgeForUser (#916)", () => {
    /** A guild whose member holds (or does not hold) the birthday role. */
    function guildWithMember(hasRole: boolean): {
      guild: unknown;
      remove: jest.Mock;
    } {
      const remove = jest.fn(async () => undefined);
      return {
        guild: {
          members: {
            fetch: jest.fn(async () => ({
              roles: { cache: { has: () => hasRole }, remove },
            })),
          },
        },
        remove,
      };
    }

    beforeEach(() => {
      jest.clearAllMocks();
      resetSingleton();
      mockConfigGetString.mockResolvedValue("role-1");
      mockBirthdayDeleteMany.mockResolvedValue({ deletedCount: 1 });
    });

    it("takes the role back before deleting the row that records it", async () => {
      // `roleAssignedAt` is the expiry sweep's only handle on the grant, so
      // deleting the row first would leave the role on the member forever.
      mockBirthdayFind.mockResolvedValue([{ roleAssignedAt: new Date() }]);
      const client = makeClient();
      const { guild, remove } = guildWithMember(true);
      (client.guilds.fetch as jest.Mock).mockResolvedValue(guild);

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(result).toEqual({
        matched: 1,
        removed: 1,
        roleRevoked: true,
        ...NO_POSTS,
      });
      expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
        mockBirthdayDeleteMany.mock.invocationCallOrder[0],
      );
    });

    it("deletes the recorded birthday posts before the row that names them", async () => {
      // The row's `announcements` list is the only handle anything has on
      // those messages, and each one names the member — and often their age
      // — in a channel the whole guild reads (#916).
      mockBirthdayFind.mockResolvedValue([
        {
          roleAssignedAt: undefined,
          announcements: [
            { channelId: "chan-1", messageId: "msg-1", year: 2025 },
            { channelId: "chan-1", messageId: "msg-2", year: 2026 },
          ],
        },
      ]);
      const client = makeClient();
      const del = jest.fn(async () => undefined);
      (client.channels.fetch as jest.Mock).mockResolvedValue({
        isTextBased: () => true,
        messages: { delete: del },
      });

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(del).toHaveBeenCalledWith("msg-1");
      expect(del).toHaveBeenCalledWith("msg-2");
      expect(result).toEqual({
        matched: 1,
        removed: 1,
        roleRevoked: false,
        announcementsAttempted: 2,
        announcementsDeleted: 2,
        announcementsFailed: 0,
      });
      expect(del.mock.invocationCallOrder[0]).toBeLessThan(
        mockBirthdayDeleteMany.mock.invocationCallOrder[0],
      );
    });

    it("counts an already-deleted post as gone", async () => {
      // Nothing left naming the member is the whole point; a post someone
      // tidied away by hand must not fail the purge forever.
      mockBirthdayFind.mockResolvedValue([
        {
          roleAssignedAt: undefined,
          announcements: [
            { channelId: "chan-1", messageId: "msg-1", year: 2026 },
          ],
        },
      ]);
      const client = makeClient();
      (client.channels.fetch as jest.Mock).mockResolvedValue({
        isTextBased: () => true,
        messages: {
          delete: jest.fn(async () => {
            throw apiError(10008); // Unknown Message
          }),
        },
      });

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(result.announcementsDeleted).toBe(1);
      expect(result.announcementsFailed).toBe(0);
      expect(result.removed).toBe(1);
    });

    it("keeps the row when a post could not be deleted", async () => {
      // The row holds the only ids by which that message can ever be found,
      // so dropping it now would leave it public for good.
      mockBirthdayFind.mockResolvedValue([
        {
          roleAssignedAt: undefined,
          announcements: [
            { channelId: "chan-1", messageId: "msg-1", year: 2026 },
          ],
        },
      ]);
      const client = makeClient();
      (client.channels.fetch as jest.Mock).mockResolvedValue({
        isTextBased: () => true,
        messages: {
          delete: jest.fn(async () => {
            throw apiError(50013); // Missing Permissions
          }),
        },
      });

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(result.announcementsFailed).toBe(1);
      expect(result.removed).toBe(0);
      expect(result.error).toContain("may still be public");
      expect(mockBirthdayDeleteMany).not.toHaveBeenCalled();
    });

    it("keeps the row when the role could not be taken back", async () => {
      // Dropping it would strand the grant: the sweep would never see it.
      mockBirthdayFind.mockResolvedValue([{ roleAssignedAt: new Date() }]);
      const client = makeClient();
      (client.guilds.fetch as jest.Mock).mockResolvedValue(null);

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(result.removed).toBe(0);
      expect(result.error).toBeDefined();
      expect(mockBirthdayDeleteMany).not.toHaveBeenCalled();
    });

    it("just deletes the row when no role was ever granted", async () => {
      mockBirthdayFind.mockResolvedValue([{ roleAssignedAt: undefined }]);
      const client = makeClient();

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(result).toEqual({
        matched: 1,
        removed: 1,
        roleRevoked: false,
        ...NO_POSTS,
      });
      expect(client.guilds.fetch).not.toHaveBeenCalled();
    });

    it("keeps the revoke on the record when the delete then fails", async () => {
      // Throwing would collapse a real Discord change into a bare 0/0 in the
      // purge report, and an operator retrying would not know the role had
      // already come off (#916).
      mockBirthdayFind.mockResolvedValue([{ roleAssignedAt: new Date() }]);
      mockBirthdayDeleteMany.mockRejectedValue(new Error("write conflict"));
      const client = makeClient();
      const { guild } = guildWithMember(true);
      (client.guilds.fetch as jest.Mock).mockResolvedValue(guild);

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(result).toEqual({
        matched: 1,
        removed: 0,
        roleRevoked: true,
        ...NO_POSTS,
        error: "write conflict",
      });
    });

    it("keeps the row when the member lookup merely failed", async () => {
      // A rate limit is not proof they left. Reading it as one would delete
      // the only marker and strand a role still on a present member (#916).
      mockBirthdayFind.mockResolvedValue([{ roleAssignedAt: new Date() }]);
      const client = makeClient();
      (client.guilds.fetch as jest.Mock).mockResolvedValue({
        members: {
          fetch: jest.fn(async () => {
            throw new Error("rate limited");
          }),
        },
      });

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(result.removed).toBe(0);
      expect(result.error).toBeDefined();
      expect(mockBirthdayDeleteMany).not.toHaveBeenCalled();
    });

    it("retries when the run wrote a new role marker mid-purge", async () => {
      // The reverse ordering: we snapshot a row with no marker, the run
      // grants a role and saves one, and our conditional delete then matches
      // nothing. Deleting unconditionally would strand that fresh grant.
      const withMarker = { _id: "b1", roleAssignedAt: new Date() };
      mockBirthdayFind
        .mockResolvedValueOnce([{ _id: "b1", roleAssignedAt: undefined }])
        .mockResolvedValueOnce([withMarker]);
      mockBirthdayDeleteMany
        .mockResolvedValueOnce({ deletedCount: 0 }) // changed under us
        .mockResolvedValueOnce({ deletedCount: 1 });
      const client = makeClient();
      const { guild, remove } = guildWithMember(true);
      (client.guilds.fetch as jest.Mock).mockResolvedValue(guild);

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      // Second pass saw the marker and revoked the role the run just granted.
      expect(remove).toHaveBeenCalled();
      expect(result).toEqual({
        matched: 1,
        removed: 1,
        roleRevoked: true,
        ...NO_POSTS,
      });
    });

    it("revokes the role that was granted, not whatever is configured now", async () => {
      // `birthdays.role_id` can change while a grant is live. Revoking the
      // configured role would leave the real one on the member and then
      // delete its only marker (#916).
      mockBirthdayFind.mockResolvedValue([
        { _id: "b1", roleAssignedAt: new Date(), roleAssignedId: "old-role" },
      ]);
      mockConfigGetString.mockResolvedValue("new-role");
      const remove = jest.fn(async () => undefined);
      const client = makeClient();
      (client.guilds.fetch as jest.Mock).mockResolvedValue({
        members: {
          fetch: jest.fn(async () => ({
            roles: {
              cache: { has: (id: string) => id === "old-role" },
              remove,
            },
          })),
        },
      });

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(remove).toHaveBeenCalledWith("old-role", expect.any(String));
      expect(result.roleRevoked).toBe(true);
    });

    it("reports zeros for a member with no birthday", async () => {
      mockBirthdayFind.mockResolvedValue([]);
      const client = makeClient();

      const svc: ServiceInstance = BirthdayService.getInstance(client);

      expect(await svc.purgeForUser("guild-1", "user-1")).toEqual({
        matched: 0,
        removed: 0,
        roleRevoked: false,
        ...NO_POSTS,
      });
      expect(mockBirthdayDeleteMany).not.toHaveBeenCalled();
    });

    it("drops the row when the member has already left", async () => {
      // No member, no grant left for the sweep to chase.
      mockBirthdayFind.mockResolvedValue([{ roleAssignedAt: new Date() }]);
      const client = makeClient();
      (client.guilds.fetch as jest.Mock).mockResolvedValue({
        members: { fetch: jest.fn(async () => null) },
      });

      const svc: ServiceInstance = BirthdayService.getInstance(client);
      const result = await svc.purgeForUser("guild-1", "user-1");

      expect(result).toEqual({
        matched: 1,
        removed: 1,
        roleRevoked: true,
        ...NO_POSTS,
      });
    });
  });
});
