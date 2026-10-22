import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Re-post of the quote channel header (#1428): posts first, stores the new id,
 * deletes the old header last, and never leaves two live copies.
 */

const store = new Map<string, unknown>();
const mockSet = jest.fn(async (key: string, value: unknown) => {
  store.set(key, value);
});
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock("cron");
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  isDebugMode: () => false,
  default: mockLogger,
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: jest.fn(),
      getBoolean: async (key: string, def: boolean) =>
        store.has(key) ? (store.get(key) as boolean) : def,
      getString: async (key: string, def: string) =>
        store.has(key) ? (store.get(key) as string) : def,
      set: mockSet,
    })),
  },
}));
jest.unstable_mockModule("../../src/services/quote-service.js", () => ({
  quoteService: {},
}));

const discordError = (code: number): Error =>
  Object.assign(new Error(`Discord ${code}`), { code });

let calls: string[];
let oldMessage: any;
let newMessage: any;
let channel: any;
let mockClient: any;

async function manager() {
  const { QuoteChannelManager } =
    await import("../../src/services/quote-channel-manager.js");
  return QuoteChannelManager.getInstance(mockClient);
}

beforeEach(async () => {
  jest.clearAllMocks();
  store.clear();
  store.set("quotes.enabled", true);
  store.set("quotes.channel_id", "c1");
  store.set("quotes.header_message_id", "old1");
  calls = [];
  oldMessage = {
    id: "old1",
    author: { id: "bot" },
    delete: jest.fn(async () => {
      calls.push("delete-old");
    }),
  };
  newMessage = {
    id: "new1",
    pin: jest.fn(async () => {
      calls.push("pin");
    }),
    delete: jest.fn(async () => {
      calls.push("delete-new");
    }),
  };
  channel = {
    id: "c1",
    name: "quotes",
    isTextBased: () => true,
    isDMBased: () => false,
    send: jest.fn(async () => {
      calls.push("send");
      return newMessage;
    }),
    messages: { fetch: jest.fn(async () => oldMessage) },
  };
  mockClient = {
    isReady: () => true,
    user: { id: "bot" },
    channels: { fetch: jest.fn(async () => channel) },
    on: jest.fn(),
    removeListener: jest.fn(),
  };
  const mod = await import("../../src/services/quote-channel-manager.js");
  (mod.QuoteChannelManager as any).instance = undefined;
});

describe("QuoteChannelManager.repostHeader", () => {
  it("posts, pins, stores the new id, then deletes the old header", async () => {
    const result = await (await manager()).repostHeader("old1");
    expect(result).toEqual({
      ok: true,
      messageId: "new1",
      oldMessageId: "old1",
      old: "deleted",
    });
    expect(calls).toEqual(["send", "pin", "delete-old"]);
    expect(store.get("quotes.header_message_id")).toBe("new1");
    const payload = channel.send.mock.calls[0][0];
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.embeds[0].toJSON().title).toContain("Quote Channel");
  });

  it("succeeds when the old header is already gone", async () => {
    channel.messages.fetch.mockRejectedValue(discordError(10008));
    const result = await (await manager()).repostHeader("old1");
    expect(result).toMatchObject({ ok: true, old: "not-found" });
    expect(store.get("quotes.header_message_id")).toBe("new1");
  });

  it("explains the missing permission and keeps the old header live", async () => {
    channel.send.mockRejectedValue(discordError(50013));
    const result = await (await manager()).repostHeader("old1");
    expect(result).toMatchObject({ ok: false, reason: "no-permission" });
    expect((result as { error: string }).error).toContain("Embed Links");
    expect(store.get("quotes.header_message_id")).toBe("old1");
    expect(oldMessage.delete).not.toHaveBeenCalled();
  });

  it("looks for the old header only in the current channel (channel changed)", async () => {
    // The old header sits in the previous channel: not found here.
    channel.messages.fetch.mockRejectedValue(discordError(10008));
    const result = await (await manager()).repostHeader();
    expect(result).toMatchObject({ ok: true, old: "not-found" });
    expect(channel.messages.fetch).toHaveBeenCalledWith("old1");
    expect(mockClient.channels.fetch).toHaveBeenCalledWith("c1");
  });

  it("refuses when the channel can't be found, without posting", async () => {
    mockClient.channels.fetch.mockResolvedValue(null);
    const result = await (await manager()).repostHeader();
    expect(result).toMatchObject({ ok: false, reason: "not-ready" });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("refuses when quotes or the header are switched off", async () => {
    store.set("quotes.header_enabled", false);
    expect(await (await manager()).repostHeader()).toMatchObject({
      ok: false,
      reason: "not-ready",
    });
    store.set("quotes.header_enabled", true);
    store.set("quotes.enabled", false);
    expect(await (await manager()).repostHeader()).toMatchObject({
      ok: false,
      reason: "not-ready",
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("re-posts once when the same form is submitted twice at the same time", async () => {
    const m = await manager();
    const [a, b] = await Promise.all([
      m.repostHeader("old1"),
      m.repostHeader("old1"),
    ]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      ok: false,
      reason: "stale",
    });
    expect(store.get("quotes.header_message_id")).toBe("new1");
  });

  it("does nothing for a form that shows an older header id", async () => {
    store.set("quotes.header_message_id", "newer");
    const result = await (await manager()).repostHeader("old1");
    expect(result).toMatchObject({ ok: false, reason: "stale" });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("removes the new header again when its id can't be saved", async () => {
    mockSet.mockRejectedValueOnce(new Error("mongo down"));
    const result = await (await manager()).repostHeader("old1");
    expect(result).toMatchObject({ ok: false, reason: "not-saved" });
    expect(calls).toEqual(["send", "pin", "delete-new"]);
    expect(oldMessage.delete).not.toHaveBeenCalled();
    expect(store.get("quotes.header_message_id")).toBe("old1");
  });

  it("is queued behind a channel rebuild and never overlaps it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    channel.messages.fetchPinned = jest.fn(async () => []);
    const m: any = await manager();
    // A rebuild that is busy clearing the channel.
    jest.spyOn(m, "syncExistingQuotes").mockImplementation(async () => {
      calls.push("rebuild-start");
      await gate;
      calls.push("rebuild-end");
      return 0;
    });
    const rebuild = m.resetChannel();
    const repost = m.repostHeader();
    await new Promise((r) => setTimeout(r, 0));
    expect(channel.send).not.toHaveBeenCalled();
    release();
    await Promise.all([rebuild, repost]);
    expect(calls.slice(0, 3)).toEqual(["rebuild-start", "rebuild-end", "send"]);
  });
});
