import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { NONCE_MARKER } from "./html.js";

/**
 * Response hardening for the Web UI (`/admin/*` and `/me/*`, #1149).
 *
 * Sets, on every response of the router it is mounted on:
 *  - `Content-Security-Policy` with a per-request script nonce (see below),
 *  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
 *    `Referrer-Policy: no-referrer`,
 *  - `Cache-Control: no-store` (every page here is authenticated or carries a
 *    one-time token / CSRF token, so a shared browser must not keep copies).
 *    The stylesheet router is mounted ahead of this middleware on purpose: it
 *    carries no per-user data, needs no session and is cached by version.
 *  - `Strict-Transport-Security` only when `WEBUI_BASE_URL` is `https://`.
 *
 * CSP design. The pages are server-rendered strings with inline `<script>`
 * blocks and `<style>` blocks, plus `style="..."` attributes. Inline event
 * handlers (`onsubmit=`/`onclick=`) were replaced by `data-confirm` and a
 * delegated listener (`CONFIRM_SCRIPT`), so nothing needs
 * `script-src 'unsafe-inline'`:
 *  - `script-src 'nonce-<n>'`: only inline scripts carrying this request's
 *    nonce run. Trusted templates emit their script blocks with
 *    `scriptTag()` (`html.ts`), which writes a server-only random marker where
 *    the nonce goes; `applyNonce` swaps that marker for the request's nonce.
 *    Content an attacker controls cannot contain the marker (it is random per
 *    process and never leaves the server), so a `<script>` that slips through
 *    escaping gets no valid nonce and does not run. This keeps the CSP a real
 *    backstop for script injection as well as for inline handlers, script-
 *    scheme URLs, external sources, framing, `<base>` and off-origin forms.
 *  - `style-src 'self' 'unsafe-inline'`: `'self'` admits the two shared
 *    stylesheets (`tokens.css`, `kb.css`, served by `design-assets.ts` from
 *    `/admin/_assets/` and `/me/_assets/`, #1315). `'unsafe-inline'` stays as
 *    a justified exception: dozens of `style="..."` attributes and several
 *    `<style>` blocks exist; a style nonce would disable `'unsafe-inline'`
 *    for the attributes too. Style injection does not execute script, and
 *    the same-origin `connect-src`, `img-src` and `form-action` below limit
 *    what it could exfiltrate.
 *  - `default-src 'none'` plus `connect-src 'self'` (the pages `fetch()`
 *    same-origin endpoints), `img-src 'self' data:`, `form-action 'self'`,
 *    `base-uri 'none'`, `object-src 'none'`, `frame-ancestors 'none'`.
 */

/**
 * HSTS value, deliberately conservative: 180 days, no `includeSubDomains`
 * and no `preload`. Those two affect sibling hosts and are hard to undo, so
 * they are an operator decision, not a default. Emitted only when
 * `WEBUI_BASE_URL` is https, because a browser ignores HSTS on plain HTTP
 * and an HTTP-only LAN deployment should not advertise it.
 */
export const HSTS_VALUE = "max-age=15552000";

export function buildCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Replace the server-only marker from `scriptTag()` with the real nonce. */
export function applyNonce(html: string, nonce: string): string {
  return html.split(NONCE_MARKER).join(nonce);
}

export function webSecurityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.removeHeader("X-Powered-By");
  res.setHeader("Content-Security-Policy", buildCsp(nonce));
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  if (env.webui.baseUrl.startsWith("https://")) {
    res.setHeader("Strict-Transport-Security", HSTS_VALUE);
  }

  const originalSend = res.send.bind(res) as (body?: unknown) => Response;
  res.send = ((body?: unknown): Response => {
    if (typeof body === "string" && body.includes(NONCE_MARKER)) {
      return originalSend(applyNonce(body, nonce));
    }
    return originalSend(body);
  }) as Response["send"];
  next();
}
