/**
 * Route-handler tests for the removed-bot cleanup page (#1179), driven over
 * HTTP through the shared harness with the real middleware stack. The cleanup
 * planner and the adoption engine are mocked (the planner is covered against a
 * simulated server in `services/bot-removal-cleanup.test.ts`).
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
    getInstance: () => ({ getBoolean: async () => false }),
  },
}));

const mockPlan = jest.fn<(...a: any[]) => any>();
const mockRevalidator = jest.fn(() => async () => []);
const mockFind = jest.fn<(...a: any[]) => any>();
const mockConfirm = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule("../../src/services/bot-removal-cleanup.js", () => ({
  planBotCleanup: mockPlan,
  cleanupRevalidator: mockRevalidator,
  findRemovedBotCandidates: mockFind,
  confirmRemovedBots: mockConfirm,
  cleanupPlanIsApplicable: (p: {
    plan: { errors: unknown[]; operations: unknown[] };
    errors: unknown[];
  }) =>
    p.plan.errors.length === 0 &&
    p.errors.length === 0 &&
    p.plan.operations.length > 0,
}));
const mockScanGuild = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule("../../src/services/server-scan-service.js", () => ({
  ServerScanService: {
    getInstance: () => ({ scanGuild: mockScanGuild }),
  },
}));
const mockStartApply = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule(
  "../../src/services/server-adoption-service.js",
  () => ({
    ServerAdoptionService: {
      getInstance: async () => ({ startApply: mockStartApply }),
    },
  }),
);

const { createBotCleanupRouter, parseChannelIds, parsePreviewStamp } =
  await import("../../src/web/routes/write/bot-cleanup.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const session = createTestSession();
const BOT = "155149108183695360";
const CH = "300000000000000001";
const CH2 = "300000000000000002";

const candidate = {
  userId: BOT,
  name: "Dyno <b>",
  evidence: "catalogue",
  needsCheck: false,
  reason: "Its id is in the bot catalogue and it is no longer in the server.",
  overwriteChannels: [
    { id: CH, name: "general <i>" },
    { id: CH2, name: "chat" },
  ],
  ownedChannels: [],
  boundFeatures: [],
};

const op = {
  id: "op-1",
  type: "overwrite.remove",
  class: "destructive",
  summary: "Remove overwrite on general",
  before: {},
  after: null,
};
const planned = (over: Record<string, unknown> = {}) => ({
  scan: {},
  candidate,
  channelIds: [CH],
  errors: [],
  plan: { id: "plan-1", errors: [], warnings: [], operations: [op] },
  ...over,
});

const fresh = () => new Date(Date.now() - 1000).toISOString();

function makeClient(fetchFails = false): Client {
  const guild = { id: "guild-1" };
  return {
    guilds: {
      fetch: jest.fn(async () => {
        if (fetchFails) throw new Error("down");
        return guild;
      }),
    },
  } as unknown as Client;
}

const JOB_ID = "11111111-1111-1111-1111-111111111111";
/** A job that has ended; `startApply` returns while the real one still runs. */
const finishedJob = (over: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  status: "done",
  error: null,
  result: {
    snapshotId: "s",
    status: "applied",
    applied: ["op-1"],
    failed: [],
    skipped: [],
  },
  ...over,
});
/** Wait for the background outcome entry the route writes after the job ends. */
async function outcomeAudit(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i += 1) {
    const hit = mockRecordAudit.mock.calls.find(
      (c) =>
        (c as unknown[])[1] && (c as any)[1].action === "adopt.cleanup.apply",
    );
    if (hit) return (hit as any)[1];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no adopt.cleanup.apply audit entry was written");
}

let harness: AdminHarness;
async function mount(client: Client = makeClient()): Promise<void> {
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createBotCleanupRouter(client),
  ]);
}
const flashOf = (res: Response) =>
  parseFlashRedirect(res.headers.get("location"));

beforeEach(() => {
  jest.clearAllMocks();
  mockPlan.mockImplementation(async () => planned());
  mockFind.mockReturnValue([candidate]);
  mockConfirm.mockImplementation(async (_g, list) => ({
    candidates: list,
    unchecked: 0,
    next: null,
  }));
  mockScanGuild.mockResolvedValue({ channels: [] });
  mockStartApply.mockReturnValue(finishedJob());
});
afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as AdminHarness;
});

