import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Client } from "discord.js";

const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetString = jest.fn();
const mockConfigGetNumber = jest.fn();

const mockGetPrefs = jest.fn();
const mockGetTimezone = jest.fn();
const mockPrefsGetInstance = jest.fn(() => ({
  getPrefs: mockGetPrefs,
  getTimezone: mockGetTimezone,
}));

const mockSnapshotYear = jest.fn();
const mockRewindGetInstance = jest.fn(() => ({
  snapshotYear: mockSnapshotYear,
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

const mockNudgeStateFindOne = jest.fn();
const mockNudgeStateFindOneAndUpdate = jest.fn();

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

jest.unstable_mockModule("../../src/models/rewind-nudge-state.js", () => ({
  RewindNudgeState: {
    findOne: mockNudgeStateFindOne,
    findOneAndUpdate: mockNudgeStateFindOneAndUpdate,
  },
}));

jest.unstable_mockModule("../../src/services/rewind-service.js", () => ({
  RewindService: { getInstance: mockRewindGetInstance },
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
    mockConfigGetBoolean.mockImplementation(
      async (key: unknown, def: unknown) => {
        const k = key as string;
        // Post-#608 the nudge keys off its own toggle; the feature gate
        // (`rewind.enabled`) is only consulted as a backward-compat default.
        if (k === "rewind.nudge.enabled") return true;
        if (k === "rewind.enabled") return true;
        return (def as boolean) ?? false;
      },
    );
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
    mockGetTimezone.mockResolvedValue(null);
    mockSnapshotYear.mockResolvedValue("created");
    mockUsersFetch.mockImplementation(async (userId: unknown) => ({
      id: userId as string,
      username: `user-${userId as string}`,
      send: mockUserSend,
    }));
    mockUserSend.mockResolvedValue(undefined);
    mockTrackingAggregate.mockResolvedValue([]);
    // Default: no prior delivery marker → not a duplicate run.
    mockNudgeStateFindOne.mockResolvedValue(null);
    mockNudgeStateFindOneAndUpdate.mockResolvedValue({});
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
    it("returns null when the nudge is disabled", async () => {
      mockConfigGetBoolean.mockResolvedValue(false);
      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).toBeNull();
      expect(mockTrackingAggregate).not.toHaveBeenCalled();
    });

    it("runs off the dedicated rewind.nudge.enabled toggle (#608)", async () => {
      // Nudge on, feature gate off — the nudge is independent of the page
      // feature, so it must still run.
      mockConfigGetBoolean.mockImplementation(
        async (key: unknown, def: unknown) => {
          const k = key as string;
          if (k === "rewind.nudge.enabled") return true;
          if (k === "rewind.enabled") return false;
          return (def as boolean) ?? false;
        },
      );
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
      ]);
      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).not.toBeNull();
      expect(result!.sent).toBe(1);
    });

    it("falls back to the legacy rewind.enabled value when rewind.nudge.enabled is unset (#608)", async () => {
      // Simulate an install that set the old key before the split: only
      // `rewind.enabled` exists (true), `rewind.nudge.enabled` is unset so
      // `getBoolean` returns the passed default (the legacy value).
      mockConfigGetBoolean.mockImplementation(
        async (key: unknown, def: unknown) => {
          const k = key as string;
          if (k === "rewind.enabled") return true; // legacy nudge opt-in
          if (k === "rewind.nudge.enabled") return def as boolean; // unset
          return (def as boolean) ?? false;
        },
      );
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
      ]);
      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).not.toBeNull();
      expect(result!.sent).toBe(1);
    });

    it("an explicit rewind.nudge.enabled=false wins over a legacy rewind.enabled=true (#608)", async () => {
      mockConfigGetBoolean.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "rewind.enabled") return true; // legacy value present
        if (k === "rewind.nudge.enabled") return false; // explicit opt-out
        return false;
      });
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

    it("sends a DM when prefs.rewind is true and writes the delivery marker", async () => {
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
      ]);

      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.sent).toBe(1);
      expect(mockUserSend).toHaveBeenCalledTimes(1);
      expect(mockNudgeStateFindOneAndUpdate).toHaveBeenCalledTimes(1);
      const [filter, update] =
        mockNudgeStateFindOneAndUpdate.mock.calls[0] as [
          Record<string, unknown>,
          { $set: Record<string, unknown> },
        ];
      const year = new Date().getUTCFullYear();
      expect(filter).toEqual({ userId: "u1", guildId: "guild-1", year });
      expect(update.$set).toMatchObject({
        userId: "u1",
        guildId: "guild-1",
        year,
      });
    });

    it("skips users who have already been nudged this year (one-shot guard)", async () => {
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
      ]);
      mockNudgeStateFindOne.mockResolvedValueOnce({
        userId: "u1",
        guildId: "guild-1",
        year: new Date().getUTCFullYear(),
        sentAt: new Date(),
      });

      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.sent).toBe(0);
      expect(result!.skippedAlreadySent).toBe(1);
      expect(mockUserSend).not.toHaveBeenCalled();
      expect(mockNudgeStateFindOneAndUpdate).not.toHaveBeenCalled();
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
      // Marker is only persisted on successful delivery, so a retry on
      // the next run can pick the user up again.
      expect(mockNudgeStateFindOneAndUpdate).not.toHaveBeenCalled();
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

  describe("completed-year snapshots (#574)", () => {
    it("snapshots each qualifying user for the year and tallies outcomes", async () => {
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
        { _id: "u2", username: "u2", totalTime: 60 * 60 * 3 },
      ]);
      mockSnapshotYear
        .mockResolvedValueOnce("created")
        .mockResolvedValueOnce("exists");

      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();

      const year = new Date().getUTCFullYear();
      expect(mockSnapshotYear).toHaveBeenCalledTimes(2);
      expect(mockSnapshotYear).toHaveBeenCalledWith("u1", "guild-1", year, null);
      expect(result!.snapshotsCreated).toBe(1);
      expect(result!.snapshotsExisting).toBe(1);
    });

    it("snapshots users even when they opted out of the DM", async () => {
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

      expect(result!.skippedOptOut).toBe(1);
      expect(result!.sent).toBe(0);
      // The snapshot is independent of DM delivery — the year is still frozen.
      expect(mockSnapshotYear).toHaveBeenCalledTimes(1);
      expect(result!.snapshotsCreated).toBe(1);
    });

    it("passes the user's timezone through to the snapshot", async () => {
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
      ]);
      mockGetTimezone.mockResolvedValue("America/New_York");

      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      await svc.runNow();

      const year = new Date().getUTCFullYear();
      expect(mockSnapshotYear).toHaveBeenCalledWith(
        "u1",
        "guild-1",
        year,
        "America/New_York",
      );
    });

    it("isolates a snapshot failure without aborting the rest", async () => {
      mockTrackingAggregate.mockResolvedValueOnce([
        { _id: "u1", username: "u1", totalTime: 60 * 60 * 5 },
        { _id: "u2", username: "u2", totalTime: 60 * 60 * 3 },
      ]);
      mockSnapshotYear
        .mockRejectedValueOnce(new Error("mongo exploded"))
        .mockResolvedValueOnce("created");

      const svc: ServiceInstance = RewindNudgeService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.snapshotsFailed).toBe(1);
      expect(result!.snapshotsCreated).toBe(1);
    });
  });
});
