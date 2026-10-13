import crypto from "node:crypto";
import { Buffer } from "buffer";
import { Request, Response, NextFunction } from "express";
import {
  hostCookieName,
  parseCookies,
  setCookie,
  shouldUseSecureCookies,
} from "./cookies.js";
import { respondFlashError } from "./http-flash.js";
import { readSessionCookie } from "./session.js";
import { env } from "../config/env.js";

// Re-exported for existing importers; the implementation lives in cookies.ts.
export { shouldUseSecureCookies };

export const CSRF_COOKIE = "koolbot_csrf";
export const CSRF_HEADER = "x-csrf-token";
/**
 * Cookie path for the pre-sign-in CSRF cookie. Broadened from `/admin`
 * to `/` in #481 so the same token is mirrored back on POSTs to the new
 * `/me/*` surface as well as `/admin/*`. The cookie is not HttpOnly by
 * design — it's the page's mirror of the token — and broadening the
 * path doesn't change any of that. Both surfaces share `requireCsrf`,
 * so a single token is enough.
 */
export const CSRF_COOKIE_PATH = "/";

/**
 * CSRF protection (#1150). Two modes:
 *
 * 1. Signed-in (a valid, HMAC-verified session cookie is present): the token
 *    is derived from the session id, `HMAC(WEBUI_SESSION_SECRET, sid)`. It is
 *    stable for the life of the session, needs no cookie, and cannot be
 *    forged or planted by someone who can only set cookies (cookie tossing),
 *    because they would need the server secret.
 * 2. Not signed in (the one-time-link consent page, whose POST creates the
 *    session): there is no session to bind to, so the classic double-submit
 *    cookie is used. On HTTPS it carries the `__Host-` prefix so a sibling
 *    sub-domain cannot plant it. On plain HTTP a network attacker could, which
 *    is inherent to HTTP and why deployments should use HTTPS.
 *
 * Sessions issued before this change keep working: the derived token only
 * needs the session id already in the signed session cookie.
 */
export function deriveCsrfToken(sessionId: string): string | null {
  const secret = env.webui.sessionSecret;
  if (!secret) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(`csrf\0${sessionId}`)
    .digest("base64url");
}

function sessionBoundToken(req: Request): string | null {
  const payload = readSessionCookie(req);
  return payload ? deriveCsrfToken(payload.sid) : null;
}

export function ensureCsrfCookie(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const typed = req as Request & { csrfToken?: string };
  const bound = sessionBoundToken(req);
  if (bound) {
    typed.csrfToken = bound;
    next();
    return;
  }
  const cookies = parseCookies(req);
  const existing = cookies.get(hostCookieName(CSRF_COOKIE));
  if (!existing) {
    const token = crypto.randomBytes(32).toString("base64url");
    setCookie(res, hostCookieName(CSRF_COOKIE), token, {
      httpOnly: false,
      sameSite: "lax",
      secure: shouldUseSecureCookies(),
      path: CSRF_COOKIE_PATH,
    });
    typed.csrfToken = token;
  } else {
    typed.csrfToken = existing;
  }
  next();
}

export function requireCsrf(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS"
  ) {
    next();
    return;
  }
  // Signed-in requests are checked against the session-derived token; the
  // double-submit cookie is only consulted when there is no session.
  const cookieToken =
    sessionBoundToken(req) ??
    parseCookies(req).get(hostCookieName(CSRF_COOKIE));
  const headerToken = req.header(CSRF_HEADER) || (req.body && req.body._csrf);
  // AJAX callers (e.g. the Settings per-section save) get a JSON error so the
  // client can surface a real message instead of a generic toast (issue #612);
  // plain form POSTs still get the text/plain body via `respondFlashError`.
  if (!cookieToken || !headerToken) {
    respondFlashError(
      req,
      res,
      403,
      "Security check failed (CSRF token missing). Reload the page and try again.",
    );
    return;
  }
  const a = Buffer.from(String(cookieToken));
  const b = Buffer.from(String(headerToken));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    respondFlashError(
      req,
      res,
      403,
      "Security check failed (CSRF token mismatch). Reload the page and try again.",
    );
    return;
  }
  next();
}
