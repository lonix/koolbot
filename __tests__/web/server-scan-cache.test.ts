import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  cachedScan,
  peekScan,
  resetScanCache,
  scanCacheKey,
  SCAN_CACHE_TTL_MS,
  SCAN_PENDING_MAX_MS,
} from "../../src/web/server-scan-cache.js";
import type { ServerScan } from "../../src/services/server-scan-service.js";

const scanOf = (name: string): ServerScan => ({ guildName: name }) as never;

/** A clock the test moves by hand. */
function clock(start = 1_000): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (n) => (t = n) };
}

function deferred(): {
  promise: Promise<ServerScan>;
  resolve: (s: ServerScan) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (s: ServerScan) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<ServerScan>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetScanCache());

describe("cachedScan (#1323)", () => {
  it("shares one scan between requests for the same key within the window", async () => {
    const c = clock();
    const load = jest.fn(async () => scanOf("a"));
    const first = await cachedScan("k", load, { now: c.now });
    await flush();
    c.set(1_000 + SCAN_CACHE_TTL_MS - 1);
    const second = await cachedScan("k", load, { now: c.now });
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("scans again once the window has passed", async () => {
    const c = clock();
    const load = jest.fn(async () => scanOf("a"));
    await cachedScan("k", load, { now: c.now });
    await flush();
    c.set(1_000 + SCAN_CACHE_TTL_MS);
    await cachedScan("k", load, { now: c.now });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps sharing a scan that is still running after the window, then starts the window when it finishes", async () => {
    const c = clock();
    const slow = deferred();
    const load = jest.fn(() => slow.promise);
    const first = cachedScan("k", load, { now: c.now });
    // 90 s pass and the scan has not finished: ordinary requests share it.
    c.set(1_000 + 90_000);
    expect(cachedScan("k", load, { now: c.now })).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);

    slow.resolve(scanOf("slow"));
    await flush();
    // The minute counts from the finish (t = 91 000), not from the start.
    c.set(1_000 + 90_000 + SCAN_CACHE_TTL_MS - 1);
    expect(cachedScan("k", load, { now: c.now })).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    c.set(1_000 + 90_000 + SCAN_CACHE_TTL_MS);
    cachedScan("k", load, { now: c.now });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not let a scan that never finishes block the page for good", () => {
    const c = clock();
    const load = jest.fn(() => new Promise<ServerScan>(() => undefined));
    cachedScan("k", load, { now: c.now });
    c.set(1_000 + SCAN_PENDING_MAX_MS - 1);
    cachedScan("k", load, { now: c.now });
    expect(load).toHaveBeenCalledTimes(1);
    c.set(1_000 + SCAN_PENDING_MAX_MS);
    cachedScan("k", load, { now: c.now });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache on refresh and keeps the new scan", async () => {
    const c = clock();
    const load = jest
      .fn<() => Promise<ServerScan>>()
      .mockResolvedValueOnce(scanOf("old"))
      .mockResolvedValueOnce(scanOf("new"));
    await cachedScan("k", load, { now: c.now });
    const fresh = await cachedScan("k", load, { now: c.now, refresh: true });
    expect(fresh?.guildName).toBe("new");
    expect((await cachedScan("k", load, { now: c.now }))?.guildName).toBe(
      "new",
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("is not disturbed when a scan a refresh replaced fails late", async () => {
    const c = clock();
    const old = deferred();
    const load = jest
      .fn<() => Promise<ServerScan>>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(scanOf("new"));
    const first = cachedScan("k", load, { now: c.now });
    first?.catch(() => undefined);
    await cachedScan("k", load, { now: c.now, refresh: true });
    old.reject(new Error("late"));
    await flush();
    expect((await cachedScan("k", load, { now: c.now }))?.guildName).toBe(
      "new",
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("asks admit only when a new scan starts, and does not scan when it refuses", async () => {
    const c = clock();
    const load = jest.fn(async () => scanOf("a"));
    const admit = jest.fn(() => true);
    await cachedScan("k", load, { now: c.now, admit });
    await cachedScan("k", load, { now: c.now, admit });
    await cachedScan("k", load, { now: c.now, admit });
    expect(admit).toHaveBeenCalledTimes(1);
    await cachedScan("k", load, { now: c.now, admit, refresh: true });
    expect(admit).toHaveBeenCalledTimes(2);

    const refuse = jest.fn(() => false);
    expect(cachedScan("other", load, { now: c.now, admit: refuse })).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    // Nothing was stored for the refused request.
    cachedScan("other", load, { now: c.now });
    expect(load).toHaveBeenCalledTimes(3);
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

  it("never keeps a failed scan, whether it rejects or throws", async () => {
    const c = clock();
    const load = jest
      .fn<() => Promise<ServerScan>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockImplementationOnce(() => {
        throw new Error("sync");
      })
      .mockResolvedValueOnce(scanOf("ok"));
    await expect(cachedScan("k", load, { now: c.now })).rejects.toThrow("down");
    await flush();
    await expect(cachedScan("k", load, { now: c.now })).rejects.toThrow("sync");
    await flush();
    expect((await cachedScan("k", load, { now: c.now }))?.guildName).toBe("ok");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("holds a bounded number of scans", async () => {
    const c = clock();
    const load = jest.fn(async () => scanOf("a"));
    for (let i = 0; i < 20; i++) cachedScan(`k${i}`, load, { now: c.now });
    await flush();
    expect(load).toHaveBeenCalledTimes(20);
    // The oldest were evicted, the newest are still shared.
    cachedScan("k19", load, { now: c.now });
    expect(load).toHaveBeenCalledTimes(20);
    cachedScan("k0", load, { now: c.now });
    expect(load).toHaveBeenCalledTimes(21);
  });
});

describe("peekScan (#1322)", () => {
  it("returns a finished fresh scan, and nothing once the window has passed", async () => {
    const c = clock();
    expect(peekScan("k", c.now)).toBeNull();
    const scan = await cachedScan("k", async () => scanOf("a"), { now: c.now });
    await flush();
    expect(peekScan("k", c.now)).toBe(scan);
    c.set(1_000 + SCAN_CACHE_TTL_MS - 1);
    expect(peekScan("k", c.now)).not.toBeNull();
    c.set(1_000 + SCAN_CACHE_TTL_MS);
    expect(peekScan("k", c.now)).toBeNull();
  });

  it("never starts a scan and does not wait for a pending one", async () => {
    expect(peekScan("nothing")).toBeNull();
    const d = deferred();
    void cachedScan("pending", () => d.promise);
    expect(peekScan("pending")).toBeNull();
    d.resolve(scanOf("done"));
    await flush();
    expect(peekScan("pending")?.guildName).toBe("done");
  });

  it("does not return a scan that failed", async () => {
    const d = deferred();
    const pending = cachedScan("bad", () => d.promise);
    d.reject(new Error("no"));
    await pending?.catch(() => undefined);
    await flush();
    expect(peekScan("bad")).toBeNull();
  });
});
