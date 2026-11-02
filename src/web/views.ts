/**
 * Inline HTML for the WebUI scaffold. We render small static pages here so
 * the scaffold doesn't pull in a templating engine; richer views land in
 * later sub-issues.
 */

import { designStylesheetLinks } from "./design-assets.js";
import { escapeHtml } from "./html.js";

function pageShell(
  title: string,
  heading: string,
  /** Trusted markup for the PageHeader: `<p class="kb-pagehead__sub">` lines. */
  subHtml: string,
  /** Trusted markup for the Panel under it; empty for a page that is only text. */
  panelHtml: string,
  product: "KoolBot Admin" | "KoolBot" = "KoolBot Admin",
): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)} — ${product}</title>`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    // kb.css supplies the base (box-sizing, the body font and background, links, the focus ring and
    // the dark `color-scheme`, #1507). These pre-auth pages are the same dark UI as the rest (#569),
    // so they carry no style sheet of their own (#1710).
    designStylesheetLinks(product === "KoolBot" ? "/me" : "/admin"),
    // <main> gives assistive tech a landmark to jump to on these one-shot pages.
    '</head><body><main class="kb-member">',
    `<header class="kb-pagehead"><div class="kb-pagehead__text"><h1 class="kb-pagehead__title">${escapeHtml(heading)}</h1>${subHtml}</div></header>`,
    panelHtml
      ? `<div class="kb-panel"><div class="kb-panel__body">${panelHtml}</div></div>`
      : "",
    "</main></body></html>",
  ].join("");
}

const sub = (html: string): string => `<p class="kb-pagehead__sub">${html}</p>`;

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
  product?: "KoolBot Admin" | "KoolBot";
}): string {
  return pageShell(
    opts.title,
    opts.heading,
    "",
    opts.bodyHtml,
    opts.product ?? "KoolBot Admin",
  );
}

/**
 * Terminal "signed out" page. `message` is an optional plain-text paragraph
 * shown above the standard copy — the data reset (#917) uses it to say what
 * just happened before the member loses the page. Pass `revoked: false`
 * when the server-side revoke could not be confirmed, so the page does not
 * claim a revocation that did not happen.
 */
export function renderSignedOut(
  message?: string,
  opts: { revoked?: boolean } = {},
): string {
  const revoked = opts.revoked ?? true;
  const next =
    'Run <span class="kb-mono">/me</span> (or <span class="kb-mono">/config</span> for admins) in Discord to start a new one.';
  return pageShell(
    "Signed out",
    "Signed out",
    [
      message ? sub(escapeHtml(message)) : "",
      sub(
        revoked
          ? `Your session has been revoked. ${next}`
          : `This browser has been signed out, but the server could not confirm your session was revoked; it will expire on its own. ${next}`,
      ),
    ].join(""),
    "",
  );
}

export function renderConsent(opts: {
  token: string;
  csrfToken: string;
}): string {
  const action = `/admin/s/${encodeURIComponent(opts.token)}`;
  const form = [
    `<form method="POST" action="${escapeHtml(action)}" class="kb-row">`,
    // Double-submit CSRF token: mirrors the koolbot_csrf cookie so the POST
    // redemption can reject a cross-site login-CSRF forgery (issue #771). A
    // cross-site auto-submit can't read the victim's cookie to forge a match.
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<button type="submit" class="kb-btn kb-btn--primary">Continue</button>',
    "</form>",
  ].join("");
  return pageShell(
    "Sign in",
    "Sign in to KoolBot Admin",
    sub(
      "Click <strong>Continue</strong> to start your admin session in this browser. Your single-use sign-in link will be consumed when you do.",
    ),
    form,
  );
}

export function renderInvalidLink(): string {
  return pageShell(
    "Invalid link",
    "Link invalid or expired",
    sub(
      'Magic-link tokens are single-use and expire quickly. Run <span class="kb-mono">/me</span> (or <span class="kb-mono">/config</span> for admins) in Discord again to receive a fresh link.',
    ),
    "",
  );
}
