import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

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
    "birthdays",
    "celebrations",
    "core",
    "digest",
    "events",
    "fun",
    "gamification",
    "help",
    "leaderboard_roles",
    "messagetracking",
    "moderation",
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
const { ConfigService } = await import("../../src/services/config-service.js");

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

    // #834: `celebrations.*` rows were purged on every restart because the
    // category was declared in settingsMetadata but missing from
    // CONFIG_CATEGORIES, so Marquee Celebrations silently turned itself off.
    it("should not delete valid celebrations.* settings (#834)", async () => {
      const mockSettings = [
        {
          key: "celebrations.enabled",
          value: true,
          category: "celebrations",
          description: "Milestone celebrations enabled",
        },
        {
          key: "celebrations.channel_id",
          value: "123456789012345678",
          category: "celebrations",
          description: "Milestone celebrations channel",
        },
      ];
      mockFind.mockResolvedValue(mockSettings);

      const service = ConfigService.getInstance();
      await service.initialize();

      expect(mockDeleteOne).not.toHaveBeenCalled();
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    // Legacy categories that still have an active normalization mapping must
    // continue to be remapped rather than left in their legacy form.
    it("should still normalize legacy gamification category to achievements", async () => {
      mockFind.mockResolvedValue([
        {
          // A known legacy key (in knownOldKeys) carrying the legacy category.
          key: "gamification.enabled",
          value: true,
          category: "gamification",
          description: "Legacy",
        },
      ]);

      const service = ConfigService.getInstance();
      await service.initialize();

      // It should be category-fixed, not deleted.
      const deletedKeys = mockDeleteOne.mock.calls.map(
        (call) => (call[0] as { key: string }).key,
      );
      expect(deletedKeys).not.toContain("gamification.enabled");

      const updates = mockUpdateOne.mock.calls.map((call) => ({
        key: (call[0] as { key: string }).key,
        set: (call[1] as { $set: { category: string } }).$set,
      }));
      expect(updates).toContainEqual({
        key: "gamification.enabled",
        set: { category: "achievements" },
      });
    });

    // Regression test for #838: the voice-tracking cleanup timestamp was not
    // allowlisted, so it was purged as "unknown" on every startup and the
    // "at most once per 24h" guard reset after any restart. Its
    // message-tracking counterpart was already handled; both must survive.
    it("should not delete cleanup last_run bookkeeping keys (#838)", async () => {
      mockFind.mockResolvedValue([
        {
          key: "voicetracking.cleanup.last_run",
          value: "2026-08-20T08:00:00.000Z",
          category: "voicetracking",
          description: "Last cleanup execution timestamp",
        },
        {
          key: "messagetracking.cleanup.last_run",
          value: "2026-08-20T08:00:00.000Z",
          category: "messagetracking",
          description: "Last message-tracking cleanup execution timestamp",
        },
        // A genuinely unknown key that should still be removed.
        {
          key: "bogus.setting",
          value: "x",
          category: "bogus",
          description: "Bogus",
        },
      ]);

      const service = ConfigService.getInstance();
      await service.initialize();

      const deletedKeys = mockDeleteOne.mock.calls.map(
        (call) => (call[0] as { key: string }).key,
      );
      expect(deletedKeys).not.toContain("voicetracking.cleanup.last_run");
      expect(deletedKeys).not.toContain("messagetracking.cleanup.last_run");
      expect(deletedKeys).toContain("bogus.setting");
      // Their categories are already valid, so nothing is rewritten either.
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    // Every key the bot itself persists via ConfigService.set() with a literal
    // key must be declared in defaultConfig or in the knownOldKeys allowlist;
    // otherwise the startup sweep silently deletes it on the next boot. This
    // scans src/ so a newly introduced bookkeeping key cannot regress the way
    // voicetracking.cleanup.last_run did (#838).
    it("should keep every literal key written via ConfigService.set() in src/", async () => {
      const testDir = path.dirname(fileURLToPath(import.meta.url));
      const srcDir = path.resolve(testDir, "../../src");
      const tsFiles = (
        fs.readdirSync(srcDir, { recursive: true }) as string[]
      ).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));

      const writtenKeys = new Set<string>();
      const setCall =
        /[cC]onfigService(?:\.getInstance\(\))?\s*\.set\(\s*"([^"]+)"/g;
      for (const file of tsFiles) {
        const source = fs.readFileSync(path.join(srcDir, file), "utf-8");
        for (const match of source.matchAll(setCall)) {
          writtenKeys.add(match[1]);
        }
      }
      // Sanity check: the scan must actually find the known call sites.
      expect(writtenKeys).toContain("voicetracking.cleanup.last_run");
      expect(writtenKeys).toContain("messagetracking.cleanup.last_run");

      mockFind.mockResolvedValue(
        [...writtenKeys].map((key) => ({
          key,
          value: "x",
          category: key.split(".")[0],
          description: "Written by the bot",
        })),
      );

      const service = ConfigService.getInstance();
      await service.initialize();

      const deletedKeys = mockDeleteOne.mock.calls.map(
        (call) => (call[0] as { key: string }).key,
      );
      expect(deletedKeys).toEqual([]);
    });
  });
});
