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

export function renderDashboard(opts: {
  discordUserId: string;
  guildId: string;
  csrfToken: string;
}): string {
  const body = [
    '<nav><a href="/admin/">Dashboard</a> <a href="/admin/bootstrap">Bootstrap</a></nav>',
    "<h1>Koolbot Admin</h1>",
    `<p>Signed in as user <code>${escapeHtml(opts.discordUserId)}</code> in guild <code>${escapeHtml(opts.guildId)}</code>.</p>`,
    "<p>This is a placeholder dashboard. Read views land in subsequent sub-issues.</p>",
    '<form method="POST" action="/admin/finish">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<button type="submit">Finish &amp; sign out</button>',
    "</form>",
  ].join("");
  return pageShell("Dashboard", body);
}

export function renderBootstrap(opts: {
  rows: Array<{ key: string; present: boolean; tail?: string }>;
  csrfToken: string;
}): string {
  const tableRows = opts.rows
    .map((row) => {
      const present = row.present
        ? `<span style="color:#15803d;">present</span>`
        : `<span style="color:#b91c1c;">missing</span>`;
      const tail = row.tail ? `<code>…${escapeHtml(row.tail)}</code>` : "";
      return `<tr><td>${escapeHtml(row.key)}</td><td>${present}</td><td>${tail}</td></tr>`;
    })
    .join("");
  const body = [
    '<nav><a href="/admin/">Dashboard</a> <a href="/admin/bootstrap">Bootstrap</a></nav>',
    "<h1>Bootstrap (read-only)</h1>",
    "<p>Environment values are <strong>never</strong> writable from the WebUI. Only presence and the last 4 characters of secrets are shown.</p>",
    "<table><thead><tr><th>Key</th><th>Status</th><th>Tail</th></tr></thead>",
    `<tbody>${tableRows}</tbody></table>`,
  ].join("");
  return pageShell("Bootstrap", body);
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

export function renderInvalidLink(): string {
  return pageShell(
    "Invalid link",
    [
      "<h1>Link invalid or expired</h1>",
      "<p>Magic-link tokens are single-use and expire quickly. Run <code>/config</code> in Discord again to receive a fresh link.</p>",
    ].join(""),
  );
}
