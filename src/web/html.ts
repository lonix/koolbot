/**
 * HTML escaping helpers shared by every WebUI renderer.
 *
 * The views build markup by string concatenation, so every dynamic value has
 * to be escaped at the interpolation site. These two functions are the only
 * sanctioned way to do that; `admin-layout.ts` and `views.ts` each used to
 * define their own `escapeHtml` (#851).
 */

import crypto from "node:crypto";

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape a value for safe interpolation into a single-quoted JavaScript
 * string inside an HTML attribute (e.g. `onsubmit="return confirm('...')"`).
 *
 * `escapeHtml` is not enough: HTML entities are decoded back to characters
 * before the JS engine sees them, so a `'` in the input would terminate the
 * JS string and let surrounding markup leak into the script context. Strip
 * the dangerous characters here, then HTML-escape the result so the
 * attribute itself is also safe.
 */
export function escapeJsInAttr(value: unknown): string {
  if (value === null || value === undefined) return "";
  const jsSafe = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    // Break any </script> sequence so the string can't escape its tag context.
    .replace(/<\/(script)/gi, "<\\/$1");
  return escapeHtml(jsSafe);
}

/**
 * Delegated confirmation prompt for destructive actions. Inline `onsubmit` /
 * `onclick` handlers are blocked by the Web UI's Content-Security-Policy
 * (#1149), so a `<form data-confirm="...">` or `<button data-confirm="...">`
 * asks via `window.confirm()` here instead. The message is plain text in an
 * HTML-escaped attribute, so it never reaches a script context. Registered in
 * the capture phase so a declined prompt also stops the other submit handlers
 * (e.g. the Settings fetch() save).
 */
export const CONFIRM_SCRIPT =
  "(function(){" +
  "document.addEventListener('submit',function(e){var f=e.target;" +
  "if(!f||!f.getAttribute)return;var m=f.getAttribute('data-confirm');" +
  "if(m&&!window.confirm(m)){e.preventDefault();e.stopImmediatePropagation()}},true);" +
  "document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('button[data-confirm],input[data-confirm]'):null;" +
  "if(!b)return;if(!window.confirm(b.getAttribute('data-confirm'))){e.preventDefault();e.stopImmediatePropagation()}},true)})();";

/**
 * Server-only marker standing in for the CSP nonce inside trusted inline
 * `<script>` blocks (#1149). It is random per process and never sent to a
 * client: the response middleware (`security-headers.ts`) replaces every
 * occurrence with the request's real nonce. Because only `scriptTag()` emits
 * it, a `<script>` that reaches the page through unescaped content (which
 * cannot know the marker) gets no valid nonce and the browser refuses to run
 * it.
 */
export const NONCE_MARKER = `koolbot-nonce-${crypto.randomBytes(24).toString("hex")}`;

/** A trusted inline script block; only call with a server-authored constant. */
export function scriptTag(js: string): string {
  return `<script nonce="${NONCE_MARKER}">${js}</script>`;
}
