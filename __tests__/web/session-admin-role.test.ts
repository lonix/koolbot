/**
 * Unit tests for the role-checking session middleware introduced in
 * #481 (`requireAdminRoleMiddleware`). Verifies:
 *
 *   - Admin-role sessions pass through.
 *   - User-role sessions get a 403 HTML page that points at `/me`.
 *   - A missing session collapses to 401 (defensive — the caller is
 *     expected to mount this AFTER `createSessionMiddleware`).
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  requireAdminRoleMiddleware,
  type WebSessionContext,
} from "../../src/web/session.js";

function makeRes(): {
  statusCode: number;
  body: string;
  status: jest.Mock;
  type: jest.Mock;
  send: jest.Mock;
} {
  const res = {
    statusCode: 200,
    body: "",
    status: jest.fn(),
    type: jest.fn(),
    send: jest.fn(),
  } as never as {
    statusCode: number;
    body: string;
    status: jest.Mock;
    type: jest.Mock;
    send: jest.Mock;
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.type.mockImplementation(() => res);
  res.send.mockImplementation((body: unknown) => {
    res.body = typeof body === "string" ? body : String(body);
    return res;
  });
  return res;
}

const baseSession: WebSessionContext = {
  sessionId: "s1",
  discordUserId: "u1",
  guildId: "g1",
  role: "admin",
  scopes: [],
  lastActivityAt: 0,
  expiresAt: new Date(),
};

describe("requireAdminRoleMiddleware", () => {
  it("calls next() for an admin-role session", () => {
    const next = jest.fn();
    const req = { webSession: { ...baseSession, role: "admin" } } as never;
    requireAdminRoleMiddleware()(req, makeRes() as never, next as never);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects a user-role session with a 403 HTML page pointing at /me", () => {
    const next = jest.fn();
    const res = makeRes();
    const req = {
      webSession: { ...baseSession, role: "user" },
    } as never;
    requireAdminRoleMiddleware()(req, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Forbidden");
    expect(res.body).toContain('href="/me/"');
  });

  it("returns 401 (not 403) when no webSession is attached", () => {
    // Defensive: surfaces a mounting bug rather than silently dropping
    // a request through to a handler with no session context.
    const next = jest.fn();
    const res = makeRes();
    const req = {} as never;
    requireAdminRoleMiddleware()(req, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
