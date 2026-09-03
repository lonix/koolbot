import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction } from "discord.js";

const mockIsEnabled = jest.fn<() => Promise<boolean>>();
const mockLogWarn = jest.fn<() => Promise<unknown>>();
const mockCountHistory = jest.fn<() => Promise<number>>();

jest.unstable_mockModule("../../src/services/moderation-service.js", () => ({
  ModerationService: {
    getInstance: () => ({
      isEnabled: mockIsEnabled,
      logWarn: mockLogWarn,
      countHistory: mockCountHistory,
    }),
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

const { data, execute } = await import("../../src/commands/warn.js");

type MockInteraction = ChatInputCommandInteraction & {
  reply: jest.Mock;
  deferReply: jest.Mock;
  editReply: jest.Mock;
};

function makeInteraction(
  overrides: {
    guildId?: string | null;
    target?: { id: string; tag: string; bot: boolean };
  } = {},
): MockInteraction {
  const target = overrides.target ?? {
    id: "user-2",
    tag: "bob#0001",
    bot: false,
  };
  return {
    guildId: overrides.guildId === undefined ? "guild-1" : overrides.guildId,
    options: {
      getUser: () => target,
      getString: () => "  spamming  ",
    },
    user: { id: "mod-1" },
    client: {},
    replied: false,
    deferred: false,
    reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deferReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    editReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as MockInteraction;
}

describe("Warn Command", () => {
  it("has the correct command name", () => {
    expect(data.name).toBe("warn");
  });

  it("has a description", () => {
    expect(data.description.length).toBeGreaterThan(0);
  });

  it("requires a user and a reason option", () => {
    const json = data.toJSON();
    expect(json.options?.[0]).toMatchObject({
      name: "user",
      type: 6, // User
      required: true,
    });
    expect(json.options?.[1]).toMatchObject({
      name: "reason",
      type: 3, // String
      required: true,
    });
  });

  it("defaults to the Moderate Members permission", () => {
    const json = data.toJSON();
    // ModerateMembers = 1 << 40. default_member_permissions is the decimal
    // string of the permission bitfield.
    expect(json.default_member_permissions).toBe((1n << 40n).toString());
  });

  // The warn write + history count are DB round trips; the handler must
  // acknowledge (ephemerally — visibility is fixed at the first ACK) before
  // them so a slow query cannot miss Discord's 3-second window (#842).
  describe("interaction acknowledgement (#842)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockIsEnabled.mockResolvedValue(true);
      mockLogWarn.mockResolvedValue({});
      mockCountHistory.mockResolvedValue(1);
    });

    it("defers ephemerally before any DB work, then edits the reply", async () => {
      const order: string[] = [];
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        order.push("defer");
      });
      mockIsEnabled.mockImplementation(async () => {
        order.push("isEnabled");
        return true;
      });
      mockLogWarn.mockImplementation(async () => {
        order.push("logWarn");
        return {};
      });

      await execute(interaction);

      expect(order).toEqual(["defer", "isEnabled", "logWarn"]);
      expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(mockLogWarn).toHaveBeenCalledWith({
        guildId: "guild-1",
        userId: "user-2",
        moderatorId: "mod-1",
        reason: "spamming",
      });
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledTimes(1);
      const payload = interaction.editReply.mock.calls[0][0] as {
        embeds: unknown[];
      };
      expect(payload.embeds).toHaveLength(1);
      expect(payload).not.toHaveProperty("ephemeral");
    });

    it("edits the deferred reply when the moderation log is disabled", async () => {
      mockIsEnabled.mockResolvedValue(false);
      const interaction = makeInteraction();

      await execute(interaction);

      expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(mockLogWarn).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: "The moderation log is currently disabled.",
      });
    });

    it.each([
      ["outside a guild", { guildId: null }],
      [
        "when the target is a bot",
        { target: { id: "bot-1", tag: "bot#0001", bot: true } },
      ],
      [
        "when the target is the invoker",
        { target: { id: "mod-1", tag: "mod#0001", bot: false } },
      ],
    ])("replies directly, without deferring, %s", async (_label, overrides) => {
      const interaction = makeInteraction(overrides);

      await execute(interaction);

      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(mockLogWarn).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ ephemeral: true }),
      );
    });

    it("delivers the error message via editReply once deferred", async () => {
      mockLogWarn.mockRejectedValue(new Error("boom"));
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "There was an error recording the warning.",
        }),
      );
    });
  });
});
