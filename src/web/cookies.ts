import crypto from "crypto";
import { Buffer } from "buffer";
import { Request, Response } from "express";

/**
 * Lightweight cookie helpers. We deliberately avoid pulling in cookie-parser
 * to keep the WebUI scaffold dependency-free.
 */

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
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
