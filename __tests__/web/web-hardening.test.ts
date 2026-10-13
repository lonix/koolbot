/**
 * Web UI hardening (#1149 response headers, #1150 session-bound CSRF and
 * cookie handling). Runs the real routers over HTTP on an ephemeral port with
 * the session service and permission check stubbed, like `redeem-csrf.test.ts`.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import express, { type Request } from "express";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "net";
import { createServer, type Server } from "http";
import { createUserWebRouter, createWebRouter } from "../../src/web/index.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import { signValue, parseCookies } from "../../src/web/cookies.js";
import { flashRedirectQuery } from "../../src/web/routes/write/helpers.js";
import { deriveCsrfToken } from "../../src/web/csrf.js";
import { CONFIRM_SCRIPT } from "../../src/web/html.js";
import { addNonce, buildCsp } from "../../src/web/security-headers.js";
import { signFlash, verifyFlashSignature } from "../../src/web/http-flash.js";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "test-secret-for-web-hardening-0123456789";
const CLIENT = {} as never;

let server: Server;
let baseUrl: string;

function startServer(): Promise<void> {
  const app = express();
  app.use("/admin", createWebRouter(CLIENT));
  app.use("/me", createUserWebRouter(CLIENT));
  return new Promise((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

function sessionCookieValue(sid = "s1", secret = SECRET): string {
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      sid,
      uid: "u1",
      gid: "g1",
      rol: "user",
      iat: now - 1000,
      act: now - 1000,
    }),
  ).toString("base64url");
  return encodeURIComponent(signValue(payload, secret));
}

function sessionCookieName(): string {
  return process.env.WEBUI_BASE_URL?.startsWith("https://")
    ? "__Host-koolbot_session"
    : "koolbot_session";
}

async function get(
  p: string,
  cookie?: string,
): Promise<{ res: Response; body: string }> {
  const res = await fetch(`${baseUrl}${p}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { res, body: await res.text() };
}

async function post(
  p: string,
  fields: Record<string, string>,
  cookie?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: new globalThis.URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

async function setup(baseUrlEnv: string): Promise<void> {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.WEBUI_BASE_URL = baseUrlEnv;
  (WebSessionService as unknown as { instance: unknown }).instance = null;
  PermissionsService.reset();
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
  jest.spyOn(svc, "findById").mockResolvedValue({
    ...context,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  } as unknown as never);
  jest
    .spyOn(PermissionsService.prototype, "checkCommandPermission")
    .mockResolvedValue(true as never);
  await startServer();
}

async function teardown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  PermissionsService.reset();
  jest.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
}

function expectHardened(res: Response, body: string): void {
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("object-src 'none'");
  // Scripts only by nonce; never a blanket inline allowance for scripts.
  const scriptSrc = csp
    .split(";")
    .find((d) => d.trim().startsWith("script-src"));
  expect(scriptSrc).toMatch(/^\s*script-src 'nonce-[A-Za-z0-9+/=]+'$/);
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-powered-by")).toBeNull();

  // Every inline script carries this response's nonce, and nothing relies
  // on an inline event handler the policy would block.
  const nonce = /'nonce-([^']+)'/.exec(csp)![1];
  const tags = body.match(/<script\b[^>]*>/gi) ?? [];
  for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
  expect(body).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
}

describe("Web UI response headers (#1149)", () => {
  beforeEach(() => setup("http://127.0.0.1"));
  afterEach(teardown);

  it("hardens the consent page and gives each response its own nonce", async () => {
    const a = await get("/admin/s/tok");
    const b = await get("/admin/s/tok");
    expect(a.res.status).toBe(200);
    expectHardened(a.res, a.body);
    expectHardened(b.res, b.body);
    expect(a.res.headers.get("content-security-policy")).not.toBe(
      b.res.headers.get("content-security-policy"),
    );
  });

  it("hardens the unauthenticated 401 page", async () => {
    const { res, body } = await get("/admin/");
    expect(res.status).toBe(401);
    expectHardened(res, body);
  });

  it("hardens signed-in /me pages, including their inline scripts", async () => {
    const cookie = `${sessionCookieName()}=${sessionCookieValue()}`;
    for (const p of ["/me/", "/me/notifications", "/me/timezone"]) {
      const { res, body } = await get(p, cookie);
      expect(res.status).toBe(200);
      expect(body).toContain("<script nonce=");
      expectHardened(res, body);
    }
  });

  it("sends no HSTS over a plain-HTTP base URL", async () => {
    const { res } = await get("/admin/s/tok");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("admin pages under the CSP (#1149)", () => {
  beforeEach(async () => {
    await setup("http://127.0.0.1");
    jest
      .spyOn(PermissionsService.prototype, "isAdministrator")
      .mockResolvedValue(true as never);
    (
      WebSessionService.getInstance().findById as unknown as jest.Mock<
        () => Promise<unknown>
      >
    ).mockResolvedValue({
      sessionId: "s1",
      discordUserId: "u1",
      guildId: "g1",
      role: "admin",
      scopes: [],
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
    } as unknown as never);
  });
  afterEach(teardown);

  it("serves nonce'd scripts and a working confirm handler on real admin pages", async () => {
    const now = Date.now();
    const payload = Buffer.from(
      JSON.stringify({
        sid: "s1",
        uid: "u1",
        gid: "g1",
        rol: "admin",
        iat: now,
        act: now,
      }),
    ).toString("base64url");
    const cookie = `koolbot_session=${encodeURIComponent(signValue(payload, SECRET))}`;
    for (const p of [
      "/admin/",
      "/admin/settings",
      "/admin/digest",
      "/admin/voice-channels",
      "/admin/birthdays",
    ]) {
      const { res, body } = await get(p, cookie);
      expect(res.status).toBe(200);
      expectHardened(res, body);
      expect((body.match(/<script nonce=/g) ?? []).length).toBeGreaterThan(3);
      // Every admin page ships the delegated handler that the
      // `data-confirm` destructive forms rely on (no inline handlers).
      expect(body).toContain(CONFIRM_SCRIPT);
    }
  });
});

describe("Web UI response headers over HTTPS (#1149)", () => {
  beforeEach(() => setup("https://admin.example.com"));
  afterEach(teardown);

  it("sends a conservative HSTS (no includeSubDomains, no preload)", async () => {
    const { res } = await get("/admin/s/tok");
    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toBe("max-age=15552000");
    expect(hsts).not.toMatch(/includeSubDomains|preload/i);
  });
});

describe("CSP helpers (#1149)", () => {
  it("adds the nonce to script tags only", () => {
    expect(addNonce("<script>a()</script><scripts>x</scripts>", "N")).toBe(
      '<script nonce="N">a()</script><scripts>x</scripts>',
    );
  });

  it("never adds a nonce to escaped user text", () => {
    const escaped = "&lt;script&gt;alert(1)&lt;/script&gt;";
    expect(addNonce(escaped, "N")).toBe(escaped);
  });

  it("builds a policy with a nonce script-src and no script unsafe-inline", () => {
    const csp = buildCsp("abc");
    expect(csp).toContain("script-src 'nonce-abc'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});

describe("no inline event handlers remain in Web UI markup (#1149)", () => {
  function listTs(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return listTs(full);
      return e.name.endsWith(".ts") ? [full] : [];
    });
  }

  it("keeps data-confirm out of the layout-less consent/error pages", () => {
    // Only admin-layout and user-layout ship CONFIRM_SCRIPT; views.ts renders
    // the standalone pages and must not rely on it.
    const views = fs.readFileSync(path.resolve("src/web/views.ts"), "utf8");
    expect(views).not.toContain("data-confirm");
  });

  it("has no on*= attribute or javascript: URL in any src/web template", () => {
    const offenders: string[] = [];
    for (const file of listTs(path.resolve("src/web"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(
        /\son(submit|click|change|input|load|error|keydown|keyup|focus|blur)\s*=\s*["']|javascript:/gi,
      )) {
        offenders.push(`${path.relative(process.cwd(), file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("signed flash messages (#1149)", () => {
  it("flash redirects carry a verifiable signature", () => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    const qs = new globalThis.URLSearchParams(
      flashRedirectQuery({ type: "ok", text: "Saved." }),
    );
    expect(verifyFlashSignature("ok", qs.get("msg")!, qs.get("sig"))).toBe(
      true,
    );
  });

  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("verifies only the exact type and text that were signed", () => {
    const sig = signFlash("err", "Saved.");
    expect(verifyFlashSignature("err", "Saved.", sig)).toBe(true);
    expect(verifyFlashSignature("err", "Session expired.", sig)).toBe(false);
    expect(verifyFlashSignature("ok", "Saved.", sig)).toBe(false);
    expect(verifyFlashSignature("err", "Saved.", undefined)).toBe(false);
    expect(verifyFlashSignature("err", "Saved.", "")).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    const sig = signFlash("ok", "x");
    delete process.env.WEBUI_SESSION_SECRET;
    expect(verifyFlashSignature("ok", "x", sig)).toBe(false);
  });
});

describe("session-bound CSRF (#1150)", () => {
  beforeEach(() => setup("http://127.0.0.1"));
  afterEach(teardown);

  const formBody = (b: string): string | undefined =>
    /name="_csrf" value="([^"]+)"/.exec(b)?.[1];

  it("renders the session-derived token and sets no CSRF cookie when signed in", async () => {
    const cookie = `koolbot_session=${sessionCookieValue()}`;
    const { res, body } = await get("/me/notifications", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join("\n")).not.toContain("koolbot_csrf");
    expect(formBody(body)).toBe(deriveCsrfToken("s1"));
  });

  it("derives different tokens for different sessions and secrets", () => {
    expect(deriveCsrfToken("s1")).not.toBe(deriveCsrfToken("s2"));
    const a = deriveCsrfToken("s1");
    process.env.WEBUI_SESSION_SECRET = "another-secret-0123456789abcdef";
    expect(deriveCsrfToken("s1")).not.toBe(a);
  });

  it("a planted matching cookie + _csrf pair no longer passes for a signed-in session", async () => {
    const cookie = `koolbot_session=${sessionCookieValue()}; koolbot_csrf=planted`;
    const res = await post("/me/notifications", { _csrf: "planted" }, cookie);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("CSRF token mismatch");
  });

  it("accepts the derived token with no CSRF cookie at all (existing sessions keep working)", async () => {
    const cookie = `koolbot_session=${sessionCookieValue()}`;
    const res = await post(
      "/me/notifications",
      { _csrf: deriveCsrfToken("s1")! },
      cookie,
    );
    expect(res.status).not.toBe(403);
  });

  it("accepts the derived token in the header too", async () => {
    const cookie = `koolbot_session=${sessionCookieValue()}`;
    const res = await post("/me/notifications", {}, cookie, {
      "x-csrf-token": deriveCsrfToken("s1")!,
    });
    expect(res.status).not.toBe(403);
  });

  it("rejects another session's token", async () => {
    const cookie = `koolbot_session=${sessionCookieValue("s1")}`;
    const res = await post(
      "/me/notifications",
      { _csrf: deriveCsrfToken("s2")! },
      cookie,
    );
    expect(res.status).toBe(403);
  });

  it("does not trust a forged session cookie", async () => {
    // A cookie signed with the wrong secret is not a session: the derived
    // token path is not unlocked and the session middleware refuses it.
    const forged = `koolbot_session=${sessionCookieValue("s1", "attacker-secret-0123456789")}`;
    const res = await post(
      "/me/notifications",
      { _csrf: deriveCsrfToken("s1")! },
      forged,
    );
    expect(res.status).toBe(401);
  });

  it("keeps the double-submit cookie for the pre-sign-in consent POST", async () => {
    const first = await get("/admin/s/tok");
    const csrf = /koolbot_csrf=([^;]+)/.exec(
      first.res.headers.getSetCookie().join("\n"),
    )![1];
    expect(formBody(first.body)).toBe(decodeURIComponent(csrf));
    const bad = await post(
      "/admin/s/tok",
      { _csrf: "x" },
      `koolbot_csrf=${csrf}`,
    );
    expect(bad.status).toBe(403);
    const ok = await post(
      "/admin/s/tok",
      { _csrf: decodeURIComponent(csrf) },
      `koolbot_csrf=${csrf}`,
    );
    expect(ok.status).not.toBe(403);
  });
});

describe("__Host- cookies over HTTPS (#1150)", () => {
  beforeEach(() => setup("https://admin.example.com"));
  afterEach(teardown);

  it("issues the pre-sign-in CSRF cookie with the __Host- prefix", async () => {
    const { res } = await get("/admin/s/tok");
    const line = res.headers
      .getSetCookie()
      .find((c) => c.includes("koolbot_csrf"))!;
    expect(line).toMatch(/^__Host-koolbot_csrf=/);
    expect(line).toContain("Secure");
    expect(line).toContain("Path=/");
    expect(line).not.toMatch(/Domain=/i);
  });

  it("only reads the __Host- session cookie, ignoring a planted bare one", async () => {
    const planted = `koolbot_session=${sessionCookieValue()}`;
    const { res } = await get("/me/", planted);
    expect(res.status).toBe(401);
    const real = `__Host-koolbot_session=${sessionCookieValue()}`;
    expect((await get("/me/", real)).res.status).toBe(200);
  });
});

describe("parseCookies first-wins (#1150)", () => {
  const req = (cookie: string): Request =>
    ({ headers: { cookie } }) as unknown as Request;

  it("keeps the first of duplicate names", () => {
    const jar = parseCookies(req("a=real; b=1; a=tossed"));
    expect(jar.get("a")).toBe("real");
    expect(jar.get("b")).toBe("1");
  });
});
