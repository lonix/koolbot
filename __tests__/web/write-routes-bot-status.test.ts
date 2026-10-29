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
import { refusal } from "./refused-form-test-utils.js";
import {
  BOT_STATUS_POOLS,
  BOT_STATUS_POOL_META,
  STATUS_POOL_DEFAULTS,
} from "../../src/content/statuses.js";

const mockRecordAudit = jest.fn(async () => undefined);
const mockRefreshStatusPools = jest.fn<() => Promise<void>>();
const mockEntrySave = jest.fn<() => Promise<unknown>>();
const mockFindById = jest.fn<() => Promise<unknown>>();
const mockFindByIdAndDelete = jest.fn<() => Promise<unknown>>();
const mockDeleteMany = jest.fn<() => Promise<unknown>>();
const mockInsertMany = jest.fn<() => Promise<unknown>>();
const mockCountDocuments = jest.fn<() => Promise<number>>();
const mockLean = jest.fn<() => Promise<unknown>>();
const mockFind = jest.fn<(q: unknown) => Promise<unknown[]>>();
const mockBulkWrite = jest.fn<(ops: unknown[]) => Promise<unknown>>();

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
  static bulkWrite = mockBulkWrite;
  // `.find(...).sort(...).lean()` — the pool a move re-reads.
  static find = (
    q: unknown,
  ): { sort: () => { lean: () => Promise<unknown> } } => ({
    sort: () => ({ lean: () => mockFind(q) }),
  });
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
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderBotStatusPage } = await import("../../src/web/admin-views.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

// The read router registers the page's renderer in the app (#1520); here the
// real view stands in, with one stored entry in the "single" pool to edit, so a
// refusal is checked as the markup the person gets.
registerFormPage("/admin/bot-status", async (_req, refused) =>
  renderBotStatusPage({
    guildId: "guild-1",
    csrfToken: "csrf",
    remainingMs: 1000,
    navFeatureStatus: {},
    maxLength: 128,
    pools: BOT_STATUS_POOLS.map((pool) => {
      const items =
        pool === "single"
          ? [{ id: "entry-1", order: 3, text: "Chatting with {user}" }]
          : [];
      return {
        pool,
        label: BOT_STATUS_POOL_META[pool].label,
        description: BOT_STATUS_POOL_META[pool].description,
        requiresCount: BOT_STATUS_POOL_META[pool].requiresCount,
        items,
        usingDefaults: items.length === 0,
        exportText: items.length
          ? items.map((i) => i.text).join("\n")
          : STATUS_POOL_DEFAULTS[pool].join("\n"),
      };
    }),
    refusedForm: refused,
  }),
);

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
  mockFind.mockResolvedValue([]);
  mockBulkWrite.mockImplementation(async (ops) => ({
    matchedCount: ops.length,
  }));
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

  it("marks empty status text", async () => {
    const res = await harness.post("/bot-status/pool/lonely/add", {
      text: "   ",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["bot-status-add-lonely-text"]);
    expect(r.errorLines["bot-status-add-lonely-text-error"]).toBe(
      "Enter the status text.",
    );
    expect(created).toHaveLength(0);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("says the multiple-users pool needs the {count} placeholder, and keeps the text", async () => {
    const res = await harness.post("/bot-status/pool/multiple/add", {
      text: "  people are here ",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["bot-status-add-multiple-text"]);
    expect(r.errorLines["bot-status-add-multiple-text-error"]).toBe(
      "This pool needs the {count} placeholder.",
    );
    // Echoed as typed; only the saved value is trimmed.
    expect(r.html).toContain('value="  people are here "');
    // Only that pool's add form is marked.
    expect(r.html).not.toContain("bot-status-add-single-text-error");
    expect(created).toHaveLength(0);
  });

  it("marks text past the length cap", async () => {
    const res = await harness.post("/bot-status/pool/lonely/add", {
      text: "x".repeat(129),
    });
    const r = await refusal(res);
    expect(r.errorLines["bot-status-add-lonely-text-error"]).toBe(
      "At most 128 characters.",
    );
  });

  it("stores the entry last in its pool, ignoring a posted order, refreshes the live pools and audits it", async () => {
    mockLean.mockResolvedValue({ order: 7 });
    const res = await harness.post("/bot-status/pool/lonely/add", {
      text: "  waiting alone  ",
      order: "-1000",
    });
    expect(created[0]).toMatchObject({
      guildId: session.guildId,
      pool: "lonely",
      text: "waiting alone",
      order: 8,
      createdBy: session.discordUserId,
    });
    expect(mockRefreshStatusPools).toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "bot-status.add",
      targetId: "entry-new",
      result: "success",
      details: { pool: "lonely", order: 8 },
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

describe("POST /bot-status/entry/:id/{update,delete}", () => {
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
    const r = await refusal(res);
    expect(r.errorLines["bot-status-edit-entry-1-text-error"]).toBe(
      "This pool needs the {count} placeholder.",
    );
  });

  it("refuses a bad edit, reopens that entry's form and keeps what was typed", async () => {
    mockFindById.mockResolvedValue(ownedEntry());
    const res = await harness.post("/bot-status/entry/entry-1/update", {
      text: "  ",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["bot-status-edit-entry-1-text"]);
    expect(r.errorLines["bot-status-edit-entry-1-text-error"]).toBe(
      "Enter the status text.",
    );
    expect(r.html).toContain(
      '<details class="helper edit-details" open><summary>Chatting with {user}</summary>',
    );
    expect(r.html).toContain('value="  "');
    expect(mockEntrySave).not.toHaveBeenCalled();
  });

  it("answers the not-found flash when the refused entry no longer exists", async () => {
    mockFindById.mockResolvedValue(null);
    const res = await harness.post("/bot-status/entry/entry-1/update", {
      text: "",
    });
    expect(res.status).toBe(303);
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Status entry entry-1 not found.",
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

  it("marks an empty paste and opens the import section", async () => {
    const res = await harness.post("/bot-status/pool/lonely/import", {
      items: "  \n \n",
      mode: "append",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["bot-status-import-lonely-items"]);
    expect(r.errorLines["bot-status-import-lonely-items-error"]).toBe(
      "Paste at least one entry: one per line, or a JSON array.",
    );
    // The disclosure holding the form is open, or the message would be hidden;
    // the append choice and the pasted text come back as typed.
    expect(r.html).toMatch(
      /<details class="helper" open>\s*<summary>Import \/ export<\/summary>/,
    );
    expect(r.html).toMatch(/value="append" checked/);
    expect(r.html).toContain("\n  \n \n</textarea>");
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  it("validates every entry before writing anything and names the entry", async () => {
    const res = await harness.post("/bot-status/pool/multiple/import", {
      items: "{count} people here\nno placeholder",
    });
    const r = await refusal(res);
    expect(r.errorLines["bot-status-import-multiple-items-error"]).toBe(
      "Entry 2 (&quot;no placeholder&quot;): This pool needs the {count} placeholder.",
    );
    // The typed list is what the box holds, not the stored one.
    expect(r.html).toContain("{count} people here\nno placeholder</textarea>");
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

describe("POST /bot-status/entry/:id/move", () => {
  const ids = ["e-a", "e-b", "e-c"];
  /** A pool stored as `[e-a, e-b, e-c]` with the given order numbers. */
  function stored(orders: number[] = [0, 1, 2]): void {
    mockFind.mockResolvedValue(
      ids.map((id, i) => ({ _id: id, order: orders[i] })),
    );
    mockFindById.mockResolvedValue(ownedEntry({ _id: "e-b" }));
  }
  const move = (
    id: string,
    from: number,
    to: number,
    count = 3,
    scope = "single",
  ): Promise<Awaited<ReturnType<AdminHarness["post"]>>> =>
    harness.post(`/bot-status/entry/${id}/move`, {
      from: String(from),
      to: String(to),
      count: String(count),
      scope,
    });
  const written = (): Array<{ id: unknown; order: number }> =>
    (
      mockBulkWrite.mock.calls[0][0] as Array<{
        updateOne: {
          filter: { _id: unknown };
          update: { $set: { order: number } };
        };
      }>
    ).map((op) => ({
      id: op.updateOne.filter._id,
      order: op.updateOne.update.$set.order,
    }));

  it("moves an entry up, writes only the rows that changed and refreshes the live pools", async () => {
    stored();
    const res = await move("e-b", 1, 0);
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("#entry-e-b");
    const flash = parseFlashRedirect(location.split("#")[0]);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("position 1 of 3");
    expect(flash.msg).toContain("picks a message at random");
    expect(written()).toEqual([
      { id: "e-b", order: 0 },
      { id: "e-a", order: 1 },
    ]);
    expect(mockRefreshStatusPools).toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "bot-status.reorder",
      targetId: "e-b",
      result: "success",
      details: { pool: "single", from: 1, to: 0, renumbered: 2 },
    });
  });

  it("moves an entry down to the last place", async () => {
    stored();
    await move("e-b", 1, 2);
    expect(written()).toEqual([
      { id: "e-c", order: 1 },
      { id: "e-b", order: 2 },
    ]);
  });

  it("ends ties: every entry gets its own place", async () => {
    stored([4, 4, 4]);
    await move("e-b", 1, 0);
    expect(written()).toEqual([
      { id: "e-b", order: 0 },
      { id: "e-a", order: 1 },
      { id: "e-c", order: 2 },
    ]);
  });

  it("re-reads only the entry's own pool in this guild", async () => {
    stored();
    await move("e-b", 1, 0);
    expect(mockFind).toHaveBeenCalledWith({
      guildId: session.guildId,
      pool: "single",
    });
  });

  it("refuses a move from a stale page and writes nothing", async () => {
    stored();
    const res = await move("e-b", 1, 0, 2);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("nothing was moved");
    expect(mockBulkWrite).not.toHaveBeenCalled();
    expect(mockRefreshStatusPools).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      result: "failure",
      errorMessage: "stale",
    });
  });

  it("refuses a move from a form of another pool (the entry is stored in single)", async () => {
    stored();
    const res = await move("e-b", 1, 0, 3, "lonely");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("warn");
    expect(mockBulkWrite).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ errorMessage: "stale" });
  });

  it("only writes an entry that still has the order the move read, in its own guild and pool", async () => {
    stored();
    await move("e-b", 1, 0);
    const ops = mockBulkWrite.mock.calls[0][0] as Array<{
      updateOne: { filter: Record<string, unknown> };
    }>;
    expect(ops.map((o) => o.updateOne.filter)).toEqual([
      { _id: "e-b", guildId: session.guildId, pool: "single", order: 1 },
      { _id: "e-a", guildId: session.guildId, pool: "single", order: 0 },
    ]);
  });

  it("reports a move that raced another one as stale when an entry no longer matched", async () => {
    stored();
    mockBulkWrite.mockResolvedValue({ matchedCount: 1 });
    const res = await move("e-b", 1, 0);
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("warn");
    expect(lastAudit()).toMatchObject({
      result: "failure",
      errorMessage: "partial",
    });
    // The live pools are refreshed: part of the move may have been written.
    expect(mockRefreshStatusPools).toHaveBeenCalled();
  });

  it("refuses a place past the end of the pool", async () => {
    stored();
    await move("e-b", 1, 3);
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("changes nothing when the entry is already at that place", async () => {
    stored();
    const res = await move("e-b", 1, 1);
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("reads the move before looking the entry up", async () => {
    const res = await harness.post("/bot-status/entry/e-b/move", {
      from: "1",
      to: "up",
      count: "3",
      scope: "single",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("refuses an entry owned by another guild", async () => {
    mockFindById.mockResolvedValue(ownedEntry({ guildId: "another-guild" }));
    const res = await move("e-b", 1, 0);
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });

  it("turns a write error into a flash and a failure audit", async () => {
    stored();
    mockBulkWrite.mockRejectedValue(new Error("db down"));
    const res = await move("e-b", 1, 0);
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "db down",
    );
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});
