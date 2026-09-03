/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * End-to-end accessibility checks against real HTTP responses (issue #856).
 *
 * `a11y-axe.test.ts` scans the renderers directly, which covers the markup.
 * This suite covers the wiring around it: that the pages a browser actually
 * receives — through the router, the CSRF cookie layer and the error handler —
 * are still whole documents with a `lang`, landmarks and labelled controls.
 * It reuses the harness from `redeem-csrf.test.ts`: the real router on an
 * ephemeral port, with `WebSessionService.peek/redeem` stubbed so no Mongo
 * connection is needed.
 *
 * `color-contrast` is disabled for the same reason as in the renderer scan —
 * jsdom does no layout. `a11y-contrast.test.ts` gates the palette instead.
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
import { createServer, request, type Server } from "http";
import { axe, toHaveNoViolations } from "jest-axe";
import { createUserWebRouter, createWebRouter } from "../../src/web/index.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { PermissionsService } from "../../src/services/permissions-service.js";

expect.extend(toHaveNoViolations);

const ORIGINAL_ENV = { ...process.env };
const SECRET = "test-secret-for-a11y-route-tests-0123456789";
const AXE_OPTIONS = { rules: { "color-contrast": { enabled: false } } };
const AXE_TIMEOUT_MS = 30_000;

let server: Server;
let baseUrl: string;

function startServer(): Promise<void> {
  const app = express();
  app.use("/admin", createWebRouter({} as never));
  app.use("/me", createUserWebRouter({} as never));
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

interface HttpResult {
  status: number;
  setCookies: string[];
  body: string;
}

/**
 * Minimal HTTP client over `node:http`. The jsdom test environment provides
 * neither `fetch` nor the `TextDecoder` undici needs, and the requests here
 * are three lines of plain GET/POST, so this beats polyfilling either.
 */
function httpRequest(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  const url = new URL(`${baseUrl}${path}`);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method ?? "GET",
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            setCookies: res.headers["set-cookie"] ?? [],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function readCookie(setCookies: string[], name: string): string | undefined {
  for (const line of setCookies) {
    const match = line.match(new RegExp(`^${name}=([^;]*)`));
    if (match) return decodeURIComponent(match[1]);
  }
  return undefined;
}

/**
 * Install a served document into jsdom and run axe over it. `lang` lives on
 * `<html>`, which `innerHTML` can't carry, so it is mirrored explicitly —
 * otherwise `html-has-lang` would pass vacuously.
 */
async function expectNoViolations(html: string): Promise<void> {
  document.documentElement.innerHTML = html
    .replace(/^<!doctype html>/i, "")
    .replace(/^<html[^>]*>/i, "")
    .replace(/<\/html>$/i, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const lang = html.match(/<html[^>]*\slang="([^"]*)"/)?.[1];
  if (lang === undefined) {
    document.documentElement.removeAttribute("lang");
  } else {
    document.documentElement.setAttribute("lang", lang);
  }
  const results = await axe(document.documentElement, AXE_OPTIONS);
  expect(results).toHaveNoViolations();
}

/** Redeem the stubbed magic link and return the resulting session cookie. */
async function signIn(): Promise<string> {
  const getRes = await httpRequest("/admin/s/tok");
  const csrf = readCookie(getRes.setCookies, "koolbot_csrf")!;
  const body = `_csrf=${encodeURIComponent(csrf)}`;
  const postRes = await httpRequest("/admin/s/tok", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(Buffer.byteLength(body)),
      cookie: `koolbot_csrf=${encodeURIComponent(csrf)}`,
    },
    body,
  });
  const session = readCookie(postRes.setCookies, "koolbot_session")!;
  expect(session).toBeTruthy();
  return `koolbot_session=${encodeURIComponent(session)}`;
}

describe("WebUI accessibility over HTTP (#856)", () => {
  beforeEach(async () => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_BASE_URL = "http://127.0.0.1";
    (WebSessionService as unknown as { instance: unknown }).instance = null;

    const svc = WebSessionService.getInstance();
    const context = {
      sessionId: "s1",
      discordUserId: "u1",
      guildId: "g1",
      role: "user",
      scopes: [],
    };
    jest.spyOn(svc, "peek").mockResolvedValue(context as unknown as never);
    jest.spyOn(svc, "redeem").mockResolvedValue(context as unknown as never);
    // The session middleware re-reads the DB row on every request and
    // re-checks the `config` permission; both are stubbed so the suite needs
    // neither Mongo nor a Discord client.
    jest.spyOn(svc, "findById").mockResolvedValue({
      ...context,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    } as unknown as never);
    jest
      .spyOn(PermissionsService.prototype, "checkCommandPermission")
      .mockResolvedValue(true as never);

    await startServer();
  });

  afterEach(async () => {
    await stopServer();
    jest.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it(
    "serves an accessible consent page",
    async () => {
      const res = await httpRequest("/admin/s/tok");
      expect(res.status).toBe(200);
      await expectNoViolations(res.body);
    },
    AXE_TIMEOUT_MS,
  );

  it(
    "serves an accessible error page when the session is missing",
    async () => {
      const res = await httpRequest("/admin/");
      expect(res.status).toBe(401);
      await expectNoViolations(res.body);
    },
    AXE_TIMEOUT_MS,
  );

  it(
    "serves accessible /me pages to a redeemed session",
    async () => {
      const cookie = await signIn();
      for (const path of ["/me/", "/me/notifications", "/me/timezone"]) {
        const res = await httpRequest(path, { headers: { cookie } });
        expect(res.status).toBe(200);
        await expectNoViolations(res.body);
      }
    },
    AXE_TIMEOUT_MS,
  );
});
