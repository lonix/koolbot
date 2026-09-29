/**
 * Route-level tests for the self-service data reset (#917).
 *
 * `user-data-deletion-service.test.ts` covers what the purge touches; this
 * suite covers the wiring in front of it: the unauthenticated and CSRF
 * refusals, the feature gate, the typed confirmation, the per-IP rate limiter
 * and the persisted per-member cooldown, the two audit rows (and the refusal
 * when the first cannot be written), self-scope, and the signed-out finish.
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
import { UserDataDeletionService } from "../../src/services/user-data-deletion-service.js";
import { WebAuditLog } from "../../src/models/web-audit-log.js";
import { renderUserPrivacyBody } from "../../src/web/user-layout.js";

const SECRET = "test-secret-for-user-privacy-reset-routes";
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
  resetEnabled?: boolean;
  cooldownHours?: number;
  /** The latest intent row the cooldown lookup finds, if any. */
  lastReset?: Record<string, unknown> | null;
  /** A recorded failure after that intent, which lifts the cooldown. */
  failedAfter?: Record<string, unknown> | null;
  revokeThrows?: boolean;
  /** Keep the purge running this long, to overlap two requests. */
  purgeDelayMs?: number;
  cooldownLookupThrows?: boolean;
  /** Make the audit write for this phase throw. */
  failAuditPhase?: string;
  purgeOk?: boolean;
  purgeThrows?: boolean;
}

