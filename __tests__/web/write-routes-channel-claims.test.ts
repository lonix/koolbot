/**
 * Route-handler tests for the Channel Claims admin page (#1022), driven over
 * HTTP through the shared harness with the real middleware stack. The planner
 * glue and the adoption engine are mocked.
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
jest.unstable_mockModule(
  "../../src/services/channel-claims-adoption.js",
  () => ({
    planChannelClaims: mockPlan,
    claimsRevalidator: () => async () => [],
    claimsPlanIsApplicable: (p: {
      plan: { errors: unknown[]; operations: unknown[] };
      errors: unknown[];
    }) =>
      p.plan.errors.length === 0 &&
      p.errors.length === 0 &&
      p.plan.operations.length > 0,
  }),
);
const mockStartApply = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule(
  "../../src/services/server-adoption-service.js",
  () => ({
    ServerAdoptionService: {
      getInstance: async () => ({ startApply: mockStartApply }),
    },
  }),
);

const { createChannelClaimsRouter } =
  await import("../../src/web/routes/write/channel-claims.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const session = createTestSession();
const CH = "300000000000000001";
const CAT = "300000000000000002";

function makeClient(opts: { fetchFails?: boolean } = {}): Client {
  const channels = new Map([
    [CAT, { id: CAT, type: 4, parentId: null }],
    [CH, { id: CH, type: 0, parentId: CAT }],
  ]);
  const guild = { id: "guild-1", channels: { fetch: async () => channels } };
  return {
    guilds: {
      fetch: jest.fn(async () => {
        if (opts.fetchFails) throw new Error("down");
        return guild;
      }),
    },
  } as unknown as Client;
}

const scan = {
  guildName: "G",
  roles: [],
  channels: [
    {
      id: CAT,
      name: "Cat <i>",
      kind: "category",
      typeName: "GuildCategory",
      parentId: null,
      position: 0,
      usedBy: [],
      gatedByRoleIds: [],
      flags: {},
      syncedToParent: null,
    },
  ],
  naming: { suggestedPrefix: null },
};

const planned = (over: Record<string, unknown> = {}) => ({
  scan,
  groups: [],
  plan: {
    id: "plan-1",
    errors: [],
    warnings: [],
    operations: [{ id: "op-1" }],
  },
  errors: [],
  warnings: [],
  ...over,
});

let harness: AdminHarness;
async function mount(client: Client = makeClient()): Promise<void> {
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createChannelClaimsRouter(client),
  ]);
}
const flashOf = (res: Response) =>
  parseFlashRedirect(res.headers.get("location"));
const payload = (claims: unknown[]) => JSON.stringify(claims);
const fresh = () => new Date().toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  mockPlan.mockResolvedValue(planned());
  mockStartApply.mockReturnValue({
    id: "11111111-1111-1111-1111-111111111111",
  });
});
afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as AdminHarness;
});

describe("GET /adopt/claims", () => {
  it("renders the form without planning any change", async () => {
    await mount();
    const res = await harness.get("/adopt/claims");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Channel Claims");
    expect(mockPlan).toHaveBeenCalledWith(
      expect.anything(),
      session.discordUserId,
      [],
      expect.any(String),
    );
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("explains when Discord can't be reached", async () => {
    await mount(makeClient({ fetchFails: true }));
    const res = await harness.get("/adopt/claims");
    expect(await res.text()).toContain("Discord couldn&#39;t be reached");
  });
});

describe("POST /adopt/claims/preview", () => {
  it("plans the submitted claims and renders the diff, writing nothing", async () => {
    await mount();
    const res = await harness.post("/adopt/claims/preview", {
      [`action_${CH}`]: "read-only",
      [`bind_${CH}`]: "quotes.channel_id",
      [`bulk_${CAT}`]: "gate",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Apply plan");
    expect(html).toContain('name="planId" value="plan-1"');
    expect(mockPlan.mock.calls[0][2]).toEqual([
      expect.objectContaining({
        channelId: CH,
        action: "read-only",
        bindKey: "quotes.channel_id",
      }),
    ]);
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("offers no apply button when the plan has errors", async () => {
    mockPlan.mockResolvedValue(
      planned({ errors: [{ code: "x", message: "blocked" }] }),
    );
    await mount();
    const html = await (
      await harness.post("/adopt/claims/preview", {
        [`action_${CH}`]: "read-only",
      })
    ).text();
    expect(html).toContain("blocked");
    expect(html).not.toContain("Apply plan");
  });

  it("requires the CSRF token", async () => {
    await mount();
    const res = await harness.post(
      "/adopt/claims/preview",
      {},
      { csrfField: "wrong" },
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /adopt/claims/apply", () => {
  const claim = { channelId: CH, action: "read-only" };

  it("applies through the engine when the plan id still matches", async () => {
    await mount();
    const res = await harness.post("/adopt/claims/apply", {
      planId: "plan-1",
      at: fresh(),
      payload: payload([claim]),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("job=");
    expect(mockStartApply).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "adopt.claims.apply",
        result: "success",
      }),
    );
  });

  it("re-plans with the preview's own approval stamp", async () => {
    await mount();
    const at = fresh();
    await harness.post("/adopt/claims/apply", {
      planId: "plan-1",
      at,
      payload: payload([claim]),
    });
    expect(mockPlan.mock.calls[0][3]).toBe(at);
  });

  it("refuses when the server changed since the preview", async () => {
    await mount();
    const res = await harness.post("/adopt/claims/apply", {
      planId: "stale",
      at: fresh(),
      payload: payload([claim]),
    });
    expect(flashOf(res).type).toBe("warn");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("refuses a plan with blocking problems", async () => {
    mockPlan.mockResolvedValue(
      planned({ errors: [{ code: "x", message: "blocked" }] }),
    );
    await mount();
    const res = await harness.post("/adopt/claims/apply", {
      planId: "plan-1",
      at: fresh(),
      payload: payload([claim]),
    });
    expect(flashOf(res).type).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it.each([
    ["an unreadable payload", { payload: "{nope" }],
    [
      "a channel that isn't in the server",
      { payload: payload([{ channelId: "1".repeat(18), action: "gate" }]) },
    ],
    [
      "an unknown feature key",
      {
        payload: payload([
          { channelId: CH, action: "leave", bindKey: "core.owner" },
        ]),
      },
    ],
    [
      "a stale approval stamp",
      {
        at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        payload: payload([claim]),
      },
    ],
    ["a missing stamp", { at: "", payload: payload([claim]) }],
  ])("refuses %s", async (_label, over) => {
    await mount();
    const res = await harness.post("/adopt/claims/apply", {
      planId: "plan-1",
      at: fresh(),
      ...over,
    });
    expect(res.status).toBe(303);
    expect(["err", "warn"]).toContain(flashOf(res).type);
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("reports an engine that can't start", async () => {
    mockStartApply.mockImplementation(() => {
      throw new Error("another apply is running");
    });
    await mount();
    const res = await harness.post("/adopt/claims/apply", {
      planId: "plan-1",
      at: fresh(),
      payload: payload([claim]),
    });
    expect(flashOf(res)).toMatchObject({
      type: "err",
      msg: "another apply is running",
    });
    expect(mockRecordAudit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: "failure" }),
    );
  });
});
