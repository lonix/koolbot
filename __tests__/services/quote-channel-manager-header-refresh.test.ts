import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockRegisterReloadCallback = jest.fn();
const mockGetBoolean = jest.fn();
const mockGetString = jest.fn();
const mockSet = jest.fn();

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

const HEADER_TITLE = "📝 Welcome to the Quote Channel!";
const SHARED_FOOTER = "KoolBot · Quotes";
const LEGACY_FOOTER = "KoolBot Quote System";
const OLD_DESCRIPTION =
  "This channel is managed by KoolBot to showcase memorable quotes from server members.";

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
  return QuoteChannelManager.getInstance(mockClient) as any;
}

/** The header as posted before #1348: old footer text, older copy. */
const OLD_HEADER_EMBED = {
  title: HEADER_TITLE,
  description: OLD_DESCRIPTION,
  footer: { text: LEGACY_FOOTER },
  fields: [
    {
      name: "📥 How to Add a Quote",
      value: "Use the `/quote` command.",
      inline: false,
    },
  ],
};

function storedMessage(
  embed: unknown,
  opts: { authorId?: string; editImpl?: () => Promise<unknown> } = {},
) {
  return {
    id: "header1",
    author: { id: opts.authorId ?? "bot123" },
    pinned: true,
    embeds: embed === undefined ? [] : [embed],
    edit: jest.fn(opts.editImpl ?? (async () => undefined)),
    pin: jest.fn(),
    delete: jest.fn(),
  };
}

function channelWith(existing: ReturnType<typeof storedMessage>) {
  return {
    send: jest.fn(async () => ({ id: "new", pin: jest.fn() })),
    messages: {
      fetch: jest.fn(async () => existing),
      fetchPinned: jest.fn(async () => []),
    },
  };
}

