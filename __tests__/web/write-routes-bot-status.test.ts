/**
 * Route-handler tests for the Bot Status write router (issue #849).
 *
 * The interesting behaviour here isn't the CRUD, it's the guard rails: an
 * unknown pool name from the URL, a `{count}` placeholder the multiple-users
 * pool requires, a malformed ObjectId that would otherwise surface as a
 * Mongoose CastError 500, cross-guild entry access, and the all-or-nothing
 * validation that stops a "replace" import leaving the pool half-written.
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
import { STATUS_POOL_DEFAULTS } from "../../src/content/statuses.js";

const mockRecordAudit = jest.fn(async () => undefined);
const mockRefreshStatusPools = jest.fn<() => Promise<void>>();
const mockEntrySave = jest.fn<() => Promise<unknown>>();
const mockFindById = jest.fn<() => Promise<unknown>>();
const mockFindByIdAndDelete = jest.fn<() => Promise<unknown>>();
const mockDeleteMany = jest.fn<() => Promise<unknown>>();
const mockInsertMany = jest.fn<() => Promise<unknown>>();
const mockCountDocuments = jest.fn<() => Promise<number>>();
const mockLean = jest.fn<() => Promise<unknown>>();

/** Documents created via `new BotStatusMessage({...})`. */
const created: Array<Record<string, unknown>> = [];

class MockBotStatusMessage {
  _id = "entry-new";
  constructor(fields: Record<string, unknown>) {
    Object.assign(this, fields);
    created.push(fields);
  }
  save = async (): Promise<MockBotStatusMessage> => {
    await mockEntrySave();
    return this;
  };
  static findById = mockFindById;
  static findByIdAndDelete = mockFindByIdAndDelete;
  static deleteMany = mockDeleteMany;
  static insertMany = mockInsertMany;
  static countDocuments = mockCountDocuments;
  // `.findOne(...).sort(...).lean()` — the append-mode order lookup.
  static findOne = (): { sort: () => { lean: () => Promise<unknown> } } => ({
    sort: () => ({ lean: mockLean }),
  });
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

jest.unstable_mockModule("../../src/services/bot-status-service.js", () => ({
  BotStatusService: {
    getInstance: (): unknown => ({
      refreshStatusPools: mockRefreshStatusPools,
    }),
  },
}));

jest.unstable_mockModule("../../src/models/bot-status-message.js", () => ({
  BotStatusMessage: MockBotStatusMessage,
  default: MockBotStatusMessage,
}));

const { createBotStatusRouter } =
  await import("../../src/web/routes/write/bot-status.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  created.length = 0;
  mockRefreshStatusPools.mockResolvedValue(undefined);
  mockEntrySave.mockResolvedValue(undefined);
  mockFindByIdAndDelete.mockResolvedValue({});
  mockDeleteMany.mockResolvedValue({});
  mockInsertMany.mockResolvedValue([]);
  mockCountDocuments.mockResolvedValue(0);
  mockLean.mockResolvedValue(null);
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createBotStatusRouter(client),
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

/** An owned entry, as `findOwnedEntry` would resolve it. */
function ownedEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: "entry-1",
    guildId: session.guildId,
    pool: "single",
    text: "Chatting with {user}",
    order: 3,
    save: mockEntrySave,
    ...overrides,
  };
}

