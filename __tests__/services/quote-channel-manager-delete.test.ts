import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { DiscordAPIError, type Client } from "discord.js";

jest.mock("../../src/services/config-service.js");
jest.mock("../../src/utils/logger.js");

/**
 * `deleteQuoteMessage` has to report whether the post is actually *gone*
 * (#916).
 *
 * The per-user purge counts what this returns and shows it to the member as
 * posts removed from Discord, while `QuoteService.purgeForUser` deletes the
 * database row either way. So swallowing a failure and reporting nothing
 * would tell someone their words had been erased from the quote channel
 * while they are still on screen, with no row left to find them by.
 */
describe("QuoteChannelManager.deleteQuoteMessage", () => {
  let mockClient: Client;
  let channel: { messages: { fetch: jest.Mock } } | null;
  let channelGone: boolean;

  async function manager(): Promise<{
    deleteQuoteMessage(messageId: string): Promise<boolean>;
  }> {
    const { QuoteChannelManager } =
      await import("../../src/services/quote-channel-manager.js");
    const instance = QuoteChannelManager.getInstance(mockClient);
    // `getQuoteChannelDetailed` resolves config and the gateway; stub it so
    // these cases are about the delete outcome alone. `gone` distinguishes a
    // deleted channel (nothing left to remove) from an unreachable one.
    (
      instance as unknown as {
        getQuoteChannelDetailed: () => Promise<unknown>;
      }
    ).getQuoteChannelDetailed = async () => ({
      channel,
      gone: channelGone,
    });
    return instance;
  }

  /** A real `DiscordAPIError` with the given code, as discord.js throws. */
  function apiError(code: number): DiscordAPIError {
    return new DiscordAPIError(
      { code, message: "nope" },
      code,
      400,
      "DELETE",
      "",
      {},
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      guilds: { cache: new Map() },
      channels: { fetch: jest.fn() },
    } as unknown as Client;
    channel = { messages: { fetch: jest.fn() } };
    channelGone = false;
  });

  it("reports true when the post is deleted", async () => {
    const message = { delete: jest.fn(async () => undefined) };
    channel!.messages.fetch.mockResolvedValue(message);

    await expect((await manager()).deleteQuoteMessage("m1")).resolves.toBe(
      true,
    );
    expect(message.delete).toHaveBeenCalled();
  });

  it("reports true when the message is already gone", async () => {
    // `messageId` is overloaded — it starts life as the original message id
    // and is only later overwritten with the quote-channel post id — so an
    // Unknown Message is the expected case for older rows, and there is
    // nothing left to erase.
    channel!.messages.fetch.mockRejectedValue(apiError(10008));

    await expect((await manager()).deleteQuoteMessage("m1")).resolves.toBe(
      true,
    );
  });

  it("reports false when the delete is refused", async () => {
    channel!.messages.fetch.mockResolvedValue({
      delete: jest.fn(async () => {
        throw apiError(50013); // Missing Permissions
      }),
    });

    await expect((await manager()).deleteQuoteMessage("m1")).resolves.toBe(
      false,
    );
  });

  it("reports false when the quote channel is unreachable", async () => {
    // The post may well still exist; we simply could not look.
    channel = null;

    await expect((await manager()).deleteQuoteMessage("m1")).resolves.toBe(
      false,
    );
  });

  it("reports true when the quote channel itself was deleted", async () => {
    // Deleting the channel took every post in it, this one included, so
    // there is nothing left to remove and nothing to report (#916).
    channel = null;
    channelGone = true;

    await expect((await manager()).deleteQuoteMessage("m1")).resolves.toBe(
      true,
    );
  });
});