let auditRows: Array<Record<string, unknown>> = [];
let purgeCalls: Array<[string, string]> = [];
let revokedUsers: string[] = [];
let cooldownQueries: Array<Record<string, unknown>> = [];

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
  jest
    .spyOn(svc, "revokeForUser")
    .mockImplementation(async (userId: string) => {
      if (opts.revokeThrows) throw new Error("mongo went away");
      revokedUsers.push(userId);
      return 1;
    });

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
      if (key === "privacy.delete.enabled") return opts.resetEnabled ?? true;
      return false;
    },
    getNumber: async (key: string, fallback: number) =>
      key === "privacy.delete.cooldown_hours"
        ? (opts.cooldownHours ?? fallback)
        : fallback,
  } as never);

  jest.spyOn(WebAuditLog, "create").mockImplementation(async (row: unknown) => {
    const r = row as Record<string, unknown>;
    const phase = (r.details as Record<string, unknown> | undefined)?.phase;
    if (opts.failAuditPhase && phase === opts.failAuditPhase) {
      throw new Error("audit store unavailable");
    }
    auditRows.push(r);
    return {} as never;
  });
  jest.spyOn(WebAuditLog, "findOne").mockImplementation(((
    query: Record<string, unknown>,
  ) => {
    cooldownQueries.push(query);
    // The intent lookup sorts; the "failure after it" lookup does not.
    const result =
      query["details.phase"] === "intent"
        ? (opts.lastReset ?? null)
        : (opts.failedAfter ?? null);
    const lean = async () => {
      if (opts.cooldownLookupThrows) throw new Error("mongo went away");
      return result;
    };
    return { sort: () => ({ lean }), lean };
  }) as never);

  jest.spyOn(UserDataDeletionService, "getInstance").mockReturnValue({
    purge: async (userId: string, guildId: string) => {
      purgeCalls.push([userId, guildId]);
      if (opts.purgeDelayMs) {
        await new Promise((r) => setTimeout(r, opts.purgeDelayMs));
      }
      if (opts.purgeThrows) throw new Error("no deleter");
      const ok = opts.purgeOk ?? true;
      return {
        ok,
        steps: [
          {
            collection: "voice-channel-tracking",
            action: "hard-delete",
            matched: 1,
            removed: 1,
          },
          {
            collection: "leaderboard-role-assignment",
            action: "hard-delete",
            matched: 1,
            removed: ok ? 1 : 0,
            ...(ok ? {} : { error: "role revoke failed" }),
          },
        ],
      };
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
    url: "/privacy/delete",
    originalUrl: "/me/privacy/delete",
    path: "/privacy/delete",
    baseUrl: "/me",
    headers,
    body: opts.body ?? { _csrf: "csrf-1", confirm: "RESET" },
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

async function createRouter(): Promise<ReturnType<typeof createUserRouter>> {
  const mockClient = {} as never;
  const { createSessionMiddleware } = await import("../../src/web/session.js");
  return createUserRouter(mockClient, createSessionMiddleware(mockClient));
}

function flashText(captured: Captured): string {
  const url = new globalThis.URL(`http://x${captured.redirect ?? ""}`);
  return url.searchParams.get("msg") ?? "";
}

describe("POST /me/privacy/delete", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
    auditRows = [];
    purgeCalls = [];
    revokedUsers = [];
    cooldownQueries = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 401 without a session and never purges", async () => {
    await installMocks();
    const { captured } = await post({ cookie: null });

    expect(captured.statusCode).toBe(401);
    expect(purgeCalls).toEqual([]);
    expect(auditRows).toEqual([]);
  });

  it("rejects a request without a CSRF token", async () => {
    await installMocks();
    const { captured } = await post({
      cookie: buildCookie(),
      body: { confirm: "RESET" },
    });

    expect(captured.statusCode).toBe(403);
    expect(purgeCalls).toEqual([]);
  });

  it("rejects a CSRF token that does not match the cookie", async () => {
    await installMocks();
    const { captured } = await post({
      body: { _csrf: "forged", confirm: "RESET" },
    });

    expect(captured.statusCode).toBe(403);
    expect(purgeCalls).toEqual([]);
  });

  it("refuses with 403 and a feature-disabled audit row when the reset is off", async () => {
    await installMocks({ resetEnabled: false });
    const { captured } = await post();

    expect(captured.statusCode).toBe(403);
    expect(purgeCalls).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.delete",
      result: "failure",
      details: { reason: "feature-disabled" },
      errorMessage: "privacy.delete.enabled is off",
    });
  });

  it("refuses when the export itself is off, naming that key rather than the reset's", async () => {
    await installMocks({ privacyEnabled: false, resetEnabled: true });
    const { captured } = await post();

    expect(captured.statusCode).toBe(403);
    expect(purgeCalls).toEqual([]);
    expect(auditRows[0]).toMatchObject({
      details: { disabledKeys: ["privacy.enabled"] },
      errorMessage: "privacy.enabled is off",
    });
  });

  it.each([
    ["missing", undefined],
    ["wrong word", "DELETE"],
    ["wrong case", "reset"],
  ])(
    "rejects a %s confirmation with an audit row and a flash",
    async (_label, confirm) => {
      await installMocks();
      const { captured } = await post({
        body: { _csrf: "csrf-1", ...(confirm ? { confirm } : {}) },
      });

      expect(captured.statusCode).toBe(303);
      expect(captured.redirect).toMatch(/^\/me\/privacy\?/);
      expect(flashText(captured)).toContain("type RESET exactly");
      expect(purgeCalls).toEqual([]);
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        action: "user.privacy.delete",
        result: "failure",
        details: { reason: "confirmation-mismatch" },
      });
    },
  );

  it("purges, writes intent then completed rows, and signs the member out", async () => {
    await installMocks();
    const { captured } = await post();

    expect(purgeCalls).toEqual([[USER, GUILD]]);
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.delete",
      targetId: USER,
      result: "success",
      details: { phase: "intent" },
    });
    expect(auditRows[1]).toMatchObject({
      action: "user.privacy.delete",
      targetId: USER,
      result: "success",
      details: { phase: "completed", report: { ok: true } },
    });
    expect(
      (auditRows[1].details as { report: { steps: unknown[] } }).report.steps,
    ).toHaveLength(2);

    // Terminal treatment, same as /me/finish.
    expect(revokedUsers).toEqual([USER]);
    expect(String(captured.headers["set-cookie"])).toContain(
      "koolbot_session=;",
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toContain("Signed out");
    expect(captured.body).toContain("has been reset");
    expect(captured.body).toContain("Your session has been revoked");
  });

  it("does not claim the session was revoked when the revoke fails", async () => {
    await installMocks({ revokeThrows: true });
    const { captured } = await post();

    expect(purgeCalls).toEqual([[USER, GUILD]]);
    expect(String(captured.headers["set-cookie"])).toContain(
      "koolbot_session=;",
    );
    expect(captured.body).toContain("has been reset");
    expect(captured.body).not.toContain("Your session has been revoked");
    expect(captured.body).toContain(
      "could not confirm your session was revoked",
    );
  });

  it("still signs out when the completed row cannot be written", async () => {
    await installMocks({ failAuditPhase: "completed" });
    const { captured } = await post();

    // The intent row (which holds the cooldown) landed; the completed one
    // failed but did not turn a finished purge into an error page.
    expect(
      auditRows.map((r) => (r.details as { phase: string }).phase),
    ).toEqual(["intent"]);
    expect(revokedUsers).toEqual([USER]);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toContain("has been reset");
  });

  it("lets only one of two concurrent requests from the same member through", async () => {
    await installMocks({ purgeDelayMs: 50 });
    const first = await createRouter();
    const [a, b] = await Promise.all([
      post({ router: first }),
      post({ router: first }),
    ]);
    // Let the purge that won finish before asserting (and before the next
    // test), so it cannot leak rows into a later test.
    await new Promise((r) => setTimeout(r, 80));

    expect(purgeCalls).toEqual([[USER, GUILD]]);
    const refused = [a, b].find((r) => r.captured.statusCode === 303);
    expect(refused).toBeDefined();
    expect(flashText(refused!.captured)).toContain("already in progress");
    expect(auditRows).toContainEqual(
      expect.objectContaining({
        result: "failure",
        details: { reason: "in-progress" },
      }),
    );
  });

  it("records a partial purge as a failed completed row and says so", async () => {
    await installMocks({ purgeOk: false });
    const { captured } = await post();

    expect(auditRows[1]).toMatchObject({
      result: "failure",
      errorMessage: "1 purge step(s) incomplete",
      details: { phase: "completed", report: { ok: false } },
    });
    expect(captured.body).toContain("did not fully complete");
    expect(revokedUsers).toEqual([USER]);
  });

  it("closes the intent row with a failure and still signs out if the coordinator throws", async () => {
    await installMocks({ purgeThrows: true });
    const { captured } = await post();

    expect(
      auditRows.map((r) => (r.details as { phase: string }).phase),
    ).toEqual(["intent", "completed"]);
    expect(auditRows[1]).toMatchObject({
      result: "failure",
      errorMessage: "no deleter",
    });
    // Part of the data may already be gone: same terminal treatment.
    expect(revokedUsers).toEqual([USER]);
    expect(captured.statusCode).toBe(200);
    expect(captured.body).toContain("Signed out");
    expect(captured.body).toContain("could not finish");
  });

  it("refuses the purge when the intent row cannot be written", async () => {
    await installMocks({ failAuditPhase: "intent" });
    const { captured } = await post();

    expect(purgeCalls).toEqual([]);
    expect(revokedUsers).toEqual([]);
    expect(captured.statusCode).toBe(303);
    expect(flashText(captured)).toContain("could not be recorded");
  });

  it("purges the session's own member, whatever the form claims", async () => {
    await installMocks();
    await post({
      body: {
        _csrf: "csrf-1",
        confirm: "RESET",
        userId: "someone-else",
        guildId: "other-guild",
      },
    });

    expect(purgeCalls).toEqual([[USER, GUILD]]);
    expect(auditRows[0]).toMatchObject({ targetId: USER });
  });

  it("refuses inside the persisted cooldown, keyed on this member's intent rows", async () => {
    const lastResetAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await installMocks({
      cooldownHours: 24,
      lastReset: { createdAt: lastResetAt },
    });
    const { captured } = await post();

    expect(purgeCalls).toEqual([]);
    expect(captured.statusCode).toBe(303);
    expect(flashText(captured)).toContain("You can reset again after");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "failure",
      details: { reason: "cooldown", lastResetAt: lastResetAt.toISOString() },
    });

    // Persisted, per member, keyed on the fail-closed intent row, then a
    // check for a recorded failure after it.
    expect(cooldownQueries).toHaveLength(2);
    expect(cooldownQueries[0]).toMatchObject({
      guildId: GUILD,
      discordUserId: USER,
      action: "user.privacy.delete",
      "details.phase": "intent",
    });
    expect(cooldownQueries[1]).toMatchObject({
      guildId: GUILD,
      discordUserId: USER,
      action: "user.privacy.delete",
      "details.phase": "completed",
      result: "failure",
      createdAt: { $gte: lastResetAt },
    });
    const since = (cooldownQueries[0].createdAt as { $gte: Date }).$gte;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(
      24 * 60 * 60 * 1000 - 1000,
    );
  });

  it("lets a member retry straight away after a recorded failed reset", async () => {
    await installMocks({
      cooldownHours: 24,
      lastReset: { createdAt: new Date(Date.now() - 60_000) },
      failedAfter: { createdAt: new Date(Date.now() - 30_000) },
    });
    await post();

    expect(purgeCalls).toEqual([[USER, GUILD]]);
  });

  it("allows a reset once no prior reset falls inside the window", async () => {
    await installMocks({ cooldownHours: 24, lastReset: null });
    await post();

    expect(purgeCalls).toEqual([[USER, GUILD]]);
  });

  it("skips the cooldown lookup entirely when the cooldown is 0", async () => {
    await installMocks({ cooldownHours: 0 });
    await post();

    expect(cooldownQueries).toEqual([]);
    expect(purgeCalls).toEqual([[USER, GUILD]]);
  });

  it("fails closed when the cooldown cannot be checked", async () => {
    await installMocks({ cooldownLookupThrows: true });
    const { captured } = await post();

    expect(purgeCalls).toEqual([]);
    expect(captured.statusCode).toBe(303);
    expect(flashText(captured)).toContain("could not check");
    // Audited like every other refusal, with no `phase`, so the row can
    // neither start nor lift a cooldown (#919).
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "failure",
      details: { reason: "cooldown-check-failed" },
    });
    expect(
      (auditRows[0].details as Record<string, unknown>).phase,
    ).toBeUndefined();
  });

  it("rate-limits repeated attempts from one client on its own bucket", async () => {
    await installMocks();
    const bad = { _csrf: "csrf-1", confirm: "nope" };
    const first = await post({ ip: "203.0.113.9", body: bad });
    const router = first.router;
    for (let i = 0; i < 4; i += 1) {
      await post({ ip: "203.0.113.9", body: bad, router });
    }
    const blocked = await post({ ip: "203.0.113.9", router });

    expect(first.captured.statusCode).toBe(303);
    expect(blocked.captured.statusCode).toBe(429);
    expect(purgeCalls).toEqual([]);
  });
});

