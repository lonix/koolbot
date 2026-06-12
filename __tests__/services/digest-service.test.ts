import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Client } from "discord.js";

const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetString = jest.fn();
const mockConfigGetNumber = jest.fn();

const mockGetTopUsers = jest.fn();
const mockTrackerGetInstance = jest.fn(() => ({
  getTopUsers: mockGetTopUsers,
}));

const mockGetPrefs = jest.fn();
const mockGetTimezone = jest.fn();
const mockGetPrefsWithTimezone = jest.fn();
const mockPrefsGetInstance = jest.fn(() => ({
  getPrefs: mockGetPrefs,
  getTimezone: mockGetTimezone,
  getPrefsWithTimezone: mockGetPrefsWithTimezone,
}));

const mockAchievementsGetInstance = jest.fn(() => ({}));

const mockLoggerIsReady = jest.fn(() => false);
const mockLogCronSuccess = jest.fn();
const mockDiscordLoggerGetInstance = jest.fn(() => ({
  isReady: mockLoggerIsReady,
  logCronSuccess: mockLogCronSuccess,
}));

const mockUserSend = jest.fn();
const mockUsersFetch = jest.fn();

const mockDigestStateFindOne = jest.fn();
const mockDigestStateFindOneAndUpdate = jest.fn();

const mockUserAchievementsFindOne = jest.fn();

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

jest.unstable_mockModule("../../src/services/voice-channel-tracker.js", () => ({
  VoiceChannelTracker: { getInstance: mockTrackerGetInstance },
}));

jest.unstable_mockModule(
  "../../src/services/user-notification-prefs-service.js",
  () => ({
    UserNotificationPrefsService: { getInstance: mockPrefsGetInstance },
  }),
);

jest.unstable_mockModule("../../src/services/achievements-service.js", () => ({
  AchievementsService: { getInstance: mockAchievementsGetInstance },
}));

jest.unstable_mockModule("../../src/services/discord-logger.js", () => ({
  DiscordLogger: { getInstance: mockDiscordLoggerGetInstance },
}));

jest.unstable_mockModule("../../src/models/digest-state.js", () => ({
  DigestState: {
    findOne: mockDigestStateFindOne,
    findOneAndUpdate: mockDigestStateFindOneAndUpdate,
  },
}));

