import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Re-post of the notices channel header (#1428): posts first, stores the new
 * id, deletes the old header last, and is queued with a resync so the resync's
 * "delete every bot message but the header" pass can't remove the new header.
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
      addChangeListener: jest.fn(),
      getBoolean: async (key: string, def: boolean) =>
        store.has(key) ? (store.get(key) as boolean) : def,
      getString: async (key: string, def: string) =>
        store.has(key) ? (store.get(key) as string) : def,
      set: mockSet,
    })),
  },
}));
jest.unstable_mockModule("../../src/models/notice.js", () => ({
  default: {
    find: () => ({ sort: async () => [] }),
  },
}));

const discordError = (code: number): Error =>
  Object.assign(new Error(`Discord ${code}`), { code });

let calls: string[];
let oldMessage: any;
let newMessage: any;
let channel: any;
let mockClient: any;

async function manager() {
  const { NoticesChannelManager } =
    await import("../../src/services/notices-channel-manager.js");
  NoticesChannelManager.reset();
  return NoticesChannelManager.getInstance(mockClient);
}

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  store.set("notices.enabled", true);
  store.set("notices.channel_id", "c1");
  store.set("notices.header_message_id", "old1");
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
    author: { id: "bot" },
    pin: jest.fn(async () => {
      calls.push("pin");
    }),
    delete: jest.fn(async () => {
      calls.push("delete-new");
    }),
  };
  channel = {
    id: "c1",
    name: "notices",
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
  };
});

describe("NoticesChannelManager.repostHeader", () => {
  it("posts, pins, stores the new id, then deletes the old header", async () => {
    const result = await (await manager()).repostHeader("old1");
    expect(result).toEqual({
      ok: true,
      messageId: "new1",
      oldMessageId: "old1",
      old: "deleted",
    });
    expect(calls).toEqual(["send", "pin", "delete-old"]);
    expect(store.get("notices.header_message_id")).toBe("new1");
    expect(channel.send.mock.calls[0][0].embeds[0].toJSON().title).toContain(
      "Server notices",
    );
  });

  it("succeeds when the old header is already gone", async () => {
    channel.messages.fetch.mockRejectedValue(discordError(10008));
    const result = await (await manager()).repostHeader("old1");
    expect(result).toMatchObject({ ok: true, old: "not-found" });
    expect(store.get("notices.header_message_id")).toBe("new1");
  });

  it("explains the missing permission and keeps the old header live", async () => {
    channel.send.mockRejectedValue(discordError(50001));
    const result = await (await manager()).repostHeader("old1");
    expect(result).toMatchObject({ ok: false, reason: "no-permission" });
    expect(store.get("notices.header_message_id")).toBe("old1");
    expect(oldMessage.delete).not.toHaveBeenCalled();
  });

  it("finds the old header only in the current channel (channel changed)", async () => {
    channel.messages.fetch.mockRejectedValue(discordError(10008));
    const result = await (await manager()).repostHeader();
    expect(result).toMatchObject({ ok: true, old: "not-found" });
    expect(mockClient.channels.fetch).toHaveBeenCalledWith("c1");
  });

  it("refuses without a usable channel or with the header off", async () => {
    mockClient.channels.fetch.mockResolvedValue(null);
    expect(await (await manager()).repostHeader()).toMatchObject({
      ok: false,
      reason: "not-ready",
    });
    mockClient.channels.fetch.mockResolvedValue(channel);
    store.set("notices.header_enabled", false);
    expect(await (await manager()).repostHeader()).toMatchObject({
      ok: false,
      reason: "not-ready",
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("re-posts once when the same form is submitted twice at the same time", async () => {
    const m = await manager();
    const results = await Promise.all([
      m.repostHeader("old1"),
      m.repostHeader("old1"),
    ]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: "stale" });
  });

  it("removes the new header again when its id can't be saved", async () => {
    mockSet.mockRejectedValueOnce(new Error("mongo down"));
    const result = await (await manager()).repostHeader("old1");
    expect(result).toMatchObject({ ok: false, reason: "not-saved" });
    expect(calls).toEqual(["send", "pin", "delete-new"]);
    expect(oldMessage.delete).not.toHaveBeenCalled();
  });

  it("makes a resync wait for it, so the new header is not deleted as a stray bot message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    channel.send.mockImplementation(async () => {
      calls.push("send");
      await gate;
      return newMessage;
    });
    // What the resync sees once it runs: both headers' messages in the channel.
    channel.messages.fetch.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "object") {
        calls.push("resync-scan");
        return { values: () => [oldMessage, newMessage] };
      }
      return oldMessage;
    });
    const m = await manager();
    const repost = m.repostHeader("old1");
    const resync = m.syncNotices();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["send"]);
    release();
    await Promise.all([repost, resync]);
    // The resync scanned only after the new id was stored, so it spared the
    // new header and, with the old one already deleted, found nothing else to
    // remove.
    expect(calls.indexOf("resync-scan")).toBeGreaterThan(
      calls.indexOf("delete-old"),
    );
    expect(newMessage.delete).not.toHaveBeenCalled();
  });
});

describe("automatic header recreation vs Re-post (#1428)", () => {
  function deletedHeaderChannel(): void {
    const live = new Map<string, unknown>();
    channel.messages.fetch = jest.fn(async (arg: unknown) => {
      const m = typeof arg === "string" ? live.get(arg) : undefined;
      if (!m) throw discordError(10008);
      return m;
    });
    let n = 0;
    channel.send = jest.fn(async () => {
      n += 1;
      const msg = {
        id: `created${n}`,
        author: { id: "bot" },
        embeds: [],
        pin: jest.fn(async () => undefined),
        delete: jest.fn(async () => undefined),
        edit: jest.fn(async () => undefined),
      };
      live.set(msg.id, msg);
      return msg;
    });
  }

  it("creates exactly one header when the cleanup check and Re-post overlap", async () => {
    deletedHeaderChannel();
    const m: any = await manager();
    await Promise.all([m.ensureHeaderPost(channel), m.repostHeader("old1")]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(store.get("notices.header_message_id")).toBe("created1");
  });

  it("creates exactly one header when Re-post goes first and the check follows", async () => {
    deletedHeaderChannel();
    const m: any = await manager();
    await Promise.all([m.repostHeader("old1"), m.ensureHeaderPost(channel)]);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(store.get("notices.header_message_id")).toBe("created1");
  });
});
