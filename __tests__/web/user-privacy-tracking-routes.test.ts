/**
 * Route-level tests for the member tracking opt-out (#918).
 *
 * `tracking-opt-out-service.test.ts` covers the cache and the writes; this
 * suite covers the wiring in front of it: the unauthenticated and CSRF
 * refusals, the offer gate (which refuses opting out but never opting back
 * in), self-scope, the audit rows and the failure path. The page copy the
 * opt-out state drives is covered at the bottom.
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
import { TrackingOptOutService } from "../../src/services/tracking-opt-out-service.js";
import { WebAuditLog } from "../../src/models/web-audit-log.js";
import { renderUserPrivacyBody } from "../../src/web/user-layout.js";

const SECRET = "test-secret-for-user-privacy-tracking-routes";
const USER = "user-1";
const GUILD = "guild-1";

interface Captured {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  redirect: string | null;
}

interface MockOptions {
  privacyEnabled?: boolean;
  optOutEnabled?: boolean;
  writeThrows?: boolean;
  /** What `optOut` reports about draining in-flight writes. */
  settled?: boolean;
}

let auditRows: Array<Record<string, unknown>> = [];
let optOutCalls: Array<[string, string]> = [];
let optInCalls: Array<[string, string]> = [];

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

async function installMocks(opts: MockOptions = {}): Promise<void> {
  const svc = WebSessionService.getInstance();
  jest.spyOn(svc, "findById").mockResolvedValue({
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

  const { ConfigService } =
    await import("../../src/services/config-service.js");
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async (key: string) => {
      if (key === "privacy.enabled") return opts.privacyEnabled ?? true;
      if (key === "privacy.tracking_opt_out.enabled") {
        return opts.optOutEnabled ?? true;
      }
      return false;
    },
    getNumber: async (_key: string, fallback: number) => fallback,
  } as never);

  jest.spyOn(WebAuditLog, "create").mockImplementation(async (row: unknown) => {
    auditRows.push(row as Record<string, unknown>);
    return {} as never;
  });

  jest.spyOn(TrackingOptOutService, "getInstance").mockReturnValue({
    optOut: async (userId: string, guildId: string) => {
      if (opts.writeThrows) throw new Error("mongo went away");
      optOutCalls.push([userId, guildId]);
      return { settled: opts.settled ?? true };
    },
    optIn: async (userId: string, guildId: string) => {
      if (opts.writeThrows) throw new Error("mongo went away");
      optInCalls.push([userId, guildId]);
      return true;
    },
  } as never);
}

async function post(
  opts: {
    body?: Record<string, unknown>;
    ip?: string;
    cookie?: string | null;
    router?: ReturnType<typeof createUserRouter>;
  } = {},
): Promise<{
  captured: Captured;
  router: ReturnType<typeof createUserRouter>;
}> {
  const mockClient = {} as never;
  const { createSessionMiddleware } = await import("../../src/web/session.js");
  const router =
    opts.router ??
    createUserRouter(mockClient, createSessionMiddleware(mockClient));

  const captured: Captured = {
    statusCode: 200,
    body: "",
    headers: {},
    redirect: null,
  };
  const headers: Record<string, unknown> = {};
  const cookie = opts.cookie === undefined ? buildCookie() : opts.cookie;
  if (cookie) headers.cookie = cookie;
  const req = {
    method: "POST",
    url: "/privacy/tracking",
    originalUrl: "/me/privacy/tracking",
    path: "/privacy/tracking",
    baseUrl: "/me",
    headers,
    body: opts.body ?? { _csrf: "csrf-1", action: "opt-out" },
    query: {},
    ip: opts.ip ?? "10.0.0.1",
    socket: { remoteAddress: opts.ip ?? "10.0.0.1" },
    csrfToken: "csrf-1",
    header: (name: string) => headers[name.toLowerCase()],
  } as never as Parameters<typeof router>[0];

  const res: Record<string, unknown> = {
    statusCode: 200,
    status: jest.fn((code: number) => {
      captured.statusCode = code;
      return res;
    }),
    type: jest.fn(() => res),
    json: jest.fn((body: unknown) => {
      captured.body = JSON.stringify(body);
      return res;
    }),
    send: jest.fn((body: unknown) => {
      captured.body = typeof body === "string" ? body : String(body);
      return res;
    }),
    setHeader: jest.fn((name: string, value: unknown) => {
      captured.headers[name.toLowerCase()] = value;
      return res;
    }),
    getHeader: jest.fn((name: string) => captured.headers[name.toLowerCase()]),
    redirect: jest.fn((code: number, url: string) => {
      captured.statusCode = code;
      captured.redirect = url;
      return res;
    }),
    header: jest.fn(() => res),
  };

  await new Promise<void>((resolve) => {
    router(req as never, res as never, (() => resolve()) as never);
    setTimeout(resolve, 0);
  });
  await new Promise((r) => setTimeout(r, 20));
  return { captured, router };
}

