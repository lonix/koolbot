/**
 * GET /admin/adopt (#1323): the tab comes from an allowlist, and the tabs share
 * one scan so clicking through them does not rescan Discord (or trip the page's
 * rate limit) each time.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { Client } from "discord.js";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  type AdminHarness,
} from "./admin-harness.js";
import { busyScan } from "./server-scan-fixtures.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

let configDelayMs = 0;
const slow = async (): Promise<void> => {
  if (configDelayMs) await new Promise((r) => setTimeout(r, configDelayMs));
};

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async (_k: string, d: boolean) => {
        await slow();
        return d;
      }),
      getString: jest.fn(async (_k: string, d: string) => d),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => []),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const { ServerScanService } =
  await import("../../src/services/server-scan-service.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");
const { resetScanCache } = await import("../../src/web/server-scan-cache.js");

let harness: AdminHarness;
let scan: jest.Mock<(guildId: string, opts: unknown) => Promise<unknown>>;

beforeEach(async () => {
  configDelayMs = 0;
  resetScanCache();
  scan = jest.fn(async () => busyScan());
  jest
    .spyOn(ServerScanService, "getInstance")
    .mockReturnValue({ scan } as never);
  harness = await startAdminHarness([
    createReadOnlyRouter(
      {} as unknown as Client,
      stubRequireSession(createTestSession()),
    ),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

const text = async (path: string): Promise<string> =>
  (await harness.get(path)).text();

describe("GET /adopt tabs", () => {
  it("renders the tab named in ?tab= and the Overview for anything else", async () => {
    expect(await text("/adopt?tab=roles")).toContain('id="p-roles"');
    expect(await text("/adopt?tab=channels")).toContain('id="p-channels"');
    expect(await text("/adopt?tab=bots")).toContain("Combined view");
    expect(await text("/adopt?tab=discord")).toContain('id="p-discord"');
    for (const q of ["", "?tab=overview", "?tab=nope", "?tab=%3Cscript%3E"]) {
      const html = await text(`/adopt${q}`);
      expect(html).toContain("Needs fixing");
      expect(html).not.toContain('id="p-roles"');
      expect(html).not.toContain("<script>x");
    }
  });

  it("lists only what ?filter= names on the Channels tab, and everything for anything else (#1364)", async () => {
    const used = await text("/adopt?tab=channels&filter=used");
    expect(used).toContain('aria-current="true">Used by KoolBot');
    expect(used).toContain('<input type="hidden" name="filter" value="used">');
    for (const q of ["", "&filter=all", "&filter=nope", "&filter=%3Cb%3E"]) {
      const html = await text(`/adopt?tab=channels${q}`);
      expect(html).toContain('aria-current="true">All');
      expect(html).not.toContain('name="filter"');
    }
    // One scan is shared across every filter.
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("passes the ownership hints to the scan only when ?sample=1", async () => {
    await text("/adopt");
    await text("/adopt?sample=1");
    // Not "1", so it is the plain scan again (shared from the first request).
    await text("/adopt?sample=true");
    const hints = scan.mock.calls.map(
      (c) => (c[1] as { sampleMessages: boolean }).sampleMessages,
    );
    expect(hints).toEqual([false, true]);
    expect((scan.mock.calls[0][1] as { adminUserId: string }).adminUserId).toBe(
      "admin-1",
    );
  });

  it("scans once for a run of tab clicks, and again on Scan again", async () => {
    await text("/adopt");
    await text("/adopt?tab=roles");
    await text("/adopt?tab=channels");
    await text("/adopt?tab=bots");
    expect(scan).toHaveBeenCalledTimes(1);
    await text("/adopt?tab=roles&refresh=1");
    expect(scan).toHaveBeenCalledTimes(2);
    await text("/adopt?tab=bots");
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("does not remember a failed scan", async () => {
    scan.mockRejectedValueOnce(new Error("Discord is down"));
    expect(await text("/adopt")).toContain("The scan failed: Discord is down.");
    expect(await text("/adopt")).toContain("Needs fixing");
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("does not count tab clicks served from the shared scan against the rate limit", async () => {
    const tabs = [
      "",
      "?tab=roles",
      "?tab=channels",
      "?tab=bots",
      "?tab=discord",
    ];
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push(
        (await harness.get(`/adopt${tabs[i % tabs.length]}`)).status,
      );
    }
    expect(statuses.every((c) => c === 200)).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("still limits scans that start: refreshes are counted, and answer 429 after 15 a minute", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 17; i++) {
      statuses.push((await harness.get("/adopt?refresh=1")).status);
    }
    expect(statuses.slice(0, 15).every((c) => c === 200)).toBe(true);
    expect(statuses.slice(15)).toEqual([429, 429]);
    expect(scan).toHaveBeenCalledTimes(15);
    // A cached tab click is still served while refreshes are throttled.
    expect((await harness.get("/adopt?tab=roles")).status).toBe(200);
  });

  it("counts a failed scan against the limit, since nothing was cached", async () => {
    scan.mockRejectedValue(new Error("down"));
    const statuses: number[] = [];
    for (let i = 0; i < 16; i++) {
      statuses.push((await harness.get("/adopt")).status);
    }
    expect(statuses.slice(0, 15).every((c) => c === 200)).toBe(true);
    expect(statuses[15]).toBe(429);
  });

  it("shares one scan, and one unit of limiter quota, between concurrent cold requests", async () => {
    configDelayMs = 40;
    const tabs = [
      "",
      "?tab=roles",
      "?tab=channels",
      "?tab=bots",
      "?tab=discord",
    ];
    const responses = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        harness.get(`/adopt${tabs[i % tabs.length]}`),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(24).fill(200));
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
