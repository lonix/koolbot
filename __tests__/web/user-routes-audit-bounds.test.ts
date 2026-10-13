/**
 * /me hardening (#1142): member-supplied strings are bounded before they reach
 * a WebAuditLog row, the rejected timezone is never stored, and the surface is
 * rate limited.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { Buffer } from "buffer";
import { createUserRouter } from "../../src/web/user-routes.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { UserNotificationPrefsService } from "../../src/services/user-notification-prefs-service.js";
import { boundAuditEntry } from "../../src/web/audit.js";

const SECRET = "test-secret-for-me-audit-bounds";
const USER = "user-1";
const GUILD = "guild-1";

let auditRows: Array<Record<string, unknown>> = [];

function buildCookie(): string {
  const now = Date.now();
  const encoded = Buffer.from(
    JSON.stringify({
      sid: "session-id",
      uid: USER,
      gid: GUILD,
      rol: "user",
      iat: now - 60_000,
      act: now - 60_000,
    }),
  ).toString("base64url");
  return `koolbot_session=${signValue(encoded, SECRET)}; koolbot_csrf=csrf-1`;
}

async function installMocks(): Promise<void> {
  jest.spyOn(WebSessionService.getInstance(), "findById").mockResolvedValue({
    discordUserId: USER,
    guildId: GUILD,
    role: "user",
    scopes: [],
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  } as never);
  const { PermissionsService } =
    await import("../../src/services/permissions-service.js");
  jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
    checkCommandPermission: async () => true,
  } as never);
  const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
  jest.spyOn(WebAuditLog, "create").mockImplementation(async (row: unknown) => {
    auditRows.push(row as Record<string, unknown>);
    return {} as never;
  });
  jest
    .spyOn(UserNotificationPrefsService.getInstance(), "getTimezone")
    .mockResolvedValue(null);
}

async function post(
  router: ReturnType<typeof createUserRouter>,
  path: string,
  body: Record<string, unknown>,
  ip = "10.0.0.1",
): Promise<{ statusCode: number; redirectedTo?: string }> {
  const out: { statusCode: number; redirectedTo?: string } = {
    statusCode: 200,
  };
  const headers: Record<string, unknown> = {
    cookie: buildCookie(),
    "x-csrf-token": "csrf-1",
  };
  const res: Record<string, unknown> = {};
  res.status = (c: number): unknown => {
    out.statusCode = c;
    return res;
  };
  res.type = (): unknown => res;
  res.send = (): unknown => res;
  res.json = (): unknown => res;
  res.setHeader = (): unknown => res;
  res.getHeader = (): unknown => undefined;
  res.header = (): unknown => res;
  res.redirect = (code: unknown, url?: unknown): unknown => {
    out.statusCode = typeof code === "number" ? code : 302;
    out.redirectedTo = String(url ?? code);
    return res;
  };
  const req = {
    method: "POST",
    url: path,
    originalUrl: `/me${path}`,
    path,
    baseUrl: "/me",
    headers,
    body,
    query: {},
    ip,
    socket: { remoteAddress: ip },
    csrfToken: "csrf-1",
    header: (name: string): unknown => headers[name.toLowerCase()],
  };
  await new Promise<void>((resolve) => {
    router(req as never, res as never, (() => resolve()) as never);
    setTimeout(resolve, 0);
  });
  await new Promise((r) => setTimeout(r, 10));
  return out;
}

describe("/me audit bounds and rate limit (#1142)", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
    auditRows = [];
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function makeRouter(): Promise<ReturnType<typeof createUserRouter>> {
    await installMocks();
    const client = {} as never;
    const { createSessionMiddleware } =
      await import("../../src/web/session.js");
    return createUserRouter(client, createSessionMiddleware(client));
  }

  it("does not persist an oversized rejected timezone", async () => {
    const router = await makeRouter();
    const huge = "X".repeat(200_000);
    const out = await post(router, "/timezone", {
      _csrf: "csrf-1",
      timezone: huge,
    });

    expect(out.statusCode).toBe(303);
    expect(auditRows).toHaveLength(1);
    const serialised = JSON.stringify(auditRows[0]);
    expect(serialised).not.toContain("XXXXXXXX");
    expect(serialised.length).toBeLessThan(2_000);
    expect(auditRows[0]).toMatchObject({
      action: "user.timezone.set",
      result: "failure",
    });
    // The flash redirect must not echo the input either.
    expect(out.redirectedTo!.length).toBeLessThan(1_000);
  });

  it("throttles /me writes per client", async () => {
    const router = await makeRouter();
    let blocked = 0;
    for (let i = 0; i < 65; i += 1) {
      const out = await post(
        router,
        "/timezone",
        { timezone: "UTC" },
        "203.0.113.9",
      );
      if (out.statusCode === 429) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(0);
    // Another client is unaffected.
    const other = await post(
      router,
      "/timezone",
      { timezone: "UTC" },
      "203.0.113.10",
    );
    expect(other.statusCode).not.toBe(429);
  });
});

describe("boundAuditEntry (#1142)", () => {
  it("caps strings at every depth, strips control characters and limits nesting", () => {
    const big = "a\n".repeat(5_000);
    const out = boundAuditEntry({
      action: "x",
      result: "failure",
      errorMessage: big,
      details: {
        a: big,
        nested: { deep: { deeper: { deepest: { z: big } } } },
        list: [big],
      },
    });
    expect(out.errorMessage!.length).toBeLessThanOrEqual(257);
    expect(out.errorMessage).not.toMatch(/[\n\r]/);
    expect(JSON.stringify(out.details).length).toBeLessThan(2_000);
  });
});
