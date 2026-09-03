/**
 * Gating tests for the composed admin write router (issue #849).
 *
 * Per the Web-UI-only design decision the write surface is the *entire*
 * admin surface, and everything it exposes sits behind exactly three
 * middleware installed at one mount point (`src/web/write-routes.ts`):
 * `requireSession` → the admin-role check → `requireCsrf`. These tests
 * drive the real composed router over HTTP so that ordering — and each
 * rejection's status, content type and body — is pinned down.
 *
 * No service mocks are needed: every request here is rejected before any
 * domain handler runs, which is precisely the property under test.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { createWriteRouter } from "../../src/web/write-routes.js";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  type AdminHarness,
} from "./admin-harness.js";
import type { Client } from "discord.js";
import type { WebSessionContext } from "../../src/web/session.js";

const client = { user: { id: "bot" } } as unknown as Client;

/** A representative write route from each end of the mount order. */
const WRITE_PATHS = [
  "/settings/set",
  "/permissions/set",
  "/events/create",
  "/database/run-cleanup",
  "/bot-status/refresh",
];

async function harnessFor(
  session: WebSessionContext | null,
): Promise<AdminHarness> {
  return startAdminHarness([
    createWriteRouter(client, stubRequireSession(session)),
  ]);
}

describe("admin write router — session gating", () => {
  let harness: AdminHarness;

  afterEach(async () => {
    await harness?.close();
    jest.restoreAllMocks();
  });

  it("answers 401 (not 403) when no session was attached", async () => {
    harness = await harnessFor(null);
    const res = await harness.post("/permissions/set", { command: "ping" });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("text/html");
    await expect(res.text()).resolves.toContain("Sign in required");
  });

  it("rejects every write path for an unauthenticated caller", async () => {
    harness = await harnessFor(null);
    for (const path of WRITE_PATHS) {
      const res = await harness.post(path);
      expect([401, 403]).toContain(res.status);
    }
  });

  it("answers 403 for a user-role session and points it at /me", async () => {
    harness = await harnessFor(createTestSession({ role: "user" }));
    const res = await harness.post("/permissions/set", { command: "ping" });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("Forbidden");
    expect(body).toContain("/me/");
  });

  it("checks the role before CSRF, so a user-role session can't probe it", async () => {
    // A user-role session with no CSRF material at all must still get the
    // role's 403 HTML — not the CSRF handler's text/plain reply, which
    // would tell a non-admin that the route exists and what it wants.
    harness = await harnessFor(createTestSession({ role: "user" }));
    const res = await harness.post(
      "/permissions/set",
      { command: "ping" },
      { csrfCookie: null, csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    await expect(res.text()).resolves.not.toContain("CSRF");
  });
});

describe("admin write router — CSRF gating", () => {
  let harness: AdminHarness;

  beforeEach(async () => {
    harness = await startAdminHarness([
      createWriteRouter(client, stubRequireSession(createTestSession())),
    ]);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("rejects a POST with no CSRF cookie or field", async () => {
    const res = await harness.post(
      "/permissions/set",
      { command: "ping" },
      { csrfCookie: null, csrfField: null },
    );
    expect(res.status).toBe(403);
    await expect(res.text()).resolves.toContain("CSRF token missing");
  });

  it("rejects a POST whose _csrf does not match the cookie", async () => {
    const res = await harness.post(
      "/permissions/set",
      { command: "ping" },
      { csrfCookie: "cookie-value", csrfField: "forged-value" },
    );
    expect(res.status).toBe(403);
    await expect(res.text()).resolves.toContain("CSRF token mismatch");
  });

  it("rejects a same-length-but-different token (constant-time compare path)", async () => {
    const res = await harness.post(
      "/permissions/set",
      { command: "ping" },
      { csrfCookie: "aaaaaaaa", csrfField: "bbbbbbbb" },
    );
    expect(res.status).toBe(403);
    await expect(res.text()).resolves.toContain("CSRF token mismatch");
  });

  it("gives AJAX callers a JSON error instead of text/plain (#612)", async () => {
    const res = await harness.post(
      "/permissions/set",
      { command: "ping" },
      { csrfCookie: null, csrfField: null, json: true },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({ type: "err" });
  });

  it("guards every write path, not just the one under test", async () => {
    for (const path of WRITE_PATHS) {
      const res = await harness.post(
        path,
        {},
        { csrfCookie: null, csrfField: null },
      );
      expect(res.status).toBe(403);
    }
  });

  it("does not answer GET requests — the write surface is POST-only", async () => {
    for (const path of WRITE_PATHS) {
      const res = await harness.get(path);
      expect(res.status).toBe(404);
    }
  });
});
