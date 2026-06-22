import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client, PollAnswer, User } from "discord.js";

jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

import { PollParticipationTracker } from "../../src/services/poll-participation-tracker.js";
import { PollParticipationTracking } from "../../src/models/poll-participation-tracking.js";

(PollParticipationTracking as unknown as { updateOne: jest.Mock }).updateOne =
  jest.fn();

function createTracker(voter: { username: string; bot: boolean } | null) {
  const usersFetch = jest
    .fn<(id: string) => Promise<User>>()
    .mockResolvedValue(
      (voter
        ? { id: "voter1", username: voter.username, bot: voter.bot }
        : { id: "voter1", username: "Voter", bot: false }) as User,
    );
  const mockClient = {
    users: { fetch: usersFetch, cache: new Map<string, User>() },
  } as unknown as Client;
  const tracker = PollParticipationTracker.getInstance(mockClient);

  const mockConfigService = {
    getString: jest.fn().mockResolvedValue("mongodb://localhost/test"),
    getBoolean: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue(null),
    getNumber: jest.fn().mockResolvedValue(0),
  };
  (tracker as never)["configService"] = mockConfigService;
  (tracker as never)["isConnected"] = true;
  (tracker as never)["client"] = mockClient;

  return { tracker, mockConfigService, usersFetch };
}

function makePollAnswer(guildId: string | null = "guild1"): PollAnswer {
  return {
    poll: {
      message: {
        guild: guildId ? { id: guildId } : null,
        guildId: guildId ?? null,
      },
    },
  } as unknown as PollAnswer;
}

describe("PollParticipationTracker", () => {
  let updateOne: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    updateOne = (
      PollParticipationTracking as unknown as { updateOne: jest.Mock }
    ).updateOne;
    updateOne.mockResolvedValue({ matchedCount: 1 });
    (PollParticipationTracker as unknown as { instance: unknown }).instance =
      undefined;
  });

  describe("singleton pattern", () => {
    it("returns the same instance", () => {
      const a = PollParticipationTracker.getInstance({} as Client);
      const b = PollParticipationTracker.getInstance({} as Client);
      expect(a).toBe(b);
    });
  });

  describe("gating", () => {
    it("does not write when tracking is disabled", async () => {
      const { tracker, mockConfigService } = createTracker({
        username: "Voter",
        bot: false,
      });
      mockConfigService.getBoolean.mockResolvedValue(false);

      await tracker.handlePollVoteAdd(makePollAnswer(), "voter1");
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("ignores DM polls (no guild)", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      await tracker.handlePollVoteAdd(makePollAnswer(null), "voter1");
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("ignores votes cast by bots", async () => {
      const { tracker } = createTracker({ username: "Botty", bot: true });
      await tracker.handlePollVoteAdd(makePollAnswer(), "voter1");
      expect(updateOne).not.toHaveBeenCalled();
    });
  });

  describe("recording", () => {
    it("records a vote with a per-year bucket", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      await tracker.handlePollVoteAdd(makePollAnswer(), "voter1");

      expect(updateOne).toHaveBeenCalledTimes(1);
      const [filter, update] = updateOne.mock.calls[0];
      expect(filter).toEqual({ userId: "voter1", guildId: "guild1" });
      expect(update.$inc.totalVotes).toBe(1);
      const year = String(new Date().getFullYear());
      expect(update.$inc[`yearlyVotes.${year}`]).toBe(1);
      expect(update.$set.username).toBe("Voter");
    });
  });

  describe("error handling", () => {
    it("swallows DB errors", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      updateOne.mockRejectedValue(new Error("DB error"));

      await expect(
        tracker.handlePollVoteAdd(makePollAnswer(), "voter1"),
      ).resolves.not.toThrow();
    });
  });
});
