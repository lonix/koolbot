/**
 * Route-level tests for the self-service data export surface (#719).
 *
 * `user-data-export-service.test.ts` covers what the payload contains; this
 * suite covers the wiring around it: the feature gate, the download headers
 * that keep the JSON a file rather than a page, the audit row every download
 * leaves behind, and the rate limiter on the most expensive read a member can
 * trigger.
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

const SECRET = "test-secret-for-user-privacy-routes";
const USER = "user-1";
const GUILD = "guild-1";

interface Captured {
  statusCode: number;
  body: string;
  written: string[];
  ended: boolean;
  headers: Record<string, unknown>;
  /** Simulate a full kernel buffer: `write()` returns false from here on. */
  backpressure: boolean;
  /** Simulate the client hanging up: no `drain` will ever fire. */
  destroyed: boolean;
  /** Listeners registered by `writeChunk`, keyed by event name. */
  listeners: Record<string, Array<() => void>>;
}

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

function makeRes(captured: Captured): Record<string, unknown> {
  const res: Record<string, unknown> = {
    statusCode: 200,
    status: jest.fn((code: number) => {
      captured.statusCode = code;
      return res;
    }),
    type: jest.fn(() => res),
    send: jest.fn((body: unknown) => {
      captured.body = typeof body === "string" ? body : String(body);
      return res;
    }),
    setHeader: jest.fn((name: string, value: unknown) => {
      captured.headers[name.toLowerCase()] = value;
      return res;
    }),
    getHeader: jest.fn((name: string) => captured.headers[name.toLowerCase()]),
    write: jest.fn((chunk: string) => {
      captured.written.push(chunk);
      return !captured.backpressure;
    }),
    end: jest.fn(() => {
      captured.ended = true;
      return res;
    }),
    redirect: jest.fn(() => res),
    header: jest.fn(() => res),
    once: jest.fn((event: string, fn: () => void) => {
      (captured.listeners[event] ??= []).push(fn);
      return res;
    }),
    off: jest.fn((event: string, fn: () => void) => {
      captured.listeners[event] = (captured.listeners[event] ?? []).filter(
        (registered) => registered !== fn,
      );
      return res;
    }),
  };
  // `writableEnded`/`destroyed` track the simulated socket state.
  Object.defineProperty(res, "writableEnded", {
    get: () => captured.ended,
  });
  Object.defineProperty(res, "destroyed", {
    get: () => captured.destroyed,
  });
  return res;
}

/** Fire the listeners a disconnect would fire on a real socket. */
function simulateDisconnect(captured: Captured): void {
  captured.destroyed = true;
  for (const fn of [...(captured.listeners.close ?? [])]) fn();
}

/** Audit rows written during the current test. */
let auditRows: Array<Record<string, unknown>> = [];

async function installCommonMocks(privacyEnabled: boolean): Promise<void> {
  const svc = WebSessionService.getInstance();
  jest.spyOn(svc, "findById").mockResolvedValue({
    discordUserId: USER,
    guildId: GUILD,
    role: "user",
    scopes: [],
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  } as never);

  const { PermissionsService } = await import(
    "../../src/services/permissions-service.js"
  );
  jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
    checkCommandPermission: async () => true,
  } as never);

  const { ConfigService } = await import(
    "../../src/services/config-service.js"
  );
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async (key: string) =>
      key === "privacy.enabled" ? privacyEnabled : false,
    getNumber: async (_key: string, fallback: number) => fallback,
  } as never);

  const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
  jest
    .spyOn(WebAuditLog, "create")
    .mockImplementation(async (row: unknown) => {
      auditRows.push(row as Record<string, unknown>);
      return {} as never;
    });
}

