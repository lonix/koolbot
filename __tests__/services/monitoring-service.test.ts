import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { MonitoringService } from "../../src/services/monitoring-service.js";

// Mock logger
jest.mock("../../src/utils/logger.js");

describe("MonitoringService", () => {
  let service: MonitoringService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = MonitoringService.getInstance();
  });

  describe("singleton pattern", () => {
    it("should create a singleton instance", () => {
      const instance1 = MonitoringService.getInstance();
      const instance2 = MonitoringService.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe("initialization", () => {
    it("should create an instance", () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(MonitoringService);
    });
  });

  describe("public methods", () => {
    it("should have trackCommandStart method", () => {
      expect(typeof service.trackCommandStart).toBe("function");
    });

    it("should have trackCommandEnd method", () => {
      expect(typeof service.trackCommandEnd).toBe("function");
    });

    it("should have trackError method", () => {
      expect(typeof service.trackError).toBe("function");
    });

    it("should have getCommandMetrics method", () => {
      expect(typeof service.getCommandMetrics).toBe("function");
    });

    it("should have getAllCommandMetrics method", () => {
      expect(typeof service.getAllCommandMetrics).toBe("function");
    });

    it("should have getPerformanceMetrics method", () => {
      expect(typeof service.getPerformanceMetrics).toBe("function");
    });

    it("should have getTopCommands method", () => {
      expect(typeof service.getTopCommands).toBe("function");
    });

    it("should have getCommandsWithErrors method", () => {
      expect(typeof service.getCommandsWithErrors).toBe("function");
    });

    it("should have getSlowestCommands method", () => {
      expect(typeof service.getSlowestCommands).toBe("function");
    });

    it("should have formatUptime method", () => {
      expect(typeof service.formatUptime).toBe("function");
    });
  });

  describe("command tracking", () => {
    it("should track command start and return tracking ID", () => {
      const trackingId = service.trackCommandStart("test-command");

      expect(trackingId).toBeDefined();
      expect(typeof trackingId).toBe("string");
      expect(trackingId).toContain("test-command");
    });

    it("should generate unique tracking IDs", () => {
      const id1 = service.trackCommandStart("test-command");
      const id2 = service.trackCommandStart("test-command");

      expect(id1).not.toBe(id2);
    });

    it("should track command completion", () => {
      const trackingId = service.trackCommandStart("test-command");
      service.trackCommandEnd("test-command", trackingId, 100);

      // Method should execute without errors
      expect(true).toBe(true);
    });

    it("should track command errors", () => {
      const error = new Error("Test error");
      service.trackError("test-command", error);

      // Method should execute without errors
      expect(true).toBe(true);
    });

    it("should get command metrics", () => {
      service.trackCommandStart("test-command");
      const metrics = service.getCommandMetrics("test-command");

      expect(metrics).toBeDefined();
    });

    it("should get all command metrics", () => {
      service.trackCommandStart("test-command-1");
      service.trackCommandStart("test-command-2");
      const metrics = service.getAllCommandMetrics();

      expect(Array.isArray(metrics)).toBe(true);
    });
  });

  describe("performance metrics", () => {
    it("should return performance metrics", () => {
      const metrics = service.getPerformanceMetrics();

      expect(metrics).toBeDefined();
      expect(metrics).toHaveProperty("memoryUsage");
      expect(metrics).toHaveProperty("uptime");
      expect(metrics).toHaveProperty("totalCommands");
      expect(metrics).toHaveProperty("totalErrors");
      expect(metrics).toHaveProperty("averageResponseTime");
    });

    it("should have valid memory usage metrics", () => {
      const metrics = service.getPerformanceMetrics();

      expect(metrics.memoryUsage).toHaveProperty("heapUsed");
      expect(metrics.memoryUsage).toHaveProperty("heapTotal");
      expect(metrics.memoryUsage).toHaveProperty("external");
      expect(metrics.memoryUsage).toHaveProperty("rss");
    });

    it("should return top commands", () => {
      const topCommands = service.getTopCommands(5);

      expect(Array.isArray(topCommands)).toBe(true);
    });

    it("should return commands with errors", () => {
      const commandsWithErrors = service.getCommandsWithErrors(3);

      expect(Array.isArray(commandsWithErrors)).toBe(true);
    });

    it("should return slowest commands", () => {
      const slowestCommands = service.getSlowestCommands(3);

      expect(Array.isArray(slowestCommands)).toBe(true);
    });

    it("should format uptime as string", () => {
      const uptime = service.formatUptime();

      expect(typeof uptime).toBe("string");
    });
  });

  describe("destroy", () => {
    let fresh: MonitoringService;

    beforeEach(() => {
      // The outer beforeEach instantiated the singleton with real timers.
      // Destroy it (now that destroy() exists) and reset the singleton
      // before switching to fake timers, so we don't leak the original
      // real interval and don't mix real+fake timer state.
      service.destroy();
      (MonitoringService as any).instance = undefined;

      jest.useFakeTimers();
      fresh = MonitoringService.getInstance();
    });

    afterEach(() => {
      // Make sure each test leaves no live interval before resetting the
      // singleton, even when the test itself didn't call destroy().
      fresh.destroy();
      (MonitoringService as any).instance = undefined;
      jest.useRealTimers();
    });

    it("captures the periodic logging interval handle on construction", () => {
      const handle = (fresh as any).periodicLoggingInterval;
      expect(handle).not.toBeNull();
      expect(handle).toBeDefined();
    });

    it("clears the periodic logging interval and nulls the handle", () => {
      const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");
      const handle = (fresh as any).periodicLoggingInterval;

      fresh.destroy();

      expect(clearIntervalSpy).toHaveBeenCalledWith(handle);
      expect((fresh as any).periodicLoggingInterval).toBeNull();

      clearIntervalSpy.mockRestore();
    });

    it("does not fire the periodic logger after destroy()", () => {
      const getPerfSpy = jest.spyOn(fresh, "getPerformanceMetrics");

      fresh.destroy();
      // Advance well past the 1-hour interval.
      jest.advanceTimersByTime(2 * 60 * 60 * 1000);

      expect(getPerfSpy).not.toHaveBeenCalled();

      getPerfSpy.mockRestore();
    });

    it("is idempotent — repeated calls are safe", () => {
      const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");

      expect(() => {
        fresh.destroy();
        fresh.destroy();
        fresh.destroy();
      }).not.toThrow();

      // Only the first call should have anything to clear: the periodic
      // logging interval and the metrics-flush interval (#648) — two handles.
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
      expect((fresh as any).periodicLoggingInterval).toBeNull();
      expect((fresh as any).flushInterval).toBeNull();

      clearIntervalSpy.mockRestore();
    });
  });
});
