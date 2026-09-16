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

const { data, execute } = await import("../../src/commands/timeout.js");

type MockInteraction = ChatInputCommandInteraction & {
  reply: jest.Mock;
  deferReply: jest.Mock;
  editReply: jest.Mock;
  applyTimeout: jest.Mock;
};

/** Fixed expiry Discord reports back, in ms. */
const TIMEOUT_EXPIRY = 1_800_000_000_000;

function makeMember(
  id: string,
  position: number,
  options: { moderatable?: boolean; timeout?: jest.Mock } = {},
): Record<string, unknown> {
  return {
    id,
    user: { tag: `${id}#0001` },
    roles: { highest: { position } },
    moderatable: options.moderatable ?? true,
    timeout:
      options.timeout ??
      jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({
          communicationDisabledUntilTimestamp: TIMEOUT_EXPIRY,
        }),
  };
}

function makeInteraction(
  overrides: {
    guildId?: string | null;
    target?: { id: string; tag: string; bot: boolean };
    minutes?: number;
    targetMember?: Record<string, unknown> | null;
    reason?: string;
    memberFetchError?: unknown;
  } = {},
): MockInteraction {
  const target = overrides.target ?? {
    id: "user-2",
    tag: "bob#0001",
    bot: false,
  };
  // discord.js resolves `member.timeout()` with the updated member, whose
  // `communicationDisabledUntil` is the authoritative expiry the embed renders.
  const applyTimeout = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({ communicationDisabledUntilTimestamp: TIMEOUT_EXPIRY });
  const targetMember =
    overrides.targetMember === undefined
      ? makeMember(target.id, 2, { timeout: applyTimeout })
      : overrides.targetMember;

  return {
    guildId: overrides.guildId === undefined ? "guild-1" : overrides.guildId,
    guild: {
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
    },
    options: {
      getUser: () => target,
      getString: () => overrides.reason ?? "  heated argument  ",
      getInteger: () => overrides.minutes ?? 180,
    },
    user: { id: "mod-1", tag: "mod#0001" },
    client: {},
    replied: false,
    deferred: false,
    applyTimeout,
    reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deferReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    editReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as MockInteraction;
}

describe("Timeout Command", () => {
  it("has the correct command name", () => {
    expect(data.name).toBe("timeout");
  });

  it("has a description", () => {
    expect(data.description.length).toBeGreaterThan(0);
  });

  // Arbitrary durations are the whole point of this command: Discord's native
  // UI offers only six presets, while the API allows up to 28 days.
  it("requires a user, a duration in minutes and a reason", () => {
    const json = data.toJSON();
    expect(json.options?.[0]).toMatchObject({
      name: "user",
      type: 6, // User
      required: true,
    });
    expect(json.options?.[1]).toMatchObject({
      name: "duration",
      type: 4, // Integer
      required: true,
      min_value: 1,
      max_value: 28 * 24 * 60,
    });
    expect(json.options?.[2]).toMatchObject({
      name: "reason",
      type: 3, // String
      required: true,
    });
  });

  it("defaults to the Moderate Members permission", () => {
    const json = data.toJSON();
    // ModerateMembers = 1 << 40.
    expect(json.default_member_permissions).toBe((1n << 40n).toString());
  });

  describe("execution", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockIsEnabled.mockResolvedValue(true);
      mockLogAction.mockResolvedValue({});
      mockCountHistory.mockResolvedValue(2);
    });

    it("defers ephemerally before any work, times out, then logs the action", async () => {
      const order: string[] = [];
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        order.push("defer");
      });
      mockIsEnabled.mockImplementation(async () => {
        order.push("isEnabled");
        return true;
      });
      interaction.applyTimeout.mockImplementation(async () => {
        order.push("timeout");
        return { communicationDisabledUntilTimestamp: TIMEOUT_EXPIRY };
      });
      mockLogAction.mockImplementation(async () => {
        order.push("logAction");
        return {};
      });

      await execute(interaction);

      expect(order).toEqual(["defer", "isEnabled", "timeout", "logAction"]);
      expect(interaction.deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(mockLogAction).toHaveBeenCalledWith({
        guildId: "guild-1",
        userId: "user-2",
        moderatorId: "mod-1",
        action: "timeout",
        reason: "heated argument",
      });
      expect(interaction.reply).not.toHaveBeenCalled();
      const payload = interaction.editReply.mock.calls[0][0] as {
        embeds: unknown[];
      };
      expect(payload.embeds).toHaveLength(1);
      expect(payload).not.toHaveProperty("flags");
    });

    // Minutes in, milliseconds out — and the moderator is prefixed onto the
    // reason because the bot is the audit-log executor.
    it("converts the duration to milliseconds and prefixes the audit reason", async () => {
      const interaction = makeInteraction({ minutes: 180 });

      await execute(interaction);

      expect(interaction.applyTimeout).toHaveBeenCalledWith(
        180 * 60 * 1000,
        "mod#0001: heated argument",
      );
    });

    it("edits the deferred reply when the moderation log is disabled", async () => {
      mockIsEnabled.mockResolvedValue(false);
      const interaction = makeInteraction();

      await execute(interaction);

      expect(interaction.applyTimeout).not.toHaveBeenCalled();
      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: "The moderation log is currently disabled.",
      });
    });

    // A timeout only exists on a present member, unlike a ban.
    it("refuses a target who is not in the guild", async () => {
      const interaction = makeInteraction({ targetMember: null });

      await execute(interaction);

      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: expect.stringContaining("isn't a member of this server"),
      });
    });

    it("refuses a target who outranks the moderator, without acting", async () => {
      const interaction = makeInteraction({
        targetMember: makeMember("user-2", 20),
      });

      await execute(interaction);

      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: expect.stringContaining(
          "their highest role is not below yours",
        ),
      });
    });

    it("records nothing when Discord rejects the timeout", async () => {
      const interaction = makeInteraction();
      interaction.applyTimeout.mockRejectedValue(
        new Error("Missing Permissions"),
      );

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

    // A failure *before* Discord is asked to act: the member was not timed out,
    // so the plain refusal is the honest message.
    it("delivers the error message via editReply once deferred", async () => {
      mockIsEnabled.mockRejectedValue(new Error("boom"));
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(interaction.applyTimeout).not.toHaveBeenCalled();
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "There was an error timing the member out.",
        }),
      );
    });

    // ...but once Discord has applied the timeout, saying it failed would send
    // the moderator back to re-run an action that already landed.
    it("says the timeout landed when only the recording failed", async () => {
      mockLogAction.mockRejectedValue(new Error("boom"));
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(interaction.applyTimeout).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            "The member was timed out, but I couldn't record it or show the confirmation. Don't run this again — check /modlog.",
        }),
      );
    });

    // Discord starts the timeout before the log write and history query, so the
    // expiry must come from Discord, not from the clock after those awaits.
    it("renders Discord's own expiry, not one computed after the DB work", async () => {
      const interaction = makeInteraction();

      await execute(interaction);

      const payload = interaction.editReply.mock.calls[0][0] as {
        embeds: Array<{ data: { description: string } }>;
      };
      expect(payload.embeds[0].data.description).toContain(
        `<t:${Math.floor(TIMEOUT_EXPIRY / 1000)}:R>`,
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
    // "", which is an invalid embed field value. The old flow timed the member
    // out first and only failed when rendering the confirmation.
    it("refuses a whitespace-only reason before timing out", async () => {
      const interaction = makeInteraction({ reason: "   " });

      await execute(interaction);

      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(interaction.applyTimeout).not.toHaveBeenCalled();
      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Please give a reason for the timeout.",
        }),
      );
    });

    it("reports absence only when Discord confirms it", async () => {
      mockIsEnabled.mockResolvedValue(true);
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

      expect(interaction.applyTimeout).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "**bob#0001** isn't a member of this server.",
        }),
      );
    });

    it("does not claim absence when the lookup fails for another reason", async () => {
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

      expect(interaction.applyTimeout).not.toHaveBeenCalled();
      expect(mockLogAction).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "There was an error timing the member out.",
        }),
      );
    });
  });
});
