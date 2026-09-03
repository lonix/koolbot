/**
 * Inline HTML for the WebUI scaffold. We render small static pages here so
 * the scaffold doesn't pull in a templating engine; richer views land in
 * later sub-issues.
 */

import { THEME } from "./theme.js";
import { escapeHtml } from "./html.js";

function pageShell(
  title: string,
  body: string,
  product: "Koolbot Admin" | "Koolbot" = "Koolbot Admin",
): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)} — ${product}</title>`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<style>",
    // Dark palette shared with the authenticated admin UI (issue #569) so the
    // pre-auth sign-in / sign-out / invalid-link pages don't flash light mode.
    `body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:48rem;margin:0 auto;padding:2rem;background:${THEME.bg};color:${THEME.text};}`,
    "h1{margin-top:0;}",
    `a{color:${THEME.link};text-decoration:none;}`,
    "a:hover{text-decoration:underline;}",
    "table{border-collapse:collapse;width:100%;}",
    `th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid ${THEME.border};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem;}`,
    `th{background:${THEME.surfaceAlt};}`,
    `code{background:${THEME.surface};padding:.1rem .3rem;border-radius:.25rem;}`,
    "nav a{margin-right:.75rem;}",
    "form{margin-top:1rem;}",
    `button{background:${THEME.primary};color:${THEME.onPrimary};border:0;padding:.45rem .9rem;border-radius:4px;cursor:pointer;font:inherit;font-weight:600;}`,
    `button:hover{background:${THEME.primaryHover};}`,
    // Keyboard focus ring (WCAG 2.4.7, #855). The UA default is nearly
    // invisible on this dark palette.
    `a:focus-visible,button:focus-visible{outline:2px solid ${THEME.focus};outline-offset:2px;}`,
    "</style></head><body>",
    // <main> gives assistive tech a landmark to jump to on these one-shot pages.
    "<main>",
    body,
    "</main></body></html>",
  ].join("");
}

/**
 * The shared shell for the HTTP error responses the web layer renders as
 * HTML (401 / 403 / 503). Before #855 each caller hand-rolled a bare
 * `<html><head>` with no `lang`, no viewport, no landmark and a light-on-
 * white body — the session-expiry 401 being a *routine* path, not an edge
 * case. Rendering them through `pageShell` gives them the same document
 * basics and dark palette as every other page.
 *
 * `bodyHtml` is trusted markup authored by the caller (static copy with
 * links); interpolate any dynamic value through `escapeHtml` first.
 */
export function renderErrorPage(opts: {
  title: string;
  heading: string;
  bodyHtml: string;
  /** Which surface the page belongs to — drives the `<title>` suffix. */
  product?: "Koolbot Admin" | "Koolbot";
}): string {
  return pageShell(
    opts.title,
    `<h1>${escapeHtml(opts.heading)}</h1>${opts.bodyHtml}`,
    opts.product ?? "Koolbot Admin",
  );
}

export function renderSignedOut(): string {
  return pageShell(
    "Signed out",
    [
      "<h1>Signed out</h1>",
      "<p>Your session has been revoked. Run <code>/config</code> in Discord to start a new one.</p>",
    ].join(""),
  );
}

export function renderConsent(opts: {
  token: string;
  csrfToken: string;
}): string {
  const action = `/admin/s/${encodeURIComponent(opts.token)}`;
  const body = [
    "<h1>Sign in to Koolbot Admin</h1>",
    "<p>Click <strong>Continue</strong> to start your admin session in this browser. Your single-use sign-in link will be consumed when you do.</p>",
    `<form method="POST" action="${escapeHtml(action)}">`,
    // Double-submit CSRF token: mirrors the koolbot_csrf cookie so the POST
    // redemption can reject a cross-site login-CSRF forgery (issue #771). A
    // cross-site auto-submit can't read the victim's cookie to forge a match.
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<button type="submit">Continue</button>',
    "</form>",
  ].join("");
  return pageShell("Sign in", body);
}

export function renderInvalidLink(): string {
  return pageShell(
    "Invalid link",
    [
      "<h1>Link invalid or expired</h1>",
      "<p>Magic-link tokens are single-use and expire quickly. Run <code>/config</code> in Discord again to receive a fresh link.</p>",
    ].join(""),
  );
}
