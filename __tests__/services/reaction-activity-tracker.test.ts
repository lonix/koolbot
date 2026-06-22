import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client, MessageReaction, User } from "discord.js";

jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

import { ReactionActivityTracker } from "../../src/services/reaction-activity-tracker.js";
import { ReactionActivityTracking } from "../../src/models/reaction-activity-tracking.js";

// The global mongoose mock does not provide updateOne; attach it to the
// shared model object so the tracker can call it.
(ReactionActivityTracking as unknown as { updateOne: jest.Mock }).updateOne =
  jest.fn();

function createTracker() {
  const mockClient = {} as Client;
  const tracker = ReactionActivityTracker.getInstance(mockClient);

  const mockConfigService = {
    getString: jest.fn().mockResolvedValue("mongodb://localhost/test"),
    getBoolean: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue(null),
    getNumber: jest.fn().mockResolvedValue(0),
  };
  (tracker as never)["configService"] = mockConfigService;
  (tracker as never)["isConnected"] = true;

  return { tracker, mockConfigService };
}

function makeReaction(
  overrides: Partial<{
    guildId: string | null;
    channelId: string;
    authorId: string | null;
    authorBot: boolean;
    authorUsername: string;
  }> = {},
): MessageReaction {
  const {
    guildId = "guild1",
    channelId = "chan1",
    authorId = "author1",
    authorBot = false,
    authorUsername = "Author",
  } = overrides;
  return {
    partial: false,
    message: {
      guild: guildId ? { id: guildId } : null,
      channelId,
      author: authorId
        ? { id: authorId, username: authorUsername, bot: authorBot }
        : null,
    },
  } as unknown as MessageReaction;
}

function makeUser(
  overrides: Partial<{ id: string; username: string; bot: boolean }> = {},
): User {
  const { id = "reactor1", username = "Reactor", bot = false } = overrides;
  return { partial: false, id, username, bot } as unknown as User;
}

describe("ReactionActivityTracker", () => {
  let updateOne: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    updateOne = (
      ReactionActivityTracking as unknown as { updateOne: jest.Mock }
    ).updateOne;
    updateOne.mockResolvedValue({ matchedCount: 1 });
    (ReactionActivityTracker as unknown as { instance: unknown }).instance =
      undefined;
  });

  describe("singleton pattern", () => {
    it("returns the same instance", () => {
      const a = ReactionActivityTracker.getInstance({} as Client);
      const b = ReactionActivityTracker.getInstance({} as Client);
      expect(a).toBe(b);
    });
  });

  describe("gating", () => {
    it("does not write when tracking is disabled", async () => {
      const { tracker, mockConfigService } = createTracker();
      mockConfigService.getBoolean.mockResolvedValue(false);

      await tracker.handleReactionAdd(makeReaction(), makeUser());
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("ignores reactions from bots", async () => {
      const { tracker } = createTracker();
      await tracker.handleReactionAdd(makeReaction(), makeUser({ bot: true }));
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("ignores DM reactions (no guild)", async () => {
      const { tracker } = createTracker();
      await tracker.handleReactionAdd(
        makeReaction({ guildId: null }),
        makeUser(),
      );
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("skips excluded channels", async () => {
      const { tracker, mockConfigService } = createTracker();
      mockConfigService.get.mockResolvedValue("chan1,chan2");

      await tracker.handleReactionAdd(
        makeReaction({ channelId: "chan1" }),
        makeUser(),
      );
      expect(updateOne).not.toHaveBeenCalled();
    });
  });

  describe("recording", () => {
    it("records both given (reactor) and received (author)", async () => {
      const { tracker } = createTracker();
      await tracker.handleReactionAdd(makeReaction(), makeUser());

      expect(updateOne).toHaveBeenCalledTimes(2);

      const [givenFilter, givenUpdate] = updateOne.mock.calls[0];
      expect(givenFilter).toEqual({ userId: "reactor1", guildId: "guild1" });
      expect(givenUpdate.$inc.totalGiven).toBe(1);
      const year = String(new Date().getFullYear());
      expect(givenUpdate.$inc[`yearlyGiven.${year}`]).toBe(1);

      const [recvFilter, recvUpdate] = updateOne.mock.calls[1];
      expect(recvFilter).toEqual({ userId: "author1", guildId: "guild1" });
      expect(recvUpdate.$inc.totalReceived).toBe(1);
      expect(recvUpdate.$inc[`yearlyReceived.${year}`]).toBe(1);
    });

    it("does not record received when reacting to a bot's message", async () => {
      const { tracker } = createTracker();
      await tracker.handleReactionAdd(
        makeReaction({ authorBot: true }),
        makeUser(),
      );
      // Only the reactor's "given" write happens.
      expect(updateOne).toHaveBeenCalledTimes(1);
      expect(updateOne.mock.calls[0][1].$inc.totalGiven).toBe(1);
    });

    it("does not double-count a self-reaction", async () => {
      const { tracker } = createTracker();
      await tracker.handleReactionAdd(
        makeReaction({ authorId: "same" }),
        makeUser({ id: "same" }),
      );
      // Reactor === author: only "given" is recorded.
      expect(updateOne).toHaveBeenCalledTimes(1);
      expect(updateOne.mock.calls[0][1].$inc.totalReceived).toBeUndefined();
    });
  });

  describe("partials", () => {
    it("fetches a partial reaction and user before recording", async () => {
      const { tracker } = createTracker();
      const fetched = makeReaction();
      const partialReaction = {
        partial: true,
        fetch: jest
          .fn<() => Promise<MessageReaction>>()
          .mockResolvedValue(fetched),
      } as unknown as MessageReaction;
      const fetchedUser = makeUser();
      const partialUser = {
        partial: true,
        fetch: jest.fn<() => Promise<User>>().mockResolvedValue(fetchedUser),
      } as unknown as User;

      await tracker.handleReactionAdd(partialReaction, partialUser);

      expect(
        (partialReaction as unknown as { fetch: jest.Mock }).fetch,
      ).toHaveBeenCalled();
      expect(
        (partialUser as unknown as { fetch: jest.Mock }).fetch,
      ).toHaveBeenCalled();
      expect(updateOne).toHaveBeenCalledTimes(2);
    });
  });

  describe("error handling", () => {
    it("swallows DB errors", async () => {
      const { tracker } = createTracker();
      updateOne.mockRejectedValue(new Error("DB error"));

      await expect(
        tracker.handleReactionAdd(makeReaction(), makeUser()),
      ).resolves.not.toThrow();
    });
  });
});
