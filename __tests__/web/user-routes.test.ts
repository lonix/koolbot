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

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
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

  // Turn the poll-participation feature gate on (other `/me/` gates left at
  // their default-off). The real ConfigService is used here, so spy its
  // singleton to flip just the one key.
  async function enablePollParticipationGate(): Promise<void> {
    const { ConfigService } = await import(
      "../../src/services/config-service.js"
    );
    jest.spyOn(ConfigService, "getInstance").mockReturnValue({
      getBoolean: async (key: string) => key === "polls.participation.enabled",
    } as never);
  }

  it("renders the poll-participation card when the member has a tracking row (#655)", async () => {
    await enablePollParticipationGate();
    const { PollParticipationTracker } = await import(
      "../../src/services/poll-participation-tracker.js"
    );
    jest.spyOn(PollParticipationTracker, "getInstance").mockReturnValue({
      getParticipationSummary: async () => ({
        totalVotes: 42,
        thisYearVotes: 9,
        lastVoteAt: new Date("2026-03-04T00:00:00Z"),
      }),
    } as never);

    const html = await dispatchIndex("user");
    expect(html).toContain("Poll participation");
    expect(html).toContain("Votes cast (all time)");
    expect(html).toContain("42");
    expect(html).toContain("2026-03-04");
  });

  it("omits the poll-participation card when the member has never voted (#655)", async () => {
    await enablePollParticipationGate();
    const { PollParticipationTracker } = await import(
      "../../src/services/poll-participation-tracker.js"
    );
    jest.spyOn(PollParticipationTracker, "getInstance").mockReturnValue({
      getParticipationSummary: async () => null,
    } as never);

    const html = await dispatchIndex("user");
    expect(html).toContain("My preferences");
    expect(html).not.toContain("Poll participation");
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
      .fn<
        () => Promise<{
          achievements: boolean;
          digest: boolean;
          rewind: boolean;
        }>
      >()
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
          ) => Promise<{
            achievements: boolean;
            digest: boolean;
            rewind: boolean;
          }>
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
    expect(out.body).toContain('name="achievements" value="true" checked');
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
    let captured: {
      patch: Record<string, boolean>;
      user: string;
      guild: string;
    } | null = null;
    const setPrefs = jest
      .fn<
        (
          userId: string,
          guildId: string,
          patch: Record<string, boolean>,
        ) => Promise<{
          achievements: boolean;
          digest: boolean;
          rewind: boolean;
        }>
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

  // `dispatchRewind` installs spies (notably on `ConfigService.getInstance`)
  // that would otherwise persist into later describe blocks — e.g.
  // `/me/timezone`, which also reads `rewind.enabled` — and make test order
  // matter. Restore after each test so every override is scoped to its own
  // dispatch.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function dispatchRewind(opts: {
    pathSuffix: string; // "" for "/rewind", "/2024" for "/rewind/2024"
    summary: unknown; // What RewindService.getInstance(...).getSummary should resolve to
    defaultYear?: number; // What getDefaultRewindYear resolves to (bare route only)
    rewindEnabled?: boolean; // Feature gate `rewind.enabled` (#608); defaults to enabled
  }): Promise<{
    statusCode: number;
    body: string;
    getSummary: jest.Mock;
    getDefaultRewindYear: jest.Mock;
  }> {
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

    const { UserNotificationPrefsService } =
      await import("../../src/services/user-notification-prefs-service.js");
    jest.spyOn(UserNotificationPrefsService, "getInstance").mockReturnValue({
      getTimezone: async () => null,
    } as never);

    const { ConfigService } =
      await import("../../src/services/config-service.js");
    const rewindEnabled = opts.rewindEnabled ?? true;
    jest.spyOn(ConfigService, "getInstance").mockReturnValue({
      getBoolean: async (key: string) =>
        key === "rewind.enabled" ? rewindEnabled : false,
    } as never);

    const { RewindService } =
      await import("../../src/services/rewind-service.js");
    const getSummary = jest.fn().mockResolvedValue(opts.summary as never);
    const getDefaultRewindYear = jest
      .fn()
      .mockResolvedValue(
        (opts.defaultYear ?? new Date().getUTCFullYear()) as never,
      );
    jest.spyOn(RewindService, "getInstance").mockReturnValue({
      getSummary,
      getDefaultRewindYear,
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
      router(req as never, res as never, (() => resolve()) as never);
      setTimeout(resolve, 0);
    });
    await new Promise((r) => setTimeout(r, 10));
    return {
      statusCode: res.statusCode,
      body: res.body,
      getSummary,
      getDefaultRewindYear,
    };
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
      topCompanions: [
        { userId: "u2", displayName: "Companion One", totalSeconds: 3600 * 5 },
      ],
      peakDay: { date: "2026-03-15", totalSeconds: 3600 * 3 },
      longestSession: {
        totalSeconds: 3600 * 6,
        date: "2026-03-14",
        channelId: "c1",
        channelName: "General",
      },
      messagesSent: 0,
      topTextChannels: [],
      peakMessageDay: null,
      reactionsGiven: 0,
      reactionsReceived: 0,
      pollVotesCast: 0,
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
    expect(out.body).toContain("12 hr"); // formatHoursMinutes(3600 * 12)
    expect(out.body).toContain("#7"); // annual rank
    expect(out.body).toContain("+30%"); // median delta
    expect(out.body).toContain("Top voice companions"); // #567 card
    expect(out.body).toContain("Companion One");
    expect(out.body).not.toContain("Top channels"); // removed from Rewind
    expect(out.body).toContain("Longest session"); // #568 card
    expect(out.body).toContain("on 2026-03-14 in General"); // date + channel
  });

  it("renders a specific past year when the route param is present", async () => {
    const out = await dispatchRewind({
      pathSuffix: "/2024",
      summary: makeSummary({ year: 2024 }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("Rewind 2024");
  });

  it("defaults the bare route to the most recent year with data (#573)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      defaultYear: 2025,
      summary: makeSummary({ year: 2025 }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("Rewind 2025");
    // The resolved default year drives the summary build, not the
    // (possibly empty) current year.
    expect(out.getDefaultRewindYear).toHaveBeenCalledWith("user-1", "guild-1");
    expect(out.getSummary).toHaveBeenCalledWith(
      "user-1",
      "guild-1",
      2025,
      null,
    );
  });

  it("does not resolve a default year for the explicit :year route (#573)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "/2024",
      summary: makeSummary({ year: 2024 }),
    });
    expect(out.statusCode).toBe(200);
    // The deep-link honours the requested year directly — the default
    // resolver is never consulted.
    expect(out.getDefaultRewindYear).not.toHaveBeenCalled();
    expect(out.getSummary).toHaveBeenCalledWith(
      "user-1",
      "guild-1",
      2024,
      null,
    );
  });

  it("renders the text-activity card when text data exists (#496)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary({
        messagesSent: 42,
        topTextChannels: [
          { channelId: "t1", channelName: "general-chat", count: 30 },
        ],
        peakMessageDay: { date: "2026-02-01", count: 12 },
      }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("Text activity");
    expect(out.body).toContain("Top text channels");
    expect(out.body).toContain("general-chat");
    expect(out.body).toContain("42"); // messages sent
  });

  it("hides the text-activity card when there is no text data (#496)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary(), // messagesSent defaults to 0
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).not.toContain("Text activity");
  });

  it("renders the reaction-activity block when reaction data exists (#653)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary({ reactionsGiven: 24, reactionsReceived: 9 }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("Reactions");
    expect(out.body).toContain("Reactions given");
    expect(out.body).toContain("24");
    expect(out.body).toContain("Reactions received");
    expect(out.body).toContain("9");
  });

  it("hides the reaction-activity block when both counts are 0 (#653)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary(), // reactions default to 0
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).not.toContain("Reactions given");
  });

  it("renders the activity heatmap with the peak hour/day when data exists (#675)", async () => {
    const hours = new Array(24).fill(0);
    hours[22] = 120; // peak hour: 10 PM
    const days = new Array(7).fill(0);
    days[5] = 200; // peak day: Friday
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary({
        hourOfDayDistribution: hours,
        dayOfWeekDistribution: days,
      }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("When you're online");
    expect(out.body).toContain("Most active:");
    expect(out.body).toContain("Friday");
    expect(out.body).toContain("10 PM");
  });

  it("hides the activity heatmap when all distribution values are 0 (#675)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary({
        hourOfDayDistribution: new Array(24).fill(0),
        dayOfWeekDistribution: new Array(7).fill(0),
      }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).not.toContain("When you're online");
  });

  it("renders the poll-participation stat when votes were cast (#655)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary({ pollVotesCast: 13 }),
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("Poll votes cast");
    expect(out.body).toContain("13");
  });

  it("hides the poll-participation stat when no votes were cast (#655)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary(), // pollVotesCast defaults to 0
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).not.toContain("Poll votes cast");
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
        topCompanions: [],
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

  it("returns a 404 disabled state and does not query data when rewind.enabled is off (#608)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "",
      summary: makeSummary(),
      rewindEnabled: false,
    });
    expect(out.statusCode).toBe(404);
    expect(out.body).toContain("Rewind) feature is currently disabled");
    // The gate short-circuits before any data work.
    expect(out.getSummary).not.toHaveBeenCalled();
    expect(out.getDefaultRewindYear).not.toHaveBeenCalled();
    // And the disabled feature drops out of the page nav.
    expect(out.body).not.toContain('href="/me/rewind"');
  });

  it("gates the explicit :year deep-link too when disabled (#608)", async () => {
    const out = await dispatchRewind({
      pathSuffix: "/2024",
      summary: makeSummary({ year: 2024 }),
      rewindEnabled: false,
    });
    expect(out.statusCode).toBe(404);
    expect(out.getSummary).not.toHaveBeenCalled();
  });
});

