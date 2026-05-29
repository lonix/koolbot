import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client, Message } from "discord.js";

// Rely on the global mongoose mock from setup.ts for a stable shared model
// object whose methods we reconfigure per-test.
jest.mock("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  isDebugMode: jest.fn(() => false),
}));

import { MessageActivityTracker } from "../../src/services/message-activity-tracker.js";
import { MessageActivityTracking } from "../../src/models/message-activity-tracking.js";

// The global mongoose mock does not provide updateOne; attach it to the
// shared model object so the tracker can call it.
(MessageActivityTracking as unknown as { updateOne: jest.Mock }).updateOne =
  jest.fn();

function createTracker() {
  const mockClient = {} as Client;
  const tracker = MessageActivityTracker.getInstance(mockClient);

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

function makeMessage(overrides: Partial<{
  bot: boolean;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
}> = {}): Message {
  const {
    bot = false,
    guildId = "guild1",
    channelId = "chan1",
    userId = "user1",
    username = "TestUser",
  } = overrides;
  return {
    author: { id: userId, username, bot },
    guild: guildId ? { id: guildId } : null,
    channelId,
    createdAt: new Date(),
  } as unknown as Message;
}

describe("MessageActivityTracker", () => {
  let updateOne: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    updateOne = (MessageActivityTracking as unknown as { updateOne: jest.Mock })
      .updateOne;
    (MessageActivityTracker as unknown as { instance: unknown }).instance =
      undefined;
  });

  describe("singleton pattern", () => {
    it("returns the same instance", () => {
      const a = MessageActivityTracker.getInstance({} as Client);
      const b = MessageActivityTracker.getInstance({} as Client);
      expect(a).toBe(b);
    });
  });

  describe("gating", () => {
    it("does not write when tracking is disabled", async () => {
      const { tracker, mockConfigService } = createTracker();
      mockConfigService.getBoolean.mockResolvedValue(false);

      await tracker.handleMessageCreate(makeMessage());
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("ignores bot messages", async () => {
      const { tracker } = createTracker();
      await tracker.handleMessageCreate(makeMessage({ bot: true }));
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("ignores DMs (no guild)", async () => {
      const { tracker } = createTracker();
      await tracker.handleMessageCreate(makeMessage({ guildId: null }));
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("skips excluded channels", async () => {
      const { tracker, mockConfigService } = createTracker();
      mockConfigService.get.mockResolvedValue("chan1,chan2");

      await tracker.handleMessageCreate(makeMessage({ channelId: "chan1" }));
      expect(updateOne).not.toHaveBeenCalled();
    });
  });

  describe("increment behaviour", () => {
    it("creates a counter on a clean collection (no existing channel)", async () => {
      const { tracker } = createTracker();
      // First update matches nothing → triggers the upsert path.
      updateOne
        .mockResolvedValueOnce({ matchedCount: 0 })
        .mockResolvedValueOnce({ matchedCount: 1, upsertedCount: 1 });

      await tracker.handleMessageCreate(makeMessage());

      expect(updateOne).toHaveBeenCalledTimes(2);

      // Second call is the upsert that seeds channels[] and recentMessages.
      const [filter, update, options] = updateOne.mock.calls[1];
      expect(filter).toEqual({ userId: "user1", guildId: "guild1" });
      expect(update.$inc).toEqual({ totalCount: 1 });
      expect(update.$push.channels).toEqual({ channelId: "chan1", count: 1 });
      expect(update.$push.recentMessages.channelId).toBe("chan1");
      expect(options).toEqual({ upsert: true });
    });

    it("increments an existing channel counter without a second write", async () => {
      const { tracker } = createTracker();
      // First update matches the existing (user, guild, channel) doc.
      updateOne.mockResolvedValueOnce({ matchedCount: 1 });

      await tracker.handleMessageCreate(makeMessage());

      expect(updateOne).toHaveBeenCalledTimes(1);

      const [filter, update] = updateOne.mock.calls[0];
      expect(filter).toEqual({
        userId: "user1",
        guildId: "guild1",
        "channels.channelId": "chan1",
      });
      expect(update.$inc).toEqual({
        totalCount: 1,
        "channels.$.count": 1,
      });
      expect(update.$push.recentMessages.channelId).toBe("chan1");
    });
  });

  describe("error handling", () => {
    it("swallows DB errors", async () => {
      const { tracker } = createTracker();
      updateOne.mockRejectedValue(new Error("DB error"));

      await expect(
        tracker.handleMessageCreate(makeMessage()),
      ).resolves.not.toThrow();
    });
  });
});