describe("renderUserPrivacyBody reset card", () => {
  const base = {
    featureEnabled: true,
    included: [],
    excluded: [],
    maxItems: 5000,
  };

  it("renders the danger zone with the four honesty points and export first", () => {
    const html = renderUserPrivacyBody({
      ...base,
      reset: { enabled: true, cooldownHours: 168, csrfToken: "tok" },
    });

    expect(html).toContain('action="/me/privacy/delete"');
    expect(html).toContain('name="_csrf" value="tok"');
    expect(html).toContain('name="confirm"');
    expect(html).toContain("<code>RESET</code>");
    expect(html).toContain('onsubmit="return confirm(');
    expect(html).toContain("This is a reset, not a deletion.");
    expect(html).toContain("Moderation records and audit logs are kept.");
    expect(html).toContain("Other members' records may still mention you.");
    expect(html).toContain("Your preferences go back to defaults.");
    expect(html).toContain("once every 168 hours");

    const card = html.slice(html.indexOf('id="reset"'));
    expect(card.indexOf("/me/privacy/export")).toBeLessThan(
      card.indexOf("Reset my data</button>"),
    );
  });

  it("omits the cooldown line when the cooldown is off", () => {
    const html = renderUserPrivacyBody({
      ...base,
      reset: { enabled: true, cooldownHours: 0, csrfToken: "tok" },
    });
    expect(html).not.toContain("You can reset once every");
  });

  it("renders no danger zone when the reset is off", () => {
    const html = renderUserPrivacyBody({
      ...base,
      reset: { enabled: false, cooldownHours: 168, csrfToken: "tok" },
    });
    expect(html).not.toContain("/me/privacy/delete");
  });

  it("renders no danger zone when the export itself is off", () => {
    const html = renderUserPrivacyBody({
      ...base,
      featureEnabled: false,
      reset: { enabled: true, cooldownHours: 168, csrfToken: "tok" },
    });
    expect(html).not.toContain("/me/privacy/delete");
  });
});
