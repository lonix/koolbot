/**
 * A failed configuration lookup on the moderator's pages (#1320).
 *
 * The real `ConfigService` and the real `ModerationCaseService` run here; only
 * the `Config` model's `findOne` is made to reject. A failed lookup must reach
 * the error handler (500) and must not read as "moderation is off", "cases are
 * off" or "no such case". An absent key (the lookup worked and found nothing)
 * still reads as the default.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
  afterAll,
} from "@jest/globals";
import {
  startAdminHarness,
  createTestSession,
  parseFlashRedirect,
  TEST_CSRF_TOKEN,
  type AdminHarness,
} from "./admin-harness.js";

process.env.WEBUI_SESSION_SECRET = "test-secret-for-me-moderation-config";

type Lookup = (query: { key: string }) => Promise<unknown>;
const findOne = jest.fn<Lookup>();
const mockRecordAudit = jest.fn<(...args: unknown[]) => Promise<undefined>>(
  async () => undefined,
);
const moderation = {
  countRecent: jest.fn<() => Promise<number>>(async () => 0),
  getRecent: jest.fn<() => Promise<unknown[]>>(async () => []),
  getHistory: jest.fn<() => Promise<unknown[]>>(async () => []),
};

const actualConfigModel = await import("../../src/models/config.js");
jest.unstable_mockModule("../../src/models/config.js", () => ({
  ...actualConfigModel,
  Config: { findOne, deleteOne: jest.fn() },
}));
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
  boundAuditEntry: (e: unknown) => e,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/moderation-service.js", () => ({
  ModerationService: { getInstance: (): unknown => moderation },
}));
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: { getInstance: (): unknown => ({ list: async () => [] }) },
}));
jest.unstable_mockModule(
  "../../src/models/discord-command-audit-log.js",
  () => ({
    DiscordCommandAuditLog: {
      countDocuments: async () => 0,
      find: () => ({
        sort: () => ({
          skip: () => ({ limit: () => ({ lean: async () => [] }) }),
        }),
      }),
    },
  }),
);
jest.unstable_mockModule("../../src/web/read-only-routes.js", () => ({
  fetchChannelData: async () => ({ names: new Map(), types: new Map() }),
}));

const { createMeModerationRouter } =
  await import("../../src/web/routes/me-moderation.js");
const { requireScopeMiddleware } = await import("../../src/web/session.js");
const { ConfigService } = await import("../../src/services/config-service.js");

const client = {
  commands: new Map(),
  guilds: {
    fetch: async () => ({
      memberCount: 0,
      members: { cache: { size: 0, get: () => undefined, values: () => [] } },
    }),
  },
};

const session = createTestSession({
  discordUserId: "111111111111111111",
  guildId: "guild-1",
  role: "user",
  scopes: ["member", "moderator"],
});

let harness: AdminHarness;

beforeAll(async () => {
  harness = await startAdminHarness(
    [
      (req, _res, next): void => {
        Object.assign(req, {
          webSession: session,
          csrfToken: TEST_CSRF_TOKEN,
        });
        next();
      },
      requireScopeMiddleware("moderator"),
      createMeModerationRouter(client as never),
    ],
    "/me/moderation",
  );
});

afterAll(async () => {
  await harness.close();
});

/** Each key either has a stored value, is absent (null) or its lookup fails. */
const lookups = (table: Record<string, boolean | null | "fail">): void => {
  findOne.mockImplementation(async ({ key }) => {
    const v = table[key];
    if (v === "fail") throw new Error(`mongo down: ${key}`);
    return typeof v === "boolean" ? { key, value: v } : null;
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  // A value read earlier is cached and would hide a failing lookup.
  (
    ConfigService.getInstance() as unknown as { cache: Map<string, unknown> }
  ).cache.clear();
});

describe("a failed configuration lookup", () => {
  it.each([
    ["moderation.enabled", { "moderation.enabled": "fail" }],
    [
      "moderation.cases.enabled",
      { "moderation.enabled": true, "moderation.cases.enabled": "fail" },
    ],
  ] as const)(
    "on %s is an error on the log page and the case page, not 'off' or 'not found'",
    async (_label, table) => {
      lookups({ ...table });
      const log = await harness.get("/");
      expect(log.status).toBe(500);
      expect(await log.text()).not.toMatch(/switched off|Mod log/i);
      const found = await harness.get("/cases/case-1");
      expect(found.status).toBe(500);
      expect(await found.text()).not.toMatch(/not found|switched off/i);
    },
  );

  it("on the command-audit switch is an error, not 'auditing off'", async () => {
    lookups({ "core.command_audit.enabled": "fail" });
    const res = await harness.get("/audit");
    expect(res.status).toBe(500);
  });

  it("on a decision says the switch could not be read, not 'turned off'", async () => {
    lookups({ "moderation.enabled": "fail" });
    const res = await harness.post("/cases/case-1/uphold", {});
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toMatch(/could not check/i);
    expect(flash.msg).not.toMatch(/turned off/i);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: "failure" }),
    );
  });

  it("still reads an ABSENT key as the default (cases off, 404 for a case)", async () => {
    lookups({ "moderation.enabled": true });
    const log = await harness.get("/");
    expect(log.status).toBe(200);
    expect(await log.text()).toMatch(/switched off/i);
    expect((await harness.get("/cases/case-1")).status).toBe(404);
  });
});
