/**
 * Regression test for #486 — the sliding inactivity window must keep
 * an active operator signed in past the magic-link TTL.
 *
 * Before the fix, the DB row's `expiresAt` was set to `now + link TTL`
 * at link creation (default 10 min) and never extended after redemption.
 * Because the session middleware enforces `dbSession.expiresAt` as a
 * hard cap, the operator was logged out ~10 min after the link was
 * minted regardless of activity. The fix bumps `expiresAt` at redeem
 * time to the session lifetime (default 24h), letting the inactivity
 * sliding window do its job.
 */

import { Buffer } from "buffer";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Client } from "discord.js";
import {
  createSessionMiddleware,
  type AuthenticatedRequest,
} from "../../src/web/session.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import type { Response, NextFunction } from "express";

const SECRET = "test-secret-for-sliding-window";

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

function extractCookieValue(setCookie: unknown): string | null {
  const header = Array.isArray(setCookie)
    ? String(setCookie[setCookie.length - 1] ?? "")
    : String(setCookie ?? "");
  // "koolbot_session=<urlencoded value>; Path=/; HttpOnly; SameSite=lax; Max-Age=1800"
  const m = header.match(/^koolbot_session=([^;]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function decodePayload(signed: string): CookiePayload {
  const dot = signed.lastIndexOf(".");
  const value = signed.slice(0, dot);
  const json = Buffer.from(value, "base64url").toString("utf8");
  return JSON.parse(json) as CookiePayload;
}

describe("createSessionMiddleware sliding window (#486)", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "10";
    process.env.WEBUI_SESSION_LIFETIME_HOURS = "24";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  it("does not log out an operator making a request every 2 minutes for 15 minutes", async () => {
    // Set up a "freshly redeemed" session: the DB row carries the
    // bumped 24h hard cap, and the cookie's `act` matches "just now".
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    let nowMs = start;
    jest.spyOn(Date, "now").mockImplementation(() => nowMs);

    const svc = WebSessionService.getInstance();
    const dbExpiresAt = new Date(start + 24 * 60 * 60 * 1000);
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "u-1",
      guildId: "g-1",
      role: "admin",
      scopes: [],
      revokedAt: null,
      expiresAt: dbExpiresAt,
    } as never);

    // Permission revalidation is mocked to always pass — we're not
    // exercising the permission path here.
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: async () => true,
    } as never);

    const middleware = createSessionMiddleware({} as Client);

    let cookieValue = buildCookie({
      sid: "session-id",
      uid: "u-1",
      gid: "g-1",
      rol: "admin",
      iat: start,
      act: start,
    });

    // Drive 8 requests spaced 2 minutes apart (covers 14 min of clock
    // time — well past the 10-minute pre-fix logout, and beyond the
    // 10-minute inactivity window itself if the cookie weren't bumped).
    for (let i = 0; i < 8; i++) {
      nowMs = start + i * 2 * 60 * 1000;

      const req = {
        headers: { cookie: `koolbot_session=${cookieValue}` },
        method: i % 2 === 0 ? "GET" : "POST",
      } as unknown as AuthenticatedRequest;
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await middleware(req, res as unknown as Response, next);

      expect(res.statusCode).toBe(200);
      expect(next).toHaveBeenCalledTimes(1);
      expect(req.webSession).toBeDefined();

      // The middleware must always re-issue the cookie with a fresh
      // `act` so the inactivity window slides on every request.
      const signed = extractCookieValue(res.headers["set-cookie"]);
      expect(signed).not.toBeNull();
      const payload = decodePayload(signed as string);
      expect(payload.act).toBe(nowMs);

      cookieValue = signed as string;
    }
  });
});
