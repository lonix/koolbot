/**
 * Integration tests for login-CSRF protection on the magic-link redemption
 * route `POST /admin/s/:token` (issue #771).
 *
 * The URL-bound token gates access to *a* valid identity, but on its own it
 * does nothing against login CSRF: an attacker auto-submitting a cross-site
 * POST that carries *their own* valid token from the victim's browser would
 * plant the attacker's session in that browser. The double-submit CSRF token
 * blocks that — a cross-site page can't read the victim's `koolbot_csrf`
 * cookie to forge a matching `_csrf`.
 *
 * We spin up the real router on an ephemeral port and drive it with `fetch`,
 * managing cookies by hand so both the same-site (legitimate) and cross-site
 * (forged) shapes are exercised end-to-end. `WebSessionService.peek/redeem`
 * are stubbed so no Mongo connection is needed.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import express from "express";
import type { AddressInfo } from "net";
import { createServer, type Server } from "http";
import { createWebRouter } from "../../src/web/index.js";
import { WebSessionService } from "../../src/services/web-session-service.js";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "test-secret-for-redeem-csrf-tests-0123456789";

let server: Server;
let baseUrl: string;

function startServer(): Promise<void> {
  const app = express();
  // Mounted at /admin to match production so the consent form's action and
  // the CSRF cookie path (`/`) line up with the routes under test.
  app.use("/admin", createWebRouter({} as never));
  return new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Pull a cookie's value out of a Set-Cookie header list. */
function readCookie(setCookies: string[], name: string): string | undefined {
  for (const line of setCookies) {
    const match = line.match(new RegExp(`^${name}=([^;]*)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return undefined;
}

describe("POST /admin/s/:token login-CSRF protection (#771)", () => {
  beforeEach(async () => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_BASE_URL = "http://127.0.0.1";
    (WebSessionService as unknown as { instance: unknown }).instance = null;

    const svc = WebSessionService.getInstance();
    jest.spyOn(svc, "peek").mockResolvedValue({
      sessionId: "s1",
      discordUserId: "attacker-1",
      guildId: "g1",
      role: "user",
      scopes: [],
    } as unknown as never);
    jest.spyOn(svc, "redeem").mockResolvedValue({
      sessionId: "s1",
      discordUserId: "attacker-1",
      guildId: "g1",
      role: "user",
      scopes: [],
    } as unknown as never);

    await startServer();
  });

  afterEach(async () => {
    await stopServer();
    jest.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("GET consent page sets a CSRF cookie and mirrors it into the form", async () => {
    const res = await fetch(`${baseUrl}/admin/s/tok`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();
    const csrf = readCookie(setCookies, "koolbot_csrf");
    expect(csrf).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(
      `<input type="hidden" name="_csrf" value="${csrf}">`,
    );
  });

  it("rejects a cross-site POST with no CSRF token (403, no session cookie)", async () => {
    const res = await fetch(`${baseUrl}/admin/s/tok`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(res.status).toBe(403);
    // The attacker's identity must NOT be planted into the browser.
    const setCookies = res.headers.getSetCookie();
    expect(readCookie(setCookies, "koolbot_session")).toBeUndefined();
  });

  it("rejects a forged POST whose _csrf doesn't match the cookie (login CSRF)", async () => {
    // Attacker knows *a* koolbot_csrf value is required but can't read the
    // victim's cookie, so the mirrored token can't match.
    const res = await fetch(`${baseUrl}/admin/s/tok`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "koolbot_csrf=victim-cookie-value",
      },
      body: "_csrf=attacker-guessed-value",
    });
    expect(res.status).toBe(403);
    const setCookies = res.headers.getSetCookie();
    expect(readCookie(setCookies, "koolbot_session")).toBeUndefined();
  });

  it("accepts the legitimate same-site POST (matching cookie + _csrf) and writes the session", async () => {
    // Step 1: GET the consent page to obtain the CSRF cookie + form token.
    const getRes = await fetch(`${baseUrl}/admin/s/tok`, {
      redirect: "manual",
    });
    const csrf = readCookie(getRes.headers.getSetCookie(), "koolbot_csrf")!;
    expect(csrf).toBeTruthy();

    // Step 2: submit the form same-site, echoing the cookie + hidden field.
    const postRes = await fetch(`${baseUrl}/admin/s/tok`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `koolbot_csrf=${encodeURIComponent(csrf)}`,
      },
      body: `_csrf=${encodeURIComponent(csrf)}`,
    });
    expect(postRes.status).toBe(302);
    expect(postRes.headers.get("location")).toBe("/me/");
    const session = readCookie(
      postRes.headers.getSetCookie(),
      "koolbot_session",
    );
    expect(session).toBeTruthy();
  });
});
