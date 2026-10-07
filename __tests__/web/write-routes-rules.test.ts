/**
 * Route-handler tests for the Rules acceptance admin writes (#1024), driven
 * over HTTP through the shared harness with the real middleware stack. The
 * rules service, the planner glue and the adoption engine are mocked.
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

const mockRecordAudit = jest.fn<(...a: any[]) => Promise<void>>(
  async () => undefined,
);
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

const mockGetBoolean = jest.fn<(...a: any[]) => Promise<boolean>>();
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({ getBoolean: mockGetBoolean }) },
}));

const mockPost = jest.fn<(...a: any[]) => any>();
const mockRecordHolders = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule("../../src/services/rules-service.js", () => ({
  RulesService: {
    getInstance: () => ({
      postOrUpdateMessage: mockPost,
      recordExistingHolders: mockRecordHolders,
    }),
  },
  ROLE_PROBLEM_TEXT: { "role-privileged": "Role is privileged." },
}));

const mockPlan = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule("../../src/services/rules-adoption.js", () => ({
  planRulesGate: mockPlan,
  rulesPlanIsApplicable: (p: { applicable: boolean }) => p.applicable,
}));
jest.unstable_mockModule("../../src/web/rules-page.js", () => ({
  parseRulesOptions: () => ({
    createRole: false,
    grantExisting: false,
    gateChannelIds: [],
  }),
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

const { createRulesRouter } =
  await import("../../src/web/routes/write/rules.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const session = createTestSession();

function makeClient(opts: { fetchFails?: boolean } = {}): Client {
  return {
    guilds: {
      fetch: jest.fn(async () => {
        if (opts.fetchFails) throw new Error("down");
        return { id: "guild-1" };
      }),
    },
  } as unknown as Client;
}

let harness: AdminHarness;
async function mount(client: Client = makeClient()): Promise<void> {
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createRulesRouter(client),
  ]);
}
const flashOf = (res: Response) =>
  parseFlashRedirect(res.headers.get("location"));
const plan = (over: Record<string, unknown> = {}) => ({
  plan: { id: "plan-1", operations: [{}, {}] },
  applicable: true,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBoolean.mockResolvedValue(true);
  mockPost.mockResolvedValue({ ok: true, action: "posted", messageId: "m1" });
  mockRecordHolders.mockResolvedValue({ recorded: 3 });
  mockPlan.mockResolvedValue(plan());
  mockStartApply.mockReturnValue({ id: "job-1" });
});
afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as AdminHarness;
});

describe("POST /rules/post", () => {
  it("refuses to post while rules acceptance is disabled", async () => {
    mockGetBoolean.mockResolvedValue(false);
    await mount();
    const res = await harness.post("/rules/post");
    expect(flashOf(res)).toMatchObject({ path: "/admin/rules", type: "err" });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("posts the message and audits it", async () => {
    await mount();
    const res = await harness.post("/rules/post");
    expect(flashOf(res).type).toBe("ok");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "rules.post", result: "success" }),
    );
  });

  it("reports a Discord failure and audits it", async () => {
    mockPost.mockResolvedValue({ ok: false, error: "No channel." });
    await mount();
    const res = await harness.post("/rules/post");
    expect(flashOf(res)).toMatchObject({ type: "err", msg: "No channel." });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: "failure",
        errorMessage: "No channel.",
      }),
    );
  });
});

describe("POST /rules/sync", () => {
  it("records current holders and audits the count", async () => {
    await mount();
    const res = await harness.post("/rules/sync");
    expect(flashOf(res).type).toBe("ok");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "rules.record-holders",
        details: { recorded: 3 },
        result: "success",
      }),
    );
  });

  it("shows the role problem and audits a refusal", async () => {
    mockRecordHolders.mockResolvedValue({ problem: "role-privileged" });
    await mount();
    const res = await harness.post("/rules/sync");
    expect(flashOf(res)).toMatchObject({ type: "err" });
    expect(flashOf(res).msg).toContain("Role is privileged.");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "rules.record-holders",
        result: "failure",
      }),
    );
  });

  it("audits a failure when the write throws part-way", async () => {
    mockRecordHolders.mockRejectedValue(new Error("bulk write failed"));
    await mount();
    const res = await harness.post("/rules/sync");
    expect(flashOf(res).type).toBe("err");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "rules.record-holders",
        result: "failure",
        errorMessage: "bulk write failed",
      }),
    );
  });

  it("reports an unreachable Discord without writing", async () => {
    await mount(makeClient({ fetchFails: true }));
    const res = await harness.post("/rules/sync");
    expect(flashOf(res).type).toBe("err");
    expect(mockRecordHolders).not.toHaveBeenCalled();
  });
});

describe("POST /rules/apply", () => {
  it("warns and applies nothing when the plan id drifted", async () => {
    await mount();
    const res = await harness.post("/rules/apply", { planId: "old-plan" });
    expect(flashOf(res).type).toBe("warn");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("refuses an inapplicable plan", async () => {
    mockPlan.mockResolvedValue(plan({ applicable: false }));
    await mount();
    const res = await harness.post("/rules/apply", { planId: "plan-1" });
    expect(flashOf(res).type).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("starts the background apply and redirects to the job", async () => {
    await mount();
    const res = await harness.post("/rules/apply", { planId: "plan-1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/rules?job=job-1");
    expect(mockStartApply).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plan-1" }),
      expect.objectContaining({ actor: expect.anything() }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "rules.apply",
        targetId: "plan-1",
        result: "success",
      }),
    );
  });

  it("audits a failure when the apply can't start", async () => {
    mockStartApply.mockImplementation(() => {
      throw new Error("another apply is running");
    });
    await mount();
    const res = await harness.post("/rules/apply", { planId: "plan-1" });
    expect(flashOf(res)).toMatchObject({
      type: "err",
      msg: "another apply is running",
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "rules.apply", result: "failure" }),
    );
  });

  it("reports an unreachable Discord without planning", async () => {
    await mount(makeClient({ fetchFails: true }));
    const res = await harness.post("/rules/apply", { planId: "plan-1" });
    expect(flashOf(res).type).toBe("err");
    expect(mockPlan).not.toHaveBeenCalled();
  });
});
