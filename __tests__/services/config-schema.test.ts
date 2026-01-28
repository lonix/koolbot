import { describe, it, expect } from "@jest/globals";
import { defaultConfig } from "../../src/services/config-schema.js";

describe("Config Schema", () => {
  describe("defaultConfig", () => {
    it("should have most core features disabled by default for security", () => {
      // Most features start disabled for security
      expect(defaultConfig["voicechannels.enabled"]).toBe(false);
      expect(defaultConfig["voicetracking.enabled"]).toBe(false);
      expect(defaultConfig["ping.enabled"]).toBe(false);
      expect(defaultConfig["amikool.enabled"]).toBe(false);
      expect(defaultConfig["quotes.enabled"]).toBe(false);
    });

    it("should have logging features disabled by default", () => {
      expect(defaultConfig["core.startup.enabled"]).toBe(false);
      expect(defaultConfig["core.errors.enabled"]).toBe(false);
      expect(defaultConfig["core.cleanup.enabled"]).toBe(false);
      expect(defaultConfig["core.config.enabled"]).toBe(false);
      expect(defaultConfig["core.cron.enabled"]).toBe(false);
    });

    it("should have reasonable default values for voice channel settings", () => {
      expect(defaultConfig["voicechannels.category.name"]).toBe(
        "Voice Channels",
      );
      expect(defaultConfig["voicechannels.lobby.name"]).toBe("Lobby");
      expect(defaultConfig["voicechannels.channel.prefix"]).toBe("🎮");
    });

    it("should have reasonable default values for cleanup retention", () => {
      expect(
        defaultConfig["voicetracking.cleanup.retention.detailed_sessions_days"],
      ).toBeGreaterThan(0);
      expect(
        defaultConfig[
          "voicetracking.cleanup.retention.monthly_summaries_months"
        ],
      ).toBeGreaterThan(0);
      expect(
        defaultConfig["voicetracking.cleanup.retention.yearly_summaries_years"],
      ).toBeGreaterThan(0);
    });

    it("should have reasonable default values for quote system", () => {
      expect(defaultConfig["quotes.max_length"]).toBeGreaterThan(0);
      expect(defaultConfig["quotes.cooldown"]).toBeGreaterThanOrEqual(0);
    });

    it("should have valid cron schedule defaults", () => {
      // Default schedules should be strings (even if empty)
      expect(typeof defaultConfig["voicetracking.announcements.schedule"]).toBe(
        "string",
      );
      expect(typeof defaultConfig["voicetracking.cleanup.schedule"]).toBe(
        "string",
      );
    });

    it("should have fun features as boolean values", () => {
      expect(typeof defaultConfig["fun.friendship"]).toBe("boolean");
    });

    it("should have channel_id fields as strings", () => {
      expect(typeof defaultConfig["core.startup.channel_id"]).toBe("string");
      expect(typeof defaultConfig["core.errors.channel_id"]).toBe("string");
      expect(typeof defaultConfig["core.cleanup.channel_id"]).toBe("string");
      expect(typeof defaultConfig["core.config.channel_id"]).toBe("string");
      expect(typeof defaultConfig["core.cron.channel_id"]).toBe("string");
    });

    it("should have string fields for comma-separated values", () => {
      expect(typeof defaultConfig["voicetracking.excluded_channels"]).toBe(
        "string",
      );
      expect(typeof defaultConfig["voicetracking.admin_roles"]).toBe("string");
      expect(typeof defaultConfig["quotes.add_roles"]).toBe("string");
      expect(typeof defaultConfig["quotes.delete_roles"]).toBe("string");
    });

    it("should have voicetracking.excluded_channels default to empty string", () => {
      expect(defaultConfig["voicetracking.excluded_channels"]).toBe("");
    });

    it("should have rate limiting disabled by default for security", () => {
      expect(defaultConfig["ratelimit.enabled"]).toBe(false);
    });

    it("should have reasonable default values for rate limiting", () => {
      expect(defaultConfig["ratelimit.max_commands"]).toBeGreaterThan(0);
      expect(defaultConfig["ratelimit.window_seconds"]).toBeGreaterThan(0);
      expect(typeof defaultConfig["ratelimit.bypass_admin"]).toBe("boolean");
    });

    it("should have gamification enabled by default", () => {
      expect(defaultConfig["gamification.enabled"]).toBe(true);
    });

    it("should have reasonable default values for gamification", () => {
      expect(typeof defaultConfig["gamification.announcements.enabled"]).toBe(
        "boolean",
      );
      expect(
        typeof defaultConfig["gamification.dm_notifications.enabled"],
      ).toBe("boolean");
    });
  });
});
