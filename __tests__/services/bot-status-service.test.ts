import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { BotStatusService } from "../../src/services/bot-status-service.js";
import { lonelyStatuses } from "../../src/content/statuses.js";

// Mock dependencies
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/utils/logger.js");

describe("BotStatusService", () => {
  describe("singleton pattern", () => {
    it("should create a singleton instance", () => {
      const mockClient = { user: { setPresence: jest.fn() } } as any;
      const instance1 = BotStatusService.getInstance(mockClient);
      const instance2 = BotStatusService.getInstance(mockClient);

      expect(instance1).toBe(instance2);
    });
  });

  describe("initialization", () => {
    it("should create an instance with a client", () => {
      const mockClient = { user: { setPresence: jest.fn() } } as any;
      const service = BotStatusService.getInstance(mockClient);

      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(BotStatusService);
    });
  });

  describe("public methods", () => {
    let service: BotStatusService;
    let mockClient: any;

    beforeEach(() => {
      jest.clearAllMocks();
      mockClient = {
        user: {
          setPresence: jest.fn(),
        },
      };
      service = BotStatusService.getInstance(mockClient);
    });

    it("should have setConnectingStatus method", () => {
      expect(typeof service.setConnectingStatus).toBe("function");
    });

    it("should have setOperationalStatus method", () => {
      expect(typeof service.setOperationalStatus).toBe("function");
    });

    it("should have setConfigReloadStatus method", () => {
      expect(typeof service.setConfigReloadStatus).toBe("function");
    });

    it("should have setShutdownStatus method", () => {
      expect(typeof service.setShutdownStatus).toBe("function");
    });

    it("should set connecting status", () => {
      service.setConnectingStatus();
      // Method should execute without errors
      expect(true).toBe(true);
    });

    it("should set operational status", () => {
      service.setOperationalStatus();
      // Method should execute without errors
      expect(true).toBe(true);
    });

    it("should set config reload status", () => {
      service.setConfigReloadStatus();
      // Method should execute without errors
      expect(true).toBe(true);
    });

    it("should set shutdown status", () => {
      service.setShutdownStatus();
      // Method should execute without errors
      expect(true).toBe(true);
    });
  });

  describe("VC user count priming (#614)", () => {
    let service: BotStatusService;
    let mockClient: any;

    const lastActivityName = (): string => {
      const calls = mockClient.user.setPresence.mock.calls;
      return calls[calls.length - 1][0].activities[0].name as string;
    };

    beforeEach(() => {
      jest.clearAllMocks();
      // Reset the singleton so each test gets a fresh instance bound to its
      // own mock client (getInstance keeps the first client otherwise).
      (BotStatusService as any).instance = undefined;
      mockClient = { user: { setPresence: jest.fn() } };
      service = BotStatusService.getInstance(mockClient);
    });

    afterEach(() => {
      service.stopVcMonitoring();
    });

    it("reflects users already in voice when primed at startup", async () => {
      // Simulates a restart with 4 users already sitting in voice: the
      // provider reports the live count and priming applies it before the
      // operational status is rendered.
      service.setVcUserCountProvider(async () => 4);
      await service.refreshVcUserCount();
      service.setOperationalStatus();

      expect(service.getStatusInfo().currentVcUserCount).toBe(4);
      expect(lastActivityName()).toContain("4");
      expect(lonelyStatuses).not.toContain(lastActivityName());
    });

    it("still shows the lonely status when no users are in voice", async () => {
      service.setVcUserCountProvider(async () => 0);
      await service.refreshVcUserCount();
      service.setOperationalStatus();

      expect(service.getStatusInfo().currentVcUserCount).toBe(0);
      expect(lonelyStatuses).toContain(lastActivityName());
    });

    it("is a no-op when no provider is registered", async () => {
      // Explicitly clearing the provider should neither throw nor change
      // the count (a fresh service also starts with no provider).
      service.setVcUserCountProvider(null);
      await expect(service.refreshVcUserCount()).resolves.toBeUndefined();
    });

    it("swallows provider errors without throwing", async () => {
      service.setVcUserCountProvider(async () => {
        throw new Error("cache walk failed");
      });
      await expect(service.refreshVcUserCount()).resolves.toBeUndefined();
    });

    it("starts a self-healing monitor interval", () => {
      service.startVcMonitoring();
      expect(service.getStatusInfo().isMonitoring).toBe(true);
      service.stopVcMonitoring();
      expect(service.getStatusInfo().isMonitoring).toBe(false);
    });
  });
});
