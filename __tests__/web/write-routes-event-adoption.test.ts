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

// The bot permission check (#1478): the page hands the view the notice built from it.
const actualCheck = await import("../../src/services/bot-permission-check.js");
const registry = await import("../../src/services/bot-permission-registry.js");
const mockCheck = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule("../../src/services/bot-permission-check.js", () => ({
  ...actualCheck,
  checkBotPermissions: mockCheck,
}));
const featureRef = (id: string) => {
  const r = registry.FEATURE_REQUIREMENTS.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return {
    id: r.id,
    area: r.area,
    feature: r.feature,
    effect: r.effect,
    fix: r.fix,
  };
};
const checkReport = (
  checks: unknown[],
  over: Record<string, unknown> = {},
) => ({
  available: true,
  reason: null,
  fresh: true,
  problems: [],
  unknown: [],
  quiet: [],
  okFeatures: [],
  notes: [],
  checks,
  ...over,
});
const finding = (id: string, outcome: "missing" | "ok") => ({
  feature: featureRef(id),
  kind: "permission",
  enabled: true,
  outcome,
  target: { kind: "category", id: "c1", name: "Events" },
  missing: outcome === "missing" ? ["Manage Channels"] : [],
});

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

describe("GET /adopt/events bot permission notice (#1478)", () => {
  const noticeOf = () => mockRender.mock.calls[0][0].permissionNotice;

  beforeEach(() => {
    mockPlan.mockResolvedValue(planned({ eventsEnabled: true }));
    mockCheck.mockResolvedValue(checkReport([]));
  });

  it("hands the view what the bot lacks for the announcement and the temporary channel", async () => {
    mockCheck.mockResolvedValue(
      checkReport([
        finding("event-channels", "missing"),
        finding("events-announce", "ok"),
        // An entry adopting does not use is left out.
        finding("event-moves", "missing"),
      ]),
    );
    await mount();
    await harness.get("/adopt/events");
    expect(noticeOf()).toMatchObject({
      unavailable: null,
      missing: [
        { feature: { id: "event-channels" }, permissions: ["Manage Channels"] },
      ],
      unchecked: [],
    });
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("hands the view nothing when the permissions are in place", async () => {
    mockCheck.mockResolvedValue(checkReport([finding("event-channels", "ok")]));
    await mount();
    await harness.get("/adopt/events");
    expect(noticeOf()).toBeNull();
  });

  it("says the check could not run, rather than staying quiet", async () => {
    mockCheck.mockResolvedValue(
      checkReport([], {
        available: false,
        reason: "The bot is not connected.",
      }),
    );
    await mount();
    await harness.get("/adopt/events");
    expect(noticeOf()).toMatchObject({
      unavailable: "The bot is not connected.",
    });
  });

  it("does not run the check while Events is off", async () => {
    mockPlan.mockResolvedValue(planned({ eventsEnabled: false }));
    await mount();
    await harness.get("/adopt/events");
    expect(noticeOf()).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("does not run the check when the server could not be read", async () => {
    await mount(makeClient({ fetchFails: true }));
    await harness.get("/adopt/events");
    expect(noticeOf()).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
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
