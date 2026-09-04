/**
 * HTML escaping helpers shared by every WebUI renderer.
 *
 * The views build markup by string concatenation, so every dynamic value has
 * to be escaped at the interpolation site. These two functions are the only
 * sanctioned way to do that; `admin-layout.ts` and `views.ts` each used to
 * define their own `escapeHtml` (#851).
 */

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