describe("POST /bot-status/pool/:pool/add", () => {
  it("rejects a pool name that is not one of the three known pools", async () => {
    const res = await harness.post("/bot-status/pool/mystery/add", {
      text: "hi",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/bot-status");
    expect(flash.msg).toBe("Unknown pool: mystery.");
    expect(created).toHaveLength(0);
  });

  it("rejects empty status text", async () => {
    const res = await harness.post("/bot-status/pool/lonely/add", {
      text: "   ",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Status text cannot be empty.",
    );
  });

  it("requires the {count} placeholder in the multiple-users pool", async () => {
    const res = await harness.post("/bot-status/pool/multiple/add", {
      text: "people are here",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "{count} placeholder",
    );
    expect(created).toHaveLength(0);
  });

  it("rejects an out-of-range order", async () => {
    const res = await harness.post("/bot-status/pool/lonely/add", {
      text: "alone",
      order: "50000",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "between -1000 and 10000",
    );
  });

  it("stores the entry, refreshes the live pools and audits it", async () => {
    const res = await harness.post("/bot-status/pool/lonely/add", {
      text: "  waiting alone  ",
      order: "5",
    });
    expect(created[0]).toMatchObject({
      guildId: session.guildId,
      pool: "lonely",
      text: "waiting alone",
      order: 5,
      createdBy: session.discordUserId,
    });
    expect(mockRefreshStatusPools).toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "bot-status.add",
      targetId: "entry-new",
      result: "success",
      details: { pool: "lonely", order: 5 },
    });
  });

  it("audits a save that threw", async () => {
    mockEntrySave.mockRejectedValue(new Error("duplicate"));
    const res = await harness.post("/bot-status/pool/lonely/add", {
      text: "alone",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});

describe("POST /bot-status/entry/:id/{update,order,delete}", () => {
  it("treats a malformed id as not-found instead of a CastError 500", async () => {
    mockFindById.mockRejectedValue(new Error("Cast to ObjectId failed"));
    const res = await harness.post("/bot-status/entry/not-an-id/update", {
      text: "hi",
    });
    expect(res.status).toBe(303);
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Status entry not-an-id not found.",
    );
  });

  it("refuses an entry owned by another guild", async () => {
    mockFindById.mockResolvedValue(ownedEntry({ guildId: "another-guild" }));
    const res = await harness.post("/bot-status/entry/entry-1/update", {
      text: "hi",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("validates the new text against the entry's own pool", async () => {
    mockFindById.mockResolvedValue(ownedEntry({ pool: "multiple" }));
    const res = await harness.post("/bot-status/entry/entry-1/update", {
      text: "no placeholder here",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "{count} placeholder",
    );
  });

  it("saves the trimmed text and refreshes the pools", async () => {
    const entry = ownedEntry();
    mockFindById.mockResolvedValue(entry);
    const res = await harness.post("/bot-status/entry/entry-1/update", {
      text: "  new text  ",
    });
    expect(entry.text).toBe("new text");
    expect(mockRefreshStatusPools).toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "bot-status.update",
      targetId: "entry-1",
      result: "success",
    });
  });

  it("records the before/after order on a reorder", async () => {
    const entry = ownedEntry({ order: 3 });
    mockFindById.mockResolvedValue(entry);
    const res = await harness.post("/bot-status/entry/entry-1/order", {
      order: "9",
    });
    expect(entry.order).toBe(9);
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "3 → 9",
    );
    expect(lastAudit()).toMatchObject({
      action: "bot-status.reorder",
      details: { from: 3, to: 9 },
    });
  });

  it("validates the order before looking the entry up", async () => {
    const res = await harness.post("/bot-status/entry/entry-1/order", {
      order: "50000",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("deletes an owned entry and refreshes the pools", async () => {
    mockFindById.mockResolvedValue(ownedEntry());
    const res = await harness.post("/bot-status/entry/entry-1/delete");
    expect(mockFindByIdAndDelete).toHaveBeenCalledWith("entry-1");
    expect(mockRefreshStatusPools).toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "bot-status.delete",
      result: "success",
    });
  });
});

describe("POST /bot-status/pool/:pool/import", () => {
  it("rejects an unknown pool", async () => {
    const res = await harness.post("/bot-status/pool/mystery/import", {
      items: "a\nb",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Unknown pool: mystery.",
    );
  });

  it("rejects an empty paste", async () => {
    const res = await harness.post("/bot-status/pool/lonely/import", {
      items: "  \n \n",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Nothing to import",
    );
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  it("validates every entry before writing anything", async () => {
    const res = await harness.post("/bot-status/pool/multiple/import", {
      items: "{count} people here\nno placeholder",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Import rejected at entry 2");
    // Nothing may be written — a partially applied "replace" would leave the
    // pool short of the entries it deleted.
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  it("replaces the pool by default, numbering from zero", async () => {
    const res = await harness.post("/bot-status/pool/lonely/import", {
      items: '["first", "second"]',
    });
    expect(mockDeleteMany).toHaveBeenCalledWith({
      guildId: session.guildId,
      pool: "lonely",
    });
    expect(mockInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({ text: "first", order: 0 }),
      expect.objectContaining({ text: "second", order: 1 }),
    ]);
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "bot-status.import",
      details: { pool: "lonely", mode: "replace", count: 2 },
    });
  });

  it("appends after the highest existing order without deleting", async () => {
    mockLean.mockResolvedValue({ order: 7 });
    await harness.post("/bot-status/pool/lonely/import", {
      mode: "append",
      items: "third\nfourth",
    });
    expect(mockDeleteMany).not.toHaveBeenCalled();
    expect(mockInsertMany).toHaveBeenCalledWith([
      expect.objectContaining({ text: "third", order: 8 }),
      expect.objectContaining({ text: "fourth", order: 9 }),
    ]);
  });
});

describe("POST /bot-status/pool/:pool/seed", () => {
  it("rejects an unknown pool", async () => {
    const res = await harness.post("/bot-status/pool/mystery/seed");
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Unknown pool: mystery.",
    );
  });

  it("refuses to seed a pool that already has entries", async () => {
    mockCountDocuments.mockResolvedValue(4);
    const res = await harness.post("/bot-status/pool/lonely/seed");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("already has entries");
    expect(mockInsertMany).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("seeds the shipped defaults into an empty pool", async () => {
    const res = await harness.post("/bot-status/pool/lonely/seed");
    const expected = STATUS_POOL_DEFAULTS.lonely;
    expect(mockInsertMany).toHaveBeenCalledTimes(1);
    const inserted = mockInsertMany.mock.calls[0][0] as Array<{
      text: string;
      order: number;
    }>;
    expect(inserted).toHaveLength(expected.length);
    expect(inserted[0]).toMatchObject({ text: expected[0], order: 0 });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "bot-status.seed",
      result: "success",
      details: { pool: "lonely", count: expected.length },
    });
  });

  it("audits a failed seed", async () => {
    mockInsertMany.mockRejectedValue(new Error("write failed"));
    const res = await harness.post("/bot-status/pool/lonely/seed");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(lastAudit()).toMatchObject({
      action: "bot-status.seed",
      result: "failure",
    });
  });
});
