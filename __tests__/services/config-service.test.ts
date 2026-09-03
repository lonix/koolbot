import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { ConfigService } from "../../src/services/config-service.js";

// Mock dependencies
jest.mock("../../src/models/config.js");
jest.mock("../../src/utils/logger.js");
jest.mock("mongoose");

describe("ConfigService", () => {
  let service: ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = ConfigService.getInstance();
  });

  describe("singleton pattern", () => {
    it("should create a singleton instance", () => {
      const instance1 = ConfigService.getInstance();
      const instance2 = ConfigService.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe("initialization", () => {
    it("should create an instance", () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(ConfigService);
    });
  });

  describe("public methods", () => {
    it("should have setClient method", () => {
      expect(typeof service.setClient).toBe("function");
    });

    it("should have registerReloadCallback method", () => {
      expect(typeof service.registerReloadCallback).toBe("function");
    });

    it("should have removeReloadCallback method", () => {
      expect(typeof service.removeReloadCallback).toBe("function");
    });

    it("should have triggerReload method", () => {
      expect(typeof service.triggerReload).toBe("function");
    });

    it("should have initialize method", () => {
      expect(typeof service.initialize).toBe("function");
    });

    it("should have getBoolean method", () => {
      expect(typeof service.getBoolean).toBe("function");
    });

    it("should have getString method", () => {
      expect(typeof service.getString).toBe("function");
    });

    it("should have getNumber method", () => {
      expect(typeof service.getNumber).toBe("function");
    });

    it("should have set method", () => {
      expect(typeof service.set).toBe("function");
    });

    it("should have getAll method", () => {
      expect(typeof service.getAll).toBe("function");
    });
  });

  describe("client management", () => {
    it("should store the client for later reload notifications", () => {
      const mockClient = { user: { id: "123" } } as any;
      service.setClient(mockClient);

      expect((service as any).client).toBe(mockClient);
    });
  });

  describe("callback management", () => {
    /** The set `triggerReload` iterates; asserted directly so the tests
     * don't have to run a full reload (which would hit Mongo). */
    const callbacks = (): Set<unknown> =>
      (service as any).reloadCallbacks as Set<unknown>;

    it("should register a reload callback exactly once", () => {
      const callback = jest.fn(async () => {});
      service.registerReloadCallback(callback);
      service.registerReloadCallback(callback);

      expect(callbacks().has(callback)).toBe(true);
      // A double registration must not fire the callback twice per reload.
      expect([...callbacks()].filter((c) => c === callback)).toHaveLength(1);

      service.removeReloadCallback(callback);
    });

    it("should remove a reload callback", () => {
      const callback = jest.fn(async () => {});
      service.registerReloadCallback(callback);
      service.removeReloadCallback(callback);

      expect(callbacks().has(callback)).toBe(false);
    });

    it("should ignore removal of a callback that was never registered", () => {
      const registered = jest.fn(async () => {});
      const stranger = jest.fn(async () => {});
      service.registerReloadCallback(registered);

      service.removeReloadCallback(stranger);

      expect(callbacks().has(registered)).toBe(true);
      service.removeReloadCallback(registered);
    });
  });
});
