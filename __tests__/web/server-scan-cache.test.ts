import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  cachedScan,
  resetScanCache,
  scanCacheKey,
  SCAN_CACHE_TTL_MS,
} from "../../src/web/server-scan-cache.js";
import type { ServerScan } from "../../src/services/server-scan-service.js";

const scanOf = (name: string): ServerScan => ({ guildName: name }) as never;

beforeEach(() => resetScanCache());

describe("cachedScan (#1323)", () => {
  it("shares one scan between requests for the same key within the window", async () => {
    const load = jest.fn(async () => scanOf("a"));
    const first = await cachedScan("k", load, { now: 1_000 });
    const second = await cachedScan("k", load, { now: 1_000 + 59_999 });
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("scans again once the window has passed", async () => {
    const load = jest.fn(async () => scanOf("a"));
    await cachedScan("k", load, { now: 1_000 });
    await cachedScan("k", load, { now: 1_000 + SCAN_CACHE_TTL_MS });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache on refresh and keeps the new scan", async () => {
    const load = jest
      .fn<() => Promise<ServerScan>>()
      .mockResolvedValueOnce(scanOf("old"))
      .mockResolvedValueOnce(scanOf("new"));
    await cachedScan("k", load, { now: 1_000 });
    const fresh = await cachedScan("k", load, { now: 2_000, refresh: true });
    expect(fresh.guildName).toBe("new");
    expect((await cachedScan("k", load, { now: 3_000 })).guildName).toBe("new");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps guilds, admins and hints apart", () => {
    const keys = new Set([
      scanCacheKey("g1", "u1", false),
      scanCacheKey("g1", "u1", true),
      scanCacheKey("g1", "u2", false),
      scanCacheKey("g2", "u1", false),
    ]);
    expect(keys.size).toBe(4);
  });

  it("never keeps a failed scan", async () => {
    const load = jest
      .fn<() => Promise<ServerScan>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(scanOf("ok"));
    await expect(cachedScan("k", load, { now: 1_000 })).rejects.toThrow("down");
    await Promise.resolve();
    expect((await cachedScan("k", load, { now: 1_001 })).guildName).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("holds a bounded number of scans", async () => {
    const load = jest.fn(async () => scanOf("a"));
    for (let i = 0; i < 20; i++)
      await cachedScan(`k${i}`, load, { now: 1_000 });
    expect(load).toHaveBeenCalledTimes(20);
    // The oldest were evicted, the newest are still shared.
    await cachedScan("k19", load, { now: 1_000 });
    expect(load).toHaveBeenCalledTimes(20);
    await cachedScan("k0", load, { now: 1_000 });
    expect(load).toHaveBeenCalledTimes(21);
  });
});
