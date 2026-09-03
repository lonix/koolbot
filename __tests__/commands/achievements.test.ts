import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

const mockGetUserAchievements = jest.fn<() => Promise<unknown>>();
const mockGetUnearnedAccoladeProgress = jest.fn<() => Promise<unknown[]>>();
const mockGetAccoladeDefinition = jest.fn<(type: string) => unknown>();
const mockGetAchievementDefinition = jest.fn<(type: string) => unknown>();

jest.unstable_mockModule("../../src/services/achievements-service.js", () => ({
  AchievementsService: {
    getInstance: jest.fn(() => ({
      getUserAchievements: mockGetUserAchievements,
      getUnearnedAccoladeProgress: mockGetUnearnedAccoladeProgress,
      getAccoladeDefinition: mockGetAccoladeDefinition,
      getAchievementDefinition: mockGetAchievementDefinition,
    })),
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { data, formatMetadata, formatProgressBar, execute } =
  await import("../../src/commands/achievements.js");

function makeInteraction() {
  const reply = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const deferReply = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const editReply = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const interaction = {
    id: "interaction-1",
    client: {},
    guildId: "guild-1",
    user: {
      id: "user-1",
      username: "member",
      displayAvatarURL: () => "https://cdn.example/avatar.png",
    },
    replied: false,
    deferred: false,
    options: { getUser: () => null },
    reply,
    deferReply,
    editReply,
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    reply,
    deferReply,
    editReply,
  };
}

// The handler defers first (#842), so the rendered embed arrives via editReply.
function embedFields(editReply: jest.Mock): { name: string; value: string }[] {
  const payload = editReply.mock.calls[0][0] as { embeds: EmbedBuilder[] };
  return payload.embeds[0].data.fields ?? [];
}

describe("Achievements Command", () => {
  describe("command metadata", () => {
    it("should have correct command name", () => {
      expect(data.name).toBe("achievements");
    });

    it("should have a description", () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toBe("View earned badges and achievements");
    });

    it("should be a valid slash command", () => {
      const json = data.toJSON();
      expect(json).toHaveProperty("name", "achievements");
      expect(json).toHaveProperty("description");
    });

    it("should have optional user parameter", () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(1);

      const userOption = json.options?.[0];
      expect(userOption?.name).toBe("user");
      expect(userOption?.type).toBe(6); // USER type
      expect(userOption?.required).toBe(false);
    });

    it("should have description for user parameter", () => {
      const json = data.toJSON();
      const userOption = json.options?.[0];
      expect(userOption?.description).toBeTruthy();
      expect(userOption?.description).toContain("user");
    });
  });

  describe("embed chunking logic", () => {
    it("should respect Discord 1024 character field limit", () => {
      // Test the chunking algorithm conceptually
      const MAX_FIELD_LENGTH = 1024;

      // Create mock accolade texts that together exceed the limit
      const mockAccolades = [
        "A".repeat(300),
        "B".repeat(300),
        "C".repeat(300),
        "D".repeat(300),
      ];

      // Simulate chunking logic
      const chunks: string[] = [];
      let currentChunk = "";

      for (const accoladeText of mockAccolades) {
        const separator = currentChunk.length > 0 ? "\n\n" : "";
        const potentialLength =
          currentChunk.length + separator.length + accoladeText.length;

        if (potentialLength > MAX_FIELD_LENGTH) {
          if (currentChunk.length > 0) {
            chunks.push(currentChunk);
          }
          currentChunk =
            accoladeText.length > MAX_FIELD_LENGTH
              ? `${accoladeText.slice(0, MAX_FIELD_LENGTH - 3)}...`
              : accoladeText;
        } else {
          currentChunk += `${separator}${accoladeText}`;
        }
      }

      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
      }

      // Verify all chunks are within limit
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
      });

      // Verify we created multiple chunks
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("should handle single long accolade that exceeds limit", () => {
      const MAX_FIELD_LENGTH = 1024;
      const longText = "X".repeat(1500);

      // Truncate logic
      const truncatedText =
        longText.length > MAX_FIELD_LENGTH
          ? `${longText.slice(0, MAX_FIELD_LENGTH - 3)}...`
          : longText;

      expect(truncatedText.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
      expect(truncatedText.endsWith("...")).toBe(true);
    });

    it("should handle empty accolade list", () => {
      const accoladesList: string[] = [];

      // Should not create any chunks
      const chunks: string[] = [];
      if (accoladesList.length === 0) {
        // No chunks added
      }

      expect(chunks.length).toBe(0);
    });
  });

  describe("metadata formatting", () => {
    it("should use unit field when available", () => {
      const metadataText = formatMetadata({
        value: 100,
        description: "100 hours milestone",
        unit: "hrs",
      });

      expect(metadataText).toBe(" - 100 hrs");
    });

    it("should handle missing unit field gracefully", () => {
      const metadataText = formatMetadata({
        value: 100,
        description: "100 hours milestone",
      });

      expect(metadataText).toBe(" - 100");
    });

    it("should handle user count with users unit", () => {
      const metadataText = formatMetadata({
        value: 25,
        description: "25+ unique users",
        unit: "users",
      });

      expect(metadataText).toBe(" - 25 users");
    });

    it("should handle missing metadata", () => {
      const metadataText = formatMetadata(undefined);

      expect(metadataText).toBe("");
    });
  });

  describe("accolade text formatting", () => {
    it("should format complete accolade text correctly", () => {
      const mockDefinition = {
        emoji: "🎉",
        name: "First Steps",
        description: "Spent your first hour in voice chat",
      };

      const earnedDate = "1/19/2026";
      const metadataText = " - 12 hrs";

      const accoladeText = `${mockDefinition.emoji} **${mockDefinition.name}**${metadataText}\n*${mockDefinition.description}*\nEarned: ${earnedDate}`;

      expect(accoladeText).toContain("🎉");
      expect(accoladeText).toContain("**First Steps**");
      expect(accoladeText).toContain("12 hrs");
      expect(accoladeText).toContain("*Spent your first hour in voice chat*");
      expect(accoladeText).toContain("Earned: 1/19/2026");
    });

    it("should handle accolade without metadata", () => {
      const mockDefinition = {
        emoji: "🏆",
        name: "Some Badge",
        description: "A badge description",
      };

      const earnedDate = "1/19/2026";
      const metadataText = "";

      const accoladeText = `${mockDefinition.emoji} **${mockDefinition.name}**${metadataText}\n*${mockDefinition.description}*\nEarned: ${earnedDate}`;

      expect(accoladeText).not.toContain(" - ");
      expect(accoladeText).toContain("🏆 **Some Badge**\n");
    });
  });

  describe("formatProgressBar", () => {
    it("renders an empty bar at 0%", () => {
      expect(formatProgressBar(0)).toBe("▱▱▱▱▱▱▱▱▱▱");
    });

    it("renders a full bar at 100%", () => {
      expect(formatProgressBar(100)).toBe("▰▰▰▰▰▰▰▰▰▰");
    });

    it("renders a partial bar (80% -> 8 filled)", () => {
      expect(formatProgressBar(80)).toBe("▰▰▰▰▰▰▰▰▱▱");
    });

    it("rounds to the nearest segment (e.g. 94% -> 9 filled)", () => {
      expect(formatProgressBar(94)).toBe("▰▰▰▰▰▰▰▰▰▱");
    });

    it("clamps out-of-range and non-finite percentages", () => {
      expect(formatProgressBar(-20)).toBe("▱▱▱▱▱▱▱▱▱▱");
      expect(formatProgressBar(150)).toBe("▰▰▰▰▰▰▰▰▰▰");
      expect(formatProgressBar(Number.NaN)).toBe("▱▱▱▱▱▱▱▱▱▱");
    });

    it("respects a custom segment count", () => {
      expect(formatProgressBar(50, 4)).toBe("▰▰▱▱");
    });
  });

  // #840: the accolades field is chunked to 1024 and the progress field is
  // clamped, but the achievements field joined up to ten three-line entries
  // unbounded, so a decorated member's embed failed with 50035.
  describe("achievements field payload limit (#840)", () => {
    beforeEach(() => {
      mockGetUserAchievements.mockReset();
      mockGetUnearnedAccoladeProgress.mockReset().mockResolvedValue([]);
      mockGetAccoladeDefinition.mockReset().mockReturnValue(undefined);
      mockGetAchievementDefinition.mockReset().mockImplementation(() => ({
        emoji: "🏅",
        name: "Weekly Voice Champion Of The Entire Server",
        description:
          "Topped the weekly voice leaderboard by spending more time in voice channels than anyone else",
      }));
    });

    const achievements = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        type: "weekly_champion",
        earnedAt: new Date(2026, 0, 1 + i),
        period: `2026-W${String(i + 1).padStart(2, "0")}`,
        metadata: { value: 1234, unit: "hrs" },
      }));

    it("keeps the ten most recent achievements within the 1024-char field limit", async () => {
      mockGetUserAchievements.mockResolvedValue({
        accolades: [],
        achievements: achievements(25),
        statistics: { totalAccolades: 0, totalAchievements: 25 },
      });
      const { interaction, editReply } = makeInteraction();

      await execute(interaction);

      expect(editReply).toHaveBeenCalledTimes(1);
      const field = embedFields(editReply).find((f) =>
        f.name.includes("Recent Achievements"),
      );
      expect(field).toBeDefined();
      expect(field!.value.length).toBeLessThanOrEqual(1024);
      expect(field!.value).toMatch(/\n\n…and \d+ more$/);
      const shown = (field!.value.match(/🏅 \*\*/g) ?? []).length;
      const dropped = Number(/…and (\d+) more$/.exec(field!.value)?.[1]);
      // Only the 10 most recent are ever considered; all are accounted for.
      expect(shown + dropped).toBe(10);
      // Newest first, and no entry is cut mid-way.
      expect(field!.value.startsWith("🏅 **")).toBe(true);
      expect(field!.value).toContain("(2026-W25)");
    });

    it("does not add an overflow note when the achievements fit", async () => {
      mockGetUserAchievements.mockResolvedValue({
        accolades: [],
        achievements: achievements(3),
        statistics: { totalAccolades: 0, totalAchievements: 3 },
      });
      const { interaction, editReply } = makeInteraction();

      await execute(interaction);

      const field = embedFields(editReply).find((f) =>
        f.name.includes("Recent Achievements"),
      );
      expect(field!.value.length).toBeLessThanOrEqual(1024);
      expect(field!.value).not.toContain("…and");
      expect(field!.value.match(/🏅 \*\*/g)).toHaveLength(3);
    });
  });
  // The achievements + progress reads are DB round trips; the handler must
  // acknowledge before them so a slow query cannot miss Discord's 3-second
  // window (`10062 Unknown interaction`, #842).
  describe("interaction acknowledgement (#842)", () => {
    beforeEach(() => {
      mockGetUserAchievements.mockReset().mockResolvedValue(null);
      mockGetUnearnedAccoladeProgress.mockReset().mockResolvedValue([]);
      mockGetAccoladeDefinition.mockReset().mockReturnValue({
        emoji: "🏆",
        name: "Accolade",
        description: "desc",
      });
      mockGetAchievementDefinition.mockReset().mockReturnValue(undefined);
    });

    it("defers before the DB reads and edits the reply with the embed", async () => {
      const order: string[] = [];
      const { interaction, reply, deferReply, editReply } = makeInteraction();
      deferReply.mockImplementation(async () => {
        order.push("defer");
      });
      mockGetUserAchievements.mockImplementation(async () => {
        order.push("query");
        return {
          accolades: [
            { type: "any", earnedAt: new Date("2026-01-01T00:00:00Z") },
          ],
          achievements: [],
          statistics: { totalAccolades: 1, totalAchievements: 0 },
        };
      });

      await execute(interaction);

      expect(order).toEqual(["defer", "query"]);
      expect(deferReply).toHaveBeenCalledWith();
      expect(reply).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledTimes(1);
      const payload = editReply.mock.calls[0][0] as { embeds: unknown[] };
      expect(payload.embeds).toHaveLength(1);
    });

    it("edits the deferred reply when the user has no badges or progress", async () => {
      const { interaction, deferReply, editReply } = makeInteraction();

      await execute(interaction);

      expect(deferReply).toHaveBeenCalledTimes(1);
      expect(editReply).toHaveBeenCalledWith({
        content:
          "member hasn't earned any badges yet. Keep participating in voice channels!",
      });
    });

    it("delivers the error message via editReply once deferred", async () => {
      mockGetUserAchievements.mockRejectedValue(new Error("boom"));
      const { interaction, reply, deferReply, editReply } = makeInteraction();
      deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(reply).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "There was an error while fetching achievements!",
        }),
      );
    });
  });
});
