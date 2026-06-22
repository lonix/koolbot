/**
 * Unit tests for `createSessionPingHandler` (#435).
 *
 * Mocks `WebSessionService.findById` so we can drive the handler without
 * a real Mongo connection, and constructs a real signed cookie via the
 * same helpers the production code uses so the cookie-parsing path is
 * exercised end-to-end.
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
import { createSessionPingHandler } from "../../src/web/session.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "test-secret-for-session-ping-tests";

interface CookiePayload {
  sid: string;
  uid: string;
  gid: string;
  iat: number;
  act: number;
}

function buildCookie(payload: CookiePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return signValue(encoded, SECRET);
}

interface MockResponse {
  statusCode: number;
  body: unknown;
  status: jest.Mock;
  json: jest.Mock;
  getHeader: jest.Mock;
  setHeader: jest.Mock;
  headers: Record<string, unknown>;
}

function makeRes(): MockResponse {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status: jest.fn(),
    json: jest.fn(),
    getHeader: jest.fn(),
    setHeader: jest.fn(),
  } as MockResponse;
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json.mockImplementation((data: unknown) => {
    res.body = data;
    return res;
  });
  res.getHeader.mockImplementation(
    (name: string) => res.headers[name.toLowerCase()],
  );
  res.setHeader.mockImplementation((name: string, value: unknown) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  });
  return res;
}

function makeReq(cookie?: string): {
  headers: { cookie?: string };
} {
  return cookie ? { headers: { cookie } } : { headers: {} };
}

describe("createSessionPingHandler", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    // Reset the singleton so the mocked findById on each test doesn't
    // leak into the next.
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  it("returns remainingMs and expiresAt for a live session, without bumping `act`", async () => {
    const now = Date.now();
    const act = now - 5 * 60 * 1000; // 5 min ago
    const expiresAt = new Date(now + 60 * 60 * 1000); // 1h in future
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      iat: now - 10 * 60 * 1000,
      act,
    };
    const cookie = `koolbot_session=${buildCookie(payload)}`;

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "user-1",
      guildId: "guild-1",
      scopes: [],
      revokedAt: null,
      expiresAt,
    } as unknown as never);

    const req = makeReq(cookie);
    const res = makeRes();
    const next = jest.fn();
    await createSessionPingHandler()(req as never, res as never, next as never);

    expect(res.statusCode).toBe(200);
    expect(next).not.toHaveBeenCalled();
    const body = res.body as { remainingMs: number; expiresAt: string };
    expect(typeof body.remainingMs).toBe("number");
    // Inactivity is 30min; `act` was 5min ago, so ~25min remain there.
    // The hard cap is 60min, so the inactivity number is the bound.
    expect(body.remainingMs).toBeGreaterThan(24 * 60 * 1000);
    expect(body.remainingMs).toBeLessThanOrEqual(25 * 60 * 1000);
    expect(body.expiresAt).toBe(expiresAt.toISOString());

    // The crucial property from the issue's acceptance criteria:
    // the ping must NOT rewrite the session cookie / bump `act`.
    expect(res.headers["set-cookie"]).toBeUndefined();

    // Per-session payload — should never be cached by intermediaries.
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("sets Cache-Control: no-store on the 401 path too", async () => {
    const res = makeRes();
    await createSessionPingHandler()(
      makeReq() as never,
      res as never,
      jest.fn() as never,
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("honours the server's hard cap when it ends before the inactivity window", async () => {
    const now = Date.now();
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      iat: now - 60_000,
      act: now - 60_000, // 1 min ago
    };
    const expiresAt = new Date(now + 3 * 60 * 1000); // 3 min hard cap
    const cookie = `koolbot_session=${buildCookie(payload)}`;

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "user-1",
      guildId: "guild-1",
      scopes: [],
      revokedAt: null,
      expiresAt,
    } as unknown as never);

    const res = makeRes();
    await createSessionPingHandler()(
      makeReq(cookie) as never,
      res as never,
      jest.fn() as never,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { remainingMs: number };
    // Capped by the 3-min hardCap, NOT the 29-min inactivity remainder.
    expect(body.remainingMs).toBeLessThanOrEqual(3 * 60 * 1000);
    expect(body.remainingMs).toBeGreaterThan(2 * 60 * 1000);
  });

  it("returns 401 when no cookie is present", async () => {
    const res = makeRes();
    await createSessionPingHandler()(
      makeReq() as never,
      res as never,
      jest.fn() as never,
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("returns 401 when the inactivity window has elapsed", async () => {
    const now = Date.now();
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      iat: now - 60 * 60 * 1000,
      act: now - 31 * 60 * 1000, // 31 min ago; default window is 30 min
    };
    const cookie = `koolbot_session=${buildCookie(payload)}`;

    const svc = WebSessionService.getInstance();
    const findById = jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "user-1",
      guildId: "guild-1",
      scopes: [],
      revokedAt: null,
      expiresAt: new Date(now + 60 * 60 * 1000),
    } as unknown as never);

    const res = makeRes();
    await createSessionPingHandler()(
      makeReq(cookie) as never,
      res as never,
      jest.fn() as never,
    );

    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    // The handler returns 401 from the cookie-level check before reaching
    // the DB; either way, no Set-Cookie is emitted.
    findById.mockRestore();
  });

  it("returns 401 when the DB session is revoked", async () => {
    const now = Date.now();
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      iat: now - 60_000,
      act: now - 60_000,
    };
    const cookie = `koolbot_session=${buildCookie(payload)}`;

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "user-1",
      guildId: "guild-1",
      scopes: [],
      revokedAt: new Date(),
      expiresAt: new Date(now + 60 * 60 * 1000),
    } as unknown as never);

    const res = makeRes();
    await createSessionPingHandler()(
      makeReq(cookie) as never,
      res as never,
      jest.fn() as never,
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("returns 401 when the DB session has expired (hard cap passed)", async () => {
    const now = Date.now();
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      iat: now - 60_000,
      act: now - 60_000,
    };
    const cookie = `koolbot_session=${buildCookie(payload)}`;

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "user-1",
      guildId: "guild-1",
      scopes: [],
      revokedAt: null,
      expiresAt: new Date(now - 1000),
    } as unknown as never);

    const res = makeRes();
    await createSessionPingHandler()(
      makeReq(cookie) as never,
      res as never,
      jest.fn() as never,
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("returns 401 when the cookie payload's uid/gid don't match the DB row", async () => {
    const now = Date.now();
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      iat: now - 60_000,
      act: now - 60_000,
    };
    const cookie = `koolbot_session=${buildCookie(payload)}`;

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "user-OTHER",
      guildId: "guild-1",
      scopes: [],
      revokedAt: null,
      expiresAt: new Date(now + 60 * 60 * 1000),
    } as unknown as never);

    const res = makeRes();
    await createSessionPingHandler()(
      makeReq(cookie) as never,
      res as never,
      jest.fn() as never,
    );
    expect(res.statusCode).toBe(401);
  });

  it("forwards unexpected errors to the Express error pipeline", async () => {
    const now = Date.now();
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      iat: now - 60_000,
      act: now - 60_000,
    };
    const cookie = `koolbot_session=${buildCookie(payload)}`;

    const svc = WebSessionService.getInstance();
    jest
      .spyOn(svc, "findById")
      .mockRejectedValue(new Error("mongo exploded") as never);

    const next = jest.fn();
    const res = makeRes();
    await createSessionPingHandler()(
      makeReq(cookie) as never,
      res as never,
      next as never,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