function flashOf(captured: Captured): { type: string; text: string } {
  const url = new globalThis.URL(`http://x${captured.redirect ?? ""}`);
  return {
    type: url.searchParams.get("flash") ?? "",
    text: url.searchParams.get("msg") ?? "",
  };
}

describe("POST /me/privacy/tracking", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
    auditRows = [];
    optOutCalls = [];
    optInCalls = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 401 without a session and changes nothing", async () => {
    await installMocks();
    const { captured } = await post({ cookie: null });

    expect(captured.statusCode).toBe(401);
    expect(optOutCalls).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  it("rejects a request without a CSRF token", async () => {
    await installMocks();
    const { captured } = await post({ body: { action: "opt-out" } });

    expect(captured.statusCode).toBe(403);
    expect(optOutCalls).toEqual([]);
  });

  it("opts the session's own member out and audits it", async () => {
    await installMocks();
    const { captured } = await post();

    expect(optOutCalls).toEqual([[USER, GUILD]]);
    expect(captured.statusCode).toBe(303);
    expect(flashOf(captured).text).toContain("opted out of tracking");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.tracking",
      result: "success",
      details: { action: "opt-out" },
    });
  });

  it("says so when the opt-out is stored but an in-flight write is unconfirmed", async () => {
    await installMocks({ settled: false });
    const { captured } = await post();

    expect(optOutCalls).toEqual([[USER, GUILD]]);
    expect(flashOf(captured).type).toBe("err");
    expect(flashOf(captured).text).toContain("could not be confirmed finished");
    expect(auditRows[0]).toMatchObject({
      result: "success",
      details: { action: "opt-out", settled: false },
    });
  });

  it("ignores a user id in the body — the session decides who", async () => {
    await installMocks();
    await post({
      body: {
        _csrf: "csrf-1",
        action: "opt-out",
        userId: "someone-else",
        guildId: "other-guild",
      },
    });
    expect(optOutCalls).toEqual([[USER, GUILD]]);
  });

  it("opts the member back in and audits it", async () => {
    await installMocks();
    const { captured } = await post({
      body: { _csrf: "csrf-1", action: "opt-in" },
    });

    expect(optInCalls).toEqual([[USER, GUILD]]);
    expect(flashOf(captured).text).toContain("opted back in");
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.tracking",
      result: "success",
      details: { action: "opt-in" },
    });
  });

  it("refuses to opt out with 403 and a feature-disabled audit row when the offer is off", async () => {
    await installMocks({ optOutEnabled: false });
    const { captured } = await post();

    expect(captured.statusCode).toBe(403);
    expect(optOutCalls).toEqual([]);
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.tracking",
      result: "failure",
      details: {
        reason: "feature-disabled",
        disabledKeys: ["privacy.tracking_opt_out.enabled"],
      },
    });
  });

  it("refuses to opt out when the export itself is off", async () => {
    await installMocks({ privacyEnabled: false });
    const { captured } = await post();

    expect(captured.statusCode).toBe(403);
    expect(auditRows[0]).toMatchObject({
      details: { disabledKeys: ["privacy.enabled"] },
    });
  });

  it("always lets a member opt back in, whatever is switched off", async () => {
    await installMocks({ privacyEnabled: false, optOutEnabled: false });
    const { captured } = await post({
      body: { _csrf: "csrf-1", action: "opt-in" },
    });

    expect(captured.statusCode).toBe(303);
    expect(optInCalls).toEqual([[USER, GUILD]]);
  });

  it("rejects an unknown action without touching anything", async () => {
    await installMocks();
    const { captured } = await post({
      body: { _csrf: "csrf-1", action: "delete-everyone" },
    });

    expect(flashOf(captured).type).toBe("err");
    expect(optOutCalls).toEqual([]);
    expect(optInCalls).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  it("reports a failed write honestly and audits the failure", async () => {
    await installMocks({ writeThrows: true });
    const { captured } = await post();

    expect(flashOf(captured)).toMatchObject({ type: "err" });
    expect(flashOf(captured).text).toContain("nothing changed");
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.tracking",
      result: "failure",
      errorMessage: "mongo went away",
    });
  });
});