describe("QuoteChannelManager - existing header copy is kept current (#1357)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSet.mockResolvedValue(undefined);
    mockGetBoolean.mockResolvedValue(true);
    mockGetString.mockResolvedValue("header1");
  });

  it("edits an old header (old copy, old footer) in place: same message, still pinned, no repost", async () => {
    const manager = await loadManager();
    const existing = storedMessage(OLD_HEADER_EMBED);
    const channel = channelWith(existing);

    await manager.ensureHeaderPost(channel);

    expect(existing.edit).toHaveBeenCalledTimes(1);
    const payload = (existing.edit.mock.calls[0] as any)[0];
    const sent = payload.embeds[0].toJSON();
    const wanted = manager.buildHeaderEmbed().toJSON();
    expect(sent.title).toBe(HEADER_TITLE);
    expect(sent.footer.text).toBe(SHARED_FOOTER);
    expect(sent.description).toBe(wanted.description);
    expect(sent.fields).toEqual(wanted.fields);
    // The edit names no mentions.
    expect(payload.allowedMentions).toEqual({ parse: [] });
    // Same message: nothing posted, deleted, re-pinned or re-stored.
    expect(channel.send).not.toHaveBeenCalled();
    expect(existing.delete).not.toHaveBeenCalled();
    expect(existing.pin).not.toHaveBeenCalled();
    expect(existing.pinned).toBe(true);
    expect(existing.id).toBe("header1");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("edits a header that only has an out-of-date footer", async () => {
    const manager = await loadManager();
    const current = manager.buildHeaderEmbed().toJSON();
    const existing = storedMessage({
      ...current,
      footer: { text: LEGACY_FOOTER },
    });

    await manager.ensureHeaderPost(channelWith(existing));

    expect(existing.edit).toHaveBeenCalledTimes(1);
  });

  it("edits a header that only has an out-of-date field", async () => {
    const manager = await loadManager();
    const current = manager.buildHeaderEmbed().toJSON();
    const existing = storedMessage({
      ...current,
      fields: [{ ...current.fields![0], value: "older text" }],
    });

    await manager.ensureHeaderPost(channelWith(existing));

    expect(existing.edit).toHaveBeenCalledTimes(1);
  });

  it("does not edit a header that already has the current copy", async () => {
    const manager = await loadManager();
    const existing = storedMessage(manager.buildHeaderEmbed().toJSON());
    const channel = channelWith(existing);

    await manager.ensureHeaderPost(channel);

    expect(existing.edit).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("does not edit twice: the refreshed header is left alone on the next run", async () => {
    const manager = await loadManager();
    const existing = storedMessage(OLD_HEADER_EMBED);
    // Discord returns the edited embed on the next fetch.
    existing.edit.mockImplementation(async (...args: unknown[]) => {
      const payload = args[0] as { embeds: { toJSON(): unknown }[] };
      existing.embeds = [payload.embeds[0].toJSON() as any];
    });
    const channel = channelWith(existing);

    await manager.ensureHeaderPost(channel);
    await manager.ensureHeaderPost(channel);

    expect(existing.edit).toHaveBeenCalledTimes(1);
  });

  it("survives a failed edit: no throw, no repost, no delete, logged", async () => {
    const manager = await loadManager();
    const err = Object.assign(new Error("Missing Access"), {
      name: "DiscordAPIError",
      code: 50001,
    });
    const existing = storedMessage(OLD_HEADER_EMBED, {
      editImpl: async () => {
        throw err;
      },
    });
    const channel = channelWith(existing);

    await expect(manager.ensureHeaderPost(channel)).resolves.toBeUndefined();

    expect(existing.edit).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
    expect(existing.delete).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to update quote channel header copy"),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("code=50001"),
    );
  });

  it("does not turn a quote post into the header when the stored id points at one", async () => {
    const manager = await loadManager();
    const quotePost = storedMessage({
      description: '"Great quote!"',
      footer: { text: SHARED_FOOTER },
      fields: [{ name: "Author", value: "<@1>", inline: true }],
    });
    const channel = channelWith(quotePost);

    await manager.ensureHeaderPost(channel);

    expect(quotePost.edit).not.toHaveBeenCalled();
    expect(quotePost.delete).not.toHaveBeenCalled();
  });

  it("does not edit a message the bot did not write", async () => {
    const manager = await loadManager();
    const foreign = storedMessage(OLD_HEADER_EMBED, { authorId: "user999" });
    const channel = channelWith(foreign);

    await manager.ensureHeaderPost(channel);

    expect(foreign.edit).not.toHaveBeenCalled();
  });

  it("does not edit a stored message that has no embed", async () => {
    const manager = await loadManager();
    const bare = storedMessage(undefined);

    await manager.ensureHeaderPost(channelWith(bare));

    expect(bare.edit).not.toHaveBeenCalled();
  });

  describe("old-footer headers are still recognised", () => {
    it("finds a header that only has the old header footer (no title match needed)", async () => {
      const manager = await loadManager();
      const legacy = {
        id: "legacy1",
        author: { id: "bot123" },
        embeds: [{ footer: { text: LEGACY_FOOTER } }],
      };
      const channel = {
        messages: {
          fetchPinned: jest.fn(async () => [legacy]),
          fetch: jest.fn(async () => []),
        },
      };

      expect(await manager.findExistingHeader(channel)).toEqual({
        id: "legacy1",
      });
    });

    it("never mistakes a quote post for the header (shared footer is not an identifier)", async () => {
      const manager = await loadManager();
      const quotePost = {
        id: "q1",
        author: { id: "bot123" },
        embeds: [{ description: '"hi"', footer: { text: SHARED_FOOTER } }],
      };
      const channel = {
        messages: {
          fetchPinned: jest.fn(async () => [quotePost]),
          fetch: jest.fn(async () => [quotePost]),
        },
      };

      expect(await manager.findExistingHeader(channel)).toBeNull();
    });

    it("adopts a lost-id old-footer header, then refreshes it in place", async () => {
      mockGetString.mockResolvedValue("");
      const manager = await loadManager();
      const legacy = storedMessage(OLD_HEADER_EMBED);
      const channel = {
        send: jest.fn(),
        messages: {
          fetchPinned: jest.fn(async () => [legacy]),
          fetch: jest.fn(async () => legacy),
        },
      };

      await manager.ensureHeaderPost(channel);

      expect(mockSet).toHaveBeenCalledWith(
        "quotes.header_message_id",
        "header1",
        expect.any(String),
        "quotes",
      );
      expect(legacy.edit).toHaveBeenCalledTimes(1);
      expect(channel.send).not.toHaveBeenCalled();
      expect(legacy.delete).not.toHaveBeenCalled();
    });

    it("a failed fetch of the adopted header is logged and does not throw or repost", async () => {
      mockGetString.mockResolvedValue("");
      const manager = await loadManager();
      const legacy = storedMessage(OLD_HEADER_EMBED);
      const channel = {
        send: jest.fn(),
        messages: {
          fetchPinned: jest.fn(async () => [legacy]),
          fetch: jest.fn(async () => {
            throw new Error("boom");
          }),
        },
      };

      await expect(manager.ensureHeaderPost(channel)).resolves.toBeUndefined();

      expect(legacy.edit).not.toHaveBeenCalled();
      expect(channel.send).not.toHaveBeenCalled();
    });
  });

  describe("creating the header", () => {
    it("posts the same embed the refresh compares against, with no mentions", async () => {
      mockGetString.mockResolvedValue("");
      const manager = await loadManager();
      const sent: any = { id: "fresh", pin: jest.fn() };
      const channel = {
        send: jest.fn(async () => sent),
        messages: {
          fetchPinned: jest.fn(async () => []),
          fetch: jest.fn(async () => []),
        },
      };

      await manager.ensureHeaderPost(channel);

      expect(channel.send).toHaveBeenCalledTimes(1);
      const payload = (channel.send.mock.calls[0] as any)[0];
      expect(payload.allowedMentions).toEqual({ parse: [] });
      const data = payload.embeds[0].toJSON();
      const wanted = manager.buildHeaderEmbed().toJSON();
      expect(data.title).toBe(wanted.title);
      expect(data.description).toBe(wanted.description);
      expect(data.fields).toEqual(wanted.fields);
      expect(data.footer.text).toBe(SHARED_FOOTER);
    });

    it("a header it just posted is up to date, so the next run does not edit it", async () => {
      const manager = await loadManager();
      const posted = storedMessage(manager.buildHeaderEmbed().toJSON());

      await manager.ensureHeaderPost(channelWith(posted));

      expect(posted.edit).not.toHaveBeenCalled();
    });
  });
});
