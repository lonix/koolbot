import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

/**
 * Response hardening for the Web UI (`/admin/*` and `/me/*`, #1149).
 *
 * Sets, on every response of the router it is mounted on:
 *  - `Content-Security-Policy` with a per-request script nonce (see below),
 *  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
 *    `Referrer-Policy: no-referrer`,
 *  - `Cache-Control: no-store` (every page here is authenticated or carries a
 *    one-time token / CSRF token, so a shared browser must not keep copies),
 *  - `Strict-Transport-Security` only when `WEBUI_BASE_URL` is `https://`.
 *
 * CSP design. The pages are server-rendered strings with inline `<script>`
 * blocks and `<style>` blocks, plus `style="..."` attributes. Inline event
 * handlers (`onsubmit=`/`onclick=`) were replaced by `data-confirm` and a
 * delegated listener (`CONFIRM_SCRIPT`), so nothing needs
 * `script-src 'unsafe-inline'`:
 *  - `script-src 'nonce-<n>'`: only inline scripts carrying this request's
 *    nonce run. The nonce is added to every `<script>` tag of an HTML
 *    response by wrapping `res.send` (`addNonce`), so no template needs to
 *    know about it. Limit of this design: it blocks inline event handlers,
 *    script-scheme URLs and external script sources, but it does NOT stop a
 *    `<script>` tag that reached the output unescaped, because that tag would
 *    be given the nonce too. Output escaping (`escapeHtml`) remains the
 *    defence against script injection; the CSP is a backstop for everything
 *    else (framing, `<base>`, off-origin forms and fetches, plugins).
 *  - `style-src 'unsafe-inline'`: justified exception. Dozens of
 *    `style="..."` attributes and several `<style>` blocks exist; a style
 *    nonce would disable `'unsafe-inline'` for the attributes too. Style
 *    injection does not execute script, and the same-origin `connect-src`,
 *    `img-src` and `form-action` below limit what it could exfiltrate.
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
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Add `nonce="..."` to every `<script>` opening tag. */
export function addNonce(html: string, nonce: string): string {
  return html.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
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
    if (typeof body === "string" && body.includes("<script")) {
      const type = String(res.getHeader("Content-Type") ?? "");
      if (type ? /html/i.test(type) : body.trimStart().startsWith("<")) {
        return originalSend(addNonce(body, nonce));
      }
    }
    return originalSend(body);
  }) as Response["send"];
  next();
}
