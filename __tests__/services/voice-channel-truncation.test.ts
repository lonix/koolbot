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

    it("registers a reload callback that rebuilds the cleanup schedule", async () => {
      const { svc, mockConfigService, getReloadCallback } =
        createServiceWithCapturedReload(true);

      expect(mockConfigService.registerReloadCallback).toHaveBeenCalledTimes(1);
      const reloadCallback = getReloadCallback();
      expect(reloadCallback).toBeDefined();

      await reloadCallback!();

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
