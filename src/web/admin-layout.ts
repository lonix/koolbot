/**
 * Shared layout for the read-only admin pages added in #381. The scaffold's
 * `views.ts` keeps tiny static pages for sign-in / sign-out flows; this
 * module renders the navigated pages with the always-visible "session
 * expires in X · [Finish]" banner mandated by #367.
 */

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface NavItem {
  href: string;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/admin/", label: "Dashboard" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/permissions", label: "Permissions" },
  { href: "/admin/wizard", label: "Setup Wizard" },
  { href: "/admin/announcements", label: "Announcements" },
  { href: "/admin/polls", label: "Polls" },
  { href: "/admin/reaction-roles", label: "Reaction Roles" },
  { href: "/admin/notices", label: "Notices" },
  { href: "/admin/voice-channels", label: "Voice Channels" },
  { href: "/admin/database", label: "Database" },
  { href: "/admin/bootstrap", label: "Bootstrap" },
];

export interface AdminPageOptions {
  title: string;
  active: string;
  body: string;
  csrfToken: string;
  remainingMs: number;
}

const STYLE = [
  "*,*::before,*::after{box-sizing:border-box}",
  "body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f1115;color:#e4e6eb}",
  "a{color:#6ea8fe;text-decoration:none}",
  "a:hover{text-decoration:underline}",
  ".banner{background:#1f2937;border-bottom:1px solid #2d3748;padding:.5rem 1rem;display:flex;justify-content:space-between;align-items:center;font-size:.85rem}",
  ".banner .left{display:flex;gap:.75rem;align-items:center}",
  ".banner form{display:inline;margin:0}",
  ".banner button{background:#ef4444;color:#fff;border:0;padding:.3rem .7rem;border-radius:4px;cursor:pointer;font-weight:600}",
  ".banner button:hover{background:#dc2626}",
  ".shell{display:flex;min-height:calc(100vh - 41px)}",
  "nav.side{background:#161a22;border-right:1px solid #2d3748;width:220px;padding:1rem .5rem;flex-shrink:0}",
  "nav.side ul{list-style:none;padding:0;margin:0}",
  "nav.side a{display:block;padding:.5rem .75rem;border-radius:6px;color:#cbd5e1}",
  "nav.side a:hover{background:#1f2937;text-decoration:none}",
  "nav.side a.active{background:#1d2a44;color:#fff}",
  "main{flex:1;padding:1.5rem 2rem;max-width:1100px}",
  "h1{margin:0 0 .25rem;font-size:1.5rem}",
  "h2{margin:1.5rem 0 .5rem;font-size:1.15rem;color:#cbd5e1}",
  ".subtitle{color:#94a3b8;margin:0 0 1rem}",
  ".card{background:#161a22;border:1px solid #2d3748;border-radius:8px;padding:1rem 1.25rem;margin:0 0 1rem}",
  ".card h2{margin-top:0}",
  "table{width:100%;border-collapse:collapse;font-size:.9rem}",
  "th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #2d3748;vertical-align:top}",
  "th{font-weight:600;color:#94a3b8;background:#1a1f2a}",
  "tr:hover td{background:#1a1f2a}",
  ".muted{color:#94a3b8}",
  ".mono{font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,monospace;font-size:.85rem}",
  ".tag{display:inline-block;padding:.1rem .45rem;border-radius:4px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}",
  ".tag-on{background:#14532d;color:#bbf7d0}",
  ".tag-off{background:#4b1e1e;color:#fecaca}",
  ".tag-info{background:#1e3a8a;color:#bfdbfe}",
  ".tag-warn{background:#4a3a0d;color:#fde68a}",
  ".tag-diff-add{background:#14532d;color:#bbf7d0}",
  ".tag-diff-change{background:#4a3a0d;color:#fde68a}",
  ".tag-diff-reject{background:#4b1e1e;color:#fecaca}",
  ".empty{padding:1rem;color:#94a3b8;font-style:italic}",
  ".kv{display:grid;grid-template-columns:200px 1fr;gap:.4rem 1rem}",
  ".kv dt{color:#94a3b8}",
  ".kv dd{margin:0}",
  ".notice{padding:.6rem .8rem;border-radius:6px;margin:0 0 1rem}",
  ".notice.info{background:#1d2a44;color:#bfdbfe}",
  ".notice.warn{background:#4a3a0d;color:#fde68a}",
  ".notice.error{background:#4b1e1e;color:#fecaca}",
  // Form controls
  "input[type=text],input[type=number],textarea,select{background:#0f1115;color:#e4e6eb;border:1px solid #2d3748;border-radius:4px;padding:.3rem .5rem;font-size:.85rem;font-family:inherit;width:100%}",
  "input[type=text]:focus,input[type=number]:focus,textarea:focus,select:focus{outline:none;border-color:#6ea8fe}",
  "input[type=checkbox]{width:1rem;height:1rem;cursor:pointer;accent-color:#6ea8fe}",
  "select[multiple]{min-height:4rem}",
  "textarea{resize:vertical;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,monospace}",
  ".btn{display:inline-block;padding:.3rem .75rem;border-radius:4px;font-size:.8rem;font-weight:600;cursor:pointer;border:0;white-space:nowrap}",
  ".btn-primary{background:#1d4ed8;color:#fff}",
  ".btn-primary:hover{background:#1e40af}",
  ".btn-secondary{background:#374151;color:#d1d5db}",
  ".btn-secondary:hover{background:#4b5563}",
  ".btn-danger{background:#7f1d1d;color:#fecaca}",
  ".btn-danger:hover{background:#991b1b}",
  ".btn-sm{padding:.2rem .5rem;font-size:.75rem}",
  ".actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}",
  ".inline-form{display:flex;gap:.4rem;align-items:center}",
  ".inline-form input[type=text],.inline-form input[type=number]{width:12rem}",
  ".field-row{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.75rem}",
  ".field-row label{font-size:.8rem;color:#94a3b8}",
  ".field-row .help{font-size:.75rem;color:#6b7280;margin-top:.15rem}",
  ".wizard-features{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.75rem;margin-bottom:1rem}",
  ".feature-card{background:#0f1115;border:1px solid #2d3748;border-radius:6px;padding:.75rem 1rem;display:flex;gap:.75rem;align-items:flex-start}",
  ".feature-card input{margin-top:.2rem;flex-shrink:0}",
  ".feature-card .fc-info{flex:1}",
  ".feature-card .fc-name{font-weight:600;font-size:.9rem}",
  ".feature-card .fc-desc{font-size:.75rem;color:#94a3b8;margin-top:.1rem}",
].join("");

