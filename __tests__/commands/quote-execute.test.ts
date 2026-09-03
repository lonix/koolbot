/**
 * `execute()` tests for `/quote` (issue #849).
 *
 * `__tests__/commands/quote.test.ts` asserts only `SlashCommandBuilder`
 * metadata — `execute()` could have been deleted and it would still pass,
 * which is how `src/commands/quote.ts` ended up at ~11% coverage. These
 * tests drive the handler itself: the per-subcommand routing, the
 * Administrator gate on the three destructive subcommands, the
 * edit-ownership check, and the "don't persist unless the channel message
 * was updated" ordering.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MessageFlags } from "discord.js";
import {
  createMockChatInputInteraction,
  createRawMember,
  type MockChatInputInteraction,
  type MockCommandOptions,
} from "../test-utils.js";

const mockAddQuote = jest.fn<() => Promise<unknown>>();
const mockUpdateQuoteMessageId = jest.fn<() => Promise<unknown>>();
const mockGetQuoteById = jest.fn<() => Promise<unknown>>();
const mockEditQuote = jest.fn<() => Promise<unknown>>();
const mockExportQuotes = jest.fn<() => Promise<unknown>>();
const mockImportQuotes = jest.fn<() => Promise<unknown>>();
const mockPostQuote = jest.fn<() => Promise<string | null>>();
const mockUpdateQuoteMessage = jest.fn<() => Promise<unknown>>();
const mockResetChannel = jest.fn<() => Promise<{ reposted: number }>>();

jest.unstable_mockModule("../../src/services/quote-service.js", () => ({
  quoteService: {
    addQuote: mockAddQuote,
    updateQuoteMessageId: mockUpdateQuoteMessageId,
    getQuoteById: mockGetQuoteById,
    editQuote: mockEditQuote,
    exportQuotes: mockExportQuotes,
    importQuotes: mockImportQuotes,
  },
}));

jest.unstable_mockModule("../../src/services/quote-channel-manager.js", () => ({
  QuoteChannelManager: {
    getInstance: (): unknown => ({
      postQuote: mockPostQuote,
      updateQuoteMessage: mockUpdateQuoteMessage,
      resetChannel: mockResetChannel,
    }),
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { execute } = await import("../../src/commands/quote.js");

/** Build an interaction for a `/quote <sub>` invocation. */
function interaction(
  options: MockCommandOptions,
  overrides: Record<string, unknown> = {},
): MockChatInputInteraction {
  return createMockChatInputInteraction(options, overrides);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAddQuote.mockResolvedValue({
    _id: "quote-1",
    content: "Hello",
    authorId: "author-1",
    addedById: "user-1",
  });
  mockPostQuote.mockResolvedValue("message-1");
  mockUpdateQuoteMessageId.mockResolvedValue(undefined);
  mockUpdateQuoteMessage.mockResolvedValue(undefined);
  mockEditQuote.mockResolvedValue(undefined);
  mockResetChannel.mockResolvedValue({ reposted: 4 });
  mockExportQuotes.mockResolvedValue({ quotes: [{ id: "q1" }] });
  mockImportQuotes.mockResolvedValue({ imported: 2, skipped: 1, errors: [] });
});

describe("/quote add", () => {
  const options: MockCommandOptions = {
    subcommand: "add",
    strings: { text: "Hello" },
    users: { author: { id: "author-1", username: "bob" } },
  };

  it("stores the quote, posts it and records the message id", async () => {
    const it_ = interaction(options);
    await execute(it_);

    expect(mockAddQuote).toHaveBeenCalledWith(
      "Hello",
      "author-1",
      "user-1",
      "channel-1",
      "interaction-id",
    );
    expect(mockPostQuote).toHaveBeenCalledWith(
      "quote-1",
      "Hello",
      "author-1",
      "user-1",
    );
    expect(mockUpdateQuoteMessageId).toHaveBeenCalledWith(
      "quote-1",
      "message-1",
    );
    expect(it_.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("✅") }),
    );
  });

  it("still confirms the DB write when the channel post failed", async () => {
    mockPostQuote.mockResolvedValue(null);
    const it_ = interaction(options);
    await execute(it_);

    expect(mockUpdateQuoteMessageId).not.toHaveBeenCalled();
    const reply = it_.reply.mock.calls[0][0] as { content: string };
    expect(reply.content).toContain("could not post to channel");
  });

  it("reports a service failure instead of throwing", async () => {
    mockAddQuote.mockRejectedValue(new Error("quote too long"));
    const it_ = interaction(options);
    await expect(execute(it_)).resolves.toBeUndefined();
    const reply = it_.reply.mock.calls[0][0] as { content: string };
    expect(reply.content).toContain("quote too long");
  });
});

