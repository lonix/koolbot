import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { VoiceChannelTruncationService } from "../../src/services/voice-channel-truncation.js";
import { ConfigService } from "../../src/services/config-service.js";

// Mock dependencies
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/models/voice-channel-tracking.js");

describe("VoiceChannelTruncationService", () => {
  let service: VoiceChannelTruncationService;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      user: { id: "123" },
    };
    service = VoiceChannelTruncationService.getInstance(mockClient);
  });

  describe("singleton pattern", () => {
    it("should create a singleton instance", () => {
      const instance1 = VoiceChannelTruncationService.getInstance(mockClient);
      const instance2 = VoiceChannelTruncationService.getInstance(mockClient);

      expect(instance1).toBe(instance2);
    });
  });

  describe("initialization", () => {
    it("should create an instance with a client", () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(VoiceChannelTruncationService);
    });
  });

  describe("public methods", () => {
    it("should have initialize method", () => {
      expect(typeof service.initialize).toBe("function");
    });

    it("should have runCleanup method", () => {
      expect(typeof service.runCleanup).toBe("function");
    });

    it("should have getStatus method", () => {
      expect(typeof service.getStatus).toBe("function");
    });
  });

  describe("config reload", () => {
    function createServiceWithCapturedReload(enabled: boolean) {
      let reloadCallback: (() => Promise<void>) | undefined;
      const mockConfigService = {
        getString: jest.fn<() => Promise<string>>().mockResolvedValue(""),
        getBoolean: jest.fn<() => Promise<boolean>>().mockResolvedValue(
          enabled,
        ),
        getNumber: jest.fn<() => Promise<number>>().mockResolvedValue(400),
        get: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
        registerReloadCallback: jest.fn((cb: () => Promise<void>) => {
          reloadCallback = cb;
        }),
      };
      jest
        .spyOn(ConfigService, "getInstance")
        .mockReturnValueOnce(mockConfigService as unknown as ConfigService);
      (
        VoiceChannelTruncationService as unknown as { instance: unknown }
      ).instance = undefined;
      const svc = VoiceChannelTruncationService.getInstance(mockClient);
      return { svc, mockConfigService, getReloadCallback: () => reloadCallback };
    }

    function getCleanupJob(
      svc: VoiceChannelTruncationService,
    ): { isActive: boolean; cronTime: { source: unknown } } | null {
      return (
        svc as unknown as {
          cleanupJob: { isActive: boolean; cronTime: { source: unknown } } | null;
        }
      ).cleanupJob;
    }

    it("registers a reload callback that replaces the old cron job with the new schedule", async () => {
      const { svc, mockConfigService, getReloadCallback } =
        createServiceWithCapturedReload(true);

      expect(mockConfigService.registerReloadCallback).toHaveBeenCalledTimes(1);
      const reloadCallback = getReloadCallback();
      expect(reloadCallback).toBeDefined();

      // First reload schedules with cron expression A.
      mockConfigService.getString.mockResolvedValue("0 1 * * *");
      await reloadCallback!();

      const oldJob = getCleanupJob(svc);
      expect(svc.getStatus().isScheduled).toBe(true);
      expect(oldJob?.isActive).toBe(true);
      expect(oldJob?.cronTime.source).toBe("0 1 * * *");

      // Admin changes the schedule to B, then runs /config reload.
      mockConfigService.getString.mockResolvedValue("0 2 * * *");
      await reloadCallback!();

      const newJob = getCleanupJob(svc);
      expect(oldJob?.isActive).toBe(false);
      expect(newJob).not.toBe(oldJob);
      expect(newJob?.isActive).toBe(true);
      expect(newJob?.cronTime.source).toBe("0 2 * * *");
      expect(svc.getStatus().isScheduled).toBe(true);
      svc.destroy();
    });

    it("does not clear the overlap guard of an in-flight cleanup when reloading", async () => {
      const { svc, getReloadCallback } = createServiceWithCapturedReload(true);

      (svc as unknown as { isRunning: boolean }).isRunning = true;
      await getReloadCallback()!();

      expect(svc.getStatus().isRunning).toBe(true);
      expect(svc.getStatus().isScheduled).toBe(true);
      svc.destroy();
    });

    it("stops the cron job when the feature is disabled at reload time", async () => {
      const { svc, getReloadCallback } = createServiceWithCapturedReload(true);
      const configService = (
        svc as unknown as {
          configService: { getBoolean: jest.Mock };
        }
      ).configService;

      await getReloadCallback()!();
      expect(svc.getStatus().isScheduled).toBe(true);

      // Admin disables the feature, then runs /config reload.
      configService.getBoolean.mockResolvedValue(false as never);
      await getReloadCallback()!();

      expect(svc.getStatus().isScheduled).toBe(false);
      svc.destroy();
    });
  });
});
