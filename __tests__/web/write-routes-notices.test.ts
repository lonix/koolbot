/**
 * Route-handler tests for the Notices write router (issue #849).
 *
 * `notices-channel-manager.ts` sat at 5.85% and the router in front of it at
 * ~5%, so nothing verified the part that actually matters to an operator:
 * the validation ladder, and whether the flash and the audit row tell the
 * truth about a channel post that silently failed (`postNotice()` swallows
 * its own errors and returns null).
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
const mockPostNotice = jest.fn<() => Promise<string | null>>();
const mockDeleteNoticeMessage = jest.fn<() => Promise<void>>();
const mockSyncNotices = jest.fn<() => Promise<void>>();
const mockNoticeSave = jest.fn<() => Promise<unknown>>();
const mockNoticeFindById = jest.fn<() => Promise<unknown>>();
const mockNoticeFindByIdAndDelete = jest.fn<() => Promise<unknown>>();
const mockNoticeCountDocuments = jest.fn<() => Promise<number>>();

/** Documents the router creates via `new Notice({...})`. */
const created: Array<Record<string, unknown>> = [];

class MockNotice {
  _id = "notice-new";
  messageId: string | undefined;
  constructor(fields: Record<string, unknown>) {
    Object.assign(this, fields);
    created.push(fields);
  }
  // `new Notice({...}).save()` must resolve to the document itself: the
  // create route reads `notice._id` and re-saves it after posting.
  save = async (): Promise<MockNotice> => {
    await mockNoticeSave();
    return this;
  };
  static findById = mockNoticeFindById;
  static findByIdAndDelete = mockNoticeFindByIdAndDelete;
  static countDocuments = mockNoticeCountDocuments;
}

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
      getNumber: jest.fn(async () => 0),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

jest.unstable_mockModule(
  "../../src/services/notices-channel-manager.js",
  () => ({
    NoticesChannelManager: {
      getInstance: (): unknown => ({
        postNotice: mockPostNotice,
        deleteNoticeMessage: mockDeleteNoticeMessage,
        syncNotices: mockSyncNotices,
      }),
    },
  }),
);

jest.unstable_mockModule("../../src/models/notice.js", () => ({
  default: MockNotice,
  Notice: MockNotice,
}));

