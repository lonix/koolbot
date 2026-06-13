import crypto from "crypto";
import { Buffer } from "buffer";
import { Request, Response, NextFunction } from "express";
import { parseCookies, setCookie } from "./cookies.js";
import { respondFlashError } from "./http-flash.js";
import { env } from "../config/env.js";

export const CSRF_COOKIE = "koolbot_csrf";
export const CSRF_HEADER = "x-csrf-token";
/**
 * Cookie path for the CSRF double-submit cookie. Broadened from `/admin`
 * to `/` in #481 so the same token is mirrored back on POSTs to the new
 * `/me/*` surface as well as `/admin/*`. The cookie is not HttpOnly by
 * design — it's the page's mirror of the token — and broadening the
 * path doesn't change any of that. Both surfaces share `requireCsrf`,
 * so a single token is enough.
 */
export const CSRF_COOKIE_PATH = "/";

/**
 * Double-submit-cookie CSRF protection. The cookie is non-HttpOnly so the
 * page can mirror it back in a header on state-changing requests; the server
 * compares the two with constant-time equality.
 */
export function ensureCsrfCookie(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const cookies = parseCookies(req);
  const existing = cookies.get(CSRF_COOKIE);
  if (!existing) {
    const token = crypto.randomBytes(32).toString("base64url");
    setCookie(res, CSRF_COOKIE, token, {
      httpOnly: false,
      sameSite: "lax",
      secure: shouldUseSecureCookies(),
      path: CSRF_COOKIE_PATH,
    });
    (req as Request & { csrfToken?: string }).csrfToken = token;
  } else {
    (req as Request & { csrfToken?: string }).csrfToken = existing;
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
  const cookies = parseCookies(req);
  const cookieToken = cookies.get(CSRF_COOKIE);
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

/**
 * Decide whether to set the `Secure` cookie attribute. We key off the
 * configured access scheme (`WEBUI_BASE_URL`) rather than NODE_ENV
 * because operators routinely run NODE_ENV=production while exposing
 * the WebUI over plain HTTP (Docker on a LAN, behind a reverse proxy
 * that terminates TLS without propagating X-Forwarded-Proto, etc.).
 * Setting Secure on an HTTP request causes browsers to silently drop
 * the cookie, which breaks the entire sign-in flow.
 *
 * If WEBUI_BASE_URL is missing or malformed we fall back to the
 * NODE_ENV check so we don't silently disable Secure on a real HTTPS
 * deployment that just forgot to set the variable.
 */
export function shouldUseSecureCookies(): boolean {
  const baseUrl = env.webui.baseUrl;
  if (baseUrl.startsWith("https://")) return true;
  if (baseUrl.startsWith("http://")) return false;
  return env.isProduction;
}
