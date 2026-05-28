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

describe("/me/notifications", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  async function dispatch(opts: {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
    csrfHeader?: string;
    csrfCookie?: string;
    prefs?: { achievements: boolean; digest: boolean; rewind: boolean };
    setPrefsImpl?: jest.Mock;
    role?: "admin" | "user";
  }): Promise<{
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
    redirectedTo?: string;
  }> {
    const now = Date.now();
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      rol: opts.role ?? "user",
      iat: now - 60_000,
      act: now - 60_000,
    };
    const csrfCookie = opts.csrfCookie ?? "csrf-1";
    const cookie = `koolbot_session=${buildCookie(payload)}; koolbot_csrf=${csrfCookie}`;

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "user-1",
      guildId: "guild-1",
      role: opts.role ?? "user",
      scopes: [],
      revokedAt: null,
      expiresAt: new Date(now + 60 * 60 * 1000),
    } as never);
    jest.spyOn(svc, "revokeSession").mockResolvedValue(true);

    const { PermissionsService } =
      await import("../../src/services/permissions-service.js");
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: async () => true,
    } as never);

    const { UserNotificationPrefsService } =
      await import("../../src/services/user-notification-prefs-service.js");
    const getPrefs = jest
      .fn<() => Promise<{ achievements: boolean; digest: boolean; rewind: boolean }>>()
      .mockResolvedValue(
        opts.prefs ?? { achievements: true, digest: true, rewind: true },
      );
    const setPrefs =
      opts.setPrefsImpl ??
      jest
        .fn<
          (
            userId: string,
            guildId: string,
            patch: Record<string, boolean>,
          ) => Promise<{ achievements: boolean; digest: boolean; rewind: boolean }>
        >()
        .mockImplementation(async (_u, _g, patch) => ({
          achievements: true,
          digest: true,
          rewind: true,
          ...patch,
        }));
    jest.spyOn(UserNotificationPrefsService, "getInstance").mockReturnValue({
      getPrefs,
      setPrefs,
    } as never);

    const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
    jest.spyOn(WebAuditLog, "create").mockResolvedValue({} as never);

    const mockClient = {} as never;
    const { createSessionMiddleware } =
      await import("../../src/web/session.js");
    const requireSession = createSessionMiddleware(mockClient);
    const router = createUserRouter(mockClient, requireSession);

    const headers: Record<string, unknown> = { cookie };
    if (opts.method === "POST" && opts.csrfHeader) {
      headers["x-csrf-token"] = opts.csrfHeader;
    }

    const captured: {
      statusCode: number;
      body: string;
      headers: Record<string, unknown>;
      redirectedTo?: string;
    } = {
      statusCode: 200,
      body: "",
      headers: {},
    };
    const res = {
      ...makeRes(),
    } as ReturnType<typeof makeRes> & {
      redirect: jest.Mock;
      header: jest.Mock;
    };
    res.status.mockImplementation((code: number) => {
      captured.statusCode = code;
      res.statusCode = code;
      return res;
    });
    res.send.mockImplementation((body: unknown) => {
      captured.body = typeof body === "string" ? body : String(body);
      res.body = captured.body;
      return res;
    });
    res.setHeader.mockImplementation((name: string, value: unknown) => {
      captured.headers[name.toLowerCase()] = value;
      return res;
    });
    res.redirect = jest.fn((code: unknown, url?: unknown) => {
      if (typeof code === "number") {
        captured.statusCode = code;
        captured.redirectedTo = String(url);
      } else {
        captured.statusCode = 302;
        captured.redirectedTo = String(code);
      }
      return res;
    });
    res.header = jest.fn(() => res);

    const req = {
      method: opts.method,
      url: opts.method === "POST" ? "/notifications" : "/notifications",
      originalUrl:
        opts.method === "POST" ? "/me/notifications" : "/me/notifications",
      path: "/notifications",
      baseUrl: "/me",
      headers,
      body: opts.body ?? {},
      query: {},
      csrfToken: "csrf-1",
      header: (name: string) => headers[name.toLowerCase()],
    } as never as Parameters<typeof router>[0];

    await new Promise<void>((resolve) => {
      router(
        req as never,
        res as never,
        (() => {
          resolve();
        }) as never,
      );
      setTimeout(resolve, 0);
    });
    await new Promise((r) => setTimeout(r, 10));
    return captured;
  }

  it("renders the notifications form for a user-role session", async () => {
    const out = await dispatch({ method: "GET" });
    expect(out.body).toContain("Notifications");
    expect(out.body).toContain('action="/me/notifications"');
    expect(out.body).toContain('name="achievements"');
    expect(out.body).toContain('name="digest"');
    expect(out.body).toContain('name="rewind"');
    // All checkboxes should be `checked` when prefs default to enabled.
    expect(out.body).toContain(
      'name="achievements" value="true" checked',
    );
  });

  it("no longer renders 'coming soon' hints for digest or rewind (both shipped)", async () => {
    const out = await dispatch({ method: "GET" });
    expect(out.body).not.toContain("#483");
    expect(out.body).not.toContain("#484");
    // The `pref-soon` style is still defined in the layout CSS for
    // future rows; assert no row actually uses it.
    expect(out.body).not.toContain('<span class="pref-soon">');
  });

  it("renders unchecked when stored prefs are off", async () => {
    const out = await dispatch({
      method: "GET",
      prefs: { achievements: false, digest: true, rewind: false },
    });
    // achievements unchecked, digest checked
    expect(out.body).toContain('name="achievements" value="true">');
    expect(out.body).toContain('name="digest" value="true" checked');
    expect(out.body).toContain('name="rewind" value="true">');
  });

  it("rejects POST without a CSRF token", async () => {
    const out = await dispatch({
      method: "POST",
      body: { submitted_achievements: "1" },
      // no csrfHeader, no _csrf in body
    });
    expect(out.statusCode).toBe(403);
  });

  it("treats checkbox absence as 'off' when the hidden submitted flag is present", async () => {
    let captured: { patch: Record<string, boolean>; user: string; guild: string } | null = null;
    const setPrefs = jest
      .fn<
        (
          userId: string,
          guildId: string,
          patch: Record<string, boolean>,
        ) => Promise<{ achievements: boolean; digest: boolean; rewind: boolean }>
      >()
      .mockImplementation(async (user, guild, patch) => {
        captured = { user, guild, patch };
        return {
          achievements: patch.achievements ?? true,
          digest: patch.digest ?? true,
          rewind: patch.rewind ?? true,
        };
      });

    const out = await dispatch({
      method: "POST",
      body: {
        _csrf: "csrf-1",
        // Only the achievements row was submitted, and the checkbox is
        // absent (= unchecked).
        submitted_achievements: "1",
      },
      csrfHeader: "csrf-1",
      setPrefsImpl: setPrefs,
    });
    expect(out.statusCode).toBe(303);
    expect(out.redirectedTo).toMatch(/^\/me\/notifications\?/);
    expect(setPrefs).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    expect(captured!.user).toBe("user-1");
    expect(captured!.guild).toBe("guild-1");
    expect(captured!.patch).toEqual({ achievements: false });
  });

  it("records a WebAuditLog row with role:'user' on successful save", async () => {
    const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
    const out = await dispatch({
      method: "POST",
      body: {
        _csrf: "csrf-1",
        submitted_achievements: "1",
        achievements: "true",
      },
      csrfHeader: "csrf-1",
    });
    expect(out.statusCode).toBe(303);
    expect(WebAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user.notifications.set",
        role: "user",
        discordUserId: "user-1",
        guildId: "guild-1",
        result: "success",
      }),
    );
  });

  it("records role:'admin' when an admin toggles their own prefs", async () => {
    const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
    const out = await dispatch({
      method: "POST",
      role: "admin",
      body: {
        _csrf: "csrf-1",
        submitted_achievements: "1",
        achievements: "true",
      },
      csrfHeader: "csrf-1",
    });
    expect(out.statusCode).toBe(303);
    expect(WebAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user.notifications.set",
        role: "admin",
      }),
    );
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