const { createNoticesRouter } =
  await import("../../src/web/routes/write/notices.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderNoticesPage } = await import("../../src/web/admin-views.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const VALID = { title: "Welcome", content: "Read me", category: "general" };

// The read router registers the page's renderer in the app (#1520); here the
// real view stands in, with one stored notice to edit, so a refusal is checked
// as the markup the person gets.
const registerPage = (): void =>
  registerFormPage("/admin/notices", async (_req, refused) =>
    renderNoticesPage({
      guildId: "guild-1",
      csrfToken: "csrf",
      remainingMs: 1000,
      navFeatureStatus: {},
      enabled: true,
      channel: null,
      total: 1,
      settingRows: [],
      textChannels: [],
      categoryOptions: [
        { value: "general", label: "General" },
        { value: "rules", label: "Rules" },
      ],
      groups: [
        {
          category: "general",
          rows: [
            {
              id: "notice-1",
              order: 3,
              title: "Stored title",
              content: "Stored text",
              preview: "Stored text",
              category: "general",
              messageId: "m1",
              updatedAt: "2026-01-01",
            },
            {
              id: "notice-2",
              order: 4,
              title: "Other title",
              content: "Other text",
              preview: "Other text",
              category: "rules",
              messageId: "m2",
              updatedAt: "2026-01-01",
            },
          ],
        },
      ],
      refusedForm: refused,
    }),
  );

beforeEach(async () => {
  jest.clearAllMocks();
  registerPage();
  created.length = 0;
  mockConfigGetBoolean.mockResolvedValue(false);
  mockPostNotice.mockResolvedValue("message-1");
  mockDeleteNoticeMessage.mockResolvedValue(undefined);
  mockSyncNotices.mockResolvedValue(undefined);
  mockNoticeSave.mockResolvedValue(undefined);
  mockNoticeCountDocuments.mockResolvedValue(3);
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createNoticesRouter(client),
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

describe("POST /notices/create", () => {
  it.each([
    ["title", { content: "c", category: "general" }, "Enter a title."],
    ["content", { title: "t", category: "general" }, "Enter the notice text."],
    ["category", { title: "t", content: "c" }, "Choose a category."],
  ])(
    "marks a submission missing %s and says what to enter",
    async (field, body, message) => {
      const res = await harness.post("/notices/create", body);
      const r = await refusal(res);
      expect(r.invalidIds).toEqual([`notice-create-${field}`]);
      expect(r.errorLines[`notice-create-${field}-error`]).toBe(message);
      expect(created).toHaveLength(0);
      expect(mockRecordAudit).not.toHaveBeenCalled();
    },
  );

  it("marks every refused field, in page order, and keeps the valid ones", async () => {
    const res = await harness.post("/notices/create", {
      title: "",
      content: "Read me",
      category: "gossip",
      order: "x",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual([
      "notice-create-title",
      "notice-create-category",
      "notice-create-order",
    ]);
    expect(r.errorLines["notice-create-category-error"]).toBe(
      "Choose one of the listed categories.",
    );
    expect(r.errorLines["notice-create-order-error"]).toBe(
      "Use a whole number from -1000 to 10000.",
    );
    expect(r.html).toContain("\nRead me</textarea>");
    expect(r.html).toContain('value="x"');
  });

  it("rejects a title past the Discord embed-title cap and keeps it", async () => {
    const res = await harness.post("/notices/create", {
      ...VALID,
      title: "t".repeat(257),
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["notice-create-title"]);
    expect(r.errorLines["notice-create-title-error"]).toBe(
      "At most 256 characters.",
    );
    expect(r.html).toContain(`value="${"t".repeat(257)}"`);
    expect(created).toHaveLength(0);
  });

  it("rejects content past the Discord embed-description cap", async () => {
    const res = await harness.post("/notices/create", {
      ...VALID,
      content: "c".repeat(4001),
    });
    const r = await refusal(res);
    expect(r.errorLines["notice-create-content-error"]).toBe(
      "At most 4000 characters.",
    );
  });

  it("keeps the typed text as typed, with its blank lines and spaces", async () => {
    const res = await harness.post("/notices/create", {
      title: "  Hi  ",
      content: "\n\nBody  ",
      category: "gossip",
    });
    const r = await refusal(res);
    expect(r.html).toContain('value="  Hi  "');
    // The refused text starts with a newline of its own, which the HTML parser
    // drops, so the leading blank lines come back.
    expect(r.html).toContain("</textarea>");
    expect(r.html).toMatch(/<textarea[^>]*>\n\n\nBody {2}<\/textarea>/);
  });

  it("keeps the chosen category when another field is refused", async () => {
    const res = await harness.post("/notices/create", {
      ...VALID,
      category: "rules",
      order: "99999",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["notice-create-order"]);
    expect(r.html).toContain('<option value="rules" selected>');
    expect(created).toHaveLength(0);
  });

  it("falls back to a flash when the page cannot be drawn", async () => {
    registerFormPage("/admin/notices", async () => {
      throw new Error("page down");
    });
    const res = await harness.post("/notices/create", { ...VALID, order: "x" });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/notices");
    expect(flash.msg).toBe(
      "Not saved. Use a whole number from -1000 to 10000.",
    );
  });

  it("saves without posting while the feature is disabled", async () => {
    const res = await harness.post("/notices/create", VALID);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Enable notices.enabled");
    expect(mockPostNotice).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({
      ...VALID,
      order: 0,
      createdBy: session.discordUserId,
    });
    expect(lastAudit()).toMatchObject({
      action: "notice.create",
      result: "success",
      details: { posted: false, featureEnabled: false },
    });
  });

  it("posts to the channel when the feature is enabled", async () => {
    mockConfigGetBoolean.mockResolvedValue(true);
    const res = await harness.post("/notices/create", VALID);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("posted to channel");
    expect(mockPostNotice).toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ details: { posted: true } });
  });

  it("warns — and audits `posted: false` — when the channel post silently failed", async () => {
    mockConfigGetBoolean.mockResolvedValue(true);
    mockPostNotice.mockResolvedValue(null);
    const res = await harness.post("/notices/create", VALID);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("channel post failed");
    expect(lastAudit()).toMatchObject({
      result: "success",
      details: { posted: false, featureEnabled: true },
    });
  });

  it("turns a save error into a flash and a failure audit", async () => {
    mockNoticeSave.mockRejectedValue(new Error("validation failed"));
    const res = await harness.post("/notices/create", VALID);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("validation failed");
    expect(lastAudit()).toMatchObject({
      action: "notice.create",
      result: "failure",
    });
  });
});

describe("POST /notices/:id/update", () => {
  function storedNotice(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      _id: "notice-1",
      title: "old",
      content: "old",
      category: "general",
      order: 0,
      messageId: "message-old",
      save: mockNoticeSave,
      ...overrides,
    };
  }

  it("reports a notice that does not exist", async () => {
    mockNoticeFindById.mockResolvedValue(null);
    const res = await harness.post("/notices/notice-1/update", {
      ...VALID,
      order: "1",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Notice notice-1 not found.");
    expect(lastAudit()).toMatchObject({
      action: "notice.update",
      errorMessage: "not found",
    });
  });

  it("requires an order on update (unlike create, which defaults to 0)", async () => {
    mockNoticeFindById.mockResolvedValue(storedNotice());
    const res = await harness.post("/notices/notice-1/update", VALID);
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["notice-edit-notice-1-order"]);
    expect(r.errorLines["notice-edit-notice-1-order-error"]).toBe(
      "Use a whole number from -1000 to 10000.",
    );
    expect(mockNoticeSave).not.toHaveBeenCalled();
  });

  it("reopens only the refused notice's form and keeps what was typed there", async () => {
    mockNoticeFindById.mockResolvedValue(storedNotice());
    const res = await harness.post("/notices/notice-1/update", {
      title: "",
      content: "New text",
      category: "rules",
      order: "7",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["notice-edit-notice-1-title"]);
    expect(r.errorLines["notice-edit-notice-1-title-error"]).toBe(
      "Enter a title.",
    );
    // One details element is open: the refused row's. The other row keeps its
    // stored values.
    expect(
      r.html.match(/<details class="helper edit-details" open>/g),
    ).toHaveLength(1);
    expect(r.html.match(/<details class="helper edit-details">/g)).toHaveLength(
      1,
    );
    expect(r.html).toContain("\nNew text</textarea>");
    expect(r.html).toContain('<option value="rules" selected>');
    expect(r.html).toContain('value="7"');
    expect(r.html).toContain('value="Other title"');
    expect(mockNoticeSave).not.toHaveBeenCalled();
  });

  it("answers the not-found flash when a refused notice has been deleted", async () => {
    mockNoticeFindById.mockResolvedValue(null);
    const res = await harness.post("/notices/notice-1/update", {
      ...VALID,
      order: "x",
    });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Notice notice-1 not found.");
  });

  it("still answers the refusal when the existence lookup fails", async () => {
    mockNoticeFindById.mockRejectedValue(new Error("db down"));
    const res = await harness.post("/notices/notice-1/update", {
      ...VALID,
      order: "x",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["notice-edit-notice-1-order"]);
  });

  it("falls back to a flash when the lookup fails and the page does not hold the form", async () => {
    mockNoticeFindById.mockRejectedValue(new Error("db down"));
    const res = await harness.post("/notices/other/update", {
      ...VALID,
      order: "x",
    });
    expect(res.status).toBe(303);
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Not saved. Use a whole number from -1000 to 10000.",
    );
  });

  it("updates without touching the channel while the feature is off", async () => {
    mockNoticeFindById.mockResolvedValue(storedNotice());
    const res = await harness.post("/notices/notice-1/update", {
      ...VALID,
      order: "5",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(mockDeleteNoticeMessage).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      details: { repostAttempted: false, repostSucceeded: false },
    });
  });

  it("reposts the notice when the feature is on", async () => {
    mockConfigGetBoolean.mockResolvedValue(true);
    const notice = storedNotice();
    mockNoticeFindById.mockResolvedValue(notice);
    const res = await harness.post("/notices/notice-1/update", {
      ...VALID,
      order: "5",
    });
    expect(mockDeleteNoticeMessage).toHaveBeenCalledWith("message-old");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      details: { repostAttempted: true, repostSucceeded: true },
    });
  });

  it("clears the stale messageId when the repost failed", async () => {
    mockConfigGetBoolean.mockResolvedValue(true);
    mockPostNotice.mockResolvedValue(null);
    const notice = storedNotice();
    mockNoticeFindById.mockResolvedValue(notice);
    const res = await harness.post("/notices/notice-1/update", {
      ...VALID,
      order: "5",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("Use Resync to retry");
    // The old message was deleted, so leaving its id behind would make the
    // next sync try to delete a message that no longer exists.
    expect(notice.messageId).toBeUndefined();
    expect(lastAudit()).toMatchObject({
      details: { repostAttempted: true, repostSucceeded: false },
    });
  });
});

describe("POST /notices/:id/order, /delete and /sync", () => {
  it("records the before/after order on a reorder", async () => {
    mockNoticeFindById.mockResolvedValue({
      _id: "notice-1",
      order: 2,
      category: "general",
      save: mockNoticeSave,
    });
    const res = await harness.post("/notices/notice-1/order", { order: "7" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("2 → 7");
    expect(lastAudit()).toMatchObject({
      action: "notice.reorder",
      details: { from: 2, to: 7 },
    });
  });

  it("rejects a non-numeric order without a DB lookup", async () => {
    const res = await harness.post("/notices/notice-1/order", {
      order: "first",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockNoticeFindById).not.toHaveBeenCalled();
  });

  it("removes the channel message before deleting the row", async () => {
    mockNoticeFindById.mockResolvedValue({
      _id: "notice-1",
      title: "Welcome",
      category: "general",
      messageId: "message-old",
    });
    mockNoticeFindByIdAndDelete.mockResolvedValue({});
    const res = await harness.post("/notices/notice-1/delete");
    expect(mockDeleteNoticeMessage).toHaveBeenCalledWith("message-old");
    expect(mockNoticeFindByIdAndDelete).toHaveBeenCalledWith("notice-1");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "notice.delete",
      result: "success",
    });
  });

  it("does not delete a row that was already gone", async () => {
    mockNoticeFindById.mockResolvedValue(null);
    const res = await harness.post("/notices/notice-1/delete");
    expect(mockNoticeFindByIdAndDelete).not.toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
  });

  it("reports the synced count", async () => {
    const res = await harness.post("/notices/sync");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(mockSyncNotices).toHaveBeenCalled();
    expect(flash.msg).toBe("Synced 3 notices to channel.");
    expect(lastAudit()).toMatchObject({
      action: "notice.sync",
      result: "success",
      details: { count: 3 },
    });
  });

  it("turns a failed sync into a flash", async () => {
    mockSyncNotices.mockRejectedValue(new Error("Missing Access"));
    const res = await harness.post("/notices/sync");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Missing Access");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});
