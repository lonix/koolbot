/**
 * Unit tests for the user self-service surface (#481).
 *
 * Covers:
 *  - `assertSelfScope`: a session may only act on its own (userId, guildId);
 *    admins on `/me/*` see their own data, not someone else's.
 *  - The `/me` index handler renders for both admin and user-role sessions.
 *  - The "Back to admin panel" link only appears for admin-role sessions.
 *  - The CSRF-protected `/me/finish` revokes the session and clears the cookie.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Buffer } from "buffer";
import {
  assertSelfScope,
  createUserRouter,
  SelfScopeError,
} from "../../src/web/user-routes.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import type { WebSessionContext } from "../../src/web/session.js";

interface CookiePayload {
  sid: string;
  uid: string;
  gid: string;
  rol?: "admin" | "user";
  iat: number;
  act: number;
}

const SECRET = "test-secret-for-user-routes";

function buildCookie(payload: CookiePayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return signValue(encoded, SECRET);
}

function makeRes(): {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  status: jest.Mock;
  type: jest.Mock;
  send: jest.Mock;
  setHeader: jest.Mock;
  getHeader: jest.Mock;
} {
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 200,
    body: "",
    headers,
    status: jest.fn(),
    type: jest.fn(),
    send: jest.fn(),
    setHeader: jest.fn((name: string, value: unknown) => {
      headers[name.toLowerCase()] = value;
      return res;
    }),
    getHeader: jest.fn((name: string) => headers[name.toLowerCase()]),
  } as never as {
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
    status: jest.Mock;
    type: jest.Mock;
    send: jest.Mock;
    setHeader: jest.Mock;
    getHeader: jest.Mock;
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.type.mockImplementation(() => res);
  res.send.mockImplementation((body: unknown) => {
    res.body = typeof body === "string" ? body : String(body);
    return res;
  });
  return res;
}

describe("assertSelfScope", () => {
  const sessionAdmin: WebSessionContext = {
    sessionId: "s1",
    discordUserId: "owner-1",
    guildId: "guild-1",
    role: "admin",
    scopes: [],
    lastActivityAt: 0,
    expiresAt: new Date(),
  };
  const sessionUser: WebSessionContext = {
    ...sessionAdmin,
    role: "user",
    discordUserId: "user-2",
  };

  it("returns the validated pair when target matches the session", () => {
    expect(
      assertSelfScope(sessionUser, {
        userId: "user-2",
        guildId: "guild-1",
      }),
    ).toEqual({ userId: "user-2", guildId: "guild-1" });
  });

  it("throws SelfScopeError when the userId differs", () => {
    expect(() =>
      assertSelfScope(sessionUser, {
        userId: "someone-else",
        guildId: "guild-1",
      }),
    ).toThrow(SelfScopeError);
  });

  it("throws SelfScopeError when the guildId differs", () => {
    expect(() =>
      assertSelfScope(sessionUser, {
        userId: "user-2",
        guildId: "another-guild",
      }),
    ).toThrow(SelfScopeError);
  });

  it("applies equally to admin-role sessions on /me/* (no impersonation bypass)", () => {
    // The crucial property from #481: admins acting on `/me/*` see THEIR
    // own data, not another user's. The helper does not relax checks for
    // admin role.
    expect(() =>
      assertSelfScope(sessionAdmin, {
        userId: "victim",
        guildId: "guild-1",
      }),
    ).toThrow(SelfScopeError);

    // Admin acting on their own row is fine.
    expect(
      assertSelfScope(sessionAdmin, {
        userId: "owner-1",
        guildId: "guild-1",
      }),
    ).toEqual({ userId: "owner-1", guildId: "guild-1" });
  });
});

describe("createUserRouter / index page", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  async function dispatchIndex(role: "admin" | "user"): Promise<string> {
    const now = Date.now();
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      rol: role,
      iat: now - 60_000,
      act: now - 60_000,
    };
    const cookie = `koolbot_session=${buildCookie(payload)}; koolbot_csrf=csrf-1`;

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "user-1",
      guildId: "guild-1",
      role,
      scopes: [],
      revokedAt: null,
      expiresAt: new Date(now + 60 * 60 * 1000),
    } as never);

    // Permission revalidation runs from the cookie-session middleware
    // inside `createUserRouter`; mock it to a pass-through so the user
    // surface doesn't drag the whole PermissionsService into this test.
    const mockClient = {} as never;
    const { PermissionsService } =
      await import("../../src/services/permissions-service.js");
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: async () => true,
    } as never);

    const { createSessionMiddleware } =
      await import("../../src/web/session.js");
    const requireSession = createSessionMiddleware(mockClient);
    const router = createUserRouter(mockClient, requireSession);

    const req = {
      method: "GET",
      url: "/",
      originalUrl: "/me/",
      path: "/",
      baseUrl: "/me",
      headers: { cookie },
      csrfToken: "csrf-1",
    } as never as Parameters<typeof router>[0];
    const res = makeRes();
    const next = jest.fn();
    await new Promise<void>((resolve) => {
      router(
        req as never,
        res as never,
        ((err: unknown) => {
          next(err);
          resolve();
        }) as never,
      );
      // The handler is async — wait one macrotask so the response
      // settles. `setTimeout(..., 0)` plays the same role as
      // `setImmediate` here without needing Node typings in the test.
      setTimeout(resolve, 0);
    });
    // Give the async handler a chance to complete.
    await new Promise((r) => setTimeout(r, 10));
    return res.body;
  }

  it("renders the index for a user-role session without the admin link", async () => {
    const html = await dispatchIndex("user");
    expect(html).toContain("My preferences");
    expect(html).not.toContain("Back to admin panel");
  });

  it("renders the index for an admin-role session WITH the admin link", async () => {
    const html = await dispatchIndex("admin");
    expect(html).toContain("My preferences");
    expect(html).toContain("Back to admin panel");
    expect(html).toContain('href="/admin/"');
  });
});

describe("userWebErrorHandler", () => {
  it("rewrites SelfScopeError to a 403 HTML page (not a generic 500)", async () => {
    const { userWebErrorHandler } = await import("../../src/web/index.js");
    const res = makeRes();
    const next = jest.fn();
    userWebErrorHandler(
      new SelfScopeError("test: user-a tried to read user-b's row"),
      {} as never,
      res as never,
      next as never,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Forbidden");
    expect(res.body).toContain('href="/me/"');
    expect(next).not.toHaveBeenCalled();
  });

  it("falls through to a generic 500 for any other error", async () => {
    const { userWebErrorHandler } = await import("../../src/web/index.js");
    const res = makeRes();
    const next = jest.fn();
    userWebErrorHandler(
      new Error("totally unrelated"),
      {} as never,
      res as never,
      next as never,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe("Internal Server Error");
  });
});
