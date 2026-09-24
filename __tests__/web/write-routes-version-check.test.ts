/**
 * Route-handler tests for the dashboard "Check now" button (#1029).
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
const mockCheckNow = jest.fn<() => Promise<Record<string, unknown>>>();

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

jest.unstable_mockModule("../../src/services/version-check-service.js", () => ({
  VersionCheckService: {
    getInstance: (): unknown => ({ checkNow: mockCheckNow }),
  },
}));

const { createVersionCheckRouter } =
  await import("../../src/web/routes/write/version-check.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
let harness: AdminHarness;

function snapshot(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    enabled: true,
    running: "2.0.0",
    latest: {
      version: "v2.1.0",
      url: "https://github.com/lonix/koolbot/releases/tag/v2.1.0",
      publishedAt: null,
      fetchedAt: new Date(),
    },
    status: "update-available",
    updateKind: "minor",
    lastAttemptAt: new Date(),
    lastError: null,
    ...overrides,
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  harness = await startAdminHarness([
    stubRequireSession(createTestSession()),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createVersionCheckRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

describe("POST /admin/version/check (#1029)", () => {
  it("runs a check and flashes the result back to the dashboard", async () => {
    mockCheckNow.mockResolvedValue(snapshot({}));
    const res = await harness.post("/version/check");
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/");
    expect(flash.type).toBe("warn");
    expect(flash.msg).toBe("Update available: v2.1.0 (minor).");
    expect(mockCheckNow).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "version.check",
        result: "success",
      }),
    );
  });

  it("reports up to date", async () => {
    mockCheckNow.mockResolvedValue(
      snapshot({ status: "up-to-date", updateKind: null }),
    );
    const flash = parseFlashRedirect(
      (await harness.post("/version/check")).headers.get("location"),
    );
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("KoolBot is up to date.");
  });

  it("flashes a failed check as an error, never a 500", async () => {
    mockCheckNow.mockResolvedValue(
      snapshot({ status: "error", lastError: "Rate-limited by GitHub." }),
    );
    const res = await harness.post("/version/check");
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Rate-limited by GitHub.");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: "failure",
        errorMessage: "Rate-limited by GitHub.",
      }),
    );
  });

  it("explains when the check is off", async () => {
    mockCheckNow.mockResolvedValue(
      snapshot({ status: "disabled", enabled: false }),
    );
    const flash = parseFlashRedirect(
      (await harness.post("/version/check")).headers.get("location"),
    );
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("core.updatecheck.enabled");
  });

  it("requires a CSRF token", async () => {
    const res = await harness.post("/version/check", {}, { csrfField: "bad" });
    expect(res.status).toBe(403);
    expect(mockCheckNow).not.toHaveBeenCalled();
  });
});
