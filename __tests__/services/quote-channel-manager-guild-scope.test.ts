import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { Client } from "discord.js";
import { QuoteChannelManager } from "../../src/services/quote-channel-manager.js";

// #1144: the quote channel's own reaction listeners must ignore a foreign
// guild before any partial fetch, so a reaction there costs no REST call.

type ReactionHandler = (reaction: unknown, user: unknown) => Promise<void>;

describe("QuoteChannelManager guild scope (#1144)", () => {
  const originalGuildId = process.env.GUILD_ID;
  const handlers = new Map<string, ReactionHandler>();

  beforeEach(() => {
    process.env.GUILD_ID = "home-guild";
    handlers.clear();
    const client = {
      isReady: jest.fn(() => true),
      user: { id: "bot-id" },
      on: jest.fn((event: string, handler: ReactionHandler) => {
        handlers.set(event, handler);
      }),
      removeListener: jest.fn(),
    } as unknown as Client;
    const manager = QuoteChannelManager.getInstance(client);
    (
      manager as unknown as { setupReactionHandlers: () => void }
    ).setupReactionHandlers();
  });

  afterEach(() => {
    if (originalGuildId === undefined) delete process.env.GUILD_ID;
    else process.env.GUILD_ID = originalGuildId;
  });

  it.each(["messageReactionAdd", "messageReactionRemove"])(
    "%s from a foreign guild triggers no fetch",
    async (event) => {
      const handler = handlers.get(event);
      expect(handler).toBeDefined();
      const reactionFetch = jest.fn<() => Promise<unknown>>();
      const userFetch = jest.fn<() => Promise<unknown>>();
      await handler!(
        {
          partial: true,
          fetch: reactionFetch,
          message: { guildId: "foreign-guild", channelId: "c1", id: "m1" },
        },
        { bot: false, partial: true, fetch: userFetch },
      );
      expect(reactionFetch).not.toHaveBeenCalled();
      expect(userFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["messageReactionAdd", "messageReactionRemove"])(
    "%s from the configured guild still resolves partials",
    async (event) => {
      const handler = handlers.get(event);
      const reactionFetch = jest.fn<() => Promise<unknown>>();
      reactionFetch.mockResolvedValue(undefined);
      const userFetch = jest.fn<() => Promise<unknown>>();
      userFetch.mockResolvedValue(undefined);
      await handler!(
        {
          partial: true,
          fetch: reactionFetch,
          message: { guildId: "home-guild", channelId: "c1", id: "m1" },
        },
        { bot: false, partial: true, fetch: userFetch },
      );
      expect(reactionFetch).toHaveBeenCalledTimes(1);
      expect(userFetch).toHaveBeenCalledTimes(1);
    },
  );
});
