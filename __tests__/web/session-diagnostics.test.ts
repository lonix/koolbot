/**
 * The session's real state is visible, and its renewals and refusals are in
 * the debug log (#1635).
 *
 * With the four values on the Environment page (signed in, previous request,
 * window, hard cap) a report like "my session outlived the night" answers
 * itself, and the debug lines say which route kept a session alive.
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
import type { Client } from "discord.js";
import type { Response, NextFunction } from "express";
import logger from "../../src/utils/logger.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import {
  createSessionMiddleware,
  createSessionPingHandler,
  type AuthenticatedRequest,
} from "../../src/web/session.js";
import { renderBootstrapPage } from "../../src/web/admin-views.js";

const SECRET = "test-secret-for-session-diagnostics";
const ORIGINAL_ENV = { ...process.env };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 1, 8, 59, 0);
const COOKIE_VALUE_MARKER = "do-not-log";

function signedCookie(act: number, iat = T0 - 5 * HOUR): string {
  const payload = {
    sid: "sid-secret-1",
    uid: "u-1",
    gid: "g-1",
    rol: "admin",
    iat,
    act,
    // Extra claim, only so the test can prove the payload is never logged.
    marker: COOKIE_VALUE_MARKER,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return signValue(encoded, SECRET);
}

function makeRes(): Response & { headers: Record<string, unknown> } {
  const headers: Record<string, unknown> = {};
  const res = {
    headers,
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type: () => res,
    send: () => res,
    json: () => res,
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
  };
  return res as never;
}

function makeReq(
  signed: string,
  method: string,
  originalUrl: string,
): AuthenticatedRequest {
  return {
    method,
    originalUrl,
    headers: { cookie: `koolbot_session=${encodeURIComponent(signed)}` },
  } as unknown as AuthenticatedRequest;
}

let nowMs = T0;
let debug: jest.SpiedFunction<typeof logger.debug>;

function loggedLines(): string[] {
  return debug.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
  process.env.WEBUI_SESSION_LIFETIME_HOURS = "24";
  process.env.WEBUI_BASE_URL = "http://example.test:3000";
  nowMs = T0;
  (WebSessionService as unknown as { instance: unknown }).instance = null;
  jest.spyOn(Date, "now").mockImplementation(() => nowMs);
  jest.spyOn(WebSessionService.getInstance(), "findById").mockResolvedValue({
    discordUserId: "u-1",
    guildId: "g-1",
    role: "admin",
    scopes: [],
    revokedAt: null,
    expiresAt: new Date(T0 + 19 * HOUR),
  } as never);
  jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
    checkCommandPermission: async () => true,
    isAdministrator: async () => true,
    resolveWebScopes: async () => ["member"],
  } as never);
  debug = jest.spyOn(logger, "debug").mockImplementation(() => logger);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

describe("the session context", () => {
  it("carries when the session was issued and when the PREVIOUS request was, before this one renewed it", async () => {
    const mw = createSessionMiddleware({} as Client);
    const req = makeReq(
      signedCookie(T0 - 14 * MINUTE),
      "GET",
      "/admin/bootstrap",
    );
    const next = jest.fn();
    await mw(req, makeRes(), next as unknown as NextFunction);
    expect(next).toHaveBeenCalled();
    expect(req.webSession?.issuedAt).toBe(T0 - 5 * HOUR);
    expect(req.webSession?.previousActivityAt).toBe(T0 - 14 * MINUTE);
    expect(req.webSession?.lastActivityAt).toBe(T0);
  });
});

describe("debug log lines", () => {
  it("logs a renewal with the method, the route without its query, and the idle gap", async () => {
    const mw = createSessionMiddleware({} as Client);
    const req = makeReq(
      signedCookie(T0 - 14 * MINUTE),
      "POST",
      "/admin/role-groups/job/abc?token=hunter2",
    );
    await mw(req, makeRes(), jest.fn() as unknown as NextFunction);
    const line = loggedLines().find((l) => /renewed/i.test(l));
    expect(line).toBeDefined();
    expect(line).toContain("POST /admin/role-groups/job/abc");
    expect(line).toContain("14 min");
    expect(line).not.toContain("hunter2");
  });

  it("logs a refusal for inactivity with the route, the idle gap and the window", async () => {
    nowMs = T0 + 8 * HOUR;
    const mw = createSessionMiddleware({} as Client);
    const req = makeReq(signedCookie(T0), "GET", "/me/events");
    await mw(req, makeRes(), jest.fn() as unknown as NextFunction);
    const line = loggedLines().find((l) => /refused/i.test(l));
    expect(line).toBeDefined();
    expect(line).toContain("inactivity");
    expect(line).toContain("GET /me/events");
    expect(line).toContain("480 min");
    expect(line).toContain("30 min");
  });

  it("logs a ping refused for inactivity, and no renewal for a ping that is served", async () => {
    const ping = createSessionPingHandler();
    nowMs = T0 + 40 * MINUTE;
    await ping(
      makeReq(signedCookie(T0), "GET", "/admin/session/ping"),
      makeRes(),
      jest.fn() as unknown as NextFunction,
    );
    expect(
      loggedLines().some(
        (l) => /refused/i.test(l) && l.includes("/admin/session/ping"),
      ),
    ).toBe(true);

    debug.mockClear();
    nowMs = T0 + 5 * MINUTE;
    await ping(
      makeReq(signedCookie(T0), "GET", "/admin/session/ping"),
      makeRes(),
      jest.fn() as unknown as NextFunction,
    );
    expect(loggedLines().some((l) => /renewed/i.test(l))).toBe(false);
  });

  it.each([
    ["the hard cap passed", { expiresAt: new Date(T0 - HOUR) }, "hard cap"],
    ["the row revoked", { revokedAt: new Date(T0 - HOUR) }, "revoked"],
  ])("names the reason when %s", async (_name, row, word) => {
    jest.spyOn(WebSessionService.getInstance(), "findById").mockResolvedValue({
      discordUserId: "u-1",
      guildId: "g-1",
      role: "admin",
      scopes: [],
      revokedAt: null,
      expiresAt: new Date(T0 + HOUR),
      ...row,
    } as never);
    const mw = createSessionMiddleware({} as Client);
    await mw(
      makeReq(signedCookie(T0 - MINUTE), "GET", "/admin/"),
      makeRes(),
      jest.fn() as unknown as NextFunction,
    );
    expect(
      loggedLines().some((l) => /refused/i.test(l) && l.includes(word)),
    ).toBe(true);
  });

  it("never writes the cookie, its payload, the session id or the secret", async () => {
    const mw = createSessionMiddleware({} as Client);
    await mw(
      makeReq(signedCookie(T0 - MINUTE), "GET", "/admin/"),
      makeRes(),
      jest.fn() as unknown as NextFunction,
    );
    nowMs = T0 + 8 * HOUR;
    await mw(
      makeReq(signedCookie(T0), "GET", "/admin/"),
      makeRes(),
      jest.fn() as unknown as NextFunction,
    );
    const all = loggedLines().join("\n");
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [
      SECRET,
      signedCookie(T0),
      COOKIE_VALUE_MARKER,
      "sid-secret-1",
      "u-1",
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("the Environment page's session panel", () => {
  const COMMON = { csrfToken: "t", remainingMs: 1_800_000 };
  const session = {
    issuedAt: Date.UTC(2026, 10, 1, 3, 59),
    previousActivityAt: Date.UTC(2026, 10, 1, 8, 45),
    now: Date.UTC(2026, 10, 1, 8, 59),
    windowMs: 30 * MINUTE,
    expiresAt: new Date(Date.UTC(2026, 10, 2, 3, 59)),
  };

  it("shows signed in, previous request, window and hard cap in a KeyValue panel", () => {
    const html = renderBootstrapPage({ ...COMMON, groups: [], session });
    const panel = html.match(
      /<section class="kb-panel"[^>]*aria-labelledby="session-title">[\s\S]*?<\/section>/,
    );
    expect(panel).not.toBeNull();
    const text = (panel as RegExpMatchArray)[0];
    expect(text).toContain('<dl class="kb-kv">');
    expect(text).toContain("<dt>Signed in</dt><dd>2026-11-01 03:59 UTC</dd>");
    expect(text).toContain("2026-11-01 08:45 UTC");
    expect(text).toContain("14 min before this page");
    expect(text).toContain("<dt>Inactivity window</dt><dd>30 minutes</dd>");
    expect(text).toContain("<dt>Hard cap</dt><dd>2026-11-02 03:59 UTC</dd>");
  });

  it("puts the session panel before the environment variables (state first)", () => {
    const html = renderBootstrapPage({
      ...COMMON,
      groups: [
        {
          category: "Web UI",
          rows: [{ key: "WEBUI_ENABLED", present: true, isSecret: false }],
        },
      ],
      session,
    });
    expect(html.indexOf('id="session-title"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="session-title"')).toBeLessThan(
      html.indexOf("WEBUI_ENABLED"),
    );
  });

  it("says so plainly when this is the first request after signing in or the value is unknown", () => {
    const html = renderBootstrapPage({
      ...COMMON,
      groups: [],
      session: { ...session, previousActivityAt: undefined },
    });
    expect(html).toContain("<dt>Previous request</dt><dd>—</dd>");
  });

  it("is absent when no session is passed (existing callers unchanged)", () => {
    const html = renderBootstrapPage({ ...COMMON, groups: [] });
    expect(html).not.toContain("session-title");
  });

  it("uses a singular unit for a one-minute window", () => {
    const html = renderBootstrapPage({
      ...COMMON,
      groups: [],
      session: { ...session, windowMs: MINUTE },
    });
    expect(html).toContain("<dd>1 minute</dd>");
  });
});
