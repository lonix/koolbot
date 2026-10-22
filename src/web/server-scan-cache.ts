import type { ServerScan } from "../services/server-scan-service.js";

/**
 * A short-lived cache for the Server scan page (#1323).
 *
 * The page has one URL per tab, and every load of it runs a full scan of the
 * guild (with ownership hints, one REST call per channel). Switching between
 * five tabs would otherwise rescan five times and trip the page's rate limit.
 * One scan is shared for a minute per guild, admin and hints setting; the
 * page says when it was read and offers *Scan again* to bypass the cache.
 *
 * An entry is *pending* while its scan runs and *done* once it has succeeded:
 *  - a pending scan is shared by everyone who asks, however long it takes,
 *    until it finishes or `MAX_PENDING_MS` passes (so a hung read cannot
 *    block the page for good);
 *  - the minute starts when the scan finishes, not when it starts, so a slow
 *    scan is not already stale when it arrives;
 *  - a failed scan is dropped at once, so the next request tries again.
 */

export const SCAN_CACHE_TTL_MS = 60_000;
export const SCAN_PENDING_MAX_MS = 5 * 60_000;
/**
 * How long the Dashboard keeps listing the problems of the last finished scan
 * (#1415), counted from when that scan finished. Longer than the minute a scan
 * is shared for, because the Dashboard never starts one: a minute would leave
 * its rows empty almost always. Short enough that a problem the admin has
 * since fixed does not linger for long; the rows say how old the scan is and
 * link to *Scan again*. It is only ever read, never a reason to skip a scan.
 */
export const DASHBOARD_SCAN_RETENTION_MS = 30 * 60_000;
const MAX_ENTRIES = 8;

interface Entry {
  scan: Promise<ServerScan>;
  startedAt: number;
  /** When the scan succeeded; null while it is pending. */
  doneAt: number | null;
  /** The finished scan, kept so `peekScan` can read it without waiting. */
  value: ServerScan | null;
}

const entries = new Map<string, Entry>();

/**
 * The last finished scan per key, kept apart from `entries` so the one-minute
 * sharing window above does not also bound what the Dashboard may mention.
 * `cachedScan` never serves from here.
 */
interface Retained {
  scan: ServerScan;
  startedAt: number;
  doneAt: number;
}
const retained = new Map<string, Retained>();

function retain(
  key: string,
  scan: ServerScan,
  startedAt: number,
  doneAt: number,
): void {
  const prev = retained.get(key);
  // A slow scan that started before the kept one, but finished after it, read
  // older data and must not replace it.
  if (prev && prev.startedAt > startedAt) return;
  for (const [k, r] of retained) {
    if (doneAt - r.doneAt >= DASHBOARD_SCAN_RETENTION_MS) retained.delete(k);
  }
  retained.delete(key);
  retained.set(key, { scan, startedAt, doneAt });
  while (retained.size > MAX_ENTRIES) {
    const oldest = retained.keys().next().value;
    if (oldest === undefined) break;
    retained.delete(oldest);
  }
}

export function scanCacheKey(
  guildId: string,
  adminUserId: string | undefined,
  sampled: boolean,
): string {
  return `${guildId}:${adminUserId ?? ""}:${sampled ? "sampled" : "plain"}`;
}

function usable(e: Entry, now: number): boolean {
  return e.doneAt === null
    ? now - e.startedAt < SCAN_PENDING_MAX_MS
    : now - e.doneAt < SCAN_CACHE_TTL_MS;
}

export interface CachedScanOptions {
  /** Bypass the cache and scan again. */
  refresh?: boolean;
  /** The clock; a function so the finish time of a slow scan is read when it finishes. */
  now?: () => number;
  /**
   * Called synchronously, only when a new scan is about to start, so whatever
   * it spends (the rate limit) is spent for scans and not for cache hits.
   * Returning `false` refuses the scan and `cachedScan` returns `null`.
   */
  admit?: () => boolean;
}

/**
 * The scan for `key`: the shared one while it is pending or fresh, otherwise a
 * new one from `load()`. Returns `null` when a new scan was needed and `admit`
 * refused it. Nothing here awaits, so the check, `admit` and the insertion
 * cannot interleave with another request.
 */
export function cachedScan(
  key: string,
  load: () => Promise<ServerScan>,
  opts: CachedScanOptions = {},
): Promise<ServerScan> | null {
  const clock = opts.now ?? Date.now;
  const now = clock();
  for (const [k, e] of entries) {
    if (!usable(e, now)) entries.delete(k);
  }
  const hit = entries.get(key);
  if (hit && !opts.refresh) return hit.scan;

  if (opts.admit && !opts.admit()) return null;

  let scan: Promise<ServerScan>;
  try {
    scan = load();
  } catch (err) {
    scan = Promise.reject(err);
  }
  const entry: Entry = { scan, startedAt: now, doneAt: null, value: null };
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  // Only this entry's own outcome counts: a refresh or an eviction may have
  // replaced it while the scan ran.
  scan.then(
    (done) => {
      entry.doneAt = clock();
      entry.value = done;
      retain(key, done, entry.startedAt, entry.doneAt);
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return scan;
}

/**
 * The finished scan for `key`, if there is one and it is still fresh. It never
 * starts a scan, never waits for a pending one and never touches the limiter,
 * so a page that only wants to mention what the last scan found (the Dashboard,
 * #1322) costs no Discord traffic.
 */
export function peekScan(
  key: string,
  now: () => number = Date.now,
): ServerScan | null {
  const e = entries.get(key);
  if (!e || e.doneAt === null || e.value === null) return null;
  return now() - e.doneAt < SCAN_CACHE_TTL_MS ? e.value : null;
}

export interface RetainedScan {
  scan: ServerScan;
  /** When the scan finished, in the cache clock's milliseconds. */
  readAt: number;
}

/**
 * The most recently finished scan among `keys` (the plain and the
 * ownership-hints scan of one admin are separate entries) that finished within
 * `DASHBOARD_SCAN_RETENTION_MS`, with when it finished. Unlike `peekScan` it
 * outlives the one-minute sharing window. It never starts or waits for a scan
 * and never touches the limiter.
 */
export function peekLastScan(
  keys: readonly string[],
  now: () => number = Date.now,
): RetainedScan | null {
  const at = now();
  let best: RetainedScan | null = null;
  for (const key of keys) {
    const r = retained.get(key);
    if (!r || at - r.doneAt >= DASHBOARD_SCAN_RETENTION_MS) continue;
    if (!best || r.doneAt > best.readAt)
      best = { scan: r.scan, readAt: r.doneAt };
  }
  return best;
}

/** Drop everything; for tests. */
export function resetScanCache(): void {
  entries.clear();
  retained.clear();
}
