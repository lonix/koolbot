import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { CommandManager } from "../../src/services/command-manager.js";
import { PermissionsService } from "../../src/services/permissions-service.js";

// Mock dependencies
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/monitoring-service.js");
jest.mock("../../src/services/cooldown-manager.js");
jest.mock("../../src/services/permissions-service.js");
jest.mock("../../src/utils/logger.js");

describe("CommandManager", () => {
  let service: CommandManager;
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    CommandManager.reset();
    PermissionsService.reset();
    mockClient = {
      user: { id: "123" },
      application: { id: "456" },
    };
    service = CommandManager.getInstance(mockClient);
  });

  describe("singleton pattern", () => {
    it("should create a singleton instance", () => {
      const instance1 = CommandManager.getInstance(mockClient);
      const instance2 = CommandManager.getInstance(mockClient);

      expect(instance1).toBe(instance2);
    });
  });

  describe("initialization", () => {
    it("should create an instance with a client", () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(CommandManager);
    });
  });

  describe("public methods", () => {
    it("should have initialize method", () => {
      expect(typeof service.initialize).toBe("function");
    });

    it("should have registerCommands method", () => {
      expect(typeof service.registerCommands).toBe("function");
    });

    it("should have populateClientCommands method", () => {
      expect(typeof service.populateClientCommands).toBe("function");
    });

    it("should have unregisterCommands method", () => {
      expect(typeof service.unregisterCommands).toBe("function");
    });

    it("should have executeCommand method", () => {
      expect(typeof service.executeCommand).toBe("function");
    });
  });

  describe("command collection", () => {
    it("should start with an empty command collection", () => {
      // `populateClientCommands()` is what fills this; a fresh manager must
      // not carry commands over from a previous instance.
      const commands = (service as any).commands;
      expect(commands).toBeDefined();
      expect(commands.size).toBe(0);
    });
  });

  describe("makeDiscordApiCall timeout retries", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("retries a timed-out call by default", async () => {
      jest.useFakeTimers();
      const call = jest
        .fn<() => Promise<string>>()
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce("ok");
      const p = service.makeDiscordApiCall(call, "op", 10, 2);
      await jest.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toBe("ok");
      expect(call).toHaveBeenCalledTimes(2);
    });

    it("runs once and fails clearly when retryOnTimeout is false", async () => {
      jest.useFakeTimers();
      const call = jest
        .fn<() => Promise<string>>()
        .mockImplementation(() => new Promise(() => undefined));
      const p = service.makeDiscordApiCall(call, "op", 10, 3, false);
      const assertion = expect(p).rejects.toThrow(/not retried/);
      await jest.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(call).toHaveBeenCalledTimes(1);
    });
  });
});
