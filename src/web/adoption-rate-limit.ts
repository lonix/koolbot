import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { createRateLimiter } from "./rate-limit.js";

/**
 * Rate limits for the server-adoption surface (#1184): the write routes that
 * plan or apply changes to Discord, and the pages that scan the server. Same
 * in-memory, per-IP limiter as the sign-in endpoints. Alongside the engine's
 * one-apply-at-a-time rule, this keeps a stuck or scripted client from
 * hammering Discord with scans and plan builds.
 */

/** Path prefixes (below /admin) whose writes are rate limited. */
const WRITE_PREFIXES = ["/adopt", "/role-groups", "/rules"];

/** Pages that scan the guild on every load, served by the write router. */
const WRITE_ROUTER_SCAN_PAGES = new Set(["/adopt/claims", "/adopt/events"]);

/** The scan page served by the read-only router. */
export const ADOPTION_SCAN_PAGE = "/adopt";

/** Limiter for the scanning pages; mount it with `router.get`. */
export function createAdoptionScanLimiter(): RequestHandler {
  return createRateLimiter({
    windowMs: 60_000,
    max: 15,
    keyName: "adoption-scan",
  });
}

/** Lower-case, collapse repeated slashes and drop trailing ones. */
function normalisePath(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/\/{2,}/g, "/")
      .replace(/\/+$/, "") || "/"
  );
}

function underPrefix(path: string): boolean {
  return WRITE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Router holding the limits for the write router: a bucket for adoption
 * writes (every non-GET under the adoption prefixes) and one for the scanning
 * pages it serves. Mount it behind the session and CSRF middleware.
 */
export function createAdoptionLimitsRouter(): Router {
  const writeLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyName: "adoption-write",
  });
  const scanLimiter = createAdoptionScanLimiter();
  const router = Router();
  router.use((req: Request, res: Response, next: NextFunction): void => {
    // Express matches routes case-insensitively and ignores a trailing slash,
    // so compare the same way: /ADOPT/Claims/ reaches the same handler.
    const path = normalisePath(req.path);
    if (req.method === "GET" || req.method === "HEAD") {
      if (WRITE_ROUTER_SCAN_PAGES.has(path)) {
        scanLimiter(req, res, next);
        return;
      }
      next();
      return;
    }
    if (underPrefix(path)) {
      writeLimiter(req, res, next);
      return;
    }
    next();
  });
  return router;
}
