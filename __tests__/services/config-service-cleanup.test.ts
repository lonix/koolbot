import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// Create mock functions
const mockFind = jest.fn();
const mockDeleteOne = jest.fn();

// Mock the Config model before importing anything
jest.mock("../../src/models/config.js", () => ({
  Config: {
    find: mockFind,
    deleteOne: mockDeleteOne,
    findOne: jest.fn(),
  },
}));

// Mock logger before importing anything
jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock mongoose
jest.mock("mongoose", () => ({
  connection: {
    readyState: 1,
  },
  connect: jest.fn(),
}));

// Import after mocking
import { ConfigService } from "../../src/services/config-service.js";

describe("ConfigService - Cleanup Unknown Settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFind.mockResolvedValue([]);
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
  });

  // Note: ConfigService is a singleton, so tests share the same instance.
  // This is intentional - we're testing that the service handles various
  // database states correctly across multiple initializations.

  describe("cleanupUnknownSettings", () => {
    it("should initialize without errors when no settings exist", async () => {
      mockFind.mockResolvedValue([]);
      const service = ConfigService.getInstance();

      await expect(service.initialize()).resolves.not.toThrow();
    });

    it("should initialize without errors when valid settings exist", async () => {
      const mockSettings = [
        {
          key: "voicechannels.enabled",
          value: true,
          category: "voicechannels",
          description: "Valid",
        },
        {
          key: "quotes.enabled",
          value: false,
          category: "quotes",
          description: "Valid",
        },
      ];

      mockFind.mockResolvedValue(mockSettings);
      const service = ConfigService.getInstance();

      await expect(service.initialize()).resolves.not.toThrow();
    });

    it("should initialize without errors when old migration keys exist", async () => {
      const mockSettings = [
        {
          key: "ENABLE_VC_MANAGEMENT",
          value: true,
          category: "voicechannels",
          description: "Old key being migrated",
        },
        {
          key: "VC_CATEGORY_NAME",
          value: "Voice",
          category: "voicechannels",
          description: "Old key being migrated",
        },
      ];

      mockFind.mockResolvedValue(mockSettings);
      const service = ConfigService.getInstance();

      await expect(service.initialize()).resolves.not.toThrow();
    });

    it("should initialize without errors when unknown settings exist", async () => {
      const mockSettings = [
        {
          key: "unknown.setting.old",
          value: "something",
          category: "unknown",
          description: "Unknown old setting",
        },
      ];

      mockFind.mockResolvedValue(mockSettings);
      const service = ConfigService.getInstance();

      await expect(service.initialize()).resolves.not.toThrow();
    });

    it("should handle database errors during cleanup gracefully", async () => {
      mockFind.mockRejectedValue(new Error("Database connection error"));
      const service = ConfigService.getInstance();

      // Should not throw - errors should be logged but not fail startup
      await expect(service.initialize()).resolves.not.toThrow();
    });

    it("should handle deletion errors gracefully", async () => {
      const mockSettings = [
        {
          key: "unknown.setting",
          value: "test",
          category: "unknown",
          description: "Unknown",
        },
      ];

      mockFind.mockResolvedValue(mockSettings);
      mockDeleteOne.mockRejectedValue(new Error("Delete failed"));
      const service = ConfigService.getInstance();

      // Should not throw - deletion errors should be logged but not fail startup
      await expect(service.initialize()).resolves.not.toThrow();
    });

    it("should initialize successfully with mixed valid and invalid settings", async () => {
      const mockSettings = [
        {
          key: "voicechannels.enabled",
          value: true,
          category: "voicechannels",
          description: "Valid",
        },
        {
          key: "unknown.old.setting",
          value: "test",
          category: "unknown",
          description: "Unknown",
        },
        {
          key: "quotes.enabled",
          value: false,
          category: "quotes",
          description: "Valid",
        },
      ];

      mockFind.mockResolvedValue(mockSettings);
      const service = ConfigService.getInstance();

      await expect(service.initialize()).resolves.not.toThrow();
    });
  });
});