const SCRIPT =
  "(function(){var el=document.getElementById('session-countdown');if(!el)return;" +
  "var deadline=Date.now()+parseInt(el.getAttribute('data-remaining-ms'),10);" +
  "var fired=false;" +
  "function tick(){var r=Math.max(0,deadline-Date.now());var s=Math.floor(r/1000);" +
  "var m=Math.floor(s/60);var ss=s%60;el.textContent=m+':'+(ss<10?'0'+ss:ss);" +
  // When the countdown hits 0, navigate to /admin/. The session middleware
  // will reject the now-expired cookie and render the scaffold's 401 page.
  "if(r<=0&&!fired){fired=true;window.location.href='/admin/'}}" +
  "tick();setInterval(tick,1000)})();";

function renderNav(active: string): string {
  return NAV_ITEMS.map((item) => {
    const isActive =
      item.href === active || (item.href === "/admin/" && active === "/admin");
    const cls = isActive ? ' class="active"' : "";
    return `<li><a href="${escapeHtml(item.href)}"${cls}>${escapeHtml(item.label)}</a></li>`;
  }).join("");
}

export function renderAdminPage(opts: AdminPageOptions): string {
  const remainingMs = Math.max(0, Math.floor(opts.remainingMs));
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    `<title>${escapeHtml(opts.title)} — Koolbot Admin</title>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
    '<div class="banner">',
    '<div class="left"><strong>Koolbot Admin</strong></div>',
    '<div class="right">Session expires in ',
    `<span id="session-countdown" data-remaining-ms="${remainingMs}" class="mono">--:--</span> · `,
    '<form method="POST" action="/admin/finish">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<button type="submit">Finish</button>',
    "</form></div></div>",
    '<div class="shell">',
    `<nav class="side"><ul>${renderNav(opts.active)}</ul></nav>`,
    `<main>${opts.body}</main></div>`,
    `<script>${SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}

/**
 * Remaining session lifetime in milliseconds for the banner countdown.
 *
 * Two ceilings apply, and the banner has to honour both:
 *   - the inactivity sliding window (`WEBUI_INACTIVITY_TIMEOUT_MINUTES`),
 *     which the cookie middleware just refreshed back to its full length.
 *   - the server-side hard cap from `dbSession.expiresAt`
 *     (`WEBUI_SESSION_TTL_MINUTES`), surfaced on `WebSessionContext`.
 *
 * We display whichever ends sooner. Without `session`, we conservatively
 * fall back to inactivity-only (used by tests).
 */
export function getDisplayedRemainingMs(session?: { expiresAt: Date }): number {
  const raw = process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
  const parsed = raw ? Number(raw) : NaN;
  const inactivityMinutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  const inactivityMs = inactivityMinutes * 60 * 1000;
  if (!session) return inactivityMs;
  const hardCapMs = Math.max(0, session.expiresAt.getTime() - Date.now());
  return Math.min(inactivityMs, hardCapMs);
}