jest.unstable_mockModule("../../src/models/user-achievements.js", () => ({
  UserAchievements: { findOne: mockUserAchievementsFindOne },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { DigestService } = await import(
  "../../src/services/digest-service.js"
);

type ServiceInstance = InstanceType<typeof DigestService>;

function resetSingleton(): void {
  (DigestService as unknown as { instance: unknown }).instance = undefined;
}

function makeClient(): Client {
  return {
    users: { fetch: mockUsersFetch },
  } as unknown as Client;
}

describe("DigestService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSingleton();
    mockConfigGetBoolean.mockImplementation(async (key: unknown) => {
      const k = key as string;
      if (k === "digest.enabled") return true;
      if (k === "digest.include_achievements") return false;
      return false;
    });
    mockConfigGetString.mockImplementation(async (key: unknown) => {
      const k = key as string;
      if (k === "GUILD_ID") return "guild-1";
      if (k === "digest.cron") return "0 9 * * 1";
      return "";
    });
    mockConfigGetNumber.mockImplementation(async (key: unknown, def: unknown) => {
      const k = key as string;
      if (k === "digest.min_active_minutes") return 30;
      if (k === "digest.streak_min_minutes") return 30;
      return (def as number) ?? 0;
    });
    mockGetPrefs.mockResolvedValue({
      achievements: true,
      digest: true,
      rewind: true,
    });
    mockGetTimezone.mockResolvedValue(null);
    mockGetPrefsWithTimezone.mockResolvedValue({
      prefs: { achievements: true, digest: true, rewind: true },
      timezone: null,
    });
    mockDigestStateFindOne.mockResolvedValue(null);
    mockDigestStateFindOneAndUpdate.mockResolvedValue({});
    mockUserAchievementsFindOne.mockResolvedValue(null);
    mockUsersFetch.mockImplementation(async (userId: unknown) => ({
      id: userId as string,
      username: `user-${userId as string}`,
      send: mockUserSend,
    }));
    mockUserSend.mockResolvedValue(undefined);
  });

  describe("singleton", () => {
    it("returns the same instance for the same client", () => {
      const client = makeClient();
      const a = DigestService.getInstance(client);
      const b = DigestService.getInstance(client);
      expect(a).toBe(b);
    });

    it("throws when called with a different client", () => {
      DigestService.getInstance(makeClient());
      expect(() => DigestService.getInstance(makeClient())).toThrow(
        /already initialised with a different client/,
      );
    });

    it("registers a reload callback on construction", () => {
      DigestService.getInstance(makeClient());
      expect(mockRegisterReloadCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("runNow guards", () => {
    it("returns null when the feature is disabled", async () => {
      mockConfigGetBoolean.mockResolvedValue(false);
      const svc: ServiceInstance = DigestService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).toBeNull();
      expect(mockGetTopUsers).not.toHaveBeenCalled();
    });

    it("returns null when GUILD_ID is missing", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        if (key === "GUILD_ID") return "";
        return "";
      });
      const svc: ServiceInstance = DigestService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).toBeNull();
      expect(mockGetTopUsers).not.toHaveBeenCalled();
    });
  });

  describe("opt-out enforcement (#483)", () => {
    it("skips users whose prefs.digest is false and does not send a DM", async () => {
      mockGetTopUsers.mockResolvedValue([
        // 60 minutes — clears min_active_minutes=30
        { userId: "u1", username: "u1", totalTime: 60 * 60 },
      ]);
      mockGetPrefsWithTimezone.mockResolvedValue({
        prefs: { achievements: true, digest: false, rewind: true },
        timezone: null,
      });

      const svc: ServiceInstance = DigestService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.qualifying).toBe(1);
      expect(result!.sent).toBe(0);
      expect(result!.skippedOptOut).toBe(1);
      // The DM and the state write are both gated behind the prefs check.
      expect(mockUserSend).not.toHaveBeenCalled();
      expect(mockDigestStateFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("sends a DM and persists DigestState when prefs.digest is true", async () => {
      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 60 * 60 },
      ]);

      const svc: ServiceInstance = DigestService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.sent).toBe(1);
      expect(result!.skippedOptOut).toBe(0);
      expect(mockUserSend).toHaveBeenCalledTimes(1);
      expect(mockDigestStateFindOneAndUpdate).toHaveBeenCalledTimes(1);
      const [filter, update] = mockDigestStateFindOneAndUpdate.mock.calls[0] as [
        Record<string, unknown>,
        { $set: Record<string, unknown> },
      ];
      expect(filter).toEqual({ userId: "u1", guildId: "guild-1" });
      expect(update.$set).toMatchObject({
        userId: "u1",
        guildId: "guild-1",
        lastWeekTotalTime: 60 * 60,
        lastWeekRank: 1,
      });
    });

    it("silently skips users with DMs closed (Discord error 50007)", async () => {
      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 60 * 60 },
      ]);
      const dmError = Object.assign(new Error("DMs closed"), { code: 50007 });
      mockUserSend.mockRejectedValueOnce(dmError);

      const svc: ServiceInstance = DigestService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.sent).toBe(0);
      expect(result!.skippedDmsClosed).toBe(1);
      expect(result!.failed).toBe(0);
      expect(mockDigestStateFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it("filters out users below the min_active_minutes threshold", async () => {
      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 60 * 60 }, // 60 min - qualifies
        { userId: "u2", username: "u2", totalTime: 60 * 5 }, // 5 min - does not
      ]);

      const svc: ServiceInstance = DigestService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.qualifying).toBe(1);
      expect(result!.sent).toBe(1);
      expect(mockGetPrefsWithTimezone).toHaveBeenCalledTimes(1);
      expect(mockGetPrefsWithTimezone).toHaveBeenCalledWith("u1", "guild-1");
    });
  });
});
