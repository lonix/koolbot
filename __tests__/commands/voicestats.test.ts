import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

import { unexpectedErrorPayload } from "../test-utils.js";

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

type MockInteraction = ChatInputCommandInteraction & {
  reply: jest.Mock;
  deferReply: jest.Mock;
  editReply: jest.Mock;
};

function mockReplyMethods(): Pick<
  MockInteraction,
  "replied" | "deferred" | "reply" | "deferReply" | "editReply"
> {
  return {
    replied: false,
    deferred: false,
    reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    // Like discord.js: deferring marks the interaction, which is what makes a
    // failure answer edit the deferred reply instead of replying again.
    deferReply: jest
      .fn<() => Promise<void>>()
      .mockImplementation(async function (this: unknown) {
        (this as { deferred: boolean }).deferred = true;
      }),
    editReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function makeUserInteraction(
  period: string | null = "alltime",
): MockInteraction {
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
    ...mockReplyMethods(),
  } as unknown as MockInteraction;
}

function makeTopInteraction(
  limit: number | null,
  period: string | null = "alltime",
): MockInteraction {
  return {
    options: {
      getSubcommand: () => "top",
      getUser: () => null,
      getString: (name: string) => (name === "period" ? period : null),
      getInteger: (name: string) => (name === "limit" ? limit : null),
    },
    user: { id: "user-1", username: "alice" },
    guildId: "guild-1",
    client: {},
    ...mockReplyMethods(),
  } as unknown as MockInteraction;
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
      channelId: `ch-${i + 1}`,
      channelName: `session-${i + 1}`,
    }));

    // Every session's channel exists and the caller can view it (#1153).
    const viewableGuild = {
      channels: {
        cache: new Map(
          sessions.map((s) => [
            s.channelId,
            {
              name: s.channelName,
              permissionsFor: () => ({ has: () => true }),
            },
          ]),
        ),
      },
    };
    const makeViewerInteraction = (): MockInteraction =>
      ({
        ...makeUserInteraction(),
        guild: viewableGuild,
      }) as unknown as MockInteraction;

    function recentLines(editReply: jest.Mock): string[] {
      const content = (editReply.mock.calls[0][0] as { content: string })
        .content;
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

      const interaction = makeViewerInteraction();
      await execute(interaction);

      expect(interaction.editReply).toHaveBeenCalledTimes(1);
      expect(recentLines(interaction.editReply)).toEqual([
        "• session-7: 1h 0m",
        "• session-6: 1h 0m",
        "• session-5: 1h 0m",
        "• session-4: 1h 0m",
        "• session-3: 1h 0m",
      ]);
    });

    // #1153: do not name a channel the caller cannot view.
    it("hides recent-session channel names the caller cannot view or that no longer exist", async () => {
      mockGetUserStats.mockResolvedValue({
        userId: "user-1",
        username: "alice",
        totalTime: 7200,
        lastSeen: new Date(base),
        sessions: [
          { ...sessions[0], channelId: "private", channelName: "Staff Room" },
          { ...sessions[1], channelId: "public", channelName: "General" },
          { ...sessions[2], channelId: "deleted", channelName: "Old Room" },
        ],
      });
      const guild = {
        channels: {
          cache: new Map([
            ["private", { permissionsFor: () => ({ has: () => false }) }],
            [
              "public",
              {
                name: "General Renamed",
                permissionsFor: () => ({ has: () => true }),
              },
            ],
          ]),
        },
      };
      const interaction = {
        ...makeUserInteraction(),
        guild,
      } as unknown as MockInteraction;
      await execute(interaction);

      const content = (
        interaction.editReply.mock.calls[0][0] as { content: string }
      ).content;
      expect(content).not.toContain("Staff Room");
      expect(content).toContain("• a voice channel: 1h 0m");
      // Current channel name, not the one stored with the session.
      expect(content).toContain("• General Renamed: 1h 0m");
      expect(content).not.toContain("• General: 1h 0m");
      // A deleted channel cannot be checked, so it fails closed too.
      expect(content).not.toContain("Old Room");
      expect(content.match(/• a voice channel: 1h 0m/g)).toHaveLength(2);
    });

    // #1162: a finished room keeps its stored name only if it was public.
    describe("names of finished rooms (#1162)", () => {
      const emptyGuild = { channels: { cache: new Map() } };
      const run = async (
        session: Record<string, unknown>,
        guild: unknown = emptyGuild,
      ): Promise<string> => {
        mockGetUserStats.mockResolvedValue({
          userId: "user-1",
          username: "alice",
          totalTime: 3600,
          lastSeen: new Date(base),
          sessions: [
            {
              ...sessions[0],
              channelId: "gone",
              channelName: "Game Night",
              ...session,
            },
          ],
        });
        const interaction = {
          ...makeUserInteraction(),
          guild,
        } as unknown as MockInteraction;
        await execute(interaction);
        return (interaction.editReply.mock.calls[0][0] as { content: string })
          .content;
      };

      it("shows the stored name of a deleted room marked public", async () => {
        const content = await run({ everyoneCanView: true });
        expect(content).toContain("• Game Night: 1h 0m");
      });

      it("hides a deleted room marked private", async () => {
        const content = await run({ everyoneCanView: false });
        expect(content).not.toContain("Game Night");
        expect(content).toContain("• a voice channel: 1h 0m");
      });

      it("hides a deleted room with no marker (older data)", async () => {
        const content = await run({});
        expect(content).not.toContain("Game Night");
        expect(content).toContain("• a voice channel: 1h 0m");
      });

      it("hides a public-marked room when the guild is not cached", async () => {
        const content = await run({ everyoneCanView: true }, null);
        expect(content).not.toContain("Game Night");
        expect(content).toContain("• a voice channel: 1h 0m");
      });

      it("still hides a live room the caller cannot view, whatever the marker says", async () => {
        const guild = {
          channels: {
            cache: new Map([
              [
                "gone",
                {
                  name: "Staff Room",
                  permissionsFor: () => ({ has: () => false }),
                },
              ],
            ]),
          },
        };
        const content = await run({ everyoneCanView: true }, guild);
        expect(content).not.toContain("Game Night");
        expect(content).not.toContain("Staff Room");
      });
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

      const interaction = makeViewerInteraction();
      await execute(interaction);

      expect(recentLines(interaction.editReply)).toEqual([
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
          {
            startTime: new Date(base + day),
            channelId: "ch-1",
            channelName: "live",
          },
        ],
      });

      const interaction = makeViewerInteraction();
      await execute(interaction);

      expect(recentLines(interaction.editReply)).toEqual([
        // ch-1's current name, not the stored "live".
        "• session-1: ongoing",
        "• session-1: 1h 0m",
      ]);
    });

    it("replies with a no-activity message when there are no stats", async () => {
      mockGetUserStats.mockResolvedValue(null);

      const interaction = makeUserInteraction();
      await execute(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        "No voice channel activity found for the selected period.",
      );
    });
  });

  // #840: the leaderboard joins up to 50 rows without checking the 2000-char
  // message limit, so a busy guild's `/voicestats top limit:50` failed with
  // 50035 Invalid Form Body and the user saw nothing.
  describe("top subcommand payload limit (#840)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGetBoolean.mockResolvedValue(true);
    });

    const worstCaseUsers = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        // Discord ids are up to 19 digits; a row names the member as a mention.
        userId: `${"9".repeat(17)}${String(i).padStart(2, "0")}`,
        username: "ignored",
        // Five-digit hours: a long-lived guild's all-time totals.
        totalTime: 99999 * 3600 + 59 * 60,
      }));

    it("keeps the maximum 50-row leaderboard within 2000 characters", async () => {
      mockGetTopUsers.mockResolvedValue(worstCaseUsers(50));
      const interaction = makeTopInteraction(50);

      await execute(interaction);

      expect(interaction.editReply).toHaveBeenCalledTimes(1);
      const content = (
        interaction.editReply.mock.calls[0][0] as { content: string }
      ).content;
      expect(typeof content).toBe("string");
      expect(content.length).toBeLessThanOrEqual(2000);
      expect(
        content.startsWith("Top Voice Channel Users (alltime):\n🥇 "),
      ).toBe(true);
      // Rows are mentions, so even 50 worst-case rows usually fit; if any are
      // dropped they are accounted for, so nothing silently vanishes.
      const shown = (content.match(/: 99999h 59m/g) ?? []).length;
      const dropped = Number(/…and (\d+) more$/.exec(content)?.[1] ?? 0);
      expect(shown + dropped).toBe(50);
    });

    it("leaves a leaderboard that fits untouched", async () => {
      mockGetTopUsers.mockResolvedValue(worstCaseUsers(10));
      const interaction = makeTopInteraction(10);

      await execute(interaction);

      const content = (
        interaction.editReply.mock.calls[0][0] as { content: string }
      ).content;
      expect(content.length).toBeLessThanOrEqual(2000);
      expect(content).not.toContain("…and");
      expect(content.split("\n")).toHaveLength(11);
    });
  });
  // Discord invalidates an interaction that is not acknowledged within three
  // seconds; the leaderboard aggregation on a large guild can take longer, so
  // the handler must defer before querying and finish with editReply (#842).
  describe("interaction acknowledgement (#842)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGetBoolean.mockResolvedValue(true);
      mockGetTimezone.mockResolvedValue(null);
    });

    it("top: defers before running the leaderboard query, then edits the reply", async () => {
      const order: string[] = [];
      const interaction = makeTopInteraction(null, "week");
      interaction.deferReply.mockImplementation(async () => {
        order.push("defer");
      });
      mockGetTopUsers.mockImplementation(async () => {
        order.push("query");
        return [{ userId: "user-1", username: "alice", totalTime: 3600 }];
      });

      await execute(interaction);

      expect(order).toEqual(["defer", "query"]);
      expect(interaction.deferReply).toHaveBeenCalledTimes(1);
      expect(interaction.deferReply).toHaveBeenCalledWith();
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Top Voice Channel Users (week):\n🥇 <@user-1>: 1h 0m",
        }),
      );
    });

    // #1146: usernames come from the database and are member-controlled.
    it("never echoes hostile usernames, and escapes a hostile channel name", async () => {
      const hostile = "<@555> @everyone [free](https://evil.example) **b**";
      const expectNeutral = (text: string): void => {
        expect(text).not.toContain("<@555>");
        expect(text).not.toContain("@everyone");
        expect(text).not.toContain("[free](");
        expect(text).not.toContain("**b**");
        expect(text).toContain("<@user-1>");
      };

      mockGetTopUsers.mockResolvedValue([
        { userId: "user-1", username: hostile, totalTime: 3600 },
      ]);
      const top = makeTopInteraction(null, "week");
      await execute(top);
      expectNeutral(
        (top.editReply.mock.calls[0][0] as { content: string }).content,
      );

      mockGetUserStats.mockResolvedValue({
        userId: "user-1",
        username: hostile,
        totalTime: 3600,
        lastSeen: new Date(),
        sessions: [],
      });
      mockGetUserStats.mockResolvedValue({
        userId: "user-1",
        username: "alice",
        totalTime: 3600,
        lastSeen: new Date(),
        sessions: [
          {
            startTime: new Date(),
            endTime: new Date(),
            duration: 3600,
            channelId: "ch-1",
            channelName: hostile,
          },
        ],
      });
      const user = {
        ...makeUserInteraction(),
        user: { id: "user-1", username: hostile },
        guild: {
          channels: {
            cache: new Map([
              [
                "ch-1",
                { name: hostile, permissionsFor: () => ({ has: () => true }) },
              ],
            ]),
          },
        },
      } as unknown as MockInteraction;
      await execute(user);
      const text = (user.editReply.mock.calls[0][0] as { content: string })
        .content;
      expectNeutral(text);
      // The header is a mention; the recent-session channel name is escaped.
      expect(text.match(/\\<@555\\>/g)).toHaveLength(1);
    });

    it("top: edits the deferred reply when there is no activity", async () => {
      mockGetTopUsers.mockResolvedValue([]);
      const interaction = makeTopInteraction(null, "week");

      await execute(interaction);

      expect(interaction.deferReply).toHaveBeenCalledTimes(1);
      expect(interaction.editReply).toHaveBeenCalledWith(
        "No voice channel activity found for the selected period.",
      );
    });

    it("top: replies ephemerally without deferring when the feature is disabled", async () => {
      mockGetBoolean.mockResolvedValue(false);
      const interaction = makeTopInteraction(null, "week");

      await execute(interaction);

      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(mockGetTopUsers).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
      );
    });

    it("user: defers before querying stats, then edits the reply", async () => {
      const order: string[] = [];
      const interaction = makeUserInteraction();
      interaction.deferReply.mockImplementation(async () => {
        order.push("defer");
      });
      mockGetUserStats.mockImplementation(async () => {
        order.push("query");
        return null;
      });

      await execute(interaction);

      expect(order).toEqual(["defer", "query"]);
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledTimes(1);
    });

    it("user: replies ephemerally without deferring when the feature is disabled", async () => {
      mockGetBoolean.mockResolvedValue(false);
      const interaction = makeUserInteraction();

      await execute(interaction);

      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(mockGetUserStats).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
      );
    });

    it("top: falls back to editReply for the error message once deferred", async () => {
      mockGetTopUsers.mockRejectedValue(new Error("boom"));
      const interaction = makeTopInteraction(null, "week");
      interaction.deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        unexpectedErrorPayload(),
      );
    });
  });
});
