import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction } from "discord.js";

const mockGetBoolean =
  jest.fn<(key: string, def: boolean) => Promise<boolean>>();
const mockGetUserStats = jest.fn<() => Promise<unknown>>();
const mockGetTopUsers = jest.fn<() => Promise<unknown>>();
const mockGetTimezone = jest.fn<() => Promise<string | null>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({ getBoolean: mockGetBoolean }),
  },
}));

jest.unstable_mockModule("../../src/services/voice-channel-tracker.js", () => ({
  VoiceChannelTracker: {
    getInstance: () => ({
      getUserStats: mockGetUserStats,
      getTopUsers: mockGetTopUsers,
    }),
  },
}));

jest.unstable_mockModule(
  "../../src/services/user-notification-prefs-service.js",
  () => ({
    UserNotificationPrefsService: {
      getInstance: () => ({ getTimezone: mockGetTimezone }),
    },
  }),
);

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { data, execute } = await import("../../src/commands/voicestats.js");

function makeUserInteraction(
  period: string | null = "alltime",
): ChatInputCommandInteraction & { reply: jest.Mock } {
  return {
    options: {
      getSubcommand: () => "user",
      getUser: () => null,
      getString: () => period,
      getInteger: () => null,
    },
    user: { id: "user-1", username: "alice" },
    guildId: null,
    client: {},
    reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction & { reply: jest.Mock };
}

describe("VoiceStats Command", () => {
  describe("command metadata", () => {
    it("should have correct command name", () => {
      expect(data.name).toBe("voicestats");
    });

    it("should have a description", () => {
      expect(data.description).toBe(
        "Voice channel statistics and leaderboards",
      );
    });

    it("should be a valid slash command", () => {
      expect(data.toJSON()).toHaveProperty("name", "voicestats");
      expect(data.toJSON()).toHaveProperty("description");
    });

    it("should have two subcommands", () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(2);
    });
  });

  describe("top subcommand", () => {
    it("should have top subcommand", () => {
      const json = data.toJSON();
      const topSubcommand = json.options?.find(
        (opt: any) => opt.name === "top",
      );
      expect(topSubcommand).toBeDefined();
      expect(topSubcommand?.type).toBe(1); // SUB_COMMAND type
      expect(topSubcommand?.description).toBe("Show top voice channel users");
    });

    it("should have optional limit parameter with constraints", () => {
      const json = data.toJSON();
      const topSubcommand = json.options?.find(
        (opt: any) => opt.name === "top",
      );
      const limitOption = topSubcommand?.options?.find(
        (opt: any) => opt.name === "limit",
      );
      expect(limitOption).toBeDefined();
      expect(limitOption?.required).toBe(false);
      expect(limitOption?.min_value).toBe(1);
      expect(limitOption?.max_value).toBe(50);
    });

    it("should have optional period parameter with choices", () => {
      const json = data.toJSON();
      const topSubcommand = json.options?.find(
        (opt: any) => opt.name === "top",
      );
      const periodOption = topSubcommand?.options?.find(
        (opt: any) => opt.name === "period",
      );
      expect(periodOption).toBeDefined();
      expect(periodOption?.required).toBe(false);
      expect(periodOption?.choices).toBeDefined();
      expect(periodOption?.choices?.length).toBe(3);
    });
  });

  describe("user subcommand", () => {
    it("should have user subcommand", () => {
      const json = data.toJSON();
      const userSubcommand = json.options?.find(
        (opt: any) => opt.name === "user",
      );
      expect(userSubcommand).toBeDefined();
      expect(userSubcommand?.type).toBe(1); // SUB_COMMAND type
      expect(userSubcommand?.description).toBe(
        "Show voice channel statistics for a user",
      );
    });

    it("should have optional user parameter", () => {
      const json = data.toJSON();
      const userSubcommand = json.options?.find(
        (opt: any) => opt.name === "user",
      );
      const userOption = userSubcommand?.options?.find(
        (opt: any) => opt.name === "user",
      );
      expect(userOption).toBeDefined();
      expect(userOption?.required).toBe(false);
    });

    it("should have optional period parameter with choices", () => {
      const json = data.toJSON();
      const userSubcommand = json.options?.find(
        (opt: any) => opt.name === "user",
      );
      const periodOption = userSubcommand?.options?.find(
        (opt: any) => opt.name === "period",
      );
      expect(periodOption).toBeDefined();
      expect(periodOption?.required).toBe(false);
      expect(periodOption?.choices).toBeDefined();
      expect(periodOption?.choices?.length).toBe(3);
    });
  });

  describe("user subcommand — Recent Sessions rendering (#841)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGetBoolean.mockResolvedValue(true);
      mockGetTimezone.mockResolvedValue(null);
    });

    // Sessions are stored append-only, so index 0 is the *oldest*.
    const day = 24 * 60 * 60 * 1000;
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    const sessions = Array.from({ length: 7 }, (_, i) => ({
      startTime: new Date(base + i * day),
      endTime: new Date(base + i * day + 3600 * 1000),
      duration: 3600,
      channelName: `session-${i + 1}`,
    }));

    function recentLines(reply: jest.Mock): string[] {
      const content = reply.mock.calls[0][0] as string;
      const lines = content.split("\n");
      const headerIdx = lines.indexOf("**Recent Sessions:**");
      expect(headerIdx).toBeGreaterThan(-1);
      return lines.slice(headerIdx + 1);
    }

    it("shows the five most recent sessions, newest first", async () => {
      mockGetUserStats.mockResolvedValue({
        userId: "user-1",
        username: "alice",
        totalTime: 7 * 3600,
        lastSeen: new Date(base + 6 * day),
        sessions,
      });

      const interaction = makeUserInteraction();
      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledTimes(1);
      expect(recentLines(interaction.reply)).toEqual([
        "• session-7: 1h 0m",
        "• session-6: 1h 0m",
        "• session-5: 1h 0m",
        "• session-4: 1h 0m",
        "• session-3: 1h 0m",
      ]);
    });

    it("orders by startTime even when the stored array is not chronological", async () => {
      // Shuffle the stored order to prove ordering comes from startTime,
      // not from array position.
      const shuffled = [
        sessions[2],
        sessions[6],
        sessions[0],
        sessions[4],
        sessions[1],
        sessions[5],
        sessions[3],
      ];
      mockGetUserStats.mockResolvedValue({
        userId: "user-1",
        username: "alice",
        totalTime: 7 * 3600,
        lastSeen: new Date(base + 6 * day),
        sessions: shuffled,
      });

      const interaction = makeUserInteraction();
      await execute(interaction);

      expect(recentLines(interaction.reply)).toEqual([
        "• session-7: 1h 0m",
        "• session-6: 1h 0m",
        "• session-5: 1h 0m",
        "• session-4: 1h 0m",
        "• session-3: 1h 0m",
      ]);
      // The stats object passed in must not be mutated by the sort.
      expect(shuffled[0]).toBe(sessions[2]);
      expect(shuffled[1]).toBe(sessions[6]);
    });

    it("renders an ongoing session (no duration) as 'ongoing'", async () => {
      mockGetUserStats.mockResolvedValue({
        userId: "user-1",
        username: "alice",
        totalTime: 3600,
        lastSeen: new Date(base + day),
        sessions: [
          sessions[0],
          { startTime: new Date(base + day), channelName: "live" },
        ],
      });

      const interaction = makeUserInteraction();
      await execute(interaction);

      expect(recentLines(interaction.reply)).toEqual([
        "• live: ongoing",
        "• session-1: 1h 0m",
      ]);
    });

    it("replies with a no-activity message when there are no stats", async () => {
      mockGetUserStats.mockResolvedValue(null);

      const interaction = makeUserInteraction();
      await execute(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        "No voice channel activity found for the selected period.",
      );
    });
  });
});
