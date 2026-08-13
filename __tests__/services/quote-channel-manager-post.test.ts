import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockRegisterReloadCallback = jest.fn();
const mockGetBoolean = jest.fn();
const mockGetString = jest.fn();
const mockSet = jest.fn();

jest.mock("../../src/utils/logger.js");
jest.mock("cron");

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: mockRegisterReloadCallback,
      getBoolean: mockGetBoolean,
      getString: mockGetString,
      set: mockSet,
    })),
  },
}));

jest.unstable_mockModule("../../src/services/quote-service.js", () => ({
  quoteService: {},
}));

function makeChannel(message: any) {
  return {
    isTextBased: jest.fn().mockReturnValue(true),
    isDMBased: jest.fn().mockReturnValue(false),
    send: jest.fn().mockResolvedValue(message),
  };
}

const mockClient: any = {
  isReady: jest.fn().mockReturnValue(true),
  user: { id: "bot123" },
  channels: { fetch: jest.fn() },
  on: jest.fn(),
  removeListener: jest.fn(),
};

async function loadManager() {
  const { QuoteChannelManager } =
    await import("../../src/services/quote-channel-manager.js");
  return QuoteChannelManager.getInstance(mockClient);
}

describe("QuoteChannelManager.postQuote - reaction failure handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetString.mockResolvedValue("channel123");
  });

  it("returns the message id when the message posts successfully", async () => {
    const message = {
      id: "msg123",
      react: jest.fn().mockResolvedValue(undefined),
    };
    const channel = makeChannel(message);
    mockClient.channels.fetch.mockResolvedValue(channel);

    const manager = await loadManager();
    const result = await manager.postQuote("q1", "hello", "author1", "adder1");

    expect(result).toBe("msg123");
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(message.react).toHaveBeenCalledWith("👍");
    expect(message.react).toHaveBeenCalledWith("👎");
  });

  it("still returns the message id when adding reactions fails", async () => {
    const message = {
      id: "msg456",
      react: jest.fn().mockRejectedValue(new Error("Missing Permissions")),
    };
    const channel = makeChannel(message);
    mockClient.channels.fetch.mockResolvedValue(channel);

    const manager = await loadManager();
    const result = await manager.postQuote("q2", "world", "author2", "adder2");

    // The message was posted; a reaction hiccup must not orphan it (issue #776).
    expect(result).toBe("msg456");
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(message.react).toHaveBeenCalled();
  });

  it("returns null when the message genuinely fails to send", async () => {
    const channel = {
      isTextBased: jest.fn().mockReturnValue(true),
      isDMBased: jest.fn().mockReturnValue(false),
      send: jest.fn().mockRejectedValue(new Error("Cannot send messages")),
    };
    mockClient.channels.fetch.mockResolvedValue(channel);

    const manager = await loadManager();
    const result = await manager.postQuote("q3", "nope", "author3", "adder3");

    expect(result).toBeNull();
  });
});
