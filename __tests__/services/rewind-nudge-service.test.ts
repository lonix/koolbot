import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Client } from "discord.js";

const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetString = jest.fn();
const mockConfigGetNumber = jest.fn();

const mockGetPrefs = jest.fn();
const mockPrefsGetInstance = jest.fn(() => ({
  getPrefs: mockGetPrefs,
}));

const mockLoggerIsReady = jest.fn(() => false);
const mockLogCronSuccess = jest.fn();
const mockDiscordLoggerGetInstance = jest.fn(() => ({
  isReady: mockLoggerIsReady,
  logCronSuccess: mockLogCronSuccess,
}));

const mockUserSend = jest.fn();
const mockUsersFetch = jest.fn();

const mockTrackingAggregate = jest.fn();

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

jest.unstable_mockModule("../../src/models/voice-channel-tracking.js", () => ({
  VoiceChannelTracking: {
    aggregate: (...args: unknown[]) => mockTrackingAggregate(...args),
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

const { RewindNudgeService } = await import(
  "../../src/services/rewind-nudge-service.js"
);

type ServiceInstance = InstanceType<typeof RewindNudgeService>;

function resetSingleton(): void {
  (RewindNudgeService as unknown as { instance: unknown }).instance = undefined;
}

function makeClient(): Client {
  return {
    users: { fetch: mockUsersFetch },
  } as unknown as Client;
}

describe("RewindNudgeService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSingleton();
    mockConfigGetBoolean.mockImplementation(async (key: unknown) => {
      const k = key as string;
      if (k === "rewind.enabled") return true;
      return false;
    });
    mockConfigGetString.mockImplementation(async (key: unknown) => {
      const k = key as string;
      if (k === "GUILD_ID") return "guild-1";
      if (k === "rewind.cron") return "0 10 30 12 *";
      return "";
    });
    mockConfigGetNumber.mockImplementation(
      async (key: unknown, def: unknown) => {
        const k = key as string;
        if (k === "rewind.min_minutes") return 60;
        return (def as number) ?? 0;
      },
    );
    mockGetPrefs.mockResolvedValue({
      achievements: true,
      digest: true,
      rewind: true,
    });
    mockUsersFetch.mockImplementation(async (userId: unknown) => ({
      id: userId as string,
      username: `user-${userId as string}`,
      send: mockUserSend,
    }));
    mockUserSend.mockResolvedValue(undefined);
    mockTrackingAggregate.mockResolvedValue([]);
  });

  describe("singleton", () => {
    it("returns the same instance for the same client", () => {
      const c = makeClient();
      expect(RewindNudgeService.getInstance(c)).toBe(
        RewindNudgeService.getInstance(c),
      );
    });

    it("throws when called with a different client", () => {
      RewindNudgeService.getInstance(makeClient());
      expect(() => RewindNudgeService.getInstance(makeClient())).toThrow(
        /different client/,
      );
    });

    it("registers a reload callback on construction", () => {
      RewindNudgeService.getInstance(makeClient());
      expect(mockRegisterReloadCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("runNow guards", () => {
    it("returns null when the feature is disabled", async () => {
      mockConfigGetBoolean.mockResolvedValue(false);
      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).toBeNull();
      expect(mockTrackingAggregate).not.toHaveBeenCalled();
    });

    it("returns null when GUILD_ID is missing", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        if (key === "GUILD_ID") return "";
        return "";
      });
      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).toBeNull();
      expect(mockTrackingAggregate).not.toHaveBeenCalled();
    });
  });

  describe("opt-out enforcement (#484)", () => {
    it("skips users whose prefs.rewind is false and does not send a DM", async () => {
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
      ]);
      mockGetPrefs.mockResolvedValue({
        achievements: true,
        digest: true,
        rewind: false,
      });

      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.qualifying).toBe(1);
      expect(result!.sent).toBe(0);
      expect(result!.skippedOptOut).toBe(1);
      expect(mockUserSend).not.toHaveBeenCalled();
    });

    it("sends a DM when prefs.rewind is true", async () => {
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
      ]);

      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.sent).toBe(1);
      expect(mockUserSend).toHaveBeenCalledTimes(1);
    });

    it("silently skips users with DMs closed (Discord error 50007)", async () => {
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
      ]);
      const dmError = Object.assign(new Error("DMs closed"), { code: 50007 });
      mockUserSend.mockRejectedValueOnce(dmError);

      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.sent).toBe(0);
      expect(result!.skippedDmsClosed).toBe(1);
      expect(result!.failed).toBe(0);
    });

    it("counts non-DM-closed errors as failed", async () => {
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
      ]);
      mockUserSend.mockRejectedValueOnce(new Error("transient API error"));

      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.sent).toBe(0);
      expect(result!.failed).toBe(1);
    });
  });
});
