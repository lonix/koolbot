import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  DiscordAPIError,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";

const mockIsEnabled = jest.fn<() => Promise<boolean>>();
const mockLogAction = jest.fn<() => Promise<unknown>>();
const mockCountHistory = jest.fn<() => Promise<number>>();

jest.unstable_mockModule("../../src/services/moderation-service.js", () => ({
  ModerationService: {
    getInstance: () => ({
      isEnabled: mockIsEnabled,
      logAction: mockLogAction,
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

const { data, execute } = await import("../../src/commands/ban.js");

type MockInteraction = ChatInputCommandInteraction & {
  reply: jest.Mock;
  deferReply: jest.Mock;
  editReply: jest.Mock;
  banCreate: jest.Mock;
};

function makeMember(
  id: string,
  position: number,
  bannable = true,
): Record<string, unknown> {
  return {
    id,
    user: { tag: `${id}#0001` },
    roles: { highest: { position } },
    bannable,
  };
}

function makeInteraction(
  overrides: {
    guildId?: string | null;
    target?: { id: string; tag: string; bot: boolean };
    deleteDays?: number | null;
    targetMember?: Record<string, unknown> | null;
    guild?: unknown;
    reason?: string;
    memberFetchError?: unknown;
  } = {},
): MockInteraction {
  const target = overrides.target ?? {
    id: "user-2",
    tag: "bob#0001",
    bot: false,
  };
  const targetMember =
    overrides.targetMember === undefined
      ? makeMember(target.id, 2)
      : overrides.targetMember;
  const banCreate = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const guild =
    overrides.guild === undefined
      ? {
          id: "guild-1",
          ownerId: "owner-1",
          members: {
            fetch: jest.fn(async (id: string) => {
              if (id === "mod-1") return makeMember("mod-1", 9);
              if (overrides.memberFetchError !== undefined) {
                throw overrides.memberFetchError;
              }
              return targetMember;
            }),
          },
          bans: { create: banCreate },
        }
      : overrides.guild;

  return {
    guildId: overrides.guildId === undefined ? "guild-1" : overrides.guildId,
    guild,
    options: {
      getUser: () => target,
      getString: () => overrides.reason ?? "  raiding  ",
      getInteger: () => overrides.deleteDays ?? null,
    },
    user: { id: "mod-1", tag: "mod#0001" },
    client: {},
    replied: false,
    deferred: false,
    banCreate,
    reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deferReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    editReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as MockInteraction;
}

describe("Ban Command", () => {
  it("has the correct command name", () => {
    expect(data.name).toBe("ban");
  });

  it("has a description", () => {
    expect(data.description.length).toBeGreaterThan(0);
  });

  it("requires a user and a reason, with an optional delete window", () => {
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
    expect(json.options?.[2]).toMatchObject({
      name: "delete_days",
      type: 4, // Integer
      min_value: 0,
      max_value: 7, // Discord's delete_message_seconds cap
    });
    expect(json.options?.[2]).not.toMatchObject({ required: true });
  });

  it("defaults to the Ban Members permission", () => {
    const json = data.toJSON();
    // BanMembers = 1 << 2. default_member_permissions is the decimal string
    // of the permission bitfield.
    expect(json.default_member_permissions).toBe((1n << 2n).toString());
  });

  describe("execution", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockIsEnabled.mockResolvedValue(true);
      mockLogAction.mockResolvedValue({});
      mockCountHistory.mockResolvedValue(3);
    });

    // The ban is a REST call and the log write + count are DB round trips; the
    // handler must acknowledge (ephemerally — visibility is fixed at the first
    // ACK) before them so a slow call cannot miss Discord's 3-second window
    // (#842).
    it("defers ephemerally before any work, bans, then logs the action", async () => {
      const order: string[] = [];
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        order.push("defer");
      });
      mockIsEnabled.mockImplementation(async () => {
        order.push("isEnabled");
        return true;
      });
      interaction.banCreate.mockImplementation(async () => {
        order.push("ban");
      });
      mockLogAction.mockImplementation(async () => {
        order.push("logAction");
        return {};
      });

      await execute(interaction);

      expect(order).toEqual(["defer", "isEnabled", "ban", "logAction"]);
      expect(interaction.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(mockLogAction).toHaveBeenCalledWith({
        guildId: "guild-1",
        userId: "user-2",
        moderatorId: "mod-1",
        action: "ban",
        reason: "raiding",
      });
      expect(interaction.reply).not.toHaveBeenCalled();
      const payload = interaction.editReply.mock.calls[0][0] as {
        embeds: unknown[];
      };
      expect(payload.embeds).toHaveLength(1);
      expect(payload).not.toHaveProperty("flags");
    });

    // Routed through the bot, KoolBot is the audit-log executor, so the
    // moderator only survives in Discord's own record via the reason.
    it("prefixes the audit reason with the moderator and passes no delete window by default", async () => {
      const interaction = makeInteraction();

      await execute(interaction);

      expect(interaction.banCreate).toHaveBeenCalledWith("user-2", {
        reason: "mod#0001: raiding",
        deleteMessageSeconds: 0,
      });
    });

    it("converts the delete window from days to seconds", async () => {
      const interaction = makeInteraction({ deleteDays: 2 });

      await execute(interaction);

      expect(interaction.banCreate).toHaveBeenCalledWith(
        "user-2",
        expect.objectContaining({ deleteMessageSeconds: 2 * 24 * 60 * 60 }),
      );
    });

    it("bans a target who is no longer in the guild", async () => {
      const interaction = makeInteraction({ targetMember: null });

      await execute(interaction);

      expect(interaction.banCreate).toHaveBeenCalled();
      expect(mockLogAction).toHaveBeenCalled();
    });

    it("edits the deferred reply when the moderation log is disabled", async () => {
      mockIsEnabled.mockResolvedValue(false);
      const interaction = makeInteraction();

      await execute(interaction);

      expect(interaction.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(interaction.banCreate).not.toHaveBeenCalled();
      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: "The moderation log is currently disabled.",
      });
    });

    // Discord enforces role hierarchy in its native UI; the bot is the
    // executor here, so the command re-applies the check itself.
    it("refuses a target who outranks the moderator, without banning", async () => {
      const interaction = makeInteraction({
        targetMember: makeMember("user-2", 20),
      });

      await execute(interaction);

      expect(interaction.banCreate).not.toHaveBeenCalled();
      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: expect.stringContaining(
          "their highest role is not below yours",
        ),
      });
    });

    it("records nothing when Discord rejects the ban", async () => {
      const interaction = makeInteraction();
      interaction.banCreate.mockRejectedValue(new Error("Missing Permissions"));

      await execute(interaction);

      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: expect.stringContaining("Nothing has been recorded."),
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
      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
      );
    });

    // A failure *before* Discord is asked to act: nobody was banned, so the
    // plain refusal is the honest message.
    it("delivers the error message via editReply once deferred", async () => {
      mockIsEnabled.mockRejectedValue(new Error("boom"));
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(interaction.banCreate).not.toHaveBeenCalled();
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "There was an error banning the member.",
        }),
      );
    });

    // ...but once Discord has banned the member, saying it failed would send
    // the moderator back to re-run an action that already landed.
    it("says the ban landed when only the recording failed", async () => {
      mockLogAction.mockRejectedValue(new Error("boom"));
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(interaction.banCreate).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            "The member was banned, but I couldn't record it or show the confirmation. Don't run this again — check /modlog.",
        }),
      );
    });
  });
  describe("input guards", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockIsEnabled.mockResolvedValue(true);
      mockLogAction.mockResolvedValue({});
      mockCountHistory.mockResolvedValue(3);
    });

    // Discord's maxLength doesn't stop a whitespace-only reason; it trims to
    // "", which is an invalid embed field value. The old flow banned first and
    // only failed when rendering the confirmation.
    it("refuses a whitespace-only reason before banning", async () => {
      const interaction = makeInteraction({ reason: "   " });

      await execute(interaction);

      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(interaction.banCreate).not.toHaveBeenCalled();
      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Please give a reason for the ban.",
        }),
      );
    });

    it("treats Unknown Member as absence and bans by id", async () => {
      mockIsEnabled.mockResolvedValue(true);
      mockCountHistory.mockResolvedValue(1);
      const interaction = makeInteraction({
        memberFetchError: new DiscordAPIError(
          { code: 10007, message: "Unknown Member" },
          10007,
          404,
          "GET",
          "",
          {},
        ),
      });

      await execute(interaction);

      expect(interaction.banCreate).toHaveBeenCalled();
      expect(mockLogAction).toHaveBeenCalled();
    });

    // A blanket catch would read this as "member absent", and a null target
    // skips the hierarchy check — so a rate limit could let the ban through.
    it("does not ban when the member lookup fails for another reason", async () => {
      mockIsEnabled.mockResolvedValue(true);
      const interaction = makeInteraction({
        memberFetchError: new DiscordAPIError(
          { code: 0, message: "rate limited" },
          0,
          429,
          "GET",
          "",
          {},
        ),
      });
      interaction.deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(interaction.banCreate).not.toHaveBeenCalled();
      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "There was an error banning the member.",
        }),
      );
    });
  });
});
