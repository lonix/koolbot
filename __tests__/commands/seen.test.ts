import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction } from "discord.js";

const mockGetActiveSession = jest.fn<() => unknown>();
const mockGetUserLastSeen = jest.fn<() => Promise<Date | null>>();

jest.unstable_mockModule("../../src/services/voice-channel-tracker.js", () => ({
  VoiceChannelTracker: {
    getInstance: () => ({
      getActiveSession: mockGetActiveSession,
      getUserLastSeen: mockGetUserLastSeen,
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

const { data, execute } = await import("../../src/commands/seen.js");

type MockInteraction = ChatInputCommandInteraction & {
  reply: jest.Mock;
  deferReply: jest.Mock;
  editReply: jest.Mock;
};

function makeInteraction(
  targetUser: { id: string; username: string } | null = {
    id: "user-2",
    username: "bob",
  },
): MockInteraction {
  return {
    options: { getUser: () => targetUser },
    user: { id: "user-1", username: "alice" },
    client: {},
    replied: false,
    deferred: false,
    reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    deferReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    editReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as MockInteraction;
}

describe("Seen Command", () => {
  describe("command metadata", () => {
    it("should have correct command name", () => {
      expect(data.name).toBe("seen");
    });

    it("should have a description", () => {
      expect(data.description).toBe(
        "Shows when a user was last seen in a voice channel",
      );
    });

    it("should be a valid slash command", () => {
      expect(data.toJSON()).toHaveProperty("name", "seen");
      expect(data.toJSON()).toHaveProperty("description");
    });

    it("should have required user parameter", () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBeGreaterThan(0);
      expect(json.options?.[0]).toMatchObject({
        name: "user",
        type: 6, // User type
        required: true,
      });
    });
  });

  // The last-seen lookup is a DB round trip; the handler must acknowledge
  // the interaction before it so a slow query cannot miss Discord's
  // 3-second window (`10062 Unknown interaction`, #842).
  describe("interaction acknowledgement (#842)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGetActiveSession.mockReturnValue(null);
      mockGetUserLastSeen.mockResolvedValue(null);
    });

    it("defers before the DB lookup and edits the reply with the result", async () => {
      const order: string[] = [];
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        order.push("defer");
      });
      mockGetUserLastSeen.mockImplementation(async () => {
        order.push("query");
        return new Date(Date.now() - 5 * 60 * 1000);
      });

      await execute(interaction);

      expect(order).toEqual(["defer", "query"]);
      expect(interaction.deferReply).toHaveBeenCalledWith();
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledTimes(1);
      expect(interaction.editReply.mock.calls[0][0]).toMatch(
        /^bob was last seen in a voice channel .+\.$/,
      );
    });

    it("edits the deferred reply when the user has never been seen", async () => {
      const interaction = makeInteraction();

      await execute(interaction);

      expect(interaction.deferReply).toHaveBeenCalledTimes(1);
      expect(interaction.editReply).toHaveBeenCalledWith(
        "bob has never been seen in a voice channel.",
      );
    });

    it("edits the deferred reply when the user is currently in a channel", async () => {
      mockGetActiveSession.mockReturnValue({ channelName: "General" });
      const interaction = makeInteraction();

      await execute(interaction);

      expect(interaction.deferReply).toHaveBeenCalledTimes(1);
      expect(mockGetUserLastSeen).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        'bob is currently in the voice channel "General".',
      );
    });

    it("replies directly, without deferring, when no user was given", async () => {
      const interaction = makeInteraction(null);

      await execute(interaction);

      expect(interaction.deferReply).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        "Please specify a user to check.",
      );
    });

    it("delivers the error message via editReply once deferred", async () => {
      mockGetUserLastSeen.mockRejectedValue(new Error("boom"));
      const interaction = makeInteraction();
      interaction.deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "There was an error while executing this command!",
        }),
      );
    });
  });
});
