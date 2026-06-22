import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { Collection } from "discord.js";

const mockRegisterReloadCallback = jest.fn();
const mockGetBoolean = jest.fn();
const mockGetString = jest.fn();
const mockSet = jest.fn();

const mockSetVoteCountsByMessageId = jest.fn();
const mockListQuotes = jest.fn();
const mockUpdateQuoteMessageId = jest.fn();

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
  quoteService: {
    setVoteCountsByMessageId: mockSetVoteCountsByMessageId,
    listQuotes: mockListQuotes,
    updateQuoteMessageId: mockUpdateQuoteMessageId,
  },
}));

const HEADER_TITLE = "📝 Welcome to the Quote Channel!";
const HEADER_FOOTER = "KoolBot Quote System";

function headerMessage(id: string) {
  return {
    id,
    author: { id: "bot123" },
    embeds: [{ title: HEADER_TITLE, footer: { text: HEADER_FOOTER } }],
  };
}

function userMessage(id: string) {
  return {
    id,
    author: { id: "user999" },
    embeds: [{ title: "something else", footer: { text: "nope" } }],
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

describe("QuoteChannelManager - header idempotency & vote persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
  });

  describe("findExistingHeader", () => {
    it("finds a pinned bot header", async () => {
      const manager = await loadManager();
      const channel = {
        messages: {
          fetchPinned: jest
            .fn()
            .mockResolvedValue([userMessage("u1"), headerMessage("h1")]),
          fetch: jest.fn().mockResolvedValue([]),
        },
      };
      const result = await (manager as any).findExistingHeader(channel);
      expect(result).toEqual({ id: "h1" });
      // Found in pins → no need to scan recent messages.
      expect(channel.messages.fetch).not.toHaveBeenCalled();
    });

    it("falls back to a recent-message scan when no pin matches", async () => {
      const manager = await loadManager();
      const channel = {
        messages: {
          fetchPinned: jest.fn().mockResolvedValue([userMessage("u1")]),
          fetch: jest
            .fn()
            .mockResolvedValue([userMessage("u2"), headerMessage("h2")]),
        },
      };
      const result = await (manager as any).findExistingHeader(channel);
      expect(result).toEqual({ id: "h2" });
    });

    it("returns null when no header exists anywhere", async () => {
      const manager = await loadManager();
      const channel = {
        messages: {
          fetchPinned: jest.fn().mockResolvedValue([userMessage("u1")]),
          fetch: jest.fn().mockResolvedValue([userMessage("u2")]),
        },
      };
      const result = await (manager as any).findExistingHeader(channel);
      expect(result).toBeNull();
    });
  });

  describe("ensureHeaderPost adoption", () => {
    it("adopts an existing header instead of creating a duplicate", async () => {
      // Header enabled, but the stored ID is gone (e.g. after a reinstall).
      mockGetBoolean.mockResolvedValue(true);
      mockGetString.mockResolvedValue(""); // no stored header id

      const manager = await loadManager();
      const channel = {
        send: jest.fn(),
        messages: {
          fetchPinned: jest.fn().mockResolvedValue([headerMessage("existing")]),
          fetch: jest.fn().mockResolvedValue([]),
        },
      };

      await (manager as any).ensureHeaderPost(channel);

      // Adopted the existing header id, did NOT post a second welcome message.
      expect(channel.send).not.toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        "quotes.header_message_id",
        "existing",
        expect.any(String),
        "quotes",
      );
    });
  });

  describe("clearChannel", () => {
    it("deletes messages bulkDelete skips (older than 14 days) individually", async () => {
      const manager = await loadManager();

      const m1: any = {
        id: "m1",
        delete: jest.fn().mockResolvedValue(undefined),
      };
      const m2: any = {
        id: "m2",
        delete: jest.fn().mockResolvedValue(undefined),
      };
      const firstBatch = new Collection<string, any>([
        ["m1", m1],
        ["m2", m2],
      ]);
      const empty = new Collection<string, any>();

      const channel: any = {
        messages: {
          fetch: jest
            .fn()
            .mockResolvedValueOnce(firstBatch)
            .mockResolvedValueOnce(empty),
        },
        // Both messages are >14 days old, so bulkDelete removes nothing.
        bulkDelete: jest.fn().mockResolvedValue(new Collection<string, any>()),
      };

      const total = await (manager as any).clearChannel(channel);

      expect(total).toBe(2);
      expect(m1.delete).toHaveBeenCalledTimes(1);
      expect(m2.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe("scheduleVotePersist (debounced)", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it("coalesces a burst into a single write with the latest values", async () => {
      const manager = await loadManager();
      mockSetVoteCountsByMessageId.mockResolvedValue(undefined);

      (manager as any).scheduleVotePersist("msg1", 1, 0);
      (manager as any).scheduleVotePersist("msg1", 2, 0);
      (manager as any).scheduleVotePersist("msg1", 3, 1);

      expect(mockSetVoteCountsByMessageId).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      expect(mockSetVoteCountsByMessageId).toHaveBeenCalledTimes(1);
      expect(mockSetVoteCountsByMessageId).toHaveBeenCalledWith("msg1", 3, 1);
    });
  });
});
