import crypto from "node:crypto";
import { Buffer } from "buffer";
import { Request, Response } from "express";
import { env } from "../config/env.js";

/**
 * Lightweight cookie helpers. We deliberately avoid pulling in cookie-parser
 * to keep the WebUI scaffold dependency-free.
 */

/**
 * Parse the Cookie header into a Map. We use a Map (not a plain object)
 * so user-controlled cookie names cannot mutate any object prototype, and
 * so CodeQL's remote-property-injection query has nothing to flag.
 *
 * First occurrence wins (#1150): when a name appears twice, browsers send the
 * most specific (longest-path, then oldest) cookie first, so a duplicate that
 * a sibling sub-domain "tossed" into the jar cannot shadow the real one.
 */
export function parseCookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (!name) continue;
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      // Keep the raw value on malformed encodings.
    }
    if (!out.has(name)) out.set(name, value);
  }
  return out;
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
 *
 * Lives here (re-exported from `csrf.ts`) so `session.ts` and `csrf.ts` can
 * both use it without importing each other.
 */
export function shouldUseSecureCookies(): boolean {
  const baseUrl = env.webui.baseUrl;
  if (baseUrl.startsWith("https://")) return true;
  if (baseUrl.startsWith("http://")) return false;
  return env.isProduction;
}

/**
 * Cookie name for a Web UI cookie. When cookies are `Secure` the name gets
 * the `__Host-` prefix (#1150), which makes browsers reject any copy that
 * carries a `Domain` attribute or a non-`/` path, or that was set over plain
 * HTTP. A sibling sub-domain can therefore no longer plant or shadow the
 * cookie. On plain-HTTP deployments the prefix is impossible (it requires
 * `Secure`), so the bare name is used.
 */
export function hostCookieName(baseName: string): string {
  return shouldUseSecureCookies() ? `__Host-${baseName}` : baseName;
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "strict" | "lax" | "none";
  path?: string;
  maxAge?: number;
  expires?: Date;
}

export function setCookie(
  res: Response,
  name: string,
  value: string,
  opts: CookieOptions = {},
): void {
  const segments: string[] = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${opts.path ?? "/"}`);
  if (opts.httpOnly !== false) segments.push("HttpOnly");
  if (opts.secure) segments.push("Secure");
  segments.push(`SameSite=${opts.sameSite ?? "lax"}`);
  if (typeof opts.maxAge === "number") {
    segments.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  }
  if (opts.expires) {
    segments.push(`Expires=${opts.expires.toUTCString()}`);
  }
  appendCookieHeader(res, segments.join("; "));
}

export function clearCookie(
  res: Response,
  name: string,
  opts: CookieOptions = {},
): void {
  setCookie(res, name, "", {
    ...opts,
    maxAge: 0,
    expires: new Date(0),
  });
}

function appendCookieHeader(res: Response, value: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, value]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), value]);
  }
}

/**
 * HMAC-sign a value with the session secret. Uses encoded.signature so the
 * raw value is recoverable on the wire. Compares with timingSafeEqual.
 */
export function signValue(value: string, secret: string): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(value)
    .digest("base64url");
  return `${value}.${sig}`;
}

export function verifySignedValue(
  signed: string,
  secret: string,
): string | null {
  if (!signed) return null;
  const idx = signed.lastIndexOf(".");
  if (idx <= 0 || idx === signed.length - 1) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(value)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return null;
  return crypto.timingSafeEqual(sigBuf, expectedBuf) ? value : null;
}
