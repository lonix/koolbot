import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import {
  createMetricsRouter,
  isMetricsEnabled,
  metricsAuth,
  metricsHandler,
  recordCommandInvocation,
  registry,
  setVoiceSessionsProvider,
} from "../../src/web/metrics.js";

const ORIGINAL_ENV = { ...process.env };

/** Minimal Express Response double that records what handlers set. */
function mockResponse(): Response & {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
} {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(field: string, value: string) {
      this.headers[field.toLowerCase()] = value;
      return this;
    },
    type(value: string) {
      this.headers["content-type"] = value;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    end(payload?: unknown) {
      if (payload !== undefined) this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    headers: Record<string, string>;
    body?: unknown;
  };
}

/** Express Request double exposing only the `get(header)` accessor. */
function mockRequest(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    get(name: string): string | undefined {
      return lower[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe("web/metrics", () => {
  beforeEach(() => {
    delete process.env.METRICS_ENABLED;
    delete process.env.METRICS_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe("isMetricsEnabled / createMetricsRouter", () => {
    it("is disabled by default and mounts no router", () => {
      expect(isMetricsEnabled()).toBe(false);
      expect(createMetricsRouter()).toBeNull();
    });

    it("mounts a router when METRICS_ENABLED=true", () => {
      process.env.METRICS_ENABLED = "true";
      expect(isMetricsEnabled()).toBe(true);
      expect(createMetricsRouter()).not.toBeNull();
    });
  });

  describe("metricsAuth", () => {
    it("returns 401 when a token is configured and the header is absent", () => {
      process.env.METRICS_TOKEN = "s3cret";
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn() as unknown as NextFunction;

      metricsAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
    });

    it("returns 401 when the bearer token does not match", () => {
      process.env.METRICS_TOKEN = "s3cret";
      const req = mockRequest({ authorization: "Bearer wrong" });
      const res = mockResponse();
      const next = jest.fn() as unknown as NextFunction;

      metricsAuth(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it("calls next() when the bearer token matches", () => {
      process.env.METRICS_TOKEN = "s3cret";
      const req = mockRequest({ authorization: "Bearer s3cret" });
      const res = mockResponse();
      const next = jest.fn() as unknown as NextFunction;

      metricsAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });

    it("calls next() with no auth when no token is configured", () => {
      const req = mockRequest();
      const res = mockResponse();
      const next = jest.fn() as unknown as NextFunction;

      metricsAuth(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("metricsHandler", () => {
    it("renders OpenMetrics text including required series", async () => {
      setVoiceSessionsProvider(() => 3);
      recordCommandInvocation("ping", "ok");

      const req = mockRequest();
      const res = mockResponse();
      await metricsHandler(req, res);

      const body = String(res.body);
      expect(res.headers["content-type"]).toBe(registry.contentType);
      expect(body).toContain("koolbot_command_invocations_total");
      expect(body).toContain('command="ping"');
      expect(body).toContain('status="ok"');
      expect(body).toContain("koolbot_voice_sessions_active 3");
      expect(body).toContain("koolbot_up");
      // Default process metrics from prom-client.
      expect(body).toContain("process_cpu_user_seconds_total");
    });
  });
});
