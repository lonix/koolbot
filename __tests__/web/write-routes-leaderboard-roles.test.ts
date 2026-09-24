/**
 * Route-handler tests for the Leaderboard Roles admin writes (#985): the
 * tier editor save and Run now. Driven over HTTP through the shared harness
 * with the real middleware stack, so each test covers body parsing, the
 * handler, its audit row and the flash redirect. Only the services behind the
 * handlers are mocked.
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
const mockGetString = jest.fn<() => Promise<string>>();
const mockSet = jest.fn<() => Promise<void>>();
const mockRunNow = jest.fn<() => Promise<unknown>>();

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
      getString: mockGetString,
      set: mockSet,
    }),
  },
}));

jest.unstable_mockModule(
  "../../src/services/leaderboard-role-service.js",
  () => ({
    LeaderboardRoleService: {
      getInstance: (): unknown => ({ runNow: mockRunNow }),
    },
  }),
);

const { createLeaderboardRolesRouter } =
  await import("../../src/web/routes/write/leaderboard-roles.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

/**
 * A guild whose roles are `roles` (id → position / managed) and whose bot
 * member's highest role sits at `botPosition`.
 */
function makeClient(opts: {
  roles?: Record<string, { position: number; managed?: boolean }>;
  botPosition?: number | null;
  fetchFails?: boolean;
}): Client {
  const cache = new Map(
    Object.entries(opts.roles ?? {}).map(([id, r]) => [
      id,
      { id, name: `role-${id}`, position: r.position, managed: !!r.managed },
    ]),
  );
  const me =
    opts.botPosition === null
      ? null
      : { roles: { highest: { position: opts.botPosition ?? 10 } } };
  const guild = {
    id: "guild-1",
    roles: { fetch: jest.fn(async () => undefined), cache },
    members: { me, fetchMe: jest.fn(async () => me) },
  };
  return {
    guilds: {
      fetch: jest.fn(async () => {
        if (opts.fetchFails) throw new Error("discord down");
        return guild;
      }),
    },
  } as unknown as Client;
}

const session = createTestSession();

async function mount(client: Client): Promise<AdminHarness> {
  return startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createLeaderboardRolesRouter(client),
  ]);
}

function soleAudit(): Record<string, unknown> {
  expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  const [auditedSession, entry] = mockRecordAudit.mock.calls[0] as unknown as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  expect(auditedSession).toMatchObject({
    sessionId: session.sessionId,
    guildId: session.guildId,
  });
  return entry;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetString.mockResolvedValue("");
  mockSet.mockResolvedValue(undefined);
});