/** Mock the export service so no model/Mongo work happens in route tests. */
async function stubExportService(
  chunks: string[],
  progress: { collections: string[]; truncated: string[] },
): Promise<void> {
  const { UserDataExportService } = await import(
    "../../src/services/user-data-export-service.js"
  );
  jest.spyOn(UserDataExportService, "getInstance").mockReturnValue({
    getMaxItems: async () => 5000,
    streamJson: async function* (
      _userId: string,
      _guildId: string,
      target: { collections: string[]; truncated: string[] },
    ) {
      target.collections.push(...progress.collections);
      target.truncated.push(...progress.truncated);
      for (const chunk of chunks) yield chunk;
    },
  } as never);
}

async function dispatch(
  path: string,
  opts: {
    ip?: string;
    router?: ReturnType<typeof createUserRouter>;
    backpressure?: boolean;
    onWait?: (captured: Captured) => void;
  } = {},
): Promise<{ captured: Captured; router: ReturnType<typeof createUserRouter> }> {
  const mockClient = {} as never;
  const { createSessionMiddleware } = await import("../../src/web/session.js");
  const router =
    opts.router ?? createUserRouter(mockClient, createSessionMiddleware(mockClient));

  const captured: Captured = {
    statusCode: 200,
    body: "",
    written: [],
    ended: false,
    headers: {},
    backpressure: opts.backpressure ?? false,
    destroyed: false,
    listeners: {},
  };
  const headers: Record<string, unknown> = { cookie: buildCookie() };
  const req = {
    method: "GET",
    url: path,
    originalUrl: `/me${path}`,
    path,
    baseUrl: "/me",
    headers,
    body: {},
    query: {},
    ip: opts.ip ?? "10.0.0.1",
    socket: { remoteAddress: opts.ip ?? "10.0.0.1" },
    csrfToken: "csrf-1",
    header: (name: string) => headers[name.toLowerCase()],
  } as never as Parameters<typeof router>[0];

  const res = makeRes(captured);
  await new Promise<void>((resolve) => {
    router(req as never, res as never, (() => resolve()) as never);
    setTimeout(resolve, 0);
  });
  // Give the handler a chance to park on backpressure, then let the test
  // decide what unblocks it (a drain, or a disconnect that never drains).
  await new Promise((r) => setTimeout(r, 20));
  opts.onWait?.(captured);
  await new Promise((r) => setTimeout(r, 20));
  return { captured, router };
}

describe("/me/privacy", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
    auditRows = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders the download button and both registry tables when enabled", async () => {
    await installCommonMocks(true);
    const { captured } = await dispatch("/privacy");

    expect(captured.body).toContain("Download my data (JSON)");
    expect(captured.body).toContain('href="/me/privacy/export"');
    // The page is rendered from the same registry the export reads, so an
    // included and an excluded collection both have to show up.
    expect(captured.body).toContain("voice-channel-tracking");
    expect(captured.body).toContain("moderation-log");
    expect(captured.body).toContain("What's not in it");
  });

  it("shows the shared disabled banner and no download when off", async () => {
    await installCommonMocks(false);
    const { captured } = await dispatch("/privacy");

    expect(captured.body).toContain(
      "hasn't enabled self-service data export yet",
    );
    expect(captured.body).not.toContain("Download my data (JSON)");
  });
});

