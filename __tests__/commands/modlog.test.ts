import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction, EmbedBuilder } from "discord.js";

const mockIsEnabled = jest.fn<() => Promise<boolean>>();
const mockCountHistory = jest.fn<() => Promise<number>>();
const mockGetHistory = jest.fn<() => Promise<unknown[]>>();

jest.unstable_mockModule("../../src/services/moderation-service.js", () => ({
  ModerationService: {
    getInstance: jest.fn(() => ({
      isEnabled: mockIsEnabled,
      countHistory: mockCountHistory,
      getHistory: mockGetHistory,
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

const { data, actionLabel, execute, PAGE_SIZE, MAX_REASON_DISPLAY_LENGTH } =
  await import("../../src/commands/modlog.js");

function makeInteraction(
  page: number | null = null,
  guildId: string | null = "guild-1",
) {
  const reply = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const deferReply = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const editReply = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const interaction = {
    id: "interaction-1",
    client: {},
    guildId,
    user: { id: "mod-1" },
    replied: false,
    deferred: false,
    options: {
      getUser: () => ({
        id: "target-1",
        tag: "target#0001",
        displayAvatarURL: () => "https://cdn.example/avatar.png",
      }),
      getInteger: () => page,
    },
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
function embedDescription(editReply: jest.Mock): string {
  const payload = editReply.mock.calls[0][0] as { embeds: EmbedBuilder[] };
  return payload.embeds[0].data.description ?? "";
}

describe("Modlog Command", () => {
  it("has the correct command name", () => {
    expect(data.name).toBe("modlog");
  });

  it("has a description", () => {
    expect(data.description.length).toBeGreaterThan(0);
  });

  it("requires a user option and an optional page option", () => {
    const json = data.toJSON();
    expect(json.options?.[0]).toMatchObject({
      name: "user",
      type: 6, // User
      required: true,
    });
    expect(json.options?.[1]).toMatchObject({
      name: "page",
      type: 4, // Integer
    });
    expect(json.options?.[1]?.required ?? false).toBe(false);
  });

  it("defaults to the Moderate Members permission", () => {
    const json = data.toJSON();
    expect(json.default_member_permissions).toBe((1n << 40n).toString());
  });

  describe("actionLabel", () => {
    it("renders a label for every action", () => {
      expect(actionLabel("warn")).toContain("Warn");
      expect(actionLabel("kick")).toContain("Kick");
      expect(actionLabel("ban")).toContain("Ban");
      expect(actionLabel("unban")).toContain("Unban");
      expect(actionLabel("timeout")).toContain("Timeout");
      expect(actionLabel("untimeout")).toContain("lifted");
    });
  });

  // #840: a page of 10 entries each carrying a 512-char reason overflows the
  // 4096-char embed description, so the whole reply failed on guilds with
  // verbose moderators.
  describe("payload limit (#840)", () => {
    beforeEach(() => {
      mockIsEnabled.mockReset().mockResolvedValue(true);
      mockCountHistory.mockReset();
      mockGetHistory.mockReset();
    });

    const worstCaseEntries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        guildId: "guild-1",
        userId: "target-1",
        // The longest action label plus a full-width snowflake moderator id.
        moderatorId: "123456789012345678",
        action: "untimeout",
        // /warn stores reasons of up to 512 characters.
        reason: `${String(i).padStart(3, "0")} ${"r".repeat(508)}`,
        source: "command",
        createdAt: new Date(2026, 0, 1 + i),
      }));

    it("keeps a full page of maximum-length reasons within 4096 characters", async () => {
      mockCountHistory.mockResolvedValue(PAGE_SIZE * 3);
      mockGetHistory.mockResolvedValue(worstCaseEntries(PAGE_SIZE));
      const { interaction, editReply } = makeInteraction(1);

      await execute(interaction);

      expect(editReply).toHaveBeenCalledTimes(1);
      const description = embedDescription(editReply);
      expect(description.length).toBeLessThanOrEqual(4096);
      // Every entry on the page is still shown: pagination stays honest.
      expect(description.match(/Timeout lifted/g)).toHaveLength(PAGE_SIZE);
      expect(description).not.toContain("more on this page");
    });

    it("shortens each over-long reason to the display cap", async () => {
      mockCountHistory.mockResolvedValue(1);
      mockGetHistory.mockResolvedValue(worstCaseEntries(1));
      const { interaction, editReply } = makeInteraction();

      await execute(interaction);

      const description = embedDescription(editReply);
      const quoted = description.split("\n> ")[1];
      expect(quoted.length).toBe(MAX_REASON_DISPLAY_LENGTH);
      expect(quoted.endsWith("…")).toBe(true);
      expect(quoted.startsWith("000 rrr")).toBe(true);
    });

    it("leaves short reasons untouched", async () => {
      mockCountHistory.mockResolvedValue(1);
      mockGetHistory.mockResolvedValue([
        { ...worstCaseEntries(1)[0], action: "warn", reason: "Spamming" },
      ]);
      const { interaction, editReply } = makeInteraction();

      await execute(interaction);

      expect(embedDescription(editReply)).toContain("\n> Spamming");
    });
  });
  // The history count + page query are DB round trips; the handler must
  // acknowledge (ephemerally — visibility is fixed at the first ACK) before
  // them so a slow query cannot miss Discord's 3-second window (#842).
  describe("interaction acknowledgement (#842)", () => {
    beforeEach(() => {
      mockIsEnabled.mockReset().mockResolvedValue(true);
      mockCountHistory.mockReset().mockResolvedValue(0);
      mockGetHistory.mockReset().mockResolvedValue([]);
    });

    it("defers ephemerally before any DB work, then edits the reply", async () => {
      const order: string[] = [];
      const { interaction, reply, deferReply, editReply } = makeInteraction();
      deferReply.mockImplementation(async () => {
        order.push("defer");
      });
      mockIsEnabled.mockImplementation(async () => {
        order.push("isEnabled");
        return true;
      });
      mockCountHistory.mockImplementation(async () => {
        order.push("count");
        return 1;
      });
      mockGetHistory.mockResolvedValue([
        {
          action: "warn",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          moderatorId: "mod-1",
          reason: "spam",
        },
      ]);

      await execute(interaction);

      expect(order).toEqual(["defer", "isEnabled", "count"]);
      expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(reply).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledTimes(1);
      const payload = editReply.mock.calls[0][0] as { embeds: unknown[] };
      expect(payload.embeds).toHaveLength(1);
      // Ephemerality is set on the deferral; editReply must not repeat it.
      expect(payload).not.toHaveProperty("ephemeral");
    });

    it("edits the deferred reply when the member has no history", async () => {
      const { interaction, deferReply, editReply } = makeInteraction();

      await execute(interaction);

      expect(deferReply).toHaveBeenCalledTimes(1);
      expect(editReply).toHaveBeenCalledWith({
        content: "**target#0001** has no moderation history.",
      });
    });

    it("edits the deferred reply when the moderation log is disabled", async () => {
      mockIsEnabled.mockResolvedValue(false);
      const { interaction, deferReply, editReply } = makeInteraction();

      await execute(interaction);

      expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(mockCountHistory).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledWith({
        content: "The moderation log is currently disabled.",
      });
    });

    it("replies directly, without deferring, outside a guild", async () => {
      const { interaction, reply, deferReply } = makeInteraction(null, null);

      await execute(interaction);

      expect(deferReply).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ ephemeral: true }),
      );
    });

    it("delivers the error message via editReply once deferred", async () => {
      mockCountHistory.mockRejectedValue(new Error("boom"));
      const { interaction, reply, deferReply, editReply } = makeInteraction();
      deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(reply).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "There was an error fetching the moderation history.",
        }),
      );
    });
  });
});
