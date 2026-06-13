/**
 * Unit tests for the shared WebUI flash/error helpers (issue #612) and the
 * middleware that now uses them to speak JSON on error paths, so the Settings
 * per-section save surfaces a real message instead of a flat toast.
 */

import { describe, it, expect, jest } from "@jest/globals";
import type { Request, Response } from "express";
import {
  respondFlashError,
  truncateFlash,
  wantsJson,
} from "../../src/web/http-flash.js";
import { requireCsrf, CSRF_COOKIE } from "../../src/web/csrf.js";
import { createRateLimiter } from "../../src/web/rate-limit.js";
import { webErrorStatus, webErrorText } from "../../src/web/index.js";

interface MockResponse {
  statusCode: number;
  body: unknown;
  contentType: string | null;
  status: jest.Mock;
  json: jest.Mock;
  type: jest.Mock;
  send: jest.Mock;
  setHeader: jest.Mock;
  headers: Record<string, unknown>;
}

function makeRes(): MockResponse {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    contentType: null as string | null,
    headers: {} as Record<string, unknown>,
    status: jest.fn(),
    json: jest.fn(),
    type: jest.fn(),
    send: jest.fn(),
    setHeader: jest.fn(),
  } as MockResponse;
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json.mockImplementation((data: unknown) => {
    res.body = data;
    return res;
  });
  res.type.mockImplementation((t: string) => {
    res.contentType = t;
    return res;
  });
  res.send.mockImplementation((data: unknown) => {
    res.body = data;
    return res;
  });
  res.setHeader.mockImplementation((name: string, value: unknown) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  });
  return res;
}

/** Minimal request stub exposing the bits the helpers/middleware read. */
function makeReq(opts: {
  headers?: Record<string, string>;
  method?: string;
  cookie?: string;
  body?: Record<string, unknown>;
}): Request {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return {
    method: opts.method ?? "POST",
    body: opts.body ?? {},
    headers,
    ip: "203.0.113.1",
    socket: { remoteAddress: "203.0.113.1" },
    get(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe("respondFlashError (issue #612)", () => {
  it("returns JSON {type:'err',text} with the real status for AJAX callers", () => {
    const res = makeRes();
    respondFlashError(
      makeReq({ headers: { "X-Requested-With": "fetch" } }),
      res as unknown as Response,
      500,
      "boom",
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ type: "err", text: "boom" });
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.send).not.toHaveBeenCalled();
  });

  it("falls back to plain text for non-JSON callers", () => {
    const res = makeRes();
    respondFlashError(makeReq({}), res as unknown as Response, 403, "nope");
    expect(res.statusCode).toBe(403);
    expect(res.contentType).toBe("text/plain");
    expect(res.body).toBe("nope");
    expect(res.json).not.toHaveBeenCalled();
  });

  it("caps the surfaced text via truncateFlash", () => {
    const res = makeRes();
    respondFlashError(
      makeReq({ headers: { Accept: "application/json" } }),
      res as unknown as Response,
      413,
      "x".repeat(800),
    );
    const text = (res.body as { text: string }).text;
    expect(text.length).toBe(500);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("requireCsrf JSON error responses (issue #612)", () => {
  it("returns a JSON error when the token is missing for an AJAX request", () => {
    const res = makeRes();
    const next = jest.fn();
    requireCsrf(
      makeReq({ headers: { "X-Requested-With": "fetch" } }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ type: "err" });
    expect((res.body as { text: string }).text).toContain("CSRF");
  });

  it("returns a JSON error on token mismatch for an AJAX request", () => {
    const res = makeRes();
    const next = jest.fn();
    requireCsrf(
      makeReq({
        headers: { "X-Requested-With": "fetch", "x-csrf-token": "bbbb" },
        cookie: `${CSRF_COOKIE}=aaaa`,
      }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ type: "err" });
    expect((res.body as { text: string }).text).toContain("mismatch");
  });

  it("still returns plain text for a no-JS form POST", () => {
    const res = makeRes();
    const next = jest.fn();
    requireCsrf(makeReq({}), res as unknown as Response, next);
    expect(res.statusCode).toBe(403);
    expect(res.contentType).toBe("text/plain");
    expect(res.json).not.toHaveBeenCalled();
  });

  it("passes through a valid matching token", () => {
    const res = makeRes();
    const next = jest.fn();
    requireCsrf(
      makeReq({
        headers: { "x-csrf-token": "match" },
        cookie: `${CSRF_COOKIE}=match`,
      }),
      res as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("createRateLimiter JSON error responses (issue #612)", () => {
  it("returns a JSON 429 (with Retry-After) for AJAX callers over the limit", () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      keyName: "test",
    });
    const next = jest.fn();
    // First hit passes.
    limiter(
      makeReq({ headers: { "X-Requested-With": "fetch" } }),
      makeRes() as unknown as Response,
      next,
    );
    // Second hit is over the limit.
    const res = makeRes();
    limiter(
      makeReq({ headers: { "X-Requested-With": "fetch" } }),
      res as unknown as Response,
      next,
    );
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ type: "err" });
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("webErrorStatus / webErrorText (router error handler, issue #612)", () => {
  it("uses a body-parser error's status (e.g. payload-too-large 413)", () => {
    expect(webErrorStatus({ status: 413, type: "entity.too.large" })).toBe(413);
    expect(webErrorStatus({ statusCode: 400 })).toBe(400);
  });

  it("falls back to 500 for an unhandled error", () => {
    expect(webErrorStatus(new Error("db exploded"))).toBe(500);
    expect(webErrorStatus(null)).toBe(500);
    expect(webErrorStatus({ status: 200 })).toBe(500);
  });

  it("returns a sanitized, status-specific message without leaking internals", () => {
    expect(webErrorText(413)).toMatch(/too large/i);
    expect(webErrorText(400)).toMatch(/malformed/i);
    expect(webErrorText(403)).toContain("(403)");
    const five = webErrorText(500);
    expect(five).toMatch(/unexpected server error/i);
    expect(five).not.toMatch(/db exploded|stack|Error:/i);
  });
});

describe("wantsJson / truncateFlash (re-homed in http-flash, issue #612)", () => {
  it("detects the fetch sentinel and Accept header", () => {
    expect(
      wantsJson(makeReq({ headers: { "X-Requested-With": "fetch" } })),
    ).toBe(true);
    expect(
      wantsJson(makeReq({ headers: { Accept: "application/json" } })),
    ).toBe(true);
    expect(wantsJson(makeReq({}))).toBe(false);
  });

  it("falls back to the `header` alias when `get` is absent", () => {
    // Some Express-like stubs (and our own /me route test mocks) expose only
    // `.header`, not `.get`. wantsJson must still negotiate correctly.
    const headerOnly = {
      header: (name: string) =>
        name.toLowerCase() === "x-requested-with" ? "fetch" : undefined,
    };
    expect(wantsJson(headerOnly)).toBe(true);

    const headerOnlyAccept = {
      header: (name: string) =>
        name.toLowerCase() === "accept" ? "application/json" : undefined,
    };
    expect(wantsJson(headerOnlyAccept)).toBe(true);

    const headerOnlyPlain = {
      header: (): string | undefined => undefined,
    };
    expect(wantsJson(headerOnlyPlain)).toBe(false);
  });

  it("truncates only when over the cap", () => {
    expect(truncateFlash("short")).toBe("short");
    expect(truncateFlash("y".repeat(600)).length).toBe(500);
  });
});
