import type { ServerScan } from "../services/server-scan-service.js";

/**
 * A short-lived cache for the Server scan page (#1323).
 *
 * The page has one URL per tab, and every load of it runs a full scan of the
 * guild (with ownership hints, one REST call per channel). Switching between
 * five tabs would otherwise rescan five times and trip the page's rate limit.
 * One scan is shared for a minute per guild, admin and hints setting; the
 * page says when it was read and offers *Scan again* to bypass the cache.
 */

export const SCAN_CACHE_TTL_MS = 60_000;
const MAX_ENTRIES = 8;

interface Entry {
  at: number;
  scan: Promise<ServerScan>;
}

const entries = new Map<string, Entry>();

export function scanCacheKey(
  guildId: string,
  adminUserId: string | undefined,
  sampled: boolean,
): string {
  return `${guildId}:${adminUserId ?? ""}:${sampled ? "sampled" : "plain"}`;
}

/** Whether a fresh scan for `key` is held (or still loading), so a request needs no new one. */
export function hasFreshScan(key: string, now: number = Date.now()): boolean {
  const e = entries.get(key);
  return e !== undefined && now - e.at < SCAN_CACHE_TTL_MS;
}

/**
 * The scan for `key`: the cached one while it is fresh, otherwise `load()`.
 * A failed load is never kept, so the next request tries again.
 */
export function cachedScan(
  key: string,
  load: () => Promise<ServerScan>,
  opts: { refresh?: boolean; now?: number } = {},
): Promise<ServerScan> {
  const now = opts.now ?? Date.now();
  for (const [k, e] of entries) {
    if (now - e.at >= SCAN_CACHE_TTL_MS) entries.delete(k);
  }
  const hit = entries.get(key);
  if (hit && !opts.refresh) return hit.scan;

  const scan = load();
  entries.delete(key);
  entries.set(key, { at: now, scan });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  scan.catch(() => {
    if (entries.get(key)?.scan === scan) entries.delete(key);
  });
  return scan;
}

/** Drop everything; for tests. */
export function resetScanCache(): void {
  entries.clear();
}
