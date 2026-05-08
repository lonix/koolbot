import crypto from "crypto";
import { Buffer } from "buffer";
import { Request, Response, NextFunction } from "express";
import { parseCookies, setCookie } from "./cookies.js";

export const CSRF_COOKIE = "koolbot_csrf";
export const CSRF_HEADER = "x-csrf-token";

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
      path: "/",
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
  if (!cookieToken || !headerToken) {
    res.status(403).type("text/plain").send("CSRF token missing");
    return;
  }
  const a = Buffer.from(String(cookieToken));
  const b = Buffer.from(String(headerToken));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).type("text/plain").send("CSRF token mismatch");
    return;
  }
  next();
}

export function shouldUseSecureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}
