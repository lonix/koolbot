import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { setImmediate } from "node:timers";
import type { Client } from "discord.js";

// The base class registers a config reload callback in its constructor, so
// ConfigService has to be mocked before the module under test is imported.
const mockRegisterReloadCallback = jest.fn<(cb: () => Promise<void>) => void>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: mockRegisterReloadCallback,
      getBoolean: jest.fn(),
      getString: jest.fn(),
      getNumber: jest.fn(),
    })),
  },
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: mockLogger,
}));

// Keep the real `CronTime` so cron expressions are validated for real, but
// stub `CronJob` so no test ever arms a live timer. Reading `CronTime` out of
// the real module here is safe: what decides whether the service gets the stub
// is that `unstable_mockModule` runs before `scheduled-service.js` is imported
// below, not whether the real module was loaded first — the two live in
// separate registries. "arms a job on the resolved schedule" is the canary: it
// asserts the stub was constructed, so it fails if the real `CronJob` leaks in.
const { CronTime } = await import("cron");
const mockJobStart = jest.fn();
const mockJobStop = jest.fn();
let lastTick: (() => void) | undefined;
const mockCronJob = jest.fn((expression: unknown, onTick: unknown) => {
  lastTick = onTick as () => void;
  return {
    start: mockJobStart,
    stop: mockJobStop,
    nextDate: () => ({ toLocaleString: () => "2026-01-01, 00:00:00" }),
  };
});
jest.unstable_mockModule("cron", () => ({
  CronJob: mockCronJob,
  CronTime,
}));

const { ScheduledService } =
  await import("../../src/services/scheduled-service.js");

const CLIENT = {} as Client;

/** Let every pending microtask settle before asserting. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * A minimal concrete service. Every knob a subclass controls is a mutable
 * field so a test can steer enablement, schedule and run outcome without
 * defining a new class each time.
 */
class TestService extends ScheduledService<string> {
  public enabled = true;
  public schedule = "0 9 * * *";
  public runs = 0;
  public runResult: string | Error = "done";
  /** Resolves the in-flight run, for the coalescing tests. */
  public release: (() => void) | undefined;

  public constructor() {
    super(CLIENT, {
      label: "Test service",
      disabledMessage: "Testing is disabled",
      cronContext: "tests",
      runLabel: "Test run",
    });
  }

  protected async isEnabled(): Promise<boolean> {
    return this.enabled;
  }

  protected async resolveSchedule(): Promise<string> {
    return this.schedule;
  }

  protected async runOnce(): Promise<string> {
    this.runs += 1;
    if (this.release) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    if (this.runResult instanceof Error) throw this.runResult;
    return this.runResult;
  }
}

