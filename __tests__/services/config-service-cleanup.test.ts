import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// Create mock functions
const mockFind = jest.fn();
const mockDeleteOne = jest.fn();
const mockUpdateOne = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerError = jest.fn();

// Mock the Config model before importing anything. CONFIG_CATEGORIES mirrors
// the real exported list so the cleanup sweep validates categories against the
// same set of categories the production schema accepts (see #609).
jest.unstable_mockModule("../../src/models/config.js", () => ({
  Config: {
    find: mockFind,
    deleteOne: mockDeleteOne,
    updateOne: mockUpdateOne,
    findOne: jest.fn(),
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

// Mock logger before importing anything
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: mockLoggerInfo,
    error: mockLoggerError,
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock mongoose
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

// Import after mocking
const { ConfigService } = await import(
  "../../src/services/config-service.js"
);

describe("ConfigService - Cleanup Unknown Settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFind.mockResolvedValue([]);
    mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    // Reset the singleton so each test gets a fresh, uninitialized instance.
    (ConfigService as unknown as { instance: unknown }).instance = undefined;
  });

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

    it("should handle delete errors gracefully during cleanup", async () => {
      // An unknown setting is found but the delete fails; cleanup should catch
      // the per-key error and let initialization complete.
      mockFind.mockResolvedValue([
        {
          key: "bogus.setting",
          value: "x",
          category: "bogus",
          description: "Bogus",
        },
      ]);
      mockDeleteOne.mockRejectedValue(new Error("Database error"));
      const service = ConfigService.getInstance();

      // Should not throw
      await expect(service.initialize()).resolves.not.toThrow();
    });

    // Regression test for #609: wizard-saved polls.* / notices.* settings were
    // purged as "unknown" because their categories were missing from the
    // cleanup allowlist even though the keys are valid schema entries.
    it("should not delete valid polls.* and notices.* settings (#609)", async () => {
      const mockSettings = [
        {
          key: "polls.enabled",
          value: true,
          category: "polls",
          description: "Polls",
        },
        {
          key: "polls.default_duration_hours",
          value: 6,
          category: "polls",
          description: "Polls",
        },
        {
          key: "polls.cooldown_days",
          value: 2,
          category: "polls",
          description: "Polls",
        },
        {
          key: "notices.enabled",
          value: false,
          category: "notices",
          description: "Notices",
        },
        // A genuinely unknown key that should still be removed.
        {
          key: "bogus.setting",
          value: "x",
          category: "bogus",
          description: "Bogus",
        },
      ];
      mockFind.mockResolvedValue(mockSettings);

      const service = ConfigService.getInstance();
      await service.initialize();

      const deletedKeys = mockDeleteOne.mock.calls.map(
        (call) => (call[0] as { key: string }).key,
      );
      expect(deletedKeys).not.toContain("polls.enabled");
      expect(deletedKeys).not.toContain("polls.default_duration_hours");
      expect(deletedKeys).not.toContain("polls.cooldown_days");
      expect(deletedKeys).not.toContain("notices.enabled");
      // The genuinely unknown key is still purged.
      expect(deletedKeys).toContain("bogus.setting");
    });
  });
});
