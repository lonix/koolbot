/**
 * An idle Web UI session ends, on both surfaces (#1635).
 *
 * The owner left the Web UI open overnight and still had a session. These
 * tests prove the server half of the answer with a clock they control and the
 * REAL middleware and routers (over HTTP, on an ephemeral port): 30 minutes
 * and one second without a real request is a 401 and a cleared cookie on a
 * protected page, on `/admin/session/ping` and on `/me/session/ping`; the
 * hard cap refuses a session whatever its cookie's `act` says; a ping never
 * writes a cookie; and over plain `http` the cookie has the name, flags and
 * `Max-Age` the code intends.
 *
 * They pass without any change to the middleware: they are proof that the
 * server side is correct, not a fix for it.
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

const SECRET = "test-secret-for-session-idle-expiry";
const ORIGINAL_ENV = { ...process.env };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);

process.env.WEBUI_SESSION_SECRET = SECRET;

const { WebSessionService } =
  await import("../../src/services/web-session-service.js");
const { PermissionsService } =
  await import("../../src/services/permissions-service.js");
const { createSessionMiddleware, readSessionCookie } =
  await import("../../src/web/session.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");
const { createUserRouter } = await import("../../src/web/user-routes.js");

function cookieFor(
  name: string,
  act: number,
  role: "admin" | "user",
  iat = T0,
): string {
  const payload = { sid: "sid-1", uid: "u-1", gid: "g-1", rol: role, iat, act };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${name}=${encodeURIComponent(signValue(encoded, SECRET))}`;
}

let nowMs = T0;
let expiresAt = new Date(T0 + 24 * HOUR);
let server: Server;
let base = "";

function mockRow(): void {
  jest.spyOn(WebSessionService.getInstance(), "findById").mockImplementation(
    async () =>
      ({
        discordUserId: "u-1",
        guildId: "g-1",
        role: "admin",
        scopes: [],
        revokedAt: null,
        expiresAt,
      }) as never,
  );
}

beforeAll(async () => {
  const client = {} as never;
  const requireSession = createSessionMiddleware(client);
  const app = express();
  app.use("/admin", createReadOnlyRouter(client, requireSession));
  app.use("/me", createUserRouter(client, requireSession));
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
  expiresAt = new Date(T0 + 24 * HOUR);
  (WebSessionService as unknown as { instance: unknown }).instance = null;
  mockRow();
  jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
    checkCommandPermission: async () => true,
    isAdministrator: async () => true,
    resolveWebScopes: async () => ["member"],
  } as never);
  // Only the clock is faked, so the HTTP server's own timers keep working.
  jest.spyOn(Date, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

async function get(path: string, cookie: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { cookie }, redirect: "manual" });
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

const SURFACES = [
  {
    name: "admin",
    role: "admin" as const,
    ping: "/admin/session/ping",
    // A protected page that needs nothing but the session to answer 401.
    page: "/admin/bootstrap",
  },
  {
    name: "/me",
    role: "user" as const,
    ping: "/me/session/ping",
    page: "/me/",
  },
];

describe.each(SURFACES)("an idle session on $name", (s) => {
  const cookie = (act: number): string =>
    cookieFor("koolbot_session", act, s.role);

  it("is refused with a 401 and a cleared cookie after 30 minutes and 1 second without a request", async () => {
    nowMs = T0 + 30 * MINUTE + 1000;
    const res = await get(s.page, cookie(T0));
    expect(res.status).toBe(401);
    const cleared = setCookies(res).filter((c) =>
      c.startsWith("koolbot_session="),
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toContain("Max-Age=0");
    expect(cleared[0]).toContain("Path=/");
    expect(cleared[0]).toMatch(/^koolbot_session=;/);
  });

  it("is refused after a whole night (8 hours) of silence, however many tabs are open", async () => {
    nowMs = T0 + 8 * HOUR;
    for (let tab = 0; tab < 3; tab++) {
      const res = await get(s.page, cookie(T0));
      expect(res.status).toBe(401);
    }
  });

  it("is refused when the cookie's own act is older than the window, although the row is live", async () => {
    nowMs = T0 + 2 * HOUR;
    // The row's hard cap is 22 hours away; only the cookie says it was idle.
    const res = await get(s.page, cookie(T0 + 60 * MINUTE));
    expect(res.status).toBe(401);
  });

  it("is still served at 29 minutes 59 seconds, and the cookie is renewed with act = now", async () => {
    nowMs = T0 + 30 * MINUTE - 1000;
    // Only the middleware is under test here, not the page body.
    const res = await get(s.page, cookie(T0));
    expect(res.status).not.toBe(401);
    const renewed = setCookies(res).find((c) =>
      c.startsWith("koolbot_session="),
    );
    expect(renewed).toContain("Max-Age=1800");
  });

  it("answers the ping with a 401 and no-store after 30 minutes and 1 second, and never writes a cookie", async () => {
    nowMs = T0 + 30 * MINUTE + 1000;
    const res = await get(s.ping, cookie(T0));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(setCookies(res)).toEqual([]);
  });

  it("answers a live ping with 200 and does not renew the session (no Set-Cookie)", async () => {
    nowMs = T0 + 10 * MINUTE;
    const res = await get(s.ping, cookie(T0));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { remainingMs: number };
    expect(body.remainingMs).toBe(20 * MINUTE);
    expect(setCookies(res)).toEqual([]);
    // A second ping 5 minutes later counts down from the SAME act.
    nowMs = T0 + 15 * MINUTE;
    const again = (await (await get(s.ping, cookie(T0))).json()) as {
      remainingMs: number;
    };
    expect(again.remainingMs).toBe(15 * MINUTE);
  });

  it("refuses a session past its hard cap whatever the cookie's act says, on a page and on the ping", async () => {
    // Active a second ago, but the row's expiresAt is in the past.
    nowMs = T0 + 25 * HOUR;
    expiresAt = new Date(T0 + 24 * HOUR);
    const fresh = cookie(nowMs - 1000);
    expect((await get(s.page, fresh)).status).toBe(401);
    expect((await get(s.ping, fresh)).status).toBe(401);
  });

  it("caps the ping's remaining time at the hard cap when it ends first", async () => {
    nowMs = T0 + 24 * HOUR - 5 * MINUTE;
    const res = await get(s.ping, cookie(nowMs - 1000));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { remainingMs: number }).remainingMs).toBe(
      5 * MINUTE,
    );
  });
});

describe("the session cookie over plain http and over https (#1635)", () => {
  async function renewedCookieHeader(
    name: string,
    act = T0,
    role: "admin" | "user" = "admin",
  ): Promise<string[]> {
    nowMs = T0 + MINUTE;
    const res = await get("/me/", cookieFor(name, act, role));
    return setCookies(res);
  }

  it("uses the bare name, no Secure flag and Max-Age = the window when WEBUI_BASE_URL is http", async () => {
    process.env.WEBUI_BASE_URL = "http://example.test:3000";
    const set = await renewedCookieHeader("koolbot_session");
    const session = set.find((c) => c.startsWith("koolbot_session="));
    expect(session).toBeDefined();
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=lax");
    expect(session).toContain("Path=/");
    expect(session).toContain("Max-Age=1800");
    expect(session).not.toContain("Secure");
    expect(set.some((c) => c.startsWith("__Host-"))).toBe(false);
  });

  it("reads Max-Age from WEBUI_INACTIVITY_TIMEOUT_MINUTES (seconds, not milliseconds)", async () => {
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "7";
    const set = await renewedCookieHeader("koolbot_session");
    expect(set.find((c) => c.startsWith("koolbot_session="))).toContain(
      "Max-Age=420",
    );
  });

  it("uses __Host-, Secure and the same Max-Age when WEBUI_BASE_URL is https", async () => {
    process.env.WEBUI_BASE_URL = "https://example.test";
    const set = await renewedCookieHeader("__Host-koolbot_session");
    const session = set.find((c) => c.startsWith("__Host-koolbot_session="));
    expect(session).toBeDefined();
    expect(session).toContain("Secure");
    expect(session).toContain("Path=/");
    expect(session).toContain("Max-Age=1800");
  });

  it("over http a request that carries only a __Host- cookie has no session (the name is not read)", async () => {
    process.env.WEBUI_BASE_URL = "http://example.test:3000";
    nowMs = T0 + MINUTE;
    const res = await get(
      "/me/",
      cookieFor("__Host-koolbot_session", T0, "user"),
    );
    expect(res.status).toBe(401);
  });

  it("clears both spellings over https and only the bare name over http", async () => {
    nowMs = T0 + 8 * HOUR;
    process.env.WEBUI_BASE_URL = "http://example.test:3000";
    const overHttp = await get(
      "/me/",
      cookieFor("koolbot_session", T0, "user"),
    );
    expect(setCookies(overHttp).map((c) => c.split("=")[0])).toEqual([
      "koolbot_session",
    ]);

    process.env.WEBUI_BASE_URL = "https://example.test";
    const overHttps = await get(
      "/me/",
      cookieFor("__Host-koolbot_session", T0, "user"),
    );
    expect(
      setCookies(overHttps)
        .map((c) => c.split("=")[0])
        .sort(),
    ).toEqual(["__Host-koolbot_session", "koolbot_session"]);
  });

  it("readSessionCookie keeps the cookie's act and iat as signed", () => {
    const req = {
      headers: {
        cookie: cookieFor("koolbot_session", T0 + 5, "admin", T0 + 1),
      },
    } as never;
    expect(readSessionCookie(req)).toMatchObject({ act: T0 + 5, iat: T0 + 1 });
  });
});