describe("POST /leaderboard-roles/tiers", () => {
  let harness: AdminHarness;

  afterEach(async () => {
    await harness.close();
  });

  it("serialises the rows to the stored topN:roleId string", async () => {
    harness = await mount(
      makeClient({ roles: { "222": { position: 2 }, "111": { position: 3 } } }),
    );
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: ["3", "1", ""],
      roleId: ["222", "111", ""],
    });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/leaderboard-roles");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Saved 2 tiers");
    expect(mockSet).toHaveBeenCalledWith(
      "leaderboard_roles.tiers",
      "1:111,3:222",
      expect.any(String),
      "leaderboard_roles",
    );
    expect(soleAudit()).toMatchObject({
      action: "leaderboard-roles.tiers",
      targetId: "leaderboard_roles.tiers",
      details: { before: "", after: "1:111,3:222" },
      result: "success",
    });
  });

  it("leaves an existing config untouched when saved unchanged", async () => {
    // Non-canonical spacing and order: re-serialising would rewrite it, so
    // the save must notice nothing changed and not write at all.
    mockGetString.mockResolvedValue("3:222, 1:111");
    const client = makeClient({});
    harness = await mount(client);
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: ["1", "3", ""],
      roleId: ["111", "222", ""],
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("unchanged");
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("clears the tiers when every row is blank", async () => {
    mockGetString.mockResolvedValue("1:111");
    harness = await mount(makeClient({}));
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: "",
      roleId: "",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Tiers cleared");
    expect(mockSet).toHaveBeenCalledWith(
      "leaderboard_roles.tiers",
      "",
      expect.any(String),
      "leaderboard_roles",
    );
  });

  it("rejects a duplicate Top N without writing", async () => {
    harness = await mount(makeClient({}));
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: ["1", "1"],
      roleId: ["111", "222"],
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Each Top N must be unique");
    expect(mockSet).not.toHaveBeenCalled();
    expect(soleAudit()).toMatchObject({ result: "failure" });
  });

  it("rejects a role above the bot's highest role", async () => {
    harness = await mount(
      makeClient({ roles: { "111": { position: 12 } }, botPosition: 10 }),
    );
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: "1",
      roleId: "111",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("above the bot's highest role");
    expect(mockSet).not.toHaveBeenCalled();
    expect(soleAudit()).toMatchObject({
      result: "failure",
      details: { attempted: "1:111" },
    });
  });

  it("rejects a role that no longer exists", async () => {
    harness = await mount(makeClient({ roles: {} }));
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: "1",
      roleId: "111",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Top 1: that role no longer exists");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("rejects a managed role", async () => {
    harness = await mount(
      makeClient({ roles: { "111": { position: 1, managed: true } } }),
    );
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: "1",
      roleId: "111",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "managed by an integration",
    );
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("fails closed when the guild cannot be read", async () => {
    harness = await mount(makeClient({ fetchFails: true }));
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: "1",
      roleId: "111",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Could not read the server's roles");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("fails closed when the bot's own member cannot be read", async () => {
    harness = await mount(
      makeClient({ roles: { "111": { position: 1 } }, botPosition: null }),
    );
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: "1",
      roleId: "111",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("turns a failed config write into a flash and audits it", async () => {
    mockSet.mockRejectedValue(new Error("mongo down"));
    harness = await mount(makeClient({ roles: { "111": { position: 1 } } }));
    const res = await harness.post("/leaderboard-roles/tiers", {
      topN: "1",
      roleId: "111",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("mongo down");
    expect(soleAudit()).toMatchObject({
      result: "failure",
      errorMessage: "mongo down",
    });
  });

  it("refuses a request without a valid CSRF token", async () => {
    harness = await mount(makeClient({ roles: { "111": { position: 1 } } }));
    const res = await harness.post(
      "/leaderboard-roles/tiers",
      { topN: "1", roleId: "111" },
      { csrfField: "wrong" },
    );
    expect(res.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe("POST /leaderboard-roles/run-now", () => {
  let harness: AdminHarness;

  beforeEach(async () => {
    harness = await mount(makeClient({}));
  });

  afterEach(async () => {
    await harness.close();
  });

  it("reports the per-tier result of a run", async () => {
    mockRunNow.mockResolvedValue({
      ranAt: new Date(),
      period: "week",
      tiers: [
        {
          topN: 1,
          roleId: "111",
          roleName: "Champion",
          added: ["u1"],
          removed: [],
        },
        {
          topN: 3,
          roleId: "222",
          roleName: "Podium",
          added: ["u2"],
          removed: ["u3", "u4"],
        },
      ],
    });
    const res = await harness.post("/leaderboard-roles/run-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/leaderboard-roles");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Recalculated (week): 2 granted, 2 revoked.");
    expect(flash.msg).toContain("Top 3 @Podium: +1 / −2");
    expect(soleAudit()).toMatchObject({
      action: "leaderboard-roles.run-now",
      result: "success",
    });
  });

  it("warns when a tier's role was not found", async () => {
    mockRunNow.mockResolvedValue({
      ranAt: new Date(),
      period: "alltime",
      tiers: [
        {
          topN: 1,
          roleId: "111",
          roleName: "111",
          added: [],
          removed: [],
          skippedReason: "role-not-found",
        },
      ],
    });
    const res = await harness.post("/leaderboard-roles/run-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("Top 1: skipped (role not found)");
    expect(soleAudit()).toMatchObject({ result: "failure" });
  });

  it("warns when nothing ran (runNow returned null)", async () => {
    mockRunNow.mockResolvedValue(null);
    const res = await harness.post("/leaderboard-roles/run-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("did not run");
    expect(soleAudit()).toMatchObject({
      result: "failure",
      errorMessage: "recalculation did not run",
    });
  });

  it("turns a thrown service error into a flash", async () => {
    mockRunNow.mockRejectedValue(new Error("gateway lost"));
    const res = await harness.post("/leaderboard-roles/run-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("gateway lost");
    expect(soleAudit()).toMatchObject({ result: "failure" });
  });
});
