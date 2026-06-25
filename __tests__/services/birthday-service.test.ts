import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Client } from "discord.js";

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
    find: mockBirthdayFind,
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
  } as unknown as Client;
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
      expect(isBirthdayToday({ month: 3, day: 14 }, { year: 2026, month: 3, day: 14 })).toBe(true);
      expect(isBirthdayToday({ month: 3, day: 14 }, { year: 2026, month: 3, day: 15 })).toBe(false);
    });
    it("celebrates a Feb 29 birthday on Mar 1 in non-leap years", () => {
      // 2026 is not a leap year.
      expect(isBirthdayToday({ month: 2, day: 29 }, { year: 2026, month: 3, day: 1 })).toBe(true);
      expect(isBirthdayToday({ month: 2, day: 29 }, { year: 2026, month: 2, day: 28 })).toBe(false);
    });
    it("celebrates a Feb 29 birthday on Feb 29 in leap years (not Mar 1)", () => {
      // 2028 is a leap year.
      expect(isBirthdayToday({ month: 2, day: 29 }, { year: 2028, month: 2, day: 29 })).toBe(true);
      expect(isBirthdayToday({ month: 2, day: 29 }, { year: 2028, month: 3, day: 1 })).toBe(false);
    });
  });

  describe("shouldAnnounceBirthday — double-announce guard", () => {
    const local = { year: 2026, month: 5, day: 10 };
    it("announces when it's the birthday and not yet announced this year", () => {
      expect(shouldAnnounceBirthday({ month: 5, day: 10 }, local)).toBe(true);
      expect(
        shouldAnnounceBirthday({ month: 5, day: 10, lastAnnouncedYear: 2025 }, local),
      ).toBe(true);
    });
    it("suppresses a second announcement in the same local year", () => {
      expect(
        shouldAnnounceBirthday({ month: 5, day: 10, lastAnnouncedYear: 2026 }, local),
      ).toBe(false);
    });
    it("does not announce when it isn't the birthday regardless of guard", () => {
      expect(
        shouldAnnounceBirthday({ month: 5, day: 11, lastAnnouncedYear: 2025 }, local),
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
    mockConfigGetString.mockImplementation(async (key: unknown, def: unknown) => {
      const k = key as string;
      if (k === "GUILD_ID") return "guild-1";
      if (k === "birthdays.cron") return "0 * * * *";
      return (def as string) ?? "";
    });
    mockConfigGetNumber.mockImplementation(async (key: unknown, def: unknown) => {
      return (def as number) ?? 0;
    });
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
});
