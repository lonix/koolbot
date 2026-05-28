/**
 * Shared layout for the user self-service surface added in #481.
 *
 * Deliberately slim: no admin nav, no settings/wizard surfaces — just a
 * top bar with the session-expiry banner, the "Finish" button, an
 * optional "Back to admin panel" link for admin-role sessions, and a
 * narrow main column. As `/me` grows (#482 notification prefs, #484
 * Rewind), new pages bolt onto `USER_NAV_ITEMS` below without touching
 * the admin layout.
 */

import { escapeHtml, getInactivityWindowMs } from "./admin-layout.js";

export { escapeHtml };

interface UserNavItem {
  href: string;
  label: string;
}

/**
 * Inline page nav for the user self-service surface. Rendered above the
 * main column on every `/me/*` page (see `renderPageNav` below). New
 * pages from later sub-issues (#484 Rewind, etc.) bolt on by appending
 * to this list.
 */
export const USER_NAV_ITEMS: UserNavItem[] = [
  { href: "/me/", label: "Overview" },
  { href: "/me/notifications", label: "Notifications" },
  { href: "/me/rewind", label: "Rewind" },
];

export interface UserFlashMessage {
  type: "ok" | "warn" | "err";
  text: string;
}

export interface UserPageOptions {
  title: string;
  active: string;
  body: string;
  csrfToken: string;
  remainingMs: number;
  /**
   * When the redeemed session is admin-role, the layout renders a small
   * "Back to admin panel" link in the top bar so the admin can hop
   * between surfaces without re-running `/config`. The header link on
   * the admin layout (added in the same issue) does the inverse.
   */
  isAdmin: boolean;
  /**
   * Optional flash notice rendered above `body`. Used by POST handlers
   * that PRG-redirect back to a GET (e.g. /me/notifications) and need to
   * surface the outcome.
   */
  flash?: UserFlashMessage | null;
}

