/**
 * Route-handler tests for the admin write surface's "run an action" routers
 * — Permissions, Database (dbtrunk), Digest and Voice Channels (issue #849).
 *
 * These are driven over HTTP through the shared harness with the real
 * middleware stack in front, so each test exercises body parsing, the
 * handler, its audit write and the flash redirect the operator actually
 * lands on. Only the services behind the handlers are mocked.
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

const mockGetCommandPermissions = jest.fn<() => Promise<unknown>>();
const mockSetCommandPermissions = jest.fn<() => Promise<unknown>>();
const mockClearCommandPermissions = jest.fn<() => Promise<unknown>>();

const mockRunCleanup = jest.fn<() => Promise<unknown>>();
const mockRunNow = jest.fn<() => Promise<unknown>>();

const mockCleanupEmptyChannels = jest.fn<() => Promise<boolean>>();
const mockEnsureLobbyChannels = jest.fn<() => Promise<boolean>>();
const mockGuildsFetch = jest.fn(async () => ({ id: "guild-1" }));

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

jest.unstable_mockModule("../../src/services/permissions-service.js", () => ({
  PermissionCheckError: class PermissionCheckError extends Error {},
  PermissionsService: {
    getInstance: (): unknown => ({
      getCommandPermissions: mockGetCommandPermissions,
      setCommandPermissions: mockSetCommandPermissions,
      clearCommandPermissions: mockClearCommandPermissions,
    }),
  },
}));

jest.unstable_mockModule(
  "../../src/services/voice-channel-truncation.js",
  () => ({
    VoiceChannelTruncationService: {
      getInstance: (): unknown => ({ runCleanup: mockRunCleanup }),
    },
  }),
);

jest.unstable_mockModule("../../src/services/digest-service.js", () => ({
  DigestService: {
    getInstance: (): unknown => ({ runNow: mockRunNow }),
  },
}));

jest.unstable_mockModule("../../src/services/voice-channel-manager.js", () => ({
  VoiceChannelManager: {
    getInstance: (): unknown => ({
      cleanupEmptyChannels: mockCleanupEmptyChannels,
      ensureLobbyChannels: mockEnsureLobbyChannels,
    }),
  },
}));

const { createPermissionsRouter } =
  await import("../../src/web/routes/write/permissions.js");
const { createDatabaseRouter } =
  await import("../../src/web/routes/write/database.js");
const { createDigestRouter } =
  await import("../../src/web/routes/write/digest.js");
const { createVoiceChannelsRouter } =
  await import("../../src/web/routes/write/voice-channels.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = {
  user: { id: "bot" },
  guilds: { fetch: mockGuildsFetch },
} as unknown as Client;

const session = createTestSession();

/** Mount a domain router behind the same stack `createWriteRouter` uses. */
async function mount(
  build: (client: Client) => Parameters<typeof startAdminHarness>[0][number],
): Promise<AdminHarness> {
  return startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    build(client),
  ]);
}

/** The single audit entry a write is required to record. */
function soleAudit(): Record<string, unknown> {
  expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  const [auditedSession, entry] = mockRecordAudit.mock.calls[0] as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  // The entry must be attributable to the session that performed it.
  expect(auditedSession).toMatchObject({
    sessionId: session.sessionId,
    guildId: session.guildId,
    discordUserId: session.discordUserId,
  });
  return entry;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /permissions/set", () => {
  let harness: AdminHarness;

  beforeEach(async () => {
    mockGetCommandPermissions.mockResolvedValue({ allowedRoles: ["old"] });
    mockSetCommandPermissions.mockResolvedValue(undefined);
    mockClearCommandPermissions.mockResolvedValue(undefined);
    harness = await mount(createPermissionsRouter);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("rejects a missing command name without touching the service", async () => {
    const res = await harness.post("/permissions/set", {});
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(res.status).toBe(303);
    expect(flash.path).toBe("/admin/permissions");
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Missing command name.");
    expect(mockSetCommandPermissions).not.toHaveBeenCalled();
    expect(mockClearCommandPermissions).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("stores the roles a <select multiple> posted as repeated fields", async () => {
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a", "role-b"],
    });
    expect(res.status).toBe(303);
    expect(mockSetCommandPermissions).toHaveBeenCalledWith("guild-1", "ping", [
      "role-a",
      "role-b",
    ]);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("2 role(s)");
  });

  it("splits a single comma-separated roleIds value", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: "role-a, role-b ,",
    });
    expect(mockSetCommandPermissions).toHaveBeenCalledWith("guild-1", "ping", [
      "role-a",
      "role-b",
    ]);
  });

  it("clears the restriction when nothing was selected", async () => {
    const res = await harness.post("/permissions/set", { command: "ping" });
    expect(mockClearCommandPermissions).toHaveBeenCalledWith("guild-1", "ping");
    expect(mockSetCommandPermissions).not.toHaveBeenCalled();
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.msg).toContain("now open");
  });

  it("audits the before/after roles on success", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a"],
    });
    expect(soleAudit()).toMatchObject({
      action: "permissions.set",
      targetId: "ping",
      result: "success",
      details: { before: { allowedRoles: ["old"] }, after: ["role-a"] },
    });
  });

  it("audits a failure and flashes the reason instead of throwing", async () => {
    mockSetCommandPermissions.mockRejectedValue(new Error("mongo is down"));
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a"],
    });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("mongo is down");
    expect(soleAudit()).toMatchObject({
      action: "permissions.set",
      result: "failure",
      errorMessage: "mongo is down",
    });
  });

  it("still records the write when the before-snapshot lookup fails", async () => {
    mockGetCommandPermissions.mockRejectedValue(new Error("read failed"));
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a"],
    });
    expect(mockSetCommandPermissions).toHaveBeenCalled();
    expect(soleAudit()).toMatchObject({
      result: "success",
      details: { before: null },
    });
  });
});