describe("ScheduledService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lastTick = undefined;
  });

  describe("start", () => {
    it("arms a job on the resolved schedule", async () => {
      const service = new TestService();
      service.schedule = "0 9 * * 1";

      await service.start();

      expect(mockCronJob).toHaveBeenCalledTimes(1);
      expect(mockCronJob.mock.calls[0][0]).toBe("0 9 * * 1");
      expect(mockJobStart).toHaveBeenCalledTimes(1);
    });

    it("strips the quotes a .env-sourced schedule arrives wrapped in", async () => {
      const service = new TestService();
      service.schedule = '"0 9 * * *"';

      await service.start();

      expect(mockCronJob.mock.calls[0][0]).toBe("0 9 * * *");
    });

    it("arms nothing when the feature is disabled", async () => {
      const service = new TestService();
      service.enabled = false;

      await service.start();

      expect(mockCronJob).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith("Testing is disabled");
    });

    it("arms nothing on an invalid cron expression, and does not throw", async () => {
      const service = new TestService();
      service.schedule = "not a cron expression";

      await expect(service.start()).resolves.toBeUndefined();

      expect(mockCronJob).not.toHaveBeenCalled();
      // Exactly one line, emitted by `validateCronExpression` against the
      // configured context — the lifecycle must not log the rejection again.
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(mockLogger.error.mock.calls[0][0]).toContain(
        "Invalid cron expression for tests",
      );
    });

    it("is idempotent — a second start does not stack a second job", async () => {
      const service = new TestService();

      await service.start();
      await service.start();

      expect(mockCronJob).toHaveBeenCalledTimes(1);
    });

    it("re-arms after a start that was skipped because the feature was off", async () => {
      const service = new TestService();
      service.enabled = false;
      await service.start();

      // A disabled start still marks the service initialized, so getting the
      // job armed later goes through reload() — the path /config reload takes.
      service.enabled = true;
      await service.reload();

      expect(mockCronJob).toHaveBeenCalledTimes(1);
    });

    it("rethrows when the enablement lookup fails", async () => {
      const service = new TestService();
      jest
        .spyOn(
          service as unknown as { isEnabled: () => Promise<boolean> },
          "isEnabled",
        )
        .mockRejectedValue(new Error("mongo is down"));

      await expect(service.start()).rejects.toThrow("mongo is down");
    });
  });

  describe("reload and destroy", () => {
    it("replaces the job on reload rather than stacking one", async () => {
      const service = new TestService();

      await service.start();
      await service.reload();

      expect(mockJobStop).toHaveBeenCalledTimes(1);
      expect(mockCronJob).toHaveBeenCalledTimes(2);
      expect(mockJobStart).toHaveBeenCalledTimes(2);
    });

    it("picks up a changed schedule on reload", async () => {
      const service = new TestService();
      await service.start();

      service.schedule = "*/5 * * * *";
      await service.reload();

      expect(mockCronJob.mock.calls[1][0]).toBe("*/5 * * * *");
    });

    it("stops the job on destroy", async () => {
      const service = new TestService();

      await service.start();
      service.destroy();

      expect(mockJobStop).toHaveBeenCalledTimes(1);
    });

    it("can be started again after being destroyed", async () => {
      const service = new TestService();

      await service.start();
      service.destroy();
      await service.start();

      expect(mockCronJob).toHaveBeenCalledTimes(2);
    });

    it("tolerates destroy before start", () => {
      const service = new TestService();

      expect(() => service.destroy()).not.toThrow();
      expect(mockJobStop).not.toHaveBeenCalled();
    });
  });

  describe("runNow", () => {
    it("returns what the run reports", async () => {
      const service = new TestService();

      await expect(service.runNow()).resolves.toBe("done");
      expect(service.runs).toBe(1);
    });

    it("does no work when the feature is disabled", async () => {
      const service = new TestService();
      service.enabled = false;

      await expect(service.runNow()).resolves.toBeNull();
      expect(service.runs).toBe(0);
    });

    it("coalesces concurrent callers onto the run already in flight", async () => {
      const service = new TestService();
      service.release = () => {};

      const first = service.runNow();
      const second = service.runNow();
      // Let the first call reach the release latch before unblocking it.
      await flush();
      service.release?.();

      await expect(first).resolves.toBe("done");
      await expect(second).resolves.toBe("done");
      expect(service.runs).toBe(1);
    });

    it("runs again once the previous run has finished", async () => {
      const service = new TestService();

      await service.runNow();
      await service.runNow();

      expect(service.runs).toBe(2);
    });

    it("propagates a failing run to its caller", async () => {
      const service = new TestService();
      service.runResult = new Error("run blew up");

      await expect(service.runNow()).rejects.toThrow("run blew up");
      // The in-flight slot is released, so the next run is not wedged out.
      service.runResult = "done";
      await expect(service.runNow()).resolves.toBe("done");
    });
  });

  describe("the cron tick", () => {
    // `CronJob` does not await its callback, so the tick is fire-and-forget:
    // let the queue drain before asserting on what it did.
    it("runs the work", async () => {
      const service = new TestService();
      await service.start();

      lastTick?.();
      await flush();

      expect(service.runs).toBe(1);
    });

    it("swallows a failing run so it cannot become an unhandled rejection", async () => {
      const service = new TestService();
      service.runResult = new Error("run blew up");
      await service.start();

      expect(() => lastTick?.()).not.toThrow();
      await flush();

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Test service: scheduled run failed:",
        expect.any(Error),
      );
    });
  });

  describe("the config reload callback", () => {
    const reloadCallback = (): (() => Promise<void>) =>
      mockRegisterReloadCallback.mock.calls[0][0];

    it("is registered once, on construction", () => {
      new TestService();

      expect(mockRegisterReloadCallback).toHaveBeenCalledTimes(1);
    });

    it("arms the job when the feature has been turned on", async () => {
      const service = new TestService();
      service.enabled = false;
      await service.start();

      service.enabled = true;
      await reloadCallback()();

      expect(mockCronJob).toHaveBeenCalledTimes(1);
      expect(mockJobStart).toHaveBeenCalledTimes(1);
    });

    it("stops the job when the feature has been turned off", async () => {
      const service = new TestService();
      await service.start();

      service.enabled = false;
      await reloadCallback()();

      expect(mockJobStop).toHaveBeenCalledTimes(1);
    });

    it("does not stack jobs when it fires repeatedly", async () => {
      const service = new TestService();
      await service.start();

      await reloadCallback()();
      await reloadCallback()();

      expect(mockCronJob).toHaveBeenCalledTimes(3);
      expect(mockJobStop).toHaveBeenCalledTimes(2);
    });

    it("logs rather than throws when reloading fails, so other services still reload", async () => {
      const service = new TestService();
      jest
        .spyOn(
          service as unknown as { isEnabled: () => Promise<boolean> },
          "isEnabled",
        )
        .mockRejectedValue(new Error("mongo is down"));

      await expect(reloadCallback()()).resolves.toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Error reloading test service after configuration change:",
        expect.any(Error),
      );
    });
  });
});