describe("/me/voice (#656)", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function dispatch(opts: {
    method: "GET" | "POST";
    url?: string; // path under /me, e.g. "/voice/preset/default"
    body?: Record<string, unknown>;
    csrfHeader?: string;
    presetsEnabled?: boolean;
    prefs?: { namePattern?: string; presets: unknown[] };
    serviceImpl?: Record<string, unknown>;
  }): Promise<{
    statusCode: number;
    body: string;
    redirectedTo?: string;
    audit?: Record<string, unknown>;
  }> {
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

    const presetsEnabled = opts.presetsEnabled ?? true;
    const { ConfigService } =
      await import("../../src/services/config-service.js");
    jest.spyOn(ConfigService, "getInstance").mockReturnValue({
      getBoolean: async (key: string) =>
        key === "voicechannels.presets.enabled" ? presetsEnabled : false,
      getNumber: async () => 3,
    } as never);

    const { UserVoicePrefsService } =
      await import("../../src/services/user-voice-prefs-service.js");
    const defaults = {
      getPrefs: async () =>
        opts.prefs ?? { namePattern: undefined, presets: [] },
      setNamePattern: jest
        .fn<(u: string, raw: string) => Promise<string | null>>()
        .mockImplementation(async (_u, raw) => (raw.trim() === "" ? null : raw.trim())),
      setDefault: jest
        .fn()
        .mockResolvedValue({ name: "Squad", isDefault: true } as never),
      deletePreset: jest
        .fn()
        .mockResolvedValue({ name: "Squad", remaining: 0 } as never),
      editPreset: jest.fn().mockResolvedValue({ name: "Squad" } as never),
    };
    const serviceImpl = { ...defaults, ...(opts.serviceImpl ?? {}) };
    jest
      .spyOn(UserVoicePrefsService, "getInstance")
      .mockReturnValue(serviceImpl as never);

    const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
    const createSpy = jest
      .spyOn(WebAuditLog, "create")
      .mockResolvedValue({} as never);

    const mockClient = {} as never;
    const { createSessionMiddleware } =
      await import("../../src/web/session.js");
    const requireSession = createSessionMiddleware(mockClient);
    const router = createUserRouter(mockClient, requireSession);

    const headers: Record<string, unknown> = { cookie };
    if (opts.method === "POST" && opts.csrfHeader) {
      headers["x-csrf-token"] = opts.csrfHeader;
    }

    const url = opts.url ?? "/voice";
    const captured: {
      statusCode: number;
      body: string;
      redirectedTo?: string;
    } = { statusCode: 200, body: "" };
    const res = makeRes() as ReturnType<typeof makeRes> & {
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
    res.redirect = jest.fn((code: unknown, target?: unknown) => {
      if (typeof code === "number") {
        captured.statusCode = code;
        captured.redirectedTo = String(target);
      } else {
        captured.statusCode = 302;
        captured.redirectedTo = String(code);
      }
      return res;
    });
    res.header = jest.fn(() => res);

    const req = {
      method: opts.method,
      url,
      originalUrl: `/me${url}`,
      path: url,
      baseUrl: "/me",
      headers,
      body: opts.body ?? {},
      query: {},
      csrfToken: "csrf-1",
      header: (name: string) => headers[name.toLowerCase()],
    } as never as Parameters<typeof router>[0];

    await new Promise<void>((resolve) => {
      router(req as never, res as never, (() => resolve()) as never);
      setTimeout(resolve, 0);
    });
    await new Promise((r) => setTimeout(r, 10));

    const auditCall = createSpy.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    return { ...captured, audit: auditCall };
  }

  it("renders the voice page with the name pattern and presets", async () => {
    const out = await dispatch({
      method: "GET",
      prefs: {
        namePattern: "{username}'s Room",
        presets: [
          {
            name: "Squad",
            channelName: "Squad HQ",
            userLimit: 5,
            bitrate: 96,
            isDefault: true,
          },
        ],
      },
    });
    expect(out.statusCode).toBe(200);
    expect(out.body).toContain("Voice preferences");
    expect(out.body).toContain('action="/me/voice/name-pattern"');
    expect(out.body).toContain("{username}&#39;s Room");
    expect(out.body).toContain("Squad");
    // The preview substitutes the (fallback) display name.
    expect(out.body).toContain("Preview:");
  });

  it("returns a 404 disabled state when presets are off, and hides the nav link", async () => {
    const out = await dispatch({ method: "GET", presetsEnabled: false });
    expect(out.statusCode).toBe(404);
    expect(out.body).toContain("voice presets are currently disabled");
    expect(out.body).not.toContain('href="/me/voice"');
  });

  it("saves the name pattern and audits it", async () => {
    const out = await dispatch({
      method: "POST",
      url: "/voice/name-pattern",
      body: { _csrf: "csrf-1", namePattern: "🎮 {username}" },
      csrfHeader: "csrf-1",
    });
    expect(out.statusCode).toBe(303);
    expect(out.redirectedTo).toMatch(/^\/me\/voice\?/);
    expect(out.audit).toMatchObject({
      action: "user.voice.namepattern.set",
      result: "success",
    });
  });

  it("rejects a name-pattern POST without CSRF", async () => {
    const out = await dispatch({
      method: "POST",
      url: "/voice/name-pattern",
      body: { namePattern: "x" },
    });
    expect(out.statusCode).toBe(403);
  });

  it("sets a preset as default through the service", async () => {
    const setDefault = jest
      .fn()
      .mockResolvedValue({ name: "Squad", isDefault: true } as never);
    const out = await dispatch({
      method: "POST",
      url: "/voice/preset/default",
      body: { _csrf: "csrf-1", index: "0", expectedName: "Squad" },
      csrfHeader: "csrf-1",
      serviceImpl: { setDefault },
    });
    expect(out.statusCode).toBe(303);
    expect(setDefault).toHaveBeenCalledWith("user-1", 0, "Squad");
    expect(out.audit).toMatchObject({
      action: "user.voice.preset.default",
      result: "success",
    });
  });

  it("deletes a preset through the service", async () => {
    const deletePreset = jest
      .fn()
      .mockResolvedValue({ name: "Squad", remaining: 0 } as never);
    const out = await dispatch({
      method: "POST",
      url: "/voice/preset/delete",
      body: { _csrf: "csrf-1", index: "0", expectedName: "Squad" },
      csrfHeader: "csrf-1",
      serviceImpl: { deletePreset },
    });
    expect(out.statusCode).toBe(303);
    expect(deletePreset).toHaveBeenCalledWith("user-1", 0, "Squad");
  });

  it("edits a preset's fields through the service", async () => {
    const editPreset = jest
      .fn()
      .mockResolvedValue({ name: "Squad+" } as never);
    const out = await dispatch({
      method: "POST",
      url: "/voice/preset/edit",
      body: {
        _csrf: "csrf-1",
        index: "0",
        expectedName: "Squad",
        name: "Squad+",
        channelName: "Room",
        userLimit: "10",
        bitrate: "128",
      },
      csrfHeader: "csrf-1",
      serviceImpl: { editPreset },
    });
    expect(out.statusCode).toBe(303);
    expect(editPreset).toHaveBeenCalledWith(
      "user-1",
      0,
      { name: "Squad+", channelName: "Room", userLimit: 10, bitrate: 128 },
      "Squad",
    );
  });

  it("surfaces a validation error as a warn flash without throwing", async () => {
    const { VoicePrefsValidationError } =
      await import("../../src/services/user-voice-prefs-service.js");
    const editPreset = jest
      .fn()
      .mockRejectedValue(
        new VoicePrefsValidationError("Bitrate must be a whole number"),
      );
    const out = await dispatch({
      method: "POST",
      url: "/voice/preset/edit",
      body: {
        _csrf: "csrf-1",
        index: "0",
        expectedName: "Squad",
        name: "Squad",
        bitrate: "999",
      },
      csrfHeader: "csrf-1",
      serviceImpl: { editPreset },
    });
    expect(out.statusCode).toBe(303);
    expect(out.redirectedTo).toContain("flash=warn");
    expect(out.audit).toMatchObject({
      action: "user.voice.preset.edit",
      result: "failure",
    });
  });

  it("rejects an edit with a missing preset index", async () => {
    const editPreset = jest.fn();
    const out = await dispatch({
      method: "POST",
      url: "/voice/preset/edit",
      body: { _csrf: "csrf-1", name: "Squad" },
      csrfHeader: "csrf-1",
      serviceImpl: { editPreset },
    });
    expect(out.statusCode).toBe(303);
    expect(out.redirectedTo).toContain("flash=err");
    expect(editPreset).not.toHaveBeenCalled();
  });
});

