/**
 * No `/admin` route is reachable with a host or moderator scope (#1316).
 *
 * The scopes only widen what a `/me` session may do; the admin console is
 * gated by `role === "admin"` and nothing else. This walks EVERY route the two
 * admin routers register (the write router and the read-only router, composed
 * the way `createWebRouter` composes them), and sends each one with `user`
 * sessions that hold every scope combination. Each must be refused with a 403,
 * on every method it registers. The walk reads the live route table, so a page
 * added later is covered without touching this test; a mount shape the walker
 * cannot follow fails the test instead of being skipped.
 *
 * Each router is also probed ALONE: composed, the write router's gate answers
 * every path first, which would hide a missing gate on the read-only router.
 *
 * Not walked: the three routes `createWebRouter` adds around these two
 * (`GET/POST /s/:token`, the magic-link sign-in; `POST /finish`, which ends the
 * caller's own session; `/session/ping`, a status poll). They are not admin
 * pages and take no scope.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { RequestHandler, Router } from "express";
import {
  startAdminHarness,
  createTestSession,
  type AdminHarness,
} from "./admin-harness.js";
import type { WebSessionContext } from "../../src/web/session.js";

process.env.WEBUI_SESSION_SECRET = "test-secret-for-admin-scope-refusal";

const { createWriteRouter } = await import("../../src/web/write-routes.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");

interface WalkedRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
}

interface Layer {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  slash?: boolean;
  name?: string;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Turn a registered path pattern into a concrete request path. */
function concretePath(pattern: unknown): string {
  if (typeof pattern !== "string") {
    throw new Error(`unsupported route pattern: ${String(pattern)}`);
  }
  return pattern
    .replace(/[{}]/g, "")
    .replace(/[:*][A-Za-z0-9_]+/g, "x1")
    .replace(/\/{2,}/g, "/");
}

/** Every (method, path) the router registers, following prefix-less sub-routers. */
function walk(router: Router): WalkedRoute[] {
  const out: WalkedRoute[] = [];
  const visit = (stack: Layer[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        const path = concretePath(layer.route.path);
        const methods = layer.route.methods;
        for (const m of METHODS) {
          if (methods[m.toLowerCase()] || methods._all) {
            out.push({ method: m, path });
          }
        }
        continue;
      }
      const inner = layer.handle?.stack;
      if (Array.isArray(inner)) {
        if (layer.slash !== true) {
          throw new Error(
            "a sub-router is mounted on a prefix; teach the walker the prefix",
          );
        }
        visit(inner);
      }
    }
  };
  visit((router as unknown as { stack: Layer[] }).stack);
  return out;
}

let current: WebSessionContext | null = null;
let routes: WalkedRoute[] = [];
let writeRoutes: WalkedRoute[] = [];
let readRoutes: WalkedRoute[] = [];
let harness: AdminHarness;
let writeOnly: AdminHarness;
let readOnly: AdminHarness;

const stubSession: RequestHandler = (req, _res, next): void => {
  if (current) Object.assign(req, { webSession: current });
  next();
};

beforeAll(async () => {
  const write = createWriteRouter({} as never, stubSession);
  const read = createReadOnlyRouter({} as never, stubSession);
  writeRoutes = walk(write);
  readRoutes = walk(read);
  routes = [...writeRoutes, ...readRoutes];
  harness = await startAdminHarness([write, read], "/admin");
  // The same routers again, each mounted alone (a router instance can be
  // mounted on several apps).
  writeOnly = await startAdminHarness([write], "/admin");
  readOnly = await startAdminHarness([read], "/admin");
});

afterAll(async () => {
  await harness.close();
  await writeOnly.close();
  await readOnly.close();
});

async function send(
  route: WalkedRoute,
  target: AdminHarness = harness,
): Promise<number> {
  const res =
    route.method === "GET"
      ? await target.get(route.path)
      : await fetch(`${target.baseUrl}/admin${route.path}`, {
          method: route.method,
          redirect: "manual",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "",
        });
  return res.status;
}

const SCOPE_SETS: Array<[string, WebSessionContext["scopes"]]> = [
  ["member only", ["member"]],
  ["host", ["member", "host"]],
  ["moderator", ["member", "moderator"]],
  ["host and moderator", ["member", "host", "moderator"]],
];

describe("the admin routers refuse host and moderator scopes (#1316)", () => {
  it("walks a real, non-trivial route table", () => {
    expect(routes.length).toBeGreaterThan(100);
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(keys.has("GET /")).toBe(true);
    expect(keys.has("POST /settings/save-section")).toBe(true);
    // Both routers contribute.
    expect(routes.some((r) => r.method === "POST")).toBe(true);
    expect(routes.some((r) => r.method === "GET")).toBe(true);
  });

  it.each(SCOPE_SETS)(
    "refuses every registered admin route for a user session: %s",
    async (_name, scopes) => {
      current = createTestSession({
        discordUserId: "u-1",
        guildId: "guild-1",
        role: "user",
        scopes,
      });
      const allowed: string[] = [];
      for (const route of routes) {
        const status = await send(route);
        if (status !== 403) {
          allowed.push(`${route.method} ${route.path} -> ${status}`);
        }
      }
      expect(allowed).toEqual([]);
    },
    120_000,
  );

  it.each(SCOPE_SETS)(
    "refuses every route of each router on its own: %s",
    async (_name, scopes) => {
      current = createTestSession({
        discordUserId: "u-1",
        guildId: "guild-1",
        role: "user",
        scopes,
      });
      expect(writeRoutes.length).toBeGreaterThan(50);
      expect(readRoutes.length).toBeGreaterThan(20);
      const allowed: string[] = [];
      for (const route of writeRoutes) {
        const status = await send(route, writeOnly);
        if (status !== 403) allowed.push(`write ${route.method} ${route.path}`);
      }
      // `/session/ping` is registered ahead of the gate on purpose: it only
      // reports the caller's own remaining session time (no admin data).
      for (const route of readRoutes.filter(
        (r) => r.path !== "/session/ping",
      )) {
        const status = await send(route, readOnly);
        if (status !== 403) allowed.push(`read ${route.method} ${route.path}`);
      }
      expect(allowed).toEqual([]);
    },
    120_000,
  );

  it("answers 401 to an unauthenticated request", async () => {
    current = null;
    for (const route of routes.slice(0, 25)) {
      expect(await send(route)).toBe(401);
    }
  });

  it("a session carrying a forged admin scope is still not an admin", async () => {
    current = createTestSession({
      discordUserId: "u-1",
      guildId: "guild-1",
      role: "user",
      scopes: ["member", "host", "moderator", "admin"] as never,
    });
    for (const route of routes.slice(0, 25)) {
      expect(await send(route)).toBe(403);
    }
  });

  it("the walker would notice an open route: an admin session is not refused", async () => {
    // Control for the walk: the 403s above come from the role gate, not from
    // the harness. An admin session gets past the gate on a cheap route (it
    // reaches the handler; whatever the handler answers, it is not the gate's
    // 403).
    current = createTestSession({
      discordUserId: "u-1",
      guildId: "guild-1",
      role: "admin",
      scopes: [],
    });
    const candidates = routes.filter((r) => r.method === "GET").slice(0, 40);
    let passed = false;
    for (const route of candidates) {
      if ((await send(route)) !== 403) {
        passed = true;
        break;
      }
    }
    expect(passed).toBe(true);
  }, 60_000);
});