describe("input parsing", () => {
  it("keeps only snowflake channel ids, once each", () => {
    expect(parseChannelIds({ ch: [CH, CH, "x", "<script>", CH2] })).toEqual([
      CH,
      CH2,
    ]);
    expect(parseChannelIds({ ch: CH })).toEqual([CH]);
    expect(parseChannelIds({})).toEqual([]);
  });

  it("accepts a recent, exact preview stamp and nothing else", () => {
    const now = Date.parse("2026-10-01T10:30:00.000Z");
    expect(parsePreviewStamp("2026-10-01T10:00:00.000Z", now)).toBe(
      "2026-10-01T10:00:00.000Z",
    );
    expect(parsePreviewStamp("2026-10-01T09:00:00.000Z", now)).toBeNull();
    expect(parsePreviewStamp("2026-10-01T12:00:00.000Z", now)).toBeNull();
    expect(parsePreviewStamp("2026-10-01", now)).toBeNull();
    expect(parsePreviewStamp("garbage", now)).toBeNull();
  });
});

describe("GET /adopt/cleanup", () => {
  it("lists removed bots without planning anything", async () => {
    await mount();
    const res = await harness.get("/adopt/cleanup");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Clean up after a removed bot");
    expect(html).toContain("Dyno &lt;b&gt;");
    expect(mockPlan).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("lists only what Discord confirmed and says when some could not be checked", async () => {
    mockConfirm.mockResolvedValueOnce({ candidates: [], unchecked: 2 });
    await mount();
    const html = await (await harness.get("/adopt/cleanup")).text();
    expect(mockConfirm).toHaveBeenCalled();
    expect(html).not.toContain("Dyno &lt;b&gt;");
    expect(html).toContain("2 account(s)");
  });

  it("continues after the account the link names, and offers the next batch", async () => {
    mockConfirm.mockResolvedValueOnce({
      candidates: [candidate],
      unchecked: 0,
      next: "777777777777777777",
    });
    await mount();
    const html = await (
      await harness.get("/adopt/cleanup?after=555555555555555555")
    ).text();
    expect(mockConfirm.mock.calls.at(-1)![2]).toEqual({
      after: "555555555555555555",
      include: null,
    });
    expect(html).toContain("after=777777777777777777");
    expect(html).toContain("Check the next accounts");
  });

  it("keeps a bot found on a later page selectable: its Review link names it and the route always checks it", async () => {
    const late = { ...candidate, userId: "999999999999999999", name: "Late" };
    // Page 2: the batch holds the late bot.
    mockConfirm.mockImplementation(async (_g, _list, opts) => ({
      candidates: [late],
      unchecked: 0,
      next: null,
      // A real run also returns the included bot even when it is off-window.
      ...(opts?.include ? {} : {}),
    }));
    await mount();
    const page2 = await (
      await harness.get("/adopt/cleanup?after=555555555555555555")
    ).text();
    const href = /href="(\/admin\/adopt\/cleanup\?bot=[^"]+)"/.exec(page2)?.[1];
    expect(href).toBeDefined();
    // Follow the link as the browser does: no cursor, only the bot.
    mockFind.mockReturnValue([late]);
    const choice = await (
      await harness.get(href!.replace(/&amp;/g, "&").replace(/^\/admin/, ""))
    ).text();
    expect(mockConfirm.mock.calls.at(-1)![2]).toEqual({
      after: null,
      include: "999999999999999999",
    });
    expect(choice).toContain('name="ch"');
    expect(choice).not.toContain("not in the list below any more");
    // And the preview form it renders (a GET with the bot) does the same.
    const form = /<form method="get"[^>]*>([^]*?)<\/form>/.exec(choice)![1]!;
    const fields = [...form.matchAll(/name="(\w+)" value="([^"]*)"/g)];
    // Hidden fields as posted; the admin ticks one channel box.
    const q = new globalThis.URLSearchParams(
      fields.filter((m) => m[1] !== "ch").map((m) => [m[1]!, m[2]!]),
    );
    q.append("ch", CH);
    const preview = await (await harness.get(`/adopt/cleanup?${q}`)).text();
    expect(mockPlan).toHaveBeenCalledWith(
      expect.anything(),
      session.discordUserId,
      "999999999999999999",
      [CH],
      expect.any(String),
      { sampleMessages: false },
    );
    expect(mockConfirm.mock.calls.at(-1)![2]).toEqual({
      after: null,
      include: "999999999999999999",
    });
    expect(preview).toContain("Destructive steps (1)");
  });

  it("ignores a malformed continuation", async () => {
    await mount();
    await harness.get("/adopt/cleanup?after=%3Cx%3E");
    expect(mockConfirm.mock.calls.at(-1)![2]).toEqual({
      after: null,
      include: null,
    });
  });

  it("shows the overwrites of the chosen bot, none ticked", async () => {
    await mount();
    const html = await (await harness.get(`/adopt/cleanup?bot=${BOT}`)).text();
    expect(html).toContain("general &lt;i&gt;");
    expect(html).not.toMatch(/name="ch"[^>]* checked/);
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("previews only on request, with a destructive section and its own confirmation", async () => {
    await mount();
    const html = await (
      await harness.get(`/adopt/cleanup?bot=${BOT}&preview=1&ch=${CH}`)
    ).text();
    expect(mockPlan).toHaveBeenCalledWith(
      expect.anything(),
      session.discordUserId,
      BOT,
      [CH],
      expect.any(String),
      { sampleMessages: false },
    );
    expect(html).toContain("Destructive steps (1)");
    expect(html).toContain('name="confirmDestructive"');
    expect(html).toContain('action="/admin/adopt/cleanup/apply"');
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("explains a plan that could not be made and offers no apply form", async () => {
    mockPlan.mockImplementation(async () =>
      planned({
        errors: [
          {
            code: "bot-still-present",
            message: "That bot is still in the server.",
          },
        ],
        plan: { id: "p", errors: [], warnings: [], operations: [] },
      }),
    );
    await mount();
    const html = await (
      await harness.get(`/adopt/cleanup?bot=${BOT}&preview=1&ch=${CH}`)
    ).text();
    expect(html).toContain("That bot is still in the server.");
    expect(html).not.toContain("/adopt/cleanup/apply");
  });

  it("says so, and plans nothing, when the server can't be read", async () => {
    await mount(makeClient(true));
    const html = await (
      await harness.get(`/adopt/cleanup?bot=${BOT}&preview=1&ch=${CH}`)
    ).text();
    expect(html).toContain("couldn&#39;t be");
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("does not trust a malformed bot id", async () => {
    await mount();
    const html = await (
      await harness.get(`/adopt/cleanup?bot=%3Cscript%3E&preview=1`)
    ).text();
    expect(html).not.toContain("<script>alert");
    expect(mockPlan).not.toHaveBeenCalled();
  });
});

describe("POST /adopt/cleanup/apply", () => {
  const form = (over: Record<string, string | string[]> = {}) => ({
    planId: "plan-1",
    bot: BOT,
    at: fresh(),
    ch: [CH],
    confirmDestructive: "1",
    ...over,
  });

  it("applies through the engine and writes an audit entry", async () => {
    await mount();
    const res = await harness.post("/adopt/cleanup/apply", form());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("job=");
    expect(mockStartApply).toHaveBeenCalledTimes(1);
    expect(mockStartApply.mock.calls[0]![1]).toMatchObject({
      actor: expect.anything(),
      revalidate: expect.any(Function),
    });
    expect(mockRevalidator).toHaveBeenCalledTimes(1);
    // Accepted is recorded at once; success only once the job has ended well.
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "adopt.cleanup.start",
        targetId: "plan-1",
        result: "success",
      }),
    );
    expect(await outcomeAudit()).toMatchObject({
      action: "adopt.cleanup.apply",
      targetId: "plan-1",
      result: "success",
    });
  });

  it("writes no outcome entry while the job is still running", async () => {
    const job = finishedJob({ status: "running", result: null });
    mockStartApply.mockReturnValue(job);
    await mount();
    await harness.post("/adopt/cleanup/apply", form());
    expect(
      mockRecordAudit.mock.calls.some(
        (c) => (c as any)[1].action === "adopt.cleanup.apply",
      ),
    ).toBe(false);
    // The job ends well: only now is success recorded.
    Object.assign(job, finishedJob());
    expect(await outcomeAudit()).toMatchObject({ result: "success" });
  });

  it("does not record success when the engine's live-state check refuses the cleanup", async () => {
    mockStartApply.mockReturnValue(
      finishedJob({
        status: "failed",
        error: "That bot is still in the server.",
        result: null,
      }),
    );
    await mount();
    const res = await harness.post("/adopt/cleanup/apply", form());
    expect(res.status).toBe(303);
    expect(await outcomeAudit()).toMatchObject({
      result: "failure",
      errorMessage: "That bot is still in the server.",
    });
    expect(
      mockRecordAudit.mock.calls.some(
        (c) =>
          (c as any)[1].action === "adopt.cleanup.apply" &&
          (c as any)[1].result === "success",
      ),
    ).toBe(false);
  });

  it("does not record success when a Discord overwrite removal fails", async () => {
    mockStartApply.mockReturnValue(
      finishedJob({
        result: {
          snapshotId: "s",
          status: "partial",
          applied: [],
          failed: [{ opId: "op-1", error: "Missing Permissions" }],
          skipped: [],
        },
      }),
    );
    await mount();
    await harness.post("/adopt/cleanup/apply", form());
    expect(await outcomeAudit()).toMatchObject({
      result: "failure",
      errorMessage: "1 step(s) failed.",
    });
  });

  it("re-plans the posted choice with the preview's own stamp", async () => {
    await mount();
    const at = fresh();
    await harness.post("/adopt/cleanup/apply", form({ at }));
    const call = mockPlan.mock.calls.at(-1)!;
    expect(call[2]).toBe(BOT);
    expect(call[3]).toEqual([CH]);
    expect(call[4]).toBe(at);
  });

  it("refuses without the separate destructive confirmation", async () => {
    await mount();
    const res = await harness.post(
      "/adopt/cleanup/apply",
      form({ confirmDestructive: undefined as never }),
    );
    expect(flashOf(res).type).toBe("warn");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("refuses a request without the CSRF token", async () => {
    await mount();
    const res = await harness.post("/adopt/cleanup/apply", form(), {
      csrfField: null,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it.each([
    ["an expired stamp", { at: "2020-01-01T00:00:00.000Z" }],
    ["no stamp", { at: "" }],
    ["a malformed bot id", { bot: "abc" }],
  ])("refuses %s", async (_label, over) => {
    await mount();
    const res = await harness.post("/adopt/cleanup/apply", form(over));
    expect(flashOf(res).type).toBe("warn");
    expect(mockPlan).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("refuses when the server changed since the preview", async () => {
    await mount();
    const res = await harness.post(
      "/adopt/cleanup/apply",
      form({ planId: "stale" }),
    );
    expect(flashOf(res).type).toBe("warn");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("refuses a plan with blocking problems", async () => {
    mockPlan.mockImplementation(async () =>
      planned({ errors: [{ code: "bot-still-present", message: "back" }] }),
    );
    await mount();
    const res = await harness.post("/adopt/cleanup/apply", form());
    expect(flashOf(res).type).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("refuses, never falling back, when the server or the re-plan can't be read", async () => {
    await mount(makeClient(true));
    const res = await harness.post("/adopt/cleanup/apply", form());
    expect(flashOf(res).type).toBe("err");
    await harness.close();
    mockPlan.mockRejectedValueOnce(new Error("scan failed"));
    await mount();
    const again = await harness.post("/adopt/cleanup/apply", form());
    expect(flashOf(again).type).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("reports an engine that can't start, and audits the failure", async () => {
    mockStartApply.mockImplementation(() => {
      throw new Error("another apply is running");
    });
    await mount();
    const res = await harness.post("/adopt/cleanup/apply", form());
    expect(flashOf(res)).toMatchObject({
      type: "err",
      msg: "another apply is running",
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "adopt.cleanup.apply",
        result: "failure",
      }),
    );
  });
});