describe("/me/privacy/export", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
    auditRows = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("streams the export as an attachment with the safety headers", async () => {
    await installCommonMocks(true);
    await stubExportService(['{"a":', "1}"], {
      collections: ["voice-channel-tracking"],
      truncated: [],
    });

    const { captured } = await dispatch("/privacy/export");

    expect(captured.statusCode).toBe(200);
    expect(captured.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(captured.headers["content-disposition"]).toBe(
      `attachment; filename="koolbot-export-${USER}-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`,
    );
    // Not rendered as HTML under any circumstances, and never cached on a
    // shared machine.
    expect(captured.headers["x-content-type-options"]).toBe("nosniff");
    expect(captured.headers["cache-control"]).toBe("no-store");
    // Written chunk by chunk rather than buffered into one `send`.
    expect(captured.written).toEqual(['{"a":', "1}"]);
    expect(captured.ended).toBe(true);
  });

  it("records one audit row naming what was served", async () => {
    await installCommonMocks(true);
    await stubExportService(["{}"], {
      collections: ["voice-channel-tracking", "quote"],
      truncated: ["voice-channel-tracking"],
    });

    await dispatch("/privacy/export");

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.export",
      discordUserId: USER,
      targetId: USER,
      result: "success",
      details: {
        collections: ["voice-channel-tracking", "quote"],
        truncated: ["voice-channel-tracking"],
      },
    });
  });

  it("refuses and audits the attempt when the feature is disabled", async () => {
    await installCommonMocks(false);
    await stubExportService(["{}"], { collections: [], truncated: [] });

    const { captured } = await dispatch("/privacy/export");

    expect(captured.statusCode).toBe(403);
    expect(captured.written).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.export",
      result: "failure",
      details: { reason: "feature-disabled" },
    });
  });

  it("audits a failure when the stream breaks mid-file", async () => {
    await installCommonMocks(true);
    const { UserDataExportService } = await import(
      "../../src/services/user-data-export-service.js"
    );
    jest.spyOn(UserDataExportService, "getInstance").mockReturnValue({
      getMaxItems: async () => 5000,
      streamJson: async function* () {
        yield "{";
        throw new Error("mongo went away");
      },
    } as never);

    const { captured } = await dispatch("/privacy/export");

    // The response is already committed, so the file is simply truncated —
    // the audit row is what records that it happened.
    expect(captured.written).toEqual(["{"]);
    expect(captured.ended).toBe(true);
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.export",
      result: "failure",
      errorMessage: "mongo went away",
    });
  });


  it("stops and audits when the client hangs up mid-stream", async () => {
    await installCommonMocks(true);
    await stubExportService(["{", '"a":1', "}"], {
      collections: ["voice-channel-tracking"],
      truncated: [],
    });

    // The socket is full, so `writeChunk` parks on `drain` — then the reader
    // disconnects. `drain` never fires on a dead socket, so without the
    // `close` release the handler would hang here forever and never audit.
    const { captured } = await dispatch("/privacy/export", {
      backpressure: true,
      onWait: simulateDisconnect,
    });

    // It stopped pulling rather than streaming the rest into the void.
    expect(captured.written).toEqual(["{"]);
    // No end() on a socket that is already gone.
    expect(captured.ended).toBe(false);
    // And the attempt is on the record, marked as not delivered.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "user.privacy.export",
      result: "failure",
      errorMessage: "client disconnected before the export completed",
      details: { aborted: true },
    });
  });

  it("resumes writing once a backpressured socket drains", async () => {
    await installCommonMocks(true);
    await stubExportService(["{", '"a":1', "}"], {
      collections: [],
      truncated: [],
    });

    const { captured } = await dispatch("/privacy/export", {
      backpressure: true,
      onWait: (c) => {
        // Buffer clears: drain fires and write() succeeds from now on.
        c.backpressure = false;
        for (const fn of [...(c.listeners.drain ?? [])]) fn();
      },
    });

    expect(captured.written).toEqual(["{", '"a":1', "}"]);
    expect(captured.ended).toBe(true);
    expect(auditRows[0]).toMatchObject({ result: "success" });
  });

  it("rate-limits repeated downloads from one client", async () => {
    await installCommonMocks(true);
    await stubExportService(["{}"], { collections: [], truncated: [] });

    // The limiter lives on the router instance, so reuse one router (as a
    // real server would) and hit it from the same IP.
    const first = await dispatch("/privacy/export", { ip: "203.0.113.7" });
    const router = first.router;
    for (let i = 0; i < 2; i += 1) {
      await dispatch("/privacy/export", { ip: "203.0.113.7", router });
    }
    const blocked = await dispatch("/privacy/export", {
      ip: "203.0.113.7",
      router,
    });

    expect(first.captured.statusCode).toBe(200);
    expect(blocked.captured.statusCode).toBe(429);
    expect(blocked.captured.written).toEqual([]);
  });
});
