/**
 * Inline HTML for the WebUI scaffold. We render small static pages here so
 * the scaffold doesn't pull in a templating engine; richer views land in
 * later sub-issues.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pageShell(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)} — Koolbot Admin</title>`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<style>",
    "body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:48rem;margin:0 auto;padding:2rem;color:#1f2937;}",
    "h1{margin-top:0;}",
    "table{border-collapse:collapse;width:100%;}",
    "th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #e5e7eb;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem;}",
    "th{background:#f3f4f6;}",
    "code{background:#f3f4f6;padding:.1rem .3rem;border-radius:.25rem;}",
    "nav a{margin-right:.75rem;}",
    "form{margin-top:1rem;}",
    "</style></head><body>",
    body,
    "</body></html>",
  ].join("");
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

export function renderConsent(opts: { token: string }): string {
  const action = `/admin/s/${encodeURIComponent(opts.token)}`;
  const body = [
    "<h1>Sign in to Koolbot Admin</h1>",
    "<p>Click <strong>Continue</strong> to start your admin session in this browser. Your single-use sign-in link will be consumed when you do.</p>",
    `<form method="POST" action="${escapeHtml(action)}">`,
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