describe("/me/rewind", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  async function dispatchRewind(opts: {
    pathSuffix: string; // "" for "/rewind", "/2024" for "/rewind/2024"
    summary: unknown; // What RewindService.getInstance(...).getSummary should resolve to
  }): Promise<{ statusCode: number; body: string }> {
    const now = Date.now();
    const payload: CookiePayload = {
      sid: "session-id",
      uid: "user-1",
      gid: "guild-1",
      rol: "user",
      iat: now - 60_000,
      act: now - 60_000,
    };
    const cookie = `koolbot_session=${buildCookie(payload)}; koolbot_csrf=csrf-1`;

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "findById").mockResolvedValue({
      discordUserId: "user-1",
      guildId: "guild-1",
      role: "user",
      scopes: [],
      revokedAt: null,
      expiresAt: new Date(now + 60 * 60 * 1000),
    } as never);

    const { PermissionsService } =
      await import("../../src/services/permissions-service.js");
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: async () => true,
    } as never);

    const { RewindService } =
      await import("../../src/services/rewind-service.js");
    const getSummary = jest.fn().mockResolvedValue(opts.summary as never);
    jest.spyOn(RewindService, "getInstance").mockReturnValue({
      getSummary,
    } as never);

    const mockClient = {} as never;
    const { createSessionMiddleware } =
      await import("../../src/web/session.js");
    const requireSession = createSessionMiddleware(mockClient);
    const router = createUserRouter(mockClient, requireSession);

    const path = `/rewind${opts.pathSuffix}`;
    const req = {
      method: "GET",
      url: path,
      originalUrl: `/me${path}`,
      path,
      baseUrl: "/me",
      headers: { cookie },
      query: {},
      csrfToken: "csrf-1",
      header: (name: string) => (name === "cookie" ? cookie : undefined),
    } as never as Parameters<typeof router>[0];
    const res = makeRes();
    await new Promise<void>((resolve) => {
      router(
        req as never,
        res as never,
        (() => resolve()) as never,
      );
      setTimeout(resolve, 0);
    });
    await new Promise((r) => setTimeout(r, 10));
    return { statusCode: res.statusCode, body: res.body };
  }

  function makeSummary(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      userId: "user-1",
      guildId: "guild-1",
      year: 2026,
      hasData: true,
      totalSeconds: 3600 * 12,
      sessionCount: 8,
      daysActive: 5,
      topChannels: [
        { channelId: "c1", channelName: "general-vc", totalSeconds: 3600 * 6 },
        { channelId: "c2", channelName: "gaming", totalSeconds: 3600 * 4 },
        { channelId: "c3", channelName: "afk", totalSeconds: 3600 * 2 },
      ],
      peakDay: { date: "2026-03-15", totalSeconds: 3600 * 3 },
      longestStreakDays: 4,
      longestStreakRange: { startDate: "2026-03-12", endDate: "2026-03-15" },
      accolades: [],
      achievements: [],
      annualRank: 7,
      annualGuildMembers: 42,
      percentAboveMedian: 30,
      weeklyJourney: { first: null, last: null, best: null },
      availableYears: [2026, 2025],
      ...overrides,
    };
  }

  it("renders the current-year rewind page", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary({ year: new Date().getUTCFullYear() }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("Rewind");
    expect(out.body).toContain("general-vc");
    expect(out.body).toContain("12 hr"); // formatHoursMinutes(3600 * 12)
    expect(out.body).toContain("#7"); // annual rank
    expect(out.body).toContain("+30%"); // median delta
  });

  it("renders a specific past year when the route param is present", async () => {
    const out = await dispatchRewind({
      pathSuffix: "/2024",
      summary: makeSummary({ year: 2024 }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("Rewind 2024");
  });

  it("renders the empty-state body when the user has no data", async () => {
    const out = await dispatchRewind({
      pathSuffix: "/2023",
      summary: makeSummary({
        year: 2023,
        hasData: false,
        totalSeconds: 0,
        sessionCount: 0,
        daysActive: 0,
        topChannels: [],
        peakDay: null,
        longestStreakDays: 0,
        longestStreakRange: null,
        annualRank: null,
        percentAboveMedian: null,
        availableYears: [2026, 2025],
      }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("Nothing to recap yet");
  });

  it("falls back to the current year for a junk year param", async () => {
    const out = await dispatchRewind({
      pathSuffix: "/not-a-year",
      summary: makeSummary({ year: new Date().getUTCFullYear() }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain(`Rewind ${new Date().getUTCFullYear()}`);
  });

  it("returns 500 with a friendly notice when the service yields null", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: null,
    });
    expect(out.statusCode).toBe(500);
    expect(out.body).toContain("Could not load your year-in-review");
  });
});
