/**
 * `/me` scopes (#1316): the session middleware resolves them from role groups
 * on EVERY request, ignores the stored `scopes` column, and fails closed to
 * plain `member`. The guards (`hasScope`, `requireScopeMiddleware`) read only
 * what the middleware attached.
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
  hasScope,
  requireScopeMiddleware,
  type AuthenticatedRequest,
  type WebSessionContext,
} from "../../src/web/session.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import type { Response, NextFunction } from "express";

const SECRET = "test-secret-for-session-scopes";
const ORIGINAL_ENV = { ...process.env };
const now = Date.UTC(2026, 0, 1, 12, 0, 0);

function cookieFor(role: "admin" | "user"): string {
  const payload = {
    sid: "session-id",
    uid: "u-1",
    gid: "g-1",
    rol: role,
    iat: now,
    act: now,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return signValue(encoded, SECRET);
}

interface FakeRes {
  statusCode: number;
  body: string;
  status: jest.Mock;
  type: jest.Mock;
  send: jest.Mock;
  setHeader: jest.Mock;
  getHeader: jest.Mock;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: "",
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
  res.send.mockImplementation((b: unknown) => {
    res.body = String(b);
    return res;
  });
  res.setHeader.mockImplementation(() => res);
  return res;
}

function makeReq(role: "admin" | "user"): AuthenticatedRequest {
  return {
    headers: { cookie: `koolbot_session=${cookieFor(role)}` },
    method: "GET",
  } as unknown as AuthenticatedRequest;
}

/** Run the real middleware once and return what it attached. */
async function run(
  role: "admin" | "user",
): Promise<{ req: AuthenticatedRequest; res: FakeRes; next: jest.Mock }> {
  const req = makeReq(role);
  const res = makeRes();
  const next = jest.fn();
  await createSessionMiddleware({} as Client)(
    req,
    res as unknown as Response,
    next as unknown as NextFunction,
  );
  return { req, res, next };
}

describe("session middleware scope resolution (#1316)", () => {
  let storedRole: "admin" | "user";
  let storedScopes: string[];
  let resolveWebScopes: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
  let isAdministrator: jest.Mock<() => Promise<boolean>>;

  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    storedRole = "user";
    storedScopes = [];
    jest
      .spyOn(WebSessionService.getInstance(), "findById")
      .mockImplementation((async () => ({
        discordUserId: "u-1",
        guildId: "g-1",
        role: storedRole,
        scopes: storedScopes,
        revokedAt: null,
        expiresAt: new Date(now + 24 * 60 * 60 * 1000),
      })) as never);
    resolveWebScopes = jest.fn(async () => ["member"]);
    isAdministrator = jest.fn(async () => true);
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: async () => true,
      isAdministrator,
      resolveWebScopes,
    } as never);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  const combos: Array<[string, string[], string[]]> = [
    ["member only", ["member"], ["member"]],
    ["host only", ["member", "host"], ["member", "host"]],
    ["moderator only", ["member", "moderator"], ["member", "moderator"]],
    [
      "host and moderator",
      ["member", "host", "moderator"],
      ["member", "host", "moderator"],
    ],
  ];

  it.each(combos)("a user session with %s", async (_n, resolved, expected) => {
    resolveWebScopes.mockResolvedValue(resolved);
    const { req, next } = await run("user");
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.webSession?.role).toBe("user");
    expect(req.webSession?.scopes).toEqual(expected);
    expect(resolveWebScopes).toHaveBeenCalledWith("u-1", "g-1");
  });

  it("never trusts the stored scopes column", async () => {
    storedScopes = ["host", "moderator", "admin"];
    resolveWebScopes.mockResolvedValue(["member"]);
    const { req } = await run("user");
    expect(req.webSession?.scopes).toEqual(["member"]);
    expect(hasScope(req.webSession, "host")).toBe(false);
    expect(hasScope(req.webSession, "moderator")).toBe(false);
  });

  it("resolves on every request: removal from the group takes effect on the next one", async () => {
    resolveWebScopes
      .mockResolvedValueOnce(["member", "host"])
      .mockResolvedValueOnce(["member"]);
    const first = await run("user");
    expect(hasScope(first.req.webSession, "host")).toBe(true);
    const second = await run("user");
    expect(hasScope(second.req.webSession, "host")).toBe(false);
    expect(resolveWebScopes).toHaveBeenCalledTimes(2);
  });

  it("fails closed to member when the resolution throws", async () => {
    resolveWebScopes.mockRejectedValue(new Error("discord down"));
    const { req, next, res } = await run("user");
    // The request itself is still served: the `me` check passed.
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(req.webSession?.scopes).toEqual(["member"]);
  });

  it("fails closed to member when the permissions service cannot resolve at all", async () => {
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: async () => true,
    } as never);
    const { req, next } = await run("user");
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.webSession?.scopes).toEqual(["member"]);
  });

  it("drops anything that is not a known scope, and never accepts admin as a scope", async () => {
    resolveWebScopes.mockResolvedValue(["admin", "root", 7, "host"]);
    const { req } = await run("user");
    expect(req.webSession?.scopes).toEqual(["member", "host"]);
    resolveWebScopes.mockResolvedValue("host");
    const second = await run("user");
    expect(second.req.webSession?.scopes).toEqual(["member"]);
  });

  it("gives an admin session every scope without a member lookup, and keeps role admin", async () => {
    storedRole = "admin";
    const { req, next } = await run("admin");
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.webSession?.role).toBe("admin");
    expect(req.webSession?.scopes).toEqual(["member", "host", "moderator"]);
    expect(resolveWebScopes).not.toHaveBeenCalled();
  });

  it("a host or moderator scope never turns a user session into an admin session", async () => {
    resolveWebScopes.mockResolvedValue(["member", "host", "moderator"]);
    isAdministrator.mockResolvedValue(false);
    const { req } = await run("user");
    expect(req.webSession?.role).toBe("user");
    expect(isAdministrator).not.toHaveBeenCalled();
  });
});

