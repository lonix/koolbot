import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import type { ConfigService as ConfigServiceType } from "../../src/services/config-service.js";

const mockFindOne = jest.fn();
const mockFind = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockDeleteOne = jest.fn();
const mockUpdateOne = jest.fn();

jest.unstable_mockModule("../../src/models/config.js", () => ({
  Config: {
    findOne: mockFindOne,
    find: mockFind,
    findOneAndUpdate: mockFindOneAndUpdate,
    deleteOne: mockDeleteOne,
    updateOne: mockUpdateOne,
  },
  CONFIG_CATEGORIES: [
    "achievements",
    "amikool",
    "announcements",
    "core",
    "digest",
    "fun",
    "gamification",
    "help",
    "leaderboard_roles",
    "messagetracking",
    "notices",
    "ping",
    "polls",
    "quotes",
    "ratelimit",
    "reactionroles",
    "reactiontracking",
    "rewind",
    "voicechannels",
    "voicetracking",
    "wizard",
  ],
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

const mongooseMock = {
  connection: {
    readyState: 1,
    on: jest.fn(),
  },
  connect: jest.fn(),
};

jest.unstable_mockModule("mongoose", () => ({
  ...mongooseMock,
  default: mongooseMock,
}));

const { ConfigService } = await import("../../src/services/config-service.js");

describe("ConfigService - Methods", () => {
  let service: ConfigServiceType;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockResolvedValue(null);
    mockFind.mockResolvedValue([]);
    mockFindOneAndUpdate.mockResolvedValue({});
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });

    // Reset environment
    process.env = { ...originalEnv };

    // Reset the singleton so each test gets a fresh instance
    (ConfigService as unknown as { instance: unknown }).instance = undefined;

    service = ConfigService.getInstance();
  });

  afterEach(() => {
    process.env = originalEnv;
    (ConfigService as unknown as { instance: unknown }).instance = undefined;
  });

  describe("get()", () => {
    it("should return value from cache when available", async () => {
      // Pre-populate the cache via set
      mockFindOneAndUpdate.mockResolvedValue({});
      await service.set("test.key", "cached-value", "Test key", "test");

      const result = await service.get("test.key");
      expect(result).toBe("cached-value");
    });

    it("should return value from database when not in cache", async () => {
      mockFindOne.mockResolvedValue({ key: "db.key", value: "db-value" });

      const result = await service.get("db.key");
      expect(result).toBe("db-value");
    });

    it("should return null when key not found anywhere", async () => {
      mockFindOne.mockResolvedValue(null);

      const result = await service.get("nonexistent.key");
      expect(result).toBeNull();
    });

    it("should return boolean true from environment variable", async () => {
      process.env["TEST_BOOL_KEY"] = "true";
      mockFindOne.mockResolvedValue(null);

      const result = await service.get("TEST_BOOL_KEY");
      expect(result).toBe(true);
    });

    it("should return boolean false from environment variable", async () => {
      process.env["TEST_BOOL_FALSE"] = "false";
      mockFindOne.mockResolvedValue(null);

      const result = await service.get("TEST_BOOL_FALSE");
      expect(result).toBe(false);
    });

    it("should return numeric value from environment variable", async () => {
      process.env["TEST_NUM_KEY"] = "42";
      mockFindOne.mockResolvedValue(null);

      const result = await service.get("TEST_NUM_KEY");
      expect(result).toBe(42);
    });

    it("should return string value from environment variable", async () => {
      process.env["TEST_STR_KEY"] = "hello world";
      mockFindOne.mockResolvedValue(null);

      const result = await service.get("TEST_STR_KEY");
      expect(result).toBe("hello world");
    });

    it("should treat empty-string env var as absent (not numeric 0)", async () => {
      process.env["TEST_EMPTY_KEY"] = "";
      mockFindOne.mockResolvedValue(null);

      const result = await service.get("TEST_EMPTY_KEY");
      expect(result).toBeNull();
    });

    it("should treat whitespace-only env var as absent", async () => {
      process.env["TEST_WHITESPACE_KEY"] = "   ";
      mockFindOne.mockResolvedValue(null);

      const result = await service.get("TEST_WHITESPACE_KEY");
      expect(result).toBeNull();
    });

    it("should handle database errors gracefully", async () => {
      mockFindOne.mockRejectedValue(new Error("DB error"));

      const result = await service.get("error.key");
      expect(result).toBeNull();
    });
  });

  describe("getBoolean()", () => {
    it("should return boolean value directly", async () => {
      mockFindOne.mockResolvedValue({ key: "bool.key", value: true });

      const result = await service.getBoolean("bool.key");
      expect(result).toBe(true);
    });

    it("should return false when value is boolean false", async () => {
      mockFindOne.mockResolvedValue({ key: "bool.key", value: false });

      const result = await service.getBoolean("bool.key");
      expect(result).toBe(false);
    });

    it('should convert string "true" to boolean true', async () => {
      mockFindOne.mockResolvedValue({ key: "bool.key", value: "true" });

      const result = await service.getBoolean("bool.key");
      expect(result).toBe(true);
    });

    it('should convert string "false" to boolean false', async () => {
      mockFindOne.mockResolvedValue({ key: "bool.key", value: "false" });

      const result = await service.getBoolean("bool.key");
      expect(result).toBe(false);
    });

    it("should convert non-zero number to true", async () => {
      mockFindOne.mockResolvedValue({ key: "bool.key", value: 1 });

      const result = await service.getBoolean("bool.key");
      expect(result).toBe(true);
    });

    it("should convert zero to false", async () => {
      mockFindOne.mockResolvedValue({ key: "bool.key", value: 0 });

      const result = await service.getBoolean("bool.key");
      expect(result).toBe(false);
    });

    it("should return defaultValue when key not found", async () => {
      mockFindOne.mockResolvedValue(null);

      const result = await service.getBoolean("nonexistent.key", true);
      expect(result).toBe(true);
    });

    it("should return false as default when no defaultValue provided", async () => {
      mockFindOne.mockResolvedValue(null);

      const result = await service.getBoolean("nonexistent.key");
      expect(result).toBe(false);
    });
  });

  describe("getString()", () => {
    it("should return string value directly", async () => {
      mockFindOne.mockResolvedValue({ key: "str.key", value: "hello" });

      const result = await service.getString("str.key");
      expect(result).toBe("hello");
    });

    it("should convert number to string", async () => {
      mockFindOne.mockResolvedValue({ key: "num.key", value: 42 });

      const result = await service.getString("num.key");
      expect(result).toBe("42");
    });

    it("should convert boolean to string", async () => {
      mockFindOne.mockResolvedValue({ key: "bool.key", value: true });

      const result = await service.getString("bool.key");
      expect(result).toBe("true");
    });

    it("should return defaultValue when key not found", async () => {
      mockFindOne.mockResolvedValue(null);

      const result = await service.getString(
        "nonexistent.key",
        "default-value",
      );
      expect(result).toBe("default-value");
    });

    it("should return empty string as default when no defaultValue provided", async () => {
      mockFindOne.mockResolvedValue(null);

      const result = await service.getString("nonexistent.key");
      expect(result).toBe("");
    });
  });

  describe("getNumber()", () => {
    it("should return number value directly", async () => {
      mockFindOne.mockResolvedValue({ key: "num.key", value: 42 });

      const result = await service.getNumber("num.key");
      expect(result).toBe(42);
    });

    it("should convert numeric string to number", async () => {
      mockFindOne.mockResolvedValue({ key: "num.key", value: "123" });

      const result = await service.getNumber("num.key");
      expect(result).toBe(123);
    });

    it("should return defaultValue for non-numeric string", async () => {
      mockFindOne.mockResolvedValue({ key: "str.key", value: "not-a-number" });

      const result = await service.getNumber("str.key", 99);
      expect(result).toBe(99);
    });

    it("should convert boolean true to 1", async () => {
      mockFindOne.mockResolvedValue({ key: "bool.key", value: true });

      const result = await service.getNumber("bool.key");
      expect(result).toBe(1);
    });

    it("should convert boolean false to 0", async () => {
      mockFindOne.mockResolvedValue({ key: "bool.key", value: false });

      const result = await service.getNumber("bool.key");
      expect(result).toBe(0);
    });

    it("should return defaultValue when key not found", async () => {
      mockFindOne.mockResolvedValue(null);

      const result = await service.getNumber("nonexistent.key", 100);
      expect(result).toBe(100);
    });

    it("should return 0 as default when no defaultValue provided", async () => {
      mockFindOne.mockResolvedValue(null);

      const result = await service.getNumber("nonexistent.key");
      expect(result).toBe(0);
    });

    it("should honor defaultValue when env var is set to empty string", async () => {
      process.env["EMPTY_NUM_KEY"] = "";
      mockFindOne.mockResolvedValue(null);

      const result = await service.getNumber("EMPTY_NUM_KEY", 60);
      expect(result).toBe(60);
    });
  });

  describe("set()", () => {
    it("should save value to database and update cache", async () => {
      mockFindOneAndUpdate.mockResolvedValue({});

      await service.set("new.key", "new-value", "New setting", "core");

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { key: "new.key" },
        expect.objectContaining({
          key: "new.key",
          value: "new-value",
          description: "New setting",
          category: "core",
        }),
        { upsert: true, new: true },
      );

      // Verify the cache was updated
      const result = await service.get("new.key");
      expect(result).toBe("new-value");
    });

    it("should throw when database operation fails", async () => {
      mockFindOneAndUpdate.mockRejectedValue(new Error("DB write error"));

      await expect(
        service.set("error.key", "value", "description", "category"),
      ).rejects.toThrow("DB write error");
    });
  });

  describe("delete()", () => {
    it("should delete key from database and cache", async () => {
      // First set a value in cache
      mockFindOneAndUpdate.mockResolvedValue({});
      await service.set("delete.key", "value", "description", "test");

      mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
      mockFindOne.mockResolvedValue(null);

      await service.delete("delete.key");

      expect(mockDeleteOne).toHaveBeenCalledWith({ key: "delete.key" });

      // Verify the cache was cleared (get should not return cached value)
      const result = await service.get("delete.key");
      expect(result).toBeNull();
    });

    it("should throw when database operation fails", async () => {
      mockDeleteOne.mockRejectedValue(new Error("DB delete error"));

      await expect(service.delete("error.key")).rejects.toThrow(
        "DB delete error",
      );
    });
  });

  describe("getAll()", () => {
    it("should return all configs from database", async () => {
      const mockConfigs = [
        { key: "key1", value: "val1", category: "test" },
        { key: "key2", value: "val2", category: "core" },
      ];
      mockFind.mockReturnValue({
        sort: jest.fn().mockResolvedValue(mockConfigs),
      });

      const result = await service.getAll();
      expect(result).toEqual(mockConfigs);
    });
  });

  describe("triggerReload()", () => {
    it("should clear cache and reinitialize", async () => {
      mockFind.mockResolvedValue([]);

      // First set the service as initialized (to test that it resets)
      (service as unknown as { initialized: boolean }).initialized = true;

      await service.triggerReload();

      // After reload, initialized should be true again (it re-initialized)
      expect((service as unknown as { initialized: boolean }).initialized).toBe(
        true,
      );
    });

    it("should call registered reload callbacks", async () => {
      mockFind.mockResolvedValue([]);
      const callback = jest.fn().mockResolvedValue(undefined);

      service.registerReloadCallback(callback);
      await service.triggerReload();

      expect(callback).toHaveBeenCalled();
    });

    it("should handle callback errors gracefully", async () => {
      mockFind.mockResolvedValue([]);
      const failingCallback = jest
        .fn()
        .mockRejectedValue(new Error("Callback failed"));

      service.registerReloadCallback(failingCallback);
      // Should not throw even if callback fails
      await expect(service.triggerReload()).resolves.not.toThrow();
    });

    it("should remove reload callback correctly", async () => {
      mockFind.mockResolvedValue([]);
      const callback = jest.fn().mockResolvedValue(undefined);

      service.registerReloadCallback(callback);
      service.removeReloadCallback(callback);
      await service.triggerReload();

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("initialize()", () => {
    it("should skip initialization if already initialized", async () => {
      mockFind.mockResolvedValue([]);

      // First initialization
      await service.initialize();
      const callCount = mockFind.mock.calls.length;

      // Second initialization - should skip
      await service.initialize();
      expect(mockFind.mock.calls.length).toBe(callCount);
    });

    it("should load configs from database on initialization", async () => {
      // Use a key that exists in defaultConfig so cleanupUnknownSettings doesn't evict it
      mockFind.mockResolvedValue([
        {
          key: "voicechannels.enabled",
          value: true,
          category: "voicechannels",
        },
      ]);

      await service.initialize();

      const result = await service.get("voicechannels.enabled");
      expect(result).toBe(true);
    });

    it("should prioritize critical env settings over database", async () => {
      process.env["GUILD_ID"] = "env-guild-123";

      mockFind.mockResolvedValue([{ key: "GUILD_ID", value: "db-guild-456" }]);

      // Reset so we can re-initialize with the new env
      (service as unknown as { initialized: boolean }).initialized = false;

      await service.initialize();

      // Env value should take priority
      const result = await service.get("GUILD_ID");
      expect(result).toBe("env-guild-123");

      delete process.env["GUILD_ID"];
    });
  });
});
