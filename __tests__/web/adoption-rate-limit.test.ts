/**
 * Rate limits on the server-adoption surface (#1184), driven over HTTP on an
 * ephemeral port with the real limiter, plus a check that the read-only
 * router really mounts the scan limiter in front of `GET /admin/adopt`.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import express from "express";
import type { AddressInfo } from "net";
import { createServer, type Server } from "http";

const { createAdoptionLimitsRouter, createAdoptionScanLimiter } =
  await import("../../src/web/adoption-rate-limit.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");

let server: Server | undefined;

async function start(): Promise<string> {
  const app = express();
  app.use(createAdoptionLimitsRouter());
  app.all(/.*/, (_req, res) => {
    res.status(204).end();
  });
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
});

/** Send `n` requests; resolve to the status codes in order. */
async function burst(
  base: string,
  method: string,
  path: string,
  n: number,
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push((await fetch(`${base}${path}`, { method })).status);
  }
  return out;
}

describe("adoption write limiter", () => {
  it.each([
    "/adopt/claims/apply",
    "/adopt/events/apply",
    "/adopt/history/abc/restore",
    "/role-groups/g1/delete-role/apply",
    "/role-groups/apply",
    "/rules/apply",
  ])("throttles POST %s after 30 requests a minute", async (path) => {
    const base = await start();
    const codes = await burst(base, "POST", path, 31);
    expect(codes.slice(0, 30).every((c) => c === 204)).toBe(true);
    expect(codes[30]).toBe(429);
    const blocked = await fetch(`${base}${path}`, { method: "POST" });
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("shares one bucket across the adoption write routes", async () => {
    const base = await start();
    await burst(base, "POST", "/rules/post", 15);
    await burst(base, "POST", "/role-groups/apply", 15);
    expect(
      (await fetch(`${base}/adopt/claims/apply`, { method: "POST" })).status,
    ).toBe(429);
  });

  it("leaves other write routes and plain page reads alone", async () => {
    const base = await start();
    await burst(base, "POST", "/adopt/claims/apply", 31);
    expect(
      (await fetch(`${base}/settings/set`, { method: "POST" })).status,
    ).toBe(204);
    expect(
      (await burst(base, "GET", "/role-groups", 40)).every((c) => c === 204),
    ).toBe(true);
    expect((await burst(base, "GET", "/adopt/history", 40)).at(-1)).toBe(204);
  });

  it("counts mixed-case, doubled-slash and trailing-slash spellings in the same bucket", async () => {
    // Express matches routes case-insensitively, so these reach the handlers.
    const base = await start();
    const spellings = [
      "/ADOPT/claims/apply",
      "/Adopt/Claims/Apply/",
      "/adopt//claims/apply",
      "/Role-Groups/apply",
      "/RULES/apply",
    ];
    for (let i = 0; i < 30; i += 1) {
      await fetch(`${base}${spellings[i % spellings.length]}`, {
        method: "POST",
      });
    }
    for (const path of spellings) {
      expect((await fetch(`${base}${path}`, { method: "POST" })).status).toBe(
        429,
      );
    }
    expect(
      (await fetch(`${base}/adopt/claims/apply`, { method: "POST" })).status,
    ).toBe(429);
  });

  it("does not let a look-alike path prefix into the bucket", async () => {
    const base = await start();
    const codes = await burst(base, "POST", "/adopted-things", 40);
    expect(codes.every((c) => c === 204)).toBe(true);
  });
});

describe("adoption scan limiter", () => {
  it.each(["/adopt/claims", "/adopt/events", "/adopt/claims/"])(
    "throttles GET %s after 15 requests a minute",
    async (path) => {
      const base = await start();
      const codes = await burst(base, "GET", path, 16);
      expect(codes.slice(0, 15).every((c) => c === 204)).toBe(true);
      expect(codes[15]).toBe(429);
    },
  );

  it("throttles mixed-case spellings of the scan pages in the same bucket", async () => {
    const base = await start();
    const spellings = ["/adopt/claims", "/ADOPT/Claims", "/Adopt/CLAIMS/"];
    for (let i = 0; i < 15; i += 1) {
      await fetch(`${base}${spellings[i % spellings.length]}`);
    }
    for (const path of [...spellings, "/adopt/events"]) {
      const status = (await fetch(`${base}${path}`)).status;
      // /adopt/events has its own page but shares the scan bucket.
      expect(status).toBe(429);
    }
  });

  it("is mounted in front of GET /admin/adopt on the read-only router", async () => {
    const router = createReadOnlyRouter(
      {} as never,
      ((_req: unknown, _res: unknown, next: () => void) => next()) as never,
    ) as unknown as {
      stack: Array<{
        route?: { path: string; methods: object; stack: unknown[] };
      }>;
    };
    const layer = router.stack.find(
      (l) => l.route?.path === "/adopt" && "get" in l.route.methods,
    );
    expect(layer).toBeDefined();
    // The limiter runs ahead of the handler that scans Discord.
    expect(layer!.route!.stack).toHaveLength(2);
  });

  it("the scan limiter answers 429 once its bucket is spent", async () => {
    const app = express();
    app.get("/adopt", createAdoptionScanLimiter(), (_req, res) => {
      res.status(204).end();
    });
    await new Promise<void>((resolve) => {
      server = createServer(app);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const codes = await burst(base, "GET", "/adopt", 16);
    expect(codes.at(-1)).toBe(429);
    expect(codes.slice(0, 15).every((c) => c === 204)).toBe(true);
  });
});
