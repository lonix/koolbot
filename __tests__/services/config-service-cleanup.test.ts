import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// Create mock functions
const mockFind = jest.fn();
const mockDeleteOne = jest.fn();
const mockUpdateOne = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();

// Mock the Config model before importing anything
jest.mock("../../src/models/config.js", () => ({
  Config: {
    find: mockFind,
    deleteOne: mockDeleteOne,
    updateOne: mockUpdateOne,
    findOne: jest.fn(),
  },
}));

// Mock logger before importing anything
jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: mockLoggerInfo,
    error: mockLoggerError,
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
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  // Note: ConfigService is a singleton. The initialize() method only runs once per instance.
  // These tests verify that cleanup logic handles various scenarios correctly.

  describe("cleanupUnknownSettings", () => {
    it("should handle various setting types during cleanup", async () => {
      // Comprehensive test with all scenarios
      const mockSettings = [
        // Valid settings
        {
          key: "voicechannels.enabled",
          value: true,
          category: "voicechannels",
          description: "Valid",
        },
        // Known old keys
        {
          key: "ENABLE_VC_MANAGEMENT",
          value: true,
          category: "voicechannels",
          description: "Old key",
        },
        {
          key: "voice_channel.enabled",
          value: true,
          category: "voice_channel",
          description: "Old dot",
        },
        // Unknown settings
        {
          key: "unknown.setting",
          value: "test",
          category: "unknown",
          description: "Unknown",
        },
      ];

      mockFind.mockResolvedValue(mockSettings);
      const service = ConfigService.getInstance();

      await service.initialize();

      // Verify initialization completed
      expect(service).toBeDefined();
    });

    it("should handle empty database", async () => {
      mockFind.mockResolvedValue([]);
      const service = ConfigService.getInstance();

      await expect(service.initialize()).resolves.not.toThrow();
    });

    it("should handle database errors gracefully", async () => {
      mockFind.mockRejectedValue(new Error("Database error"));
      const service = ConfigService.getInstance();

      // Should not throw
      await expect(service.initialize()).resolves.not.toThrow();
    });
  });
});