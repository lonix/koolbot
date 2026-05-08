import { Request, Response, NextFunction } from "express";

interface Bucket {
  hits: number;
  resetAt: number;
}

/**
 * In-memory fixed-window rate limiter. Keyed by client IP + route name.
 * Adequate for the auth-endpoint protection required by the scaffold;
 * we are not trying to defend against a distributed attacker here.
 */
export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  keyName: string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const buckets = new Map<string, Bucket>();

  return function rateLimit(req, res, next): void {
    const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
    const key = `${opts.keyName}:${ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { hits: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
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
