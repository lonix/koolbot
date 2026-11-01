/**
 * The session ping must not renew the session in the REAL router (#1635).
 *
 * `createWebRouter` mounts the write router first, and that router starts
 * with `requireSession`, which renews the session. A ping route that only
 * lives inside the read-only router is therefore never reached before the
 * renewal, and the banner's own pings kept an idle admin session alive.
 * These tests go through `createWebRouter` and `createUserWebRouter`, the
 * mount the bot really uses, not through a router mounted on its own.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { Buffer } from "buffer";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { signValue } from "../../src/web/cookies.js";

const SECRET = "test-secret-for-session-ping-mount";
const ORIGINAL_ENV = { ...process.env };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);

process.env.WEBUI_SESSION_SECRET = SECRET;

const { WebSessionService } =
  await import("../../src/services/web-session-service.js");
const { PermissionsService } =
  await import("../../src/services/permissions-service.js");
const { createWebRouter, createUserWebRouter } =
  await import("../../src/web/index.js");

function cookieFor(role: "admin" | "user", act: number): string {
  const payload = {
    sid: "sid-1",
    uid: "u-1",
    gid: "g-1",
    rol: role,
    iat: T0,
    act,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `koolbot_session=${encodeURIComponent(signValue(encoded, SECRET))}`;
}

let nowMs = T0;
let server: Server;
let base = "";

beforeAll(async () => {
  const client = {} as never;
  const app = express();
  app.use("/admin", createWebRouter(client));
  app.use("/me", createUserWebRouter(client));
  server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
  process.env.WEBUI_SESSION_LIFETIME_HOURS = "24";
  process.env.WEBUI_BASE_URL = "http://example.test:3000";
  nowMs = T0;
  (WebSessionService as unknown as { instance: unknown }).instance = null;
  jest.spyOn(WebSessionService.getInstance(), "findById").mockImplementation(
    async () =>
      ({
        discordUserId: "u-1",
        guildId: "g-1",
        role: "admin",
        scopes: [],
        revokedAt: null,
        expiresAt: new Date(T0 + 24 * HOUR),
      }) as never,
  );
  jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
    checkCommandPermission: async () => true,
    isAdministrator: async () => true,
    resolveWebScopes: async () => ["member"],
  } as never);
  jest.spyOn(Date, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

function sessionCookiesSet(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((c) => c.startsWith("koolbot_session=") || c.includes("_session="));
}

describe.each([
  { name: "admin", role: "admin" as const, ping: "/admin/session/ping" },
  { name: "/me", role: "user" as const, ping: "/me/session/ping" },
])("the $name ping through the real router", ({ role, ping }) => {
  it("never writes a session cookie and never moves the deadline", async () => {
    const cookie = cookieFor(role, T0);
    const left: number[] = [];
    for (const minute of [5, 10, 15, 20, 25]) {
      nowMs = T0 + minute * MINUTE;
      const res = await fetch(`${base}${ping}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(sessionCookiesSet(res)).toEqual([]);
      left.push(((await res.json()) as { remainingMs: number }).remainingMs);
    }
    // The deadline stays at T0 + 30 minutes: each ping sees less time.
    expect(left).toEqual([25, 20, 15, 10, 5].map((m) => m * MINUTE));
  });

  it("answers 401 once the idle window has passed, pings or not", async () => {
    const cookie = cookieFor(role, T0);
    for (const minute of [10, 20, 29]) {
      nowMs = T0 + minute * MINUTE;
      expect(
        (await fetch(`${base}${ping}`, { headers: { cookie } })).status,
      ).toBe(200);
    }
    nowMs = T0 + 30 * MINUTE + 1000;
    const res = await fetch(`${base}${ping}`, { headers: { cookie } });
    expect(res.status).toBe(401);
  });
});