const STYLE = [
  "*,*::before,*::after{box-sizing:border-box}",
  "body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f1115;color:#e4e6eb}",
  "a{color:#6ea8fe;text-decoration:none}",
  "a:hover{text-decoration:underline}",
  ".banner{background:#1f2937;border-bottom:1px solid #2d3748;padding:.5rem 1rem;display:flex;justify-content:space-between;align-items:center;font-size:.85rem;gap:1rem;flex-wrap:wrap}",
  ".banner .left{display:flex;gap:.75rem;align-items:center}",
  ".banner .right{display:flex;gap:.75rem;align-items:center}",
  ".banner .pill{background:#374151;color:#d1d5db;padding:.15rem .5rem;border-radius:999px;font-size:.75rem}",
  ".banner form{display:inline;margin:0}",
  ".banner button{background:#ef4444;color:#fff;border:0;padding:.3rem .7rem;border-radius:4px;cursor:pointer;font-weight:600}",
  ".banner button:hover{background:#dc2626}",
  ".banner a.surface{color:#cbd5e1;background:#374151;padding:.25rem .55rem;border-radius:4px;font-weight:600}",
  ".banner a.surface:hover{background:#4b5563;text-decoration:none;color:#fff}",
  ".shell{display:flex;min-height:calc(100vh - 41px);justify-content:center}",
  "main{flex:1;padding:2rem 2rem;max-width:64rem}",
  "h1{margin:0 0 .25rem;font-size:1.5rem}",
  "h2{margin:1.5rem 0 .5rem;font-size:1.15rem;color:#cbd5e1}",
  ".subtitle{color:#94a3b8;margin:0 0 1rem}",
  ".card{background:#161a22;border:1px solid #2d3748;border-radius:8px;padding:1rem 1.25rem;margin:0 0 1rem}",
  ".card h2{margin-top:0}",
  ".empty{padding:1rem;color:#94a3b8;font-style:italic}",
  ".muted{color:#94a3b8}",
  ".mono{font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,monospace;font-size:.85rem}",
  ".pill{background:#374151;color:#d1d5db;padding:.15rem .5rem;border-radius:999px;font-size:.75rem}",
  ".tag{display:inline-block;padding:.1rem .45rem;border-radius:4px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}",
  ".tag-info{background:#1e3a8a;color:#bfdbfe}",
  ".notice{padding:.6rem .8rem;border-radius:6px;margin:0 0 1rem}",
  ".notice.info{background:#1d2a44;color:#bfdbfe}",
  ".notice.ok{background:#14532d;color:#bbf7d0}",
  ".notice.warn{background:#78350f;color:#fed7aa}",
  ".notice.err{background:#7f1d1d;color:#fecaca}",
  ".prefs-table{width:100%;border-collapse:collapse}",
  ".prefs-table th,.prefs-table td{text-align:left;padding:.6rem .5rem;vertical-align:top;border-bottom:1px solid #1f2937}",
  ".prefs-table th{font-weight:600;color:#cbd5e1;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em}",
  ".prefs-table tr:last-child td{border-bottom:0}",
  ".prefs-table .toggle{display:flex;align-items:center;gap:.4rem;font-size:.85rem;color:#94a3b8}",
  ".prefs-table .pref-desc{color:#94a3b8;font-size:.85rem;margin-top:.15rem}",
  ".prefs-table .pref-soon{display:block;color:#f59e0b;font-size:.75rem;font-style:italic;margin-top:.15rem}",
  ".btn{background:#2563eb;color:#fff;border:0;padding:.45rem .9rem;border-radius:4px;cursor:pointer;font-weight:600;font-size:.9rem}",
  ".btn:hover{background:#1d4ed8}",
  ".form-actions{margin-top:1rem;display:flex;gap:.5rem;align-items:center}",
  ".feature-list{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.75rem}",
  ".feature-list li{background:#0f1115;border:1px solid #2d3748;border-radius:6px;padding:.75rem 1rem}",
  ".feature-list .feature-name{font-weight:600;display:block;margin-bottom:.2rem;color:#e4e6eb}",
  ".feature-list .feature-desc{font-size:.8rem;color:#94a3b8}",
  ".page-nav{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1.5rem}",
  ".page-nav a{padding:.35rem .75rem;border-radius:4px;background:#161a22;border:1px solid #2d3748;color:#cbd5e1;font-size:.85rem;font-weight:600}",
  ".page-nav a:hover{background:#1f2937;text-decoration:none;color:#fff}",
  ".page-nav a.active{background:#1e3a8a;border-color:#1e3a8a;color:#fff}",
  ".rw-hero{background:linear-gradient(135deg,#1e1b4b 0%,#312e81 100%);border:1px solid #4338ca;border-radius:8px;padding:1.5rem;margin:0 0 1rem;text-align:center}",
  ".rw-hero .total{font-size:2.5rem;font-weight:700;color:#fff;line-height:1.1}",
  ".rw-hero .compare{margin-top:.4rem;color:#c7d2fe;font-size:1rem}",
  ".rw-hero .sub{margin-top:.6rem;color:#a5b4fc;font-size:.85rem}",
  ".rw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.75rem;margin:0 0 1rem}",
  ".rw-stat{background:#161a22;border:1px solid #2d3748;border-radius:8px;padding:.85rem 1rem}",
  ".rw-stat .label{font-size:.7rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em}",
  ".rw-stat .value{font-size:1.2rem;color:#e4e6eb;font-weight:600;margin-top:.2rem}",
  ".rw-stat .detail{font-size:.8rem;color:#94a3b8;margin-top:.1rem}",
  ".rw-channels{list-style:none;padding:0;margin:0}",
  ".rw-channels li{display:flex;justify-content:space-between;align-items:baseline;padding:.4rem 0;border-bottom:1px solid #1f2937;gap:.5rem}",
  ".rw-channels li:last-child{border-bottom:0}",
  ".rw-channels .name{color:#e4e6eb;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".rw-channels .dur{color:#94a3b8;font-size:.85rem;flex-shrink:0}",
  ".rw-badges{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.6rem}",
  ".rw-badge{background:#0f1115;border:1px solid #2d3748;border-radius:6px;padding:.6rem .8rem;display:flex;gap:.6rem;align-items:flex-start}",
  ".rw-badge .emoji{font-size:1.4rem;line-height:1}",
  ".rw-badge .body{flex:1;min-width:0}",
  ".rw-badge .body .name{font-weight:600;color:#e4e6eb;font-size:.9rem}",
  ".rw-badge .body .desc{color:#94a3b8;font-size:.75rem;margin-top:.15rem}",
  ".rw-badge .body .date{color:#64748b;font-size:.7rem;margin-top:.2rem}",
  ".rw-year-picker{display:flex;gap:.4rem;flex-wrap:wrap;margin:0 0 1rem}",
  ".rw-year-picker a{padding:.3rem .7rem;border-radius:999px;background:#161a22;border:1px solid #2d3748;color:#cbd5e1;font-size:.8rem;font-weight:600}",
  ".rw-year-picker a:hover{background:#1f2937;text-decoration:none;color:#fff}",
  ".rw-year-picker a.current{background:#312e81;border-color:#4338ca;color:#fff}",
  ".rw-journey{display:flex;justify-content:space-around;gap:.5rem;flex-wrap:wrap}",
  ".rw-journey .step{text-align:center;flex:1;min-width:100px}",
  ".rw-journey .step .num{font-size:1.4rem;font-weight:700;color:#e4e6eb}",
  ".rw-journey .step .when{font-size:.75rem;color:#94a3b8;margin-top:.15rem}",
  ".rw-journey .step .label{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.2rem}",
].join("");

// Same DOM hooks (`#session-countdown`, `data-remaining-ms`,
// `data-inactivity-ms`) and behaviour as the admin layout's banner
// script, but polls the surface-local `/me/session/ping` mount so
// `/me/*` pages never reach into the `/admin` namespace. The two
// pings hit identical handlers — the path split exists so a future
// operational change to one surface can't silently break countdown
// on the other.
const SCRIPT =
  "(function(){var el=document.getElementById('session-countdown');if(!el)return;" +
  "function toMs(v){var n=Math.floor(Number(v));return isFinite(n)&&n>0?n:0}" +
  "var deadline=Date.now()+toMs(el.getAttribute('data-remaining-ms'));" +
  "var inactivityMs=toMs(el.getAttribute('data-inactivity-ms'));" +
  "var hardCapAt=0;var fired=false;var lastReset=0;" +
  "function expire(){if(fired)return;fired=true;window.location.href='/me/'}" +
  "function tick(){var r=Math.max(0,deadline-Date.now());var s=Math.floor(r/1000);" +
  "var m=Math.floor(s/60);var ss=s%60;el.textContent=m+':'+(ss<10?'0'+ss:ss);" +
  "if(r<=0)expire()}" +
  "function applyRemaining(ms){deadline=Date.now()+toMs(ms);tick()}" +
  "function onActivity(){if(inactivityMs<=0||fired)return;" +
  "var now=Date.now();if(now-lastReset<5000)return;lastReset=now;" +
  "var target=inactivityMs;" +
  "if(hardCapAt>0){var cap=hardCapAt-now;if(cap<target)target=cap}" +
  "if(target>0&&deadline-now<target)applyRemaining(target)}" +
  "function poll(){if(fired)return;" +
  "fetch('/me/session/ping',{credentials:'same-origin',headers:{'Accept':'application/json'},cache:'no-store'})" +
  ".then(function(res){if(res.status===401){expire();return null}" +
  "if(!res.ok)return null;return res.json()})" +
  ".then(function(data){if(!data)return;" +
  "if(typeof data.expiresAt==='string'){var t=Date.parse(data.expiresAt);if(!isNaN(t))hardCapAt=t}" +
  "if(typeof data.remainingMs==='number')applyRemaining(data.remainingMs)})" +
  ".catch(function(){})}" +
  "tick();poll();setInterval(tick,1000);setInterval(poll,30000);" +
  "document.addEventListener('mousemove',onActivity,{passive:true});" +
  "document.addEventListener('keydown',onActivity)})();";

export function renderUserPage(opts: UserPageOptions): string {
  const remainingMs = Math.max(0, Math.floor(opts.remainingMs));
  const inactivityMs = getInactivityWindowMs();
  const adminLink = opts.isAdmin
    ? '<a class="surface" href="/admin/">Back to admin panel</a>'
    : "";
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    `<title>${escapeHtml(opts.title)} — Koolbot</title>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
    '<div class="banner">',
    '<div class="left"><strong>Koolbot · My preferences</strong></div>',
    '<div class="right">',
    adminLink,
    "Session expires in ",
    `<span id="session-countdown" data-remaining-ms="${remainingMs}" data-inactivity-ms="${inactivityMs}" class="mono">--:--</span> · `,
    '<form method="POST" action="/me/finish">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<button type="submit">Finish</button>',
    "</form></div></div>",
    '<div class="shell">',
    `<main>${renderPageNav(opts.active)}${renderFlash(opts.flash)}${opts.body}</main></div>`,
    `<script>${SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}

function renderPageNav(active: string): string {
  const items = USER_NAV_ITEMS.map((item) => {
    const isActive =
      item.href === active ||
      (item.href === "/me/" && (active === "/me" || active === "/me/"));
    const cls = isActive ? ' class="active"' : "";
    return `<a href="${escapeHtml(item.href)}"${cls}>${escapeHtml(item.label)}</a>`;
  }).join("");
  return `<nav class="page-nav">${items}</nav>`;
}

function renderFlash(flash?: UserFlashMessage | null): string {
  if (!flash) return "";
  const cls =
    flash.type === "ok" ? "ok" : flash.type === "warn" ? "warn" : "err";
  return `<div class="notice ${cls}">${escapeHtml(flash.text)}</div>`;
}

/**
 * Page body for `/me/`. Self-contained — the layout supplies the chrome,
 * this function supplies just the inner HTML. The Notifications card
 * landed in #482; later cards (#484 Rewind, etc.) bolt on as they ship.
 */
export function renderUserIndexBody(opts: {
  discordUserId: string;
  guildId: string;
  isAdmin: boolean;
}): string {
  const greeting = opts.isAdmin
    ? `<p class="subtitle">Signed in as an administrator viewing your own preferences. Use the <em>Back to admin panel</em> link above to manage the server.</p>`
    : `<p class="subtitle">These pages are scoped to <strong>you</strong> — what you see and change here only affects your own data on this server.</p>`;
  return [
    "<h1>My preferences</h1>",
    greeting,
    '<div class="card">',
    "<h2>What you can manage</h2>",
    `<p>Self-service settings scoped to you on this server.</p>`,
    '<ul class="feature-list">',
    '<li><span class="feature-name"><a href="/me/notifications">Notifications</a></span>' +
      '<span class="feature-desc">Opt in or out of DM nudges from Koolbot.</span></li>',
    '<li><span class="feature-name"><a href="/me/rewind">Rewind</a></span>' +
      '<span class="feature-desc">Your personal year-in-review of voice activity, top channels, peak day, and badges earned.</span></li>',
    "</ul>",
    "</div>",
    '<div class="card">',
    "<h2>Account context</h2>",
    `<p class="mono">User: ${escapeHtml(opts.discordUserId)} · Guild: ${escapeHtml(opts.guildId)}</p>`,
    "<p>To sign in as a different user, run <code>/config</code> in Discord with that account.</p>",
    "</div>",
  ].join("");
}

// --------------------------------------------------------------------
// Rewind page (#484)
// --------------------------------------------------------------------

export interface RewindBadgeView {
  emoji: string;
  name: string;
  description: string;
  earnedAt: string; // ISO date already formatted by the route
}

export interface RewindChannelView {
  channelId: string;
  channelName: string;
  duration: string; // pre-formatted
}

export interface RewindBodyOptions {
  year: number;
  availableYears: number[]; // includes `year` for the current selection
  hasData: boolean;
  totalDuration: string; // pre-formatted "X hr Y min"
  funComparison: string | null;
  sessionCount: number;
  daysActive: number;
  topChannels: RewindChannelView[];
  peakDay: { date: string; duration: string } | null;
  longestStreakDays: number;
  longestStreakRange: { startDate: string; endDate: string } | null;
  accolades: RewindBadgeView[];
  achievements: RewindBadgeView[];
  annualRank: number | null;
  annualGuildMembers: number;
  percentAboveMedian: number | null;
  weeklyJourney: {
    first: { isoYear: number; isoWeek: number; rank: number } | null;
    last: { isoYear: number; isoWeek: number; rank: number } | null;
    best: { isoYear: number; isoWeek: number; rank: number } | null;
  };
}

function renderYearPicker(current: number, years: number[]): string {
  if (years.length <= 1) return "";
  const items = years
    .map((y) => {
      const cls = y === current ? ' class="current"' : "";
      return `<a href="/me/rewind/${y}"${cls}>${y}</a>`;
    })
    .join("");
  return `<nav class="rw-year-picker">${items}</nav>`;
}

function renderBadges(badges: RewindBadgeView[]): string {
  if (badges.length === 0) {
    return '<div class="empty">None this year — there\'s always next year!</div>';
  }
  return (
    '<div class="rw-badges">' +
    badges
      .map(
        (b) =>
          '<div class="rw-badge">' +
          `<div class="emoji">${escapeHtml(b.emoji)}</div>` +
          '<div class="body">' +
          `<div class="name">${escapeHtml(b.name)}</div>` +
          `<div class="desc">${escapeHtml(b.description)}</div>` +
          `<div class="date">Earned ${escapeHtml(b.earnedAt)}</div>` +
          "</div></div>",
      )
      .join("") +
    "</div>"
  );
}

function renderJourney(j: RewindBodyOptions["weeklyJourney"]): string {
  if (!j.first && !j.last && !j.best) {
    return '<div class="empty">No qualifying weekly leaderboards this year.</div>';
  }
  const cell = (
    label: string,
    entry: { isoYear: number; isoWeek: number; rank: number } | null,
  ): string => {
    if (!entry) {
      return (
        '<div class="step">' +
        `<div class="label">${escapeHtml(label)}</div>` +
        '<div class="num">—</div>' +
        "</div>"
      );
    }
    return (
      '<div class="step">' +
      `<div class="label">${escapeHtml(label)}</div>` +
      `<div class="num">#${entry.rank}</div>` +
      `<div class="when">${entry.isoYear} · W${entry.isoWeek}</div>` +
      "</div>"
    );
  };
  return (
    '<div class="rw-journey">' +
    cell("First", j.first) +
    cell("Best", j.best) +
    cell("Last", j.last) +
    "</div>"
  );
}

export function renderUserRewindBody(opts: RewindBodyOptions): string {
  const years = opts.availableYears.includes(opts.year)
    ? opts.availableYears
    : [opts.year, ...opts.availableYears];
  const picker = renderYearPicker(opts.year, years);

  if (!opts.hasData) {
    return [
      `<h1>Rewind ${opts.year}</h1>`,
      '<p class="subtitle">Your personal year-in-review.</p>',
      picker,
      '<div class="card">',
      "<h2>Nothing to recap yet</h2>",
      `<p class="muted">We didn't find any voice activity or badges for you in ${opts.year}. Hop into a tracked voice channel and your stats will start filling in.</p>`,
      "</div>",
    ].join("");
  }

  const hero = [
    '<div class="rw-hero">',
    `<div class="total">${escapeHtml(opts.totalDuration)}</div>`,
    opts.funComparison
      ? `<div class="compare">${escapeHtml(opts.funComparison)}</div>`
      : "",
    `<div class="sub">${opts.sessionCount} session${opts.sessionCount === 1 ? "" : "s"} across ${opts.daysActive} day${opts.daysActive === 1 ? "" : "s"}</div>`,
    "</div>",
  ].join("");

  const peak = opts.peakDay
    ? `<div class="value">${escapeHtml(opts.peakDay.date)}</div><div class="detail">${escapeHtml(opts.peakDay.duration)} that day</div>`
    : '<div class="value">—</div>';

  const streak = opts.longestStreakDays
    ? `<div class="value">${opts.longestStreakDays} day${opts.longestStreakDays === 1 ? "" : "s"}</div>` +
      (opts.longestStreakRange
        ? `<div class="detail">${escapeHtml(opts.longestStreakRange.startDate)} → ${escapeHtml(opts.longestStreakRange.endDate)}</div>`
        : "")
    : '<div class="value">—</div>';

  const rankStat =
    opts.annualRank !== null
      ? `<div class="value">#${opts.annualRank}</div><div class="detail">of ${opts.annualGuildMembers} active members</div>`
      : '<div class="value">—</div>';

  const medianStat =
    opts.percentAboveMedian !== null
      ? opts.percentAboveMedian >= 0
        ? `<div class="value">+${opts.percentAboveMedian}%</div><div class="detail">vs. the guild median</div>`
        : `<div class="value">${opts.percentAboveMedian}%</div><div class="detail">vs. the guild median</div>`
      : '<div class="value">—</div>';

  const channels =
    opts.topChannels.length === 0
      ? '<div class="empty">No tracked channels this year.</div>'
      : '<ul class="rw-channels">' +
        opts.topChannels
          .map(
            (c) =>
              "<li>" +
              `<span class="name">${escapeHtml(c.channelName)}</span>` +
              `<span class="dur">${escapeHtml(c.duration)}</span>` +
              "</li>",
          )
          .join("") +
        "</ul>";

  return [
    `<h1>Rewind ${opts.year}</h1>`,
    '<p class="subtitle">Your personal year-in-review.</p>',
    picker,
    hero,
    '<div class="rw-grid">',
    '<div class="rw-stat"><div class="label">Peak day</div>' + peak + "</div>",
    '<div class="rw-stat"><div class="label">Longest streak</div>' +
      streak +
      "</div>",
    '<div class="rw-stat"><div class="label">Annual rank</div>' +
      rankStat +
      "</div>",
    '<div class="rw-stat"><div class="label">Above median</div>' +
      medianStat +
      "</div>",
    "</div>",
    '<div class="card"><h2>Top channels</h2>' + channels + "</div>",
    '<div class="card"><h2>Rank journey</h2>' +
      renderJourney(opts.weeklyJourney) +
      "</div>",
    '<div class="card"><h2>Badges earned this year</h2>' +
      renderBadges([...opts.accolades, ...opts.achievements]) +
      "</div>",
  ].join("");
}

interface NotificationRow {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  /**
   * When set, the row is rendered with a "coming soon" hint and the
   * dependent-issue reference. The toggle itself stays functional so
   * users can pre-set their preference before the matching DM path
   * lands. See #482 acceptance criteria.
   */
  comingSoon?: string;
}

export interface NotificationsPageBodyOptions {
  csrfToken: string;
  rows: NotificationRow[];
}

/**
 * Inner HTML for `GET /me/notifications` (#482). One form, one POST.
 * Each toggle is a real checkbox (no JS), submitted along with the
 * other rows so the page is friendly to keyboard / no-JS sessions.
 */
export function renderUserNotificationsBody(
  opts: NotificationsPageBodyOptions,
): string {
  const rows = opts.rows
    .map((row) => {
      const soon = row.comingSoon
        ? `<span class="pref-soon">${escapeHtml(row.comingSoon)}</span>`
        : "";
      return [
        "<tr>",
        "<td>",
        `<strong>${escapeHtml(row.label)}</strong>`,
        `<div class="pref-desc">${escapeHtml(row.description)}</div>`,
        soon,
        "</td>",
        '<td class="toggle">',
        // Mirrors the admin "checkbox + hidden flag" pattern: when the
        // checkbox is unchecked the browser submits nothing for that
        // name, so the hidden `submitted` flag lets the server tell
        // "explicitly off" from "key not in form".
        `<input type="hidden" name="submitted_${escapeHtml(row.key)}" value="1">`,
        `<label><input type="checkbox" name="${escapeHtml(row.key)}" value="true"${row.enabled ? " checked" : ""}> Enabled</label>`,
        "</td>",
        "</tr>",
      ].join("");
    })
    .join("");
  return [
    "<h1>Notifications</h1>",
    `<p class="subtitle">Choose which DMs Koolbot may send you on this server. Untoggling a row stops the matching DM immediately.</p>`,
    '<form method="POST" action="/me/notifications">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<div class="card">',
    '<table class="prefs-table"><thead><tr>',
    "<th>Notification</th>",
    "<th>Current state</th>",
    "</tr></thead><tbody>",
    rows,
    "</tbody></table>",
    '<div class="form-actions">',
    '<button class="btn" type="submit">Save preferences</button>',
    '<span class="muted">Missing record on first save → defaults to all-enabled.</span>',
    "</div>",
    "</div>",
    "</form>",
  ].join("");
}