describe("renderUserPrivacyBody tracking opt-out", () => {
  const base = {
    featureEnabled: true,
    included: [],
    excluded: [],
    maxItems: 5000,
    reset: { enabled: true, cooldownHours: 0, csrfToken: "tok" },
  };

  it("offers the opt-out, honest that the flag itself is stored", () => {
    const html = renderUserPrivacyBody({
      ...base,
      trackingOptOut: { offered: true, optedOutAt: null, csrfToken: "tok" },
    });

    expect(html).toContain('action="/me/privacy/tracking"');
    expect(html).toContain('name="action" value="opt-out"');
    expect(html).toContain("the opt-out itself is stored");
    expect(html).toContain("the one thing a reset does not remove");
    // The reset stays a reset, and points at the opt-out.
    expect(html).toContain("This is a reset, not a deletion.");
    expect(html).toContain('href="#tracking"');
    // Opt-out card sits above the reset card.
    expect(html.indexOf('id="tracking"')).toBeLessThan(
      html.indexOf('id="reset"'),
    );
  });

  it("calls the reset a deletion once the member is opted out", () => {
    const html = renderUserPrivacyBody({
      ...base,
      trackingOptOut: {
        offered: true,
        optedOutAt: new Date("2026-09-01T12:00:00Z"),
        csrfToken: "tok",
      },
    });

    expect(html).toContain("You are opted out");
    expect(html).toContain("2026-09-01");
    expect(html).toContain('name="action" value="opt-in"');
    expect(html).toContain("This is a deletion.");
    expect(html).not.toContain("This is a reset, not a deletion.");
  });

  it("renders no opt-out card, and no link to one, when it is not offered", () => {
    const html = renderUserPrivacyBody({
      ...base,
      trackingOptOut: { offered: false, optedOutAt: null, csrfToken: "tok" },
    });

    expect(html).not.toContain("/me/privacy/tracking");
    expect(html).not.toContain('href="#tracking"');
    expect(html).toContain("This is a reset, not a deletion.");
  });

  it("keeps opting back in reachable when everything is switched off", () => {
    const html = renderUserPrivacyBody({
      ...base,
      featureEnabled: false,
      trackingOptOut: {
        offered: false,
        optedOutAt: new Date("2026-09-01T12:00:00Z"),
        csrfToken: "tok",
      },
    });

    expect(html).toContain('name="action" value="opt-in"');
    // No reset card on the page, so nothing may point "below" at one.
    expect(html).not.toContain("reset your data below");
    expect(html).toContain("this server has not enabled one");
  });

  it("points at the reset only when its card renders", () => {
    const withReset = renderUserPrivacyBody({
      ...base,
      trackingOptOut: {
        offered: true,
        optedOutAt: new Date("2026-09-01T12:00:00Z"),
        csrfToken: "tok",
      },
    });
    expect(withReset).toContain("reset your data below");

    const withoutReset = renderUserPrivacyBody({
      ...base,
      reset: { enabled: false, cooldownHours: 0, csrfToken: "tok" },
      trackingOptOut: { offered: true, optedOutAt: null, csrfToken: "tok" },
    });
    expect(withoutReset).not.toContain("/me/privacy/delete");
    expect(withoutReset).not.toContain("until you reset it");
    expect(withoutReset).toContain("this server has not enabled one");
  });
});