describe("/quote edit", () => {
  const base: MockCommandOptions = {
    subcommand: "edit",
    strings: { id: "quote-1", text: "Updated" },
  };

  it("requires at least one field to change", async () => {
    const it_ = interaction({ subcommand: "edit", strings: { id: "quote-1" } });
    await execute(it_);
    const reply = it_.reply.mock.calls[0][0] as { content: string };
    expect(reply.content).toContain("at least one field");
    expect(mockGetQuoteById).not.toHaveBeenCalled();
  });

  it("reports a quote id that does not exist", async () => {
    mockGetQuoteById.mockResolvedValue(null);
    const it_ = interaction(base);
    await execute(it_);
    const reply = it_.reply.mock.calls[0][0] as { content: string };
    expect(reply.content).toContain("Quote not found");
    expect(mockEditQuote).not.toHaveBeenCalled();
  });

  it("refuses to edit a quote somebody else added", async () => {
    mockGetQuoteById.mockResolvedValue({
      content: "Hello",
      authorId: "author-1",
      addedById: "someone-else",
      messageId: "message-1",
    });
    const it_ = interaction(base);
    await execute(it_);
    const reply = it_.reply.mock.calls[0][0] as { content: string };
    expect(reply.content).toContain("only edit quotes that you added");
    expect(mockEditQuote).not.toHaveBeenCalled();
  });

  it("normalizes legacy <@id> mentions before the ownership check", async () => {
    // Rows written before the id normalisation store mentions, not raw
    // snowflakes; comparing those verbatim would lock the original author
    // out of their own quote.
    mockGetQuoteById.mockResolvedValue({
      content: "Hello",
      authorId: "<@!222222222222222222>",
      addedById: "<@111111111111111111>",
      messageId: "message-1",
    });
    await execute(
      interaction(base, {
        user: { id: "111111111111111111", username: "alice" },
      }),
    );
    expect(mockEditQuote).toHaveBeenCalledWith(
      "quote-1",
      "Updated",
      "222222222222222222",
    );
  });

  it("does not persist the edit when the channel message could not be updated", async () => {
    mockGetQuoteById.mockResolvedValue({
      content: "Hello",
      authorId: "author-1",
      addedById: "user-1",
      messageId: "message-1",
    });
    mockUpdateQuoteMessage.mockRejectedValue(new Error("Unknown Message"));
    const it_ = interaction(base);
    await execute(it_);
    expect(mockEditQuote).not.toHaveBeenCalled();
    const reply = it_.reply.mock.calls[0][0] as { content: string };
    expect(reply.content).toContain(
      "couldn't find or update the quote message",
    );
  });

  it("keeps the existing text when only the author changed", async () => {
    mockGetQuoteById.mockResolvedValue({
      content: "Original",
      authorId: "author-1",
      addedById: "user-1",
      messageId: "message-1",
    });
    await execute(
      interaction({
        subcommand: "edit",
        strings: { id: "quote-1" },
        users: { author: { id: "author-2" } },
      }),
    );
    expect(mockEditQuote).toHaveBeenCalledWith(
      "quote-1",
      "Original",
      "author-2",
    );
  });
});