describe("hasScope and requireScopeMiddleware (#1316)", () => {
  const base: WebSessionContext = {
    sessionId: "s",
    discordUserId: "u",
    guildId: "g",
    role: "user",
    scopes: ["member"],
    lastActivityAt: 0,
    expiresAt: new Date(),
  };

  it("a user needs the scope; an admin session holds every scope", () => {
    expect(hasScope(base, "host")).toBe(false);
    expect(hasScope({ ...base, scopes: ["member", "host"] }, "host")).toBe(
      true,
    );
    expect(hasScope({ ...base, scopes: ["member", "host"] }, "moderator")).toBe(
      false,
    );
    expect(hasScope({ ...base, role: "admin", scopes: [] }, "moderator")).toBe(
      true,
    );
  });

  it("fails closed on a missing session, a malformed scopes value or an unknown role", () => {
    expect(hasScope(null, "host")).toBe(false);
    expect(hasScope(undefined, "host")).toBe(false);
    expect(hasScope({ role: "user", scopes: undefined } as never, "host")).toBe(
      false,
    );
    expect(hasScope({ role: "user", scopes: "host" } as never, "host")).toBe(
      false,
    );
    expect(hasScope({ role: "root", scopes: ["host"] } as never, "host")).toBe(
      false,
    );
  });

  function guard(
    scope: "host" | "moderator",
    session: Partial<WebSessionContext> | null,
  ): { status: number; next: jest.Mock } {
    const res = makeRes();
    const next = jest.fn();
    requireScopeMiddleware(scope)(
      (session ? { webSession: { ...base, ...session } } : {}) as never,
      res as never,
      next as never,
    );
    return { status: res.statusCode, next };
  }

  it("lets a session with the scope through and refuses one without it", () => {
    expect(
      guard("host", { scopes: ["member", "host"] }).next,
    ).toHaveBeenCalled();
    const denied = guard("host", { scopes: ["member", "moderator"] });
    expect(denied.status).toBe(403);
    expect(denied.next).not.toHaveBeenCalled();
    expect(
      guard("moderator", { scopes: ["member", "moderator"] }).next,
    ).toHaveBeenCalled();
    const deniedMod = guard("moderator", { scopes: ["member", "host"] });
    expect(deniedMod.status).toBe(403);
    expect(deniedMod.next).not.toHaveBeenCalled();
  });

  it("admits an admin session and answers 401 when no session was attached", () => {
    expect(
      guard("moderator", { role: "admin", scopes: [] }).next,
    ).toHaveBeenCalled();
    const none = guard("host", null);
    expect(none.status).toBe(401);
    expect(none.next).not.toHaveBeenCalled();
  });
});
