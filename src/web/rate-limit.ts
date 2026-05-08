import { Request, Response, NextFunction } from "express";

interface Bucket {
  hits: number;
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;
const SWEEP_EVERY_N_HITS = 256;

/**
 * In-memory fixed-window rate limiter. Keyed by client IP + route name.
 *
 * Bucket map size is bounded by:
 *   - lazy eviction of expired buckets every SWEEP_EVERY_N_HITS requests, and
 *   - a hard cap (DEFAULT_MAX_KEYS) above which we evict the oldest entries
 *     (Map iteration order is insertion-ordered).
 *
 * Adequate for the auth-endpoint protection required by the scaffold; we
 * are not trying to defend against a distributed attacker here.
 */
export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  keyName: string;
  maxKeys?: number;
}): (req: Request, res: Response, next: NextFunction) => void {
  const buckets = new Map<string, Bucket>();
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  let hitsSinceSweep = 0;

  function sweep(now: number): void {
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }

  function trimToCap(): void {
    if (buckets.size <= maxKeys) return;
    const overflow = buckets.size - maxKeys;
    let removed = 0;
    for (const k of buckets.keys()) {
      if (removed >= overflow) break;
      buckets.delete(k);
      removed += 1;
    }
  }

  return function rateLimit(req, res, next): void {
    const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
    const key = `${opts.keyName}:${ip}`;
    const now = Date.now();

    hitsSinceSweep += 1;
    if (hitsSinceSweep >= SWEEP_EVERY_N_HITS) {
      hitsSinceSweep = 0;
      sweep(now);
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { hits: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
      trimToCap();
    }
    bucket.hits += 1;
    if (bucket.hits > opts.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", retryAfter);
      res.status(429).type("text/plain").send("Too Many Requests");
      return;
    }
    next();
  };
}