describe("/quote admin subcommands", () => {
  it.each(["export", "import", "reset"])(
    "refuses /quote %s without the Administrator permission",
    async (subcommand) => {
      const it_ = interaction(
        {
          subcommand,
          attachments: {
            file: { url: "https://example.invalid/b.json", size: 10 },
          },
        },
        { member: createRawMember(false) },
      );
      await execute(it_);
      const reply = it_.reply.mock.calls[0][0] as { content: string };
      expect(reply.content).toContain("requires the Administrator permission");
      expect(it_.deferReply).not.toHaveBeenCalled();
    },
  );

  it("refuses when there is no guild member at all (DM invocation)", async () => {
    const it_ = interaction({ subcommand: "reset" }, { member: null });
    await execute(it_);
    expect(mockResetChannel).not.toHaveBeenCalled();
  });

  it("exports the backup as a file attachment", async () => {
    mockExportQuotes.mockResolvedValue({
      quotes: [{ id: "q1" }, { id: "q2" }],
    });
    const it_ = interaction(
      { subcommand: "export" },
      { member: createRawMember(true) },
    );
    await execute(it_);
    expect(it_.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    const edit = it_.editReply.mock.calls[0][0] as {
      content: string;
      files: unknown[];
    };
    expect(edit.content).toContain("Exported 2 quotes");
    expect(edit.files).toHaveLength(1);
  });

  it("rebuilds the channel and reports the repost count on /quote reset", async () => {
    const it_ = interaction(
      { subcommand: "reset" },
      { member: createRawMember(true) },
    );
    await execute(it_);
    expect(mockResetChannel).toHaveBeenCalled();
    const edit = it_.editReply.mock.calls[0][0] as { content: string };
    expect(edit.content).toContain("4 quotes re-posted");
  });

  it("reports a failed rebuild without throwing", async () => {
    mockResetChannel.mockRejectedValue(new Error("Missing Access"));
    const it_ = interaction(
      { subcommand: "reset" },
      { member: createRawMember(true), deferred: true },
    );
    await expect(execute(it_)).resolves.toBeUndefined();
    const edit = it_.editReply.mock.calls[0][0] as { content: string };
    expect(edit.content).toContain("Missing Access");
  });
});

describe("/quote import", () => {
  const attachment = {
    url: "https://example.invalid/backup.json",
    size: 100,
  };

  function importInteraction(
    overrides: Record<string, unknown> = {},
    rebuild: boolean | null = null,
  ): MockChatInputInteraction {
    return interaction(
      {
        subcommand: "import",
        attachments: { file: attachment },
        booleans: { rebuild },
      },
      { member: createRawMember(true), ...overrides },
    );
  }

  it("refuses an attachment past the 5 MB cap before deferring", async () => {
    const it_ = interaction(
      {
        subcommand: "import",
        attachments: {
          file: { url: attachment.url, size: 6 * 1024 * 1024 },
        },
        booleans: { rebuild: null },
      },
      { member: createRawMember(true) },
    );
    await execute(it_);
    const reply = it_.reply.mock.calls[0][0] as { content: string };
    expect(reply.content).toContain("too large");
    expect(it_.deferReply).not.toHaveBeenCalled();
    expect(mockImportQuotes).not.toHaveBeenCalled();
  });

  it("reports an unreadable backup instead of importing garbage", async () => {
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 404 } as Response);
    const it_ = importInteraction({ deferred: true });
    await execute(it_);
    expect(mockImportQuotes).not.toHaveBeenCalled();
    const edit = it_.editReply.mock.calls[0][0] as { content: string };
    expect(edit.content).toContain("Could not read the backup file");
    fetchMock.mockRestore();
  });

  it("imports the payload and summarises the result", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ version: 1, quotes: [] }),
    } as unknown as Response);
    const it_ = importInteraction();
    await execute(it_);
    expect(mockImportQuotes).toHaveBeenCalledWith({ version: 1, quotes: [] });
    const edit = it_.editReply.mock.calls[0][0] as { content: string };
    expect(edit.content).toBe("✅ Imported 2, skipped 1.");
    expect(mockResetChannel).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("rebuilds when asked even if nothing new was imported", async () => {
    mockImportQuotes.mockResolvedValue({
      imported: 0,
      skipped: 5,
      errors: ["row 2 skipped"],
    });
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "{}",
    } as unknown as Response);
    const it_ = importInteraction({}, true);
    await execute(it_);
    const edit = it_.editReply.mock.calls[0][0] as { content: string };
    expect(edit.content).toContain("First error: row 2 skipped");
    expect(edit.content).toContain("Rebuilt the quote channel (4 quotes");
    fetchMock.mockRestore();
  });

  it("says the rebuild failed rather than claiming success", async () => {
    mockResetChannel.mockRejectedValue(new Error("Missing Access"));
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "{}",
    } as unknown as Response);
    const it_ = importInteraction({}, true);
    await execute(it_);
    const edit = it_.editReply.mock.calls[0][0] as { content: string };
    expect(edit.content).toContain("channel rebuild failed");
    fetchMock.mockRestore();
  });
});
