/**
 * Route-handler tests for adopting existing Discord events (#1034), driven over
 * HTTP through the shared harness with the real middleware stack. The planner
 * glue, the page renderer and the adoption engine are mocked.
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
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({ getBoolean: async () => true }),
  },
}));

const mockPlan = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule("../../src/services/event-adoption.js", () => ({
  planEventAdoption: mockPlan,
  eventPlanIsApplicable: (p: { applicable: boolean }) => p.applicable,
}));
const mockRender = jest.fn<(...a: any[]) => string>(() => "<html>page</html>");
jest.unstable_mockModule("../../src/web/event-adoption-view.js", () => ({
  EVENT_ADOPTION_PATH: "/admin/adopt/events",
  renderEventAdoptionPage: mockRender,
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

const { createEventAdoptionRouter, parseEventIds } =
  await import("../../src/web/routes/write/event-adoption.js");
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
    createEventAdoptionRouter(client),
  ]);
}
const flashOf = (res: Response) =>
  parseFlashRedirect(res.headers.get("location"));
const planned = (over: Record<string, unknown> = {}) => ({
  plan: { id: "plan-1", operations: [{}, {}] },
  applicable: true,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPlan.mockResolvedValue(planned());
  mockStartApply.mockReturnValue({ id: "job-1" });
});
afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as AdminHarness;
});

describe("parseEventIds", () => {
  it("keeps unique snowflakes from a string or a list and drops the rest", () => {
    expect(parseEventIds({ ev: ["123456", "123456", "x1", "<b>"] })).toEqual([
      "123456",
    ]);
    expect(parseEventIds({ ev: "987654321" })).toEqual(["987654321"]);
    expect(parseEventIds({})).toEqual([]);
  });
});

describe("GET /adopt/events", () => {
  it("plans the chosen events for the signed-in admin and renders the page", async () => {
    await mount();
    const res = await harness.get(
      "/adopt/events?preview=1&ev=111111&ev=222222&ev=bad",
    );
    expect(res.status).toBe(200);
    expect(mockPlan).toHaveBeenCalledWith(
      { id: "guild-1" },
      session.discordUserId,
      ["111111", "222222"],
    );
    expect(mockRender.mock.calls[0][0]).toMatchObject({
      previewing: true,
      jobId: null,
      error: undefined,
    });
  });

  it("lists without a preview, and passes a job id only when it looks like one", async () => {
    await mount();
    await harness.get("/adopt/events?job=123e4567-e89b-12d3-a456-426614174000");
    expect(mockRender.mock.calls[0][0]).toMatchObject({
      previewing: false,
      jobId: "123e4567-e89b-12d3-a456-426614174000",
    });
    await harness.get("/adopt/events?job=<script>");
    expect(mockRender.mock.calls[1][0]).toMatchObject({ jobId: null });
  });

  it("shows an error page when the server can't be read", async () => {
    mockPlan.mockRejectedValue(new Error("scan <failed>"));
    await mount();
    await harness.get("/adopt/events");
    expect(mockRender.mock.calls[0][0]).toMatchObject({
      planned: null,
      error: "scan <failed>",
    });
    await harness.close();
    await mount(makeClient({ fetchFails: true }));
    await harness.get("/adopt/events");
    expect(mockRender.mock.calls[1][0]).toMatchObject({
      planned: null,
      error: "Discord couldn't be reached.",
    });
  });
});

describe("POST /adopt/events/apply", () => {
  const body = { planId: "plan-1", ev: ["111111", "222222"] };

  it("re-plans the same choice, starts the apply as the admin and audits it", async () => {
    await mount();
    const res = await harness.post("/adopt/events/apply", body);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/adopt/events?job=job-1");
    expect(mockPlan).toHaveBeenCalledWith(
      { id: "guild-1" },
      session.discordUserId,
      ["111111", "222222"],
    );
    expect(mockStartApply).toHaveBeenCalledWith(
      { id: "plan-1", operations: [{}, {}] },
      { actor: session },
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "adopt.events.apply",
        targetId: "plan-1",
        result: "success",
      }),
    );
  });

  it("refuses a plan that changed since the preview and starts nothing", async () => {
    mockPlan.mockResolvedValue(
      planned({ plan: { id: "plan-2", operations: [{}] } }),
    );
    await mount();
    const res = await harness.post("/adopt/events/apply", body);
    expect(flashOf(res)).toMatchObject({
      path: "/admin/adopt/events",
      type: "warn",
    });
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("refuses a plan with blocking problems", async () => {
    mockPlan.mockResolvedValue(planned({ applicable: false }));
    await mount();
    const res = await harness.post("/adopt/events/apply", body);
    expect(flashOf(res).type).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("reports an unreachable server without planning", async () => {
    await mount(makeClient({ fetchFails: true }));
    const res = await harness.post("/adopt/events/apply", body);
    expect(flashOf(res).type).toBe("err");
    expect(mockPlan).not.toHaveBeenCalled();
  });

  it("reports an engine that refuses to start and audits the failure", async () => {
    mockStartApply.mockImplementation(() => {
      throw new Error("Another apply is running");
    });
    await mount();
    const res = await harness.post("/adopt/events/apply", body);
    expect(flashOf(res)).toMatchObject({ type: "err" });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "adopt.events.apply",
        result: "failure",
        errorMessage: "Another apply is running",
      }),
    );
  });

  it("needs the CSRF token", async () => {
    await mount();
    const res = await harness.post("/adopt/events/apply", body, {
      csrfField: "wrong",
    });
    expect(res.status).toBe(403);
    expect(mockStartApply).not.toHaveBeenCalled();
  });
});
