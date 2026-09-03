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

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const VALID = { title: "Welcome", content: "Read me", category: "general" };

beforeEach(async () => {
  jest.clearAllMocks();
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
    ["title", { content: "c", category: "general" }],
    ["content", { title: "t", category: "general" }],
    ["category", { title: "t", content: "c" }],
  ])("rejects a submission missing %s", async (_field, body) => {
    const res = await harness.post("/notices/create", body);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/notices");
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Title, content, and category are all required.");
    expect(created).toHaveLength(0);
  });

  it("rejects a title past the Discord embed-title cap", async () => {
    const res = await harness.post("/notices/create", {
      ...VALID,
      title: "t".repeat(257),
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.msg).toBe("Title must be 256 characters or fewer.");
    expect(created).toHaveLength(0);
  });

  it("rejects content past the Discord embed-description cap", async () => {
    const res = await harness.post("/notices/create", {
      ...VALID,
      content: "c".repeat(4001),
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Content must be 4000 characters or fewer.",
    );
  });

  it("rejects an unknown category", async () => {
    const res = await harness.post("/notices/create", {
      ...VALID,
      category: "gossip",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Unknown category: gossip.",
    );
    expect(created).toHaveLength(0);
  });

  it("rejects an out-of-range order", async () => {
    const res = await harness.post("/notices/create", {
      ...VALID,
      order: "99999",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "between -1000 and 10000",
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
    const res = await harness.post("/notices/notice-1/update", VALID);
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "between -1000 and 10000",
    );
    expect(mockNoticeFindById).not.toHaveBeenCalled();
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
