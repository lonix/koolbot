/**
 * HTTP harness for the WebUI's admin write surface (issue #849).
 *
 * `__tests__/web/redeem-csrf.test.ts` established the pattern — mount the
 * real Express router on an ephemeral port and drive it with `fetch` — but
 * it was the only suite doing it, so the entire admin write surface (the
 * *only* admin surface per the Web-UI-only design decision) sat at ~10%
 * coverage with no route-handler tests at all. This module is the shared
 * harness those tests were missing.
 *
 * It deliberately imports **nothing** from `src/`: suites register their
 * service mocks with `jest.unstable_mockModule` and then `await import()`
 * the routers and middleware, so anything this file pulled in statically
 * would load before those mocks and defeat them. Callers hand the built
 * handlers in instead.
 */

import express, { type RequestHandler } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { WebSessionContext } from "../../src/web/session.js";

/**
 * Fixed double-submit token used by the harness. `requireCsrf` compares the
 * `koolbot_csrf` cookie with the `_csrf` body field, so a constant on both
 * sides passes; tests that care about the *failure* modes override one side.
 */
export const TEST_CSRF_TOKEN = "harness-csrf-token";

/** A session context in the shape `requireSession` would have attached. */
export function createTestSession(
  overrides: Partial<WebSessionContext> = {},
): WebSessionContext {
  return {
    sessionId: "session-1",
    discordUserId: "admin-1",
    guildId: "guild-1",
    role: "admin",
    scopes: [],
    lastActivityAt: Date.now(),
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

/**
 * Stand-in for `createSessionMiddleware` that attaches a fixed context
 * without touching Mongo. Pass `null` to simulate an unauthenticated
 * request so the downstream role check takes its defensive branch.
 */
export function stubRequireSession(
  session: WebSessionContext | null,
): RequestHandler {
  return (req, _res, next): void => {
    if (session) {
      (req as express.Request & { webSession?: WebSessionContext }).webSession =
        session;
    }
    next();
  };
}

/** The flash a write handler redirected with, parsed out of `Location`. */
export interface ParsedFlash {
  path: string;
  type: string | null;
  msg: string | null;
  invalid: string[];
}

/** Parse a 303 flash redirect's `Location` into its path and flash parts. */
export function parseFlashRedirect(location: string | null): ParsedFlash {
  const [path, query = ""] = (location ?? "").split("?");
  const params = new globalThis.URLSearchParams(query);
  const invalid = params.get("invalid");
  return {
    path,
    type: params.get("flash"),
    msg: params.get("msg"),
    invalid: invalid ? invalid.split(",") : [],
  };
}

export interface PostOptions {
  /** Value sent in the `_csrf` body field. Defaults to the cookie value. */
  csrfField?: string | null;
  /** Value sent in the `koolbot_csrf` cookie. */
  csrfCookie?: string | null;
  /** Ask for the JSON reply shape the progressively-enhanced saves use. */
  json?: boolean;
  headers?: Record<string, string>;
}

export interface AdminHarness {
  baseUrl: string;
  /**
   * POST a form body to `<mountPath><path>`, carrying a matching CSRF
   * cookie + `_csrf` field by default. Array values are repeated, which is
   * how `<select multiple>` posts.
   */
  post(
    path: string,
    body?: Record<string, string | string[] | undefined>,
    options?: PostOptions,
  ): Promise<Response>;
  /** GET a path (used to assert that write routers don't answer GETs). */
  get(path: string): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Mount `handlers` on an ephemeral-port Express app and return a client for
 * it. `express.urlencoded` is installed first so handlers see a parsed
 * `req.body`, matching how `createWebRouter` composes the real app.
 */
export async function startAdminHarness(
  handlers: RequestHandler[],
  mountPath = "/admin",
): Promise<AdminHarness> {
  const app = express();
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));
  for (const handler of handlers) app.use(mountPath, handler);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    async post(path, body = {}, options = {}): Promise<Response> {
      const cookieToken =
        options.csrfCookie === undefined ? TEST_CSRF_TOKEN : options.csrfCookie;
      const fieldToken =
        options.csrfField === undefined ? cookieToken : options.csrfField;

      const params = new globalThis.URLSearchParams();
      if (fieldToken !== null) params.append("_csrf", fieldToken);
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const entry of value) params.append(key, entry);
        } else {
          params.append(key, value);
        }
      }

      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
        ...(options.json ? { "x-requested-with": "fetch" } : {}),
        ...options.headers,
      };
      if (cookieToken !== null) {
        headers.cookie = `koolbot_csrf=${encodeURIComponent(cookieToken)}`;
      }

      return fetch(`${baseUrl}${mountPath}${path}`, {
        method: "POST",
        redirect: "manual",
        headers,
        body: params.toString(),
      });
    },
    async get(path): Promise<Response> {
      return fetch(`${baseUrl}${mountPath}${path}`, { redirect: "manual" });
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