describe("/me/timezone (#524)", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  async function dispatch(opts: {
    method: "GET" | "POST";
    body?: Record<string, unknown>;
    csrfHeader?: string;
    stored?: string | null;
    setTimezoneImpl?: jest.Mock;
  }): Promise<{
    statusCode: number;
    body: string;
    redirectedTo?: string;
    audit?: Record<string, unknown>;
  }> {
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

    const { UserNotificationPrefsService } =
      await import("../../src/services/user-notification-prefs-service.js");
    const getTimezone = jest
      .fn<() => Promise<string | null>>()
      .mockResolvedValue(opts.stored ?? null);
    const setTimezone =
      opts.setTimezoneImpl ??
      jest
        .fn<
          (
            userId: string,
            guildId: string,
            tz: string | null,
          ) => Promise<string | null>
        >()
        .mockImplementation(async (_u, _g, tz) => tz);
    jest.spyOn(UserNotificationPrefsService, "getInstance").mockReturnValue({
      getTimezone,
      setTimezone,
    } as never);

    const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
    const createSpy = jest
      .spyOn(WebAuditLog, "create")
      .mockResolvedValue({} as never);

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
      redirectedTo?: string;
    } = { statusCode: 200, body: "" };
    const res = makeRes() as ReturnType<typeof makeRes> & {
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
      url: "/timezone",
      originalUrl: "/me/timezone",
      path: "/timezone",
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

    // Spies accumulate across the suite, so read the most recent create
    // call — the one this dispatch produced.
    const auditCall = createSpy.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    return { ...captured, audit: auditCall };
  }

  it("renders the timezone selector with the server default option", async () => {
    const out = await dispatch({ method: "GET" });
    expect(out.body).toContain("Timezone");
    expect(out.body).toContain('action="/me/timezone"');
    expect(out.body).toContain('name="timezone"');
    expect(out.body).toContain("Server default");
    expect(out.body).toContain("America/New_York");
  });

  it("pre-selects the stored zone", async () => {
    const out = await dispatch({ method: "GET", stored: "Europe/Berlin" });
    expect(out.body).toContain(
      '<option value="Europe/Berlin" selected>Europe/Berlin</option>',
    );
  });

  it("saves a chosen timezone and redirects with a success flash", async () => {
    const out = await dispatch({
      method: "POST",
      body: { _csrf: "csrf-1", timezone: "America/New_York" },
      csrfHeader: "csrf-1",
    });
    expect(out.statusCode).toBe(303);
    expect(out.redirectedTo).toMatch(/^\/me\/timezone\?/);
    expect(out.audit).toMatchObject({
      action: "user.timezone.set",
      result: "success",
    });
  });

  it("clears the timezone when an empty value is submitted", async () => {
    let captured: { tz: string | null } | null = null;
    const setTimezone = jest
      .fn<(u: string, g: string, tz: string | null) => Promise<string | null>>()
      .mockImplementation(async (_u, _g, tz) => {
        captured = { tz };
        return tz;
      });
    const out = await dispatch({
      method: "POST",
      body: { _csrf: "csrf-1", timezone: "" },
      csrfHeader: "csrf-1",
      stored: "Europe/Berlin",
      setTimezoneImpl: setTimezone,
    });
    expect(out.statusCode).toBe(303);
    expect(captured).not.toBeNull();
    expect(captured!.tz).toBeNull();
  });

  it("surfaces a descriptive error when the service rejects an invalid zone", async () => {
    const setTimezone = jest
      .fn<(u: string, g: string, tz: string | null) => Promise<string | null>>()
      .mockRejectedValue(
        new Error('"Mars/Phobos" is not a recognized IANA timezone identifier'),
      );
    const out = await dispatch({
      method: "POST",
      body: { _csrf: "csrf-1", timezone: "Mars/Phobos" },
      csrfHeader: "csrf-1",
      setTimezoneImpl: setTimezone,
    });
    expect(out.statusCode).toBe(303);
    expect(out.redirectedTo).toContain("flash=err");
    expect(out.audit).toMatchObject({
      action: "user.timezone.set",
      result: "failure",
    });
  });

  it("rejects POST without a CSRF token", async () => {
    const out = await dispatch({
      method: "POST",
      body: { timezone: "UTC" },
    });
    expect(out.statusCode).toBe(403);
  });
});
