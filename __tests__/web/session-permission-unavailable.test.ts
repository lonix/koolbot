/**
 * Regression test for #781 — a transient Discord API error during the
 * per-request permission re-check must NOT be treated as "access denied"
 * and must NOT permanently revoke the user's session.
 *
 * Before the fix, `checkCommandPermission` swallowed every internal
 * error into the same `false` as a genuine denial, and the session
 * middleware reacted to any `false` by clearing the cookie and calling
 * `revokeSession` — so a brief Discord outage logged every active WebUI
 * user out for good. Now the middleware asks for `onUnavailable:
 * "throw"`, and a thrown `PermissionCheckError` fails only the current
 * request (503) while leaving the cookie and the DB session intact.
 */

import { Buffer } from "buffer";
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { Client } from "discord.js";
import {
  createSessionMiddleware,
  type AuthenticatedRequest,
} from "../../src/web/session.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import {
  PermissionsService,
  PermissionCheckError,
} from "../../src/services/permissions-service.js";
import type { Response, NextFunction } from "express";

const SECRET = "test-secret-for-permission-unavailable";
const ORIGINAL_ENV = { ...process.env };

interface CookiePayload {
  sid: string;
  uid: string;
  gid: string;
  rol?: "admin" | "user";
  iat: number;
  act: number;
}

function buildCookie(payload: CookiePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return signValue(encoded, SECRET);
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, unknown>;
  status: jest.Mock;
  type: jest.Mock;
  send: jest.Mock;
  setHeader: jest.Mock;
  getHeader: jest.Mock;
}

function makeRes(): FakeRes {
  const headers: Record<string, unknown> = {};
  const res: FakeRes = {
    statusCode: 200,
    headers,
    status: jest.fn(),
    type: jest.fn(),
    send: jest.fn(),
    setHeader: jest.fn(),
    getHeader: jest.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.type.mockImplementation(() => res);
  res.send.mockImplementation(() => res);
  res.setHeader.mockImplementation((name: string, value: unknown) => {
    headers[name.toLowerCase()] = value;
    return res;
  });
  res.getHeader.mockImplementation(
    (name: string) => headers[name.toLowerCase()],
  );
  return res;
}

function makeReq(cookieValue: string): AuthenticatedRequest {
  return {
    headers: { cookie: `koolbot_session=${cookieValue}` },
    method: "GET",
  } as unknown as AuthenticatedRequest;
}

function sessionCookieHeaders(res: FakeRes): string[] {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list
    .map((h) => String(h))
    .filter((h) => h.startsWith("koolbot_session="));
}

describe("createSessionMiddleware permission re-check failures (#781)", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  let revokeSession: jest.Mock;

  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;

    jest.spyOn(Date, "now").mockImplementation(() => now);

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "u-1",
      guildId: "g-1",
      role: "admin",
      scopes: [],
      revokedAt: null,
      expiresAt: new Date(now + 24 * 60 * 60 * 1000),
    } as never);
    revokeSession = jest.fn(async () => true);
    (svc as unknown as { revokeSession: unknown }).revokeSession =
      revokeSession;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  function freshCookie(): string {
    return buildCookie({
      sid: "session-id",
      uid: "u-1",
      gid: "g-1",
      rol: "admin",
      iat: now,
      act: now,
    });
  }

  it("asks checkCommandPermission to throw instead of masking failures as denial", async () => {
    const check = jest.fn(async () => true);
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: check,
    } as never);

    const middleware = createSessionMiddleware({} as Client);
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    await middleware(makeReq(freshCookie()), res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("u-1", "g-1", "config", {
      onUnavailable: "throw",
    });
  });

  it("responds 503 and keeps the session when the check fails transiently", async () => {
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: async () => {
        throw new PermissionCheckError(
          "Permission check could not be completed",
          new Error("Discord API timeout"),
        );
      },
    } as never);

    const middleware = createSessionMiddleware({} as Client);
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    await middleware(makeReq(freshCookie()), res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("10");
    // The session must survive: no DB revocation and no cookie clearing,
    // so the very next request succeeds once the transient error clears.
    expect(revokeSession).not.toHaveBeenCalled();
    expect(sessionCookieHeaders(res)).toHaveLength(0);
  });

  it("still revokes the session on a genuine denial", async () => {
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: async () => false,
    } as never);

    const middleware = createSessionMiddleware({} as Client);
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;
    await middleware(makeReq(freshCookie()), res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(revokeSession).toHaveBeenCalledWith("session-id");
    // Denial clears the cookie (Max-Age=0 / empty value).
    const cleared = sessionCookieHeaders(res);
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared[0]).toMatch(/^koolbot_session=;/);
  });
});