describe("POST /database/run-cleanup", () => {
  let harness: AdminHarness;

  beforeEach(async () => {
    harness = await mount(createDatabaseRouter);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("reports the sweep's counts on a clean run", async () => {
    mockRunCleanup.mockResolvedValue({
      sessionsRemoved: 7,
      dataAggregated: 3,
      executionTime: 42,
      errors: [],
    });
    const res = await harness.post("/database/run-cleanup");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/database");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Removed 7 sessions across 3 users in 42ms");
    expect(soleAudit()).toMatchObject({
      action: "dbtrunk.run",
      result: "success",
      details: { sessionsRemoved: 7, errors: 0, skipped: false },
    });
  });

  it("warns (not errors) when the 24h interval blocked the run", async () => {
    mockRunCleanup.mockResolvedValue({
      sessionsRemoved: 0,
      dataAggregated: 0,
      executionTime: 0,
      errors: ["interval not met"],
      skipped: true,
    });
    const res = await harness.post("/database/run-cleanup");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("24-hour minimum interval");
    // A skipped run is not a failure, and its errors must not be counted.
    expect(soleAudit()).toMatchObject({
      result: "success",
      details: { skipped: true, errors: 0 },
    });
  });

  it("surfaces at most three errors from a partially failed run", async () => {
    mockRunCleanup.mockResolvedValue({
      sessionsRemoved: 1,
      dataAggregated: 1,
      executionTime: 5,
      errors: ["e1", "e2", "e3", "e4"],
    });
    const res = await harness.post("/database/run-cleanup");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("e1; e2; e3");
    expect(flash.msg).not.toContain("e4");
    expect(soleAudit()).toMatchObject({
      result: "failure",
      errorMessage: "e1; e2; e3",
      details: { errors: 4 },
    });
  });

  it("turns a thrown service error into a flash, not a 500", async () => {
    mockRunCleanup.mockRejectedValue(new Error("boom"));
    const res = await harness.post("/database/run-cleanup");
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("boom");
    expect(soleAudit()).toMatchObject({
      action: "dbtrunk.run",
      result: "failure",
      errorMessage: "boom",
    });
  });
});

describe("POST /digest/send-now", () => {
  let harness: AdminHarness;

  beforeEach(async () => {
    harness = await mount(createDigestRouter);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("reports the delivery breakdown on a successful send", async () => {
    mockRunNow.mockResolvedValue({
      qualifying: 10,
      sent: 8,
      skippedOptOut: 1,
      skippedDmsClosed: 1,
      failed: 0,
    });
    const res = await harness.post("/digest/send-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/digest");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("8 delivered");
    expect(soleAudit()).toMatchObject({
      action: "digest.send-now",
      result: "success",
    });
  });

  it("warns when the feature is disabled (runNow returned null)", async () => {
    mockRunNow.mockResolvedValue(null);
    const res = await harness.post("/digest/send-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("disabled or GUILD_ID");
    expect(soleAudit()).toMatchObject({
      result: "failure",
      errorMessage: "digest disabled or GUILD_ID unset",
    });
  });

  it("downgrades to a warning when some deliveries failed", async () => {
    mockRunNow.mockResolvedValue({
      qualifying: 5,
      sent: 3,
      skippedOptOut: 0,
      skippedDmsClosed: 0,
      failed: 2,
    });
    const res = await harness.post("/digest/send-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(soleAudit()).toMatchObject({
      result: "failure",
      errorMessage: "2 delivery error(s)",
    });
  });

  it("turns a thrown service error into a flash", async () => {
    mockRunNow.mockRejectedValue(new Error("smtp down"));
    const res = await harness.post("/digest/send-now");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("smtp down");
    expect(soleAudit()).toMatchObject({ result: "failure" });
  });
});

describe("POST /voice-channels/force-reload", () => {
  let harness: AdminHarness;

  beforeEach(async () => {
    harness = await mount(createVoiceChannelsRouter);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("confirms success only when both the sweep and the lobby succeeded", async () => {
    mockCleanupEmptyChannels.mockResolvedValue(true);
    mockEnsureLobbyChannels.mockResolvedValue(true);
    const res = await harness.post("/voice-channels/force-reload");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/voice-channels");
    expect(flash.type).toBe("ok");
    expect(mockGuildsFetch).toHaveBeenCalledWith("guild-1");
    expect(soleAudit()).toMatchObject({
      action: "voicechannels.force-reload",
      result: "success",
      details: { swept: true, lobbyEnsured: true },
    });
  });

  it("warns rather than claiming a cleanup when the sweep no-ops (#843)", async () => {
    mockCleanupEmptyChannels.mockResolvedValue(false);
    mockEnsureLobbyChannels.mockResolvedValue(true);
    const res = await harness.post("/voice-channels/force-reload");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("the cleanup sweep did not complete");
    expect(soleAudit()).toMatchObject({
      result: "failure",
      errorMessage: "the cleanup sweep did not complete",
    });
  });

  it("names both problems when neither step completed", async () => {
    mockCleanupEmptyChannels.mockResolvedValue(false);
    mockEnsureLobbyChannels.mockResolvedValue(false);
    const res = await harness.post("/voice-channels/force-reload");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("the cleanup sweep did not complete");
    expect(flash.msg).toContain("the lobby could not be ensured");
  });

  it("turns a thrown guild fetch into a flash", async () => {
    mockCleanupEmptyChannels.mockResolvedValue(true);
    mockGuildsFetch.mockRejectedValue(new Error("Missing Access") as never);
    const res = await harness.post("/voice-channels/force-reload");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Missing Access");
    expect(soleAudit()).toMatchObject({ result: "failure" });
  });
});
