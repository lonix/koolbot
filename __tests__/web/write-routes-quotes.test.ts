/**
 * Route-handler tests for the Quotes write router (#984): the validation
 * ladder, the channel-post-first ordering of an edit, what a delete does when
 * the post can't be removed, the resync gate and the audited JSON export.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { Client } from "discord.js";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  parseFlashRedirect,
  type AdminHarness,
} from "./admin-harness.js";
import { refusal } from "./refused-form-test-utils.js";

const mockRecordAudit = jest.fn(async () => undefined);
const mockConfigGetBoolean = jest.fn<() => Promise<boolean>>();
const mockConfigGetNumber = jest.fn<() => Promise<number>>();
const mockGetQuoteById = jest.fn<(id: string) => Promise<unknown>>();
const mockEditQuote = jest.fn<() => Promise<void>>();
const mockRemoveQuote = jest.fn<() => Promise<unknown>>();
const mockExportQuotes = jest.fn<() => Promise<unknown>>();
const mockListQuotes = jest.fn<() => Promise<{ total: number }>>();
const mockUpdateQuoteMessage = jest.fn<() => Promise<void>>();
const mockDeleteQuoteMessage = jest.fn<() => Promise<boolean>>();
const mockResetChannel = jest.fn<() => Promise<{ reposted: number }>>();

class MockMissingPostError extends Error {}

jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: mockConfigGetBoolean,
      getString: jest.fn(async () => ""),
      getNumber: mockConfigGetNumber,
      registerReloadCallback: jest.fn(),
    }),
  },
}));

jest.unstable_mockModule("../../src/services/quote-service.js", () => ({
  quoteService: {
    getQuoteById: mockGetQuoteById,
    editQuote: mockEditQuote,
    removeQuote: mockRemoveQuote,
    exportQuotes: mockExportQuotes,
    listQuotes: mockListQuotes,
  },
}));

jest.unstable_mockModule("../../src/services/quote-channel-manager.js", () => ({
  QuoteChannelManager: {
    getInstance: (): unknown => ({
      updateQuoteMessage: mockUpdateQuoteMessage,
      deleteQuoteMessage: mockDeleteQuoteMessage,
      resetChannel: mockResetChannel,
    }),
  },
}));

jest.unstable_mockModule("../../src/utils/discord.js", () => ({
  isMissingPostError: (err: unknown): boolean =>
    err instanceof MockMissingPostError,
}));

const { createQuotesRouter } =
  await import("../../src/web/routes/write/quotes.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderQuotesPage } = await import("../../src/web/admin-views.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const QUOTE_ID = "0123456789abcdef01234567";
const AUTHOR = "111111111111111111";
const SAVER = "222222222222222222";
const STORED = {
  _id: QUOTE_ID,
  content: "old text",
  authorId: AUTHOR,
  addedById: SAVER,
  messageId: "333333333333333333",
  postChannelId: "444444444444444444",
};

// The read router registers the page's renderer in the app (#1520); here the
// real view stands in, with the stored quote on the page the request names, so
// a refusal is checked as the markup the person gets.
const registerPage = (): void =>
  registerFormPage("/admin/quotes", async (req, refused) => {
    const page = Number(req.query.page ?? 1) || 1;
    return renderQuotesPage({
      guildId: "guild-1",
      csrfToken: "csrf",
      remainingMs: 1000,
      navFeatureStatus: {},
      enabled: true,
      channel: null,
      headerMessageId: "",
      settingRows: [],
      maxLength: 1000,
      rows:
        page === 2
          ? [
              {
                id: QUOTE_ID,
                content: "old text",
                authorId: AUTHOR,
                authorLabel: "Ada",
                addedByLabel: "Bo",
                addedAt: "2026-01-01",
                likes: 0,
                dislikes: 0,
                messageId: "m1",
              },
            ]
          : [],
      total: 26,
      page,
      pageSize: 25,
      search: String(req.query.q ?? ""),
      refusedForm: refused,
    });
  });

beforeEach(async () => {
  jest.clearAllMocks();
  registerPage();
  mockConfigGetBoolean.mockResolvedValue(true);
  mockConfigGetNumber.mockResolvedValue(1000);
  mockGetQuoteById.mockResolvedValue(STORED);
  mockEditQuote.mockResolvedValue(undefined);
  mockRemoveQuote.mockResolvedValue(STORED);
  mockUpdateQuoteMessage.mockResolvedValue(undefined);
  mockDeleteQuoteMessage.mockResolvedValue(true);
  mockResetChannel.mockResolvedValue({ reposted: 4 });
  mockListQuotes.mockResolvedValue({ total: 4 });
  mockExportQuotes.mockResolvedValue({
    version: 1,
    exportedAt: "2026-09-24T00:00:00.000Z",
    quotes: [{ content: "hi", authorId: AUTHOR, addedById: SAVER }],
  });
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createQuotesRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

function lastAudit(): Record<string, unknown> {
  const calls = mockRecordAudit.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe("POST /quotes/:id/edit", () => {
  const edit = (body: Record<string, string>): Promise<Response> =>
    harness.post(`/quotes/${QUOTE_ID}/edit`, body);

  it("rejects a request without a CSRF token", async () => {
    const res = await harness.post(
      `/quotes/${QUOTE_ID}/edit`,
      { content: "new", author_id: AUTHOR },
      { csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(mockEditQuote).not.toHaveBeenCalled();
  });

  const PAGE_2 = `/quotes/${QUOTE_ID}/edit?page=2`;

  it("marks a missing quote text and says what to enter", async () => {
    const res = await harness.post(PAGE_2, { content: "", author_id: AUTHOR });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual([`quote-edit-${QUOTE_ID}-content`]);
    expect(r.errorLines[`quote-edit-${QUOTE_ID}-content-error`]).toBe(
      "Enter the quote.",
    );
    expect(mockEditQuote).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("marks an author that isn't a snowflake and keeps both typed values", async () => {
    const res = await harness.post(PAGE_2, {
      content: "  new text ",
      author_id: " bob ",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual([`quote-edit-${QUOTE_ID}-author_id`]);
    expect(r.errorLines[`quote-edit-${QUOTE_ID}-author_id-error`]).toBe(
      "Enter the Discord user ID of the author: 17 to 20 digits.",
    );
    expect(r.html).toContain('value=" bob "');
    expect(r.html).toContain("\n  new text </textarea>");
    expect(r.html).toContain(
      '<details class="helper edit-details" open><summary>Edit</summary>',
    );
    expect(mockEditQuote).not.toHaveBeenCalled();
  });

  it("answers on the page the edit form was on, not only the first page", async () => {
    // The form's action carries the page and the search, so the refusal draws
    // the page that holds the quote. Without them the stand-in has no row and
    // the refusal degrades to a flash.
    const onPage1 = await harness.post(`/quotes/${QUOTE_ID}/edit`, {
      content: "",
      author_id: AUTHOR,
    });
    expect(onPage1.status).toBe(303);
    expect(parseFlashRedirect(onPage1.headers.get("location")).msg).toBe(
      "Not saved. Enter the quote.",
    );
    const onPage2 = await harness.post(PAGE_2, {
      content: "",
      author_id: AUTHOR,
    });
    expect(onPage2.status).toBe(422);
  });

  it("accepts a mention-form author and stores the bare ID", async () => {
    await edit({ content: "new", author_id: `<@${AUTHOR}>` });
    expect(mockEditQuote).toHaveBeenCalledWith(QUOTE_ID, "new", AUTHOR);
  });

  it("rejects text past quotes.max_length before touching the post", async () => {
    mockConfigGetNumber.mockResolvedValue(5);
    const res = await harness.post(PAGE_2, {
      content: "too long",
      author_id: AUTHOR,
    });
    const r = await refusal(res);
    expect(r.errorLines[`quote-edit-${QUOTE_ID}-content-error`]).toBe(
      "At most 5 characters.",
    );
    expect(r.html).toContain("\ntoo long</textarea>");
    expect(mockUpdateQuoteMessage).not.toHaveBeenCalled();
    expect(mockEditQuote).not.toHaveBeenCalled();
  });

  it("still refuses a missing author when the config read fails", async () => {
    mockConfigGetNumber.mockRejectedValue(new Error("config down"));
    const res = await harness.post(PAGE_2, { content: "new", author_id: "x" });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual([`quote-edit-${QUOTE_ID}-author_id`]);
  });

  it("reports a failed config read on a valid edit as a failure flash", async () => {
    mockConfigGetNumber.mockRejectedValue(new Error("config down"));
    const res = await edit({ content: "new", author_id: AUTHOR });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("config down");
    expect(mockEditQuote).not.toHaveBeenCalled();
  });

  it("answers the not-found flash when a refused quote has been deleted", async () => {
    mockGetQuoteById.mockResolvedValue(null);
    const res = await harness.post(PAGE_2, { content: "", author_id: AUTHOR });
    expect(res.status).toBe(303);
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      `Quote ${QUOTE_ID} not found.`,
    );
  });

  it("answers the not-found flash for a refused edit of a malformed id", async () => {
    const res = await harness.post("/quotes/not-an-id/edit", {
      content: "",
      author_id: AUTHOR,
    });
    expect(res.status).toBe(303);
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Quote not-an-id not found.",
    );
    expect(mockGetQuoteById).not.toHaveBeenCalled();
  });

  it("still answers the refusal when the existence lookup fails", async () => {
    mockGetQuoteById.mockRejectedValue(new Error("db down"));
    const res = await harness.post(PAGE_2, { content: "", author_id: AUTHOR });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual([`quote-edit-${QUOTE_ID}-content`]);
    expect(mockEditQuote).not.toHaveBeenCalled();
  });

  it("reports an unknown or malformed id as not found", async () => {
    mockGetQuoteById.mockResolvedValue(null);
    const flash = parseFlashRedirect(
      (await edit({ content: "new", author_id: AUTHOR })).headers.get(
        "location",
      ),
    );
    expect(flash.msg).toBe(`Quote ${QUOTE_ID} not found.`);

    const bad = await harness.post("/quotes/not-an-id/edit", {
      content: "new",
      author_id: AUTHOR,
    });
    expect(parseFlashRedirect(bad.headers.get("location")).msg).toBe(
      "Quote not-an-id not found.",
    );
    // A malformed id never reaches Mongo, where it would be a CastError.
    expect(mockGetQuoteById).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({
      action: "quote.edit",
      result: "failure",
    });
  });

  it("redraws the channel post, then saves the row", async () => {
    const flash = parseFlashRedirect(
      (await edit({ content: "new", author_id: AUTHOR })).headers.get(
        "location",
      ),
    );
    expect(mockUpdateQuoteMessage).toHaveBeenCalledWith(
      STORED.messageId,
      QUOTE_ID,
      "new",
      AUTHOR,
      SAVER,
      STORED.postChannelId,
    );
    expect(mockEditQuote).toHaveBeenCalledWith(QUOTE_ID, "new", AUTHOR);
    expect(flash).toMatchObject({ type: "ok" });
    expect(flash.msg).toContain("and its channel post");
    expect(lastAudit()).toMatchObject({
      action: "quote.edit",
      targetId: QUOTE_ID,
      result: "success",
      details: {
        contentChanged: true,
        authorChanged: false,
        postUpdated: true,
      },
    });
  });

  it("saves the row and warns when the post no longer exists", async () => {
    mockUpdateQuoteMessage.mockRejectedValue(new MockMissingPostError("gone"));
    const flash = parseFlashRedirect(
      (await edit({ content: "new", author_id: AUTHOR })).headers.get(
        "location",
      ),
    );
    expect(mockEditQuote).toHaveBeenCalled();
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("Resync quote channel");
    expect(lastAudit()).toMatchObject({ details: { postUpdated: false } });
  });

  it("keeps the row unchanged when the post can't be reached", async () => {
    mockUpdateQuoteMessage.mockRejectedValue(new Error("Missing Access"));
    const flash = parseFlashRedirect(
      (await edit({ content: "new", author_id: AUTHOR })).headers.get(
        "location",
      ),
    );
    expect(mockEditQuote).not.toHaveBeenCalled();
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Missing Access");
    expect(lastAudit()).toMatchObject({
      action: "quote.edit",
      result: "failure",
      errorMessage: "Missing Access",
    });
  });

  it("puts the post back when saving the row fails", async () => {
    mockEditQuote.mockRejectedValue(new Error("db down"));
    const flash = parseFlashRedirect(
      (await edit({ content: "new", author_id: AUTHOR })).headers.get(
        "location",
      ),
    );
    expect(mockUpdateQuoteMessage).toHaveBeenCalledTimes(2);
    expect(mockUpdateQuoteMessage).toHaveBeenLastCalledWith(
      STORED.messageId,
      QUOTE_ID,
      STORED.content,
      STORED.authorId,
      SAVER,
      STORED.postChannelId,
    );
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe(`Failed to update quote ${QUOTE_ID}: db down`);
    expect(lastAudit()).toMatchObject({
      action: "quote.edit",
      result: "failure",
      details: { postUpdated: true, postReverted: true },
    });
  });

  it("says the post is out of step when it can't be put back", async () => {
    mockEditQuote.mockRejectedValue(new Error("db down"));
    mockUpdateQuoteMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Missing Access"));
    const flash = parseFlashRedirect(
      (await edit({ content: "new", author_id: AUTHOR })).headers.get(
        "location",
      ),
    );
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("already shows the new text");
    expect(flash.msg).toContain("Resync quote channel");
    expect(lastAudit()).toMatchObject({
      details: { postUpdated: true, postReverted: false },
    });
  });

  it("saves without touching the channel while quotes are disabled", async () => {
    mockConfigGetBoolean.mockResolvedValue(false);
    const flash = parseFlashRedirect(
      (await edit({ content: "new", author_id: AUTHOR })).headers.get(
        "location",
      ),
    );
    expect(mockUpdateQuoteMessage).not.toHaveBeenCalled();
    expect(mockEditQuote).toHaveBeenCalled();
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("quotes.enabled is off");
  });
});

describe("POST /quotes/:id/delete", () => {
  it("removes the post and the row", async () => {
    const res = await harness.post(`/quotes/${QUOTE_ID}/delete`);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(mockDeleteQuoteMessage).toHaveBeenCalledWith(
      STORED.messageId,
      STORED.postChannelId,
    );
    expect(mockRemoveQuote).toHaveBeenCalledWith(QUOTE_ID);
    expect(flash).toMatchObject({
      type: "ok",
      msg: `Deleted quote ${QUOTE_ID}.`,
    });
    expect(lastAudit()).toMatchObject({
      action: "quote.delete",
      result: "success",
      details: { postRemoved: true },
    });
  });

  it("still deletes the row but warns when the post may remain", async () => {
    mockDeleteQuoteMessage.mockResolvedValue(false);
    const res = await harness.post(`/quotes/${QUOTE_ID}/delete`);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(mockRemoveQuote).toHaveBeenCalledWith(QUOTE_ID);
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("could not be removed");
    expect(lastAudit()).toMatchObject({ details: { postRemoved: false } });
  });

  it("reports a missing quote without deleting anything", async () => {
    mockGetQuoteById.mockResolvedValue(null);
    const res = await harness.post(`/quotes/${QUOTE_ID}/delete`);
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockDeleteQuoteMessage).not.toHaveBeenCalled();
    expect(mockRemoveQuote).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "quote.delete",
      result: "failure",
      errorMessage: "not found",
    });
  });

  it("surfaces and audits a storage failure", async () => {
    mockRemoveQuote.mockRejectedValue(new Error("db down"));
    const res = await harness.post(`/quotes/${QUOTE_ID}/delete`);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("db down");
    expect(lastAudit()).toMatchObject({
      action: "quote.delete",
      result: "failure",
    });
  });
});

describe("POST /quotes/sync", () => {
  it("rebuilds the channel and reports the count", async () => {
    const res = await harness.post("/quotes/sync");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(mockResetChannel).toHaveBeenCalled();
    expect(flash).toMatchObject({ type: "ok" });
    expect(flash.msg).toContain("4 quotes reposted");
    expect(lastAudit()).toMatchObject({
      action: "quote.sync",
      result: "success",
      details: { reposted: 4 },
    });
  });

  it("warns — and audits a failure — when some quotes weren't reposted", async () => {
    mockListQuotes.mockResolvedValue({ total: 6 });
    const res = await harness.post("/quotes/sync");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("only 4 of 6 quotes were reposted");
    expect(lastAudit()).toMatchObject({
      action: "quote.sync",
      result: "failure",
      details: { reposted: 4, total: 6 },
    });
  });

  it("refuses while quotes are disabled", async () => {
    mockConfigGetBoolean.mockResolvedValue(false);
    const res = await harness.post("/quotes/sync");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockResetChannel).not.toHaveBeenCalled();
  });

  it("surfaces a rebuild failure", async () => {
    mockResetChannel.mockRejectedValue(
      new Error("Quote channel not configured or not found"),
    );
    const res = await harness.post("/quotes/sync");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("not configured");
    expect(lastAudit()).toMatchObject({
      action: "quote.sync",
      result: "failure",
    });
  });
});

describe("GET /quotes/export", () => {
  it("downloads the JSON backup and audits it", async () => {
    const res = await harness.get("/quotes/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="quotes-backup-\d{4}-\d{2}-\d{2}\.json"/,
    );
    const body = (await res.json()) as { quotes: unknown[] };
    expect(body.quotes).toHaveLength(1);
    expect(lastAudit()).toMatchObject({
      action: "quote.export",
      result: "success",
      details: { quotes: 1 },
    });
  });

  it("flashes an export failure back to the page", async () => {
    mockExportQuotes.mockRejectedValue(new Error("db down"));
    const res = await harness.get("/quotes/export");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash).toMatchObject({ path: "/admin/quotes", type: "err" });
    expect(lastAudit()).toMatchObject({
      action: "quote.export",
      result: "failure",
    });
  });
});
