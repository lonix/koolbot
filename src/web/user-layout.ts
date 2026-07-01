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
import {
  DAY_NAMES,
  formatHourLabel,
  peakIndex,
} from "../services/rewind-service.js";

export { escapeHtml };

interface UserNavItem {
  href: string;
  label: string;
  /**
   * When set, the item is feature-gated. A disabled feature is NOT hidden:
   * the link stays visible but is greyed with an "off" badge (#709),
   * mirroring the admin nav's `featureKey` treatment (#610). Its page stays
   * reachable so members can pre-set their choice before an admin flips the
   * feature on — the same "let users pre-set" intent the birthday page has
   * always followed.
   */
  feature?: "rewind" | "voice" | "birthday";
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
  { href: "/me/timezone", label: "Timezone" },
  { href: "/me/voice", label: "Voice", feature: "voice" },
  { href: "/me/birthday", label: "Birthday", feature: "birthday" },
  { href: "/me/rewind", label: "Rewind", feature: "rewind" },
];

/**
 * Enabled-state of every feature-gated `/me/*` surface, threaded from the
 * routes into the layout so the nav and overview cards can render a
 * consistent "off" treatment (#709). Each flag defaults to enabled
 * (`undefined` → treated as on) so non-gating callers and tests that don't
 * care about gating render every item as a plain link.
 */
export interface UserFeatureFlags {
  rewindEnabled?: boolean;
  presetsEnabled?: boolean;
  birthdayEnabled?: boolean;
}

/** Whether a given nav item's feature is disabled per the supplied flags. */
function isNavItemDisabled(
  item: UserNavItem,
  flags: UserFeatureFlags,
): boolean {
  if (item.feature === "rewind") return flags.rewindEnabled === false;
  if (item.feature === "voice") return flags.presetsEnabled === false;
  if (item.feature === "birthday") return flags.birthdayEnabled === false;
  return false;
}

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
  /**
   * Enabled-state of the feature-gated Rewind page (#608). When `false`,
   * the Rewind nav link is greyed with an "off" badge rather than hidden
   * (#709). Omitted/`undefined` keeps the link plain, so direct callers and
   * tests that don't care about gating work unchanged.
   */
  rewindEnabled?: boolean;
  /**
   * Enabled-state of the feature-gated Voice-preferences page (#656). When
   * `false`, the Voice nav link is greyed with an "off" badge, mirroring
   * `rewindEnabled` (#709).
   */
  presetsEnabled?: boolean;
  /**
   * Enabled-state of the feature-gated Birthday page (#657). When `false`,
   * the Birthday nav link is greyed with an "off" badge, mirroring
   * `rewindEnabled`/`presetsEnabled` (#709). The page itself stays reachable
   * either way so members can pre-set their date.
   */
  birthdayEnabled?: boolean;
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
  // Disabled-feature "off" tag on the overview cards, mirroring the admin
  // Settings palette (#709).
  ".tag-off{background:#4b1e1e;color:#fecaca}",
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
  "select.tz-select{width:100%;max-width:28rem;background:#0f1115;color:#e4e6eb;border:1px solid #2d3748;border-radius:4px;padding:.45rem .5rem;font-size:.9rem}",
  ".tz-preview{margin-top:.75rem;font-size:.9rem;color:#cbd5e1}",
  ".tz-preview .now{font-weight:600;color:#e4e6eb}",
  ".btn{background:#2563eb;color:#fff;border:0;padding:.45rem .9rem;border-radius:4px;cursor:pointer;font-weight:600;font-size:.9rem}",
  ".btn:hover{background:#1d4ed8}",
  ".btn-secondary{background:#374151;color:#e4e6eb;border:0;padding:.45rem .9rem;border-radius:4px;cursor:pointer;font-weight:600;font-size:.9rem}",
  ".btn-secondary:hover{background:#4b5563}",
  ".btn-danger{background:#dc2626;color:#fff;border:0;padding:.45rem .9rem;border-radius:4px;cursor:pointer;font-weight:600;font-size:.9rem}",
  ".btn-danger:hover{background:#b91c1c}",
  ".preset-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin:.5rem 0}",
  ".preset-grid label{display:flex;flex-direction:column;gap:.25rem;font-size:.8rem;color:#94a3b8}",
  ".preset-grid input{background:#0f1115;color:#e4e6eb;border:1px solid #2d3748;border-radius:4px;padding:.4rem .5rem;font-size:.9rem}",
  ".preset-actions{display:flex;gap:.5rem;margin-top:.5rem}",
  ".preset-actions form{display:inline;margin:0}",
  ".form-actions{margin-top:1rem;display:flex;gap:.5rem;align-items:center}",
  ".feature-list{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.75rem}",
  ".feature-list li{background:#0f1115;border:1px solid #2d3748;border-radius:6px;padding:.75rem 1rem}",
  ".feature-list .feature-name{font-weight:600;display:block;margin-bottom:.2rem;color:#e4e6eb}",
  ".feature-list .feature-desc{font-size:.8rem;color:#94a3b8}",
  ".page-nav{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1.5rem}",
  ".page-nav a{padding:.35rem .75rem;border-radius:4px;background:#161a22;border:1px solid #2d3748;color:#cbd5e1;font-size:.85rem;font-weight:600}",
  ".page-nav a:hover{background:#1f2937;text-decoration:none;color:#fff}",
  ".page-nav a.active{background:#1e3a8a;border-color:#1e3a8a;color:#fff}",
  // Feature-gated pages whose feature is off are shown but greyed with an
  // "off" badge so they stay discoverable and pre-settable (#709), mirroring
  // the admin side nav (#610). The active page keeps its highlight even when
  // disabled, so the greying only applies while inactive.
  ".page-nav a.nav-disabled:not(.active){color:#6b7280;border-style:dashed}",
  ".page-nav a.nav-disabled:not(.active):hover{color:#94a3b8}",
  ".page-nav a .nav-badge{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#cbd5e1;background:#374151;border-radius:4px;padding:.05rem .3rem;margin-left:.35rem}",
  ".rw-hero{background:linear-gradient(135deg,#1e1b4b 0%,#312e81 100%);border:1px solid #4338ca;border-radius:8px;padding:1.5rem;margin:0 0 1rem;text-align:center}",
  ".rw-hero .total{font-size:2.5rem;font-weight:700;color:#fff;line-height:1.1}",
  ".rw-hero .compare{margin-top:.4rem;color:#c7d2fe;font-size:1rem}",
  ".rw-hero .sub{margin-top:.6rem;color:#a5b4fc;font-size:.85rem}",
  ".rw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.75rem;margin:0 0 1rem}",
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
  // Voice activity heatmap (#675): a vertical 24-bar hour histogram and a
  // horizontal 7-bar weekday breakdown, sharing the indigo Rewind palette.
  ".rw-heat .peak{font-size:.95rem;color:#cbd5e1;margin:0 0 .9rem}",
  ".rw-heat .peak strong{color:#a5b4fc}",
  ".rw-heat .heat-section{margin:0 0 1.1rem}",
  ".rw-heat .heat-section:last-child{margin-bottom:0}",
  ".rw-heat .heat-title{font-size:.7rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin:0 0 .45rem}",
  ".rw-hours{display:flex;align-items:flex-end;gap:2px;height:84px}",
  ".rw-hours .hb{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%}",
  ".rw-hours .hb .fill{background:#4338ca;border-radius:2px 2px 0 0;min-height:2px}",
  ".rw-hours .hb.peak .fill{background:#a5b4fc}",
  ".rw-hour-axis{display:flex;justify-content:space-between;font-size:.65rem;color:#64748b;margin-top:.3rem}",
  ".rw-days{display:flex;flex-direction:column;gap:.32rem}",
  ".rw-days .db{display:flex;align-items:center;gap:.55rem}",
  ".rw-days .db .dl{width:2.4rem;font-size:.75rem;color:#94a3b8;flex-shrink:0}",
  ".rw-days .db .track{flex:1;background:#0f1115;border:1px solid #2d3748;border-radius:4px;height:.95rem;overflow:hidden}",
  ".rw-days .db .track .fill{height:100%;background:#4338ca}",
  ".rw-days .db.peak .track .fill{background:#a5b4fc}",
  ".rw-days .db .dv{width:5rem;text-align:right;font-size:.7rem;color:#64748b;flex-shrink:0}",
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
    `<main>${renderPageNav(opts.active, {
      rewindEnabled: opts.rewindEnabled,
      presetsEnabled: opts.presetsEnabled,
      birthdayEnabled: opts.birthdayEnabled,
    })}${renderFlash(opts.flash)}${opts.body}</main></div>`,
    `<script>${SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}

function renderPageNav(active: string, flags: UserFeatureFlags): string {
  // Every item always renders (#709): a feature-gated page whose feature is
  // off is greyed with an "off" badge rather than hidden, so it stays
  // discoverable and its choice stays pre-settable. `undefined` flags are
  // treated as enabled so non-gating callers/tests render plain links.
  const items = USER_NAV_ITEMS.map((item) => {
    const isActive =
      item.href === active ||
      (item.href === "/me/" && (active === "/me" || active === "/me/"));
    const disabled = isNavItemDisabled(item, flags);
    const classes = [isActive ? "active" : "", disabled ? "nav-disabled" : ""]
      .filter(Boolean)
      .join(" ");
    const cls = classes ? ` class="${classes}"` : "";
    const title = disabled
      ? ' title="Your server admin hasn\'t enabled this yet — your choice is still saved"'
      : "";
    const badge = disabled ? '<span class="nav-badge">off</span>' : "";
    return `<a href="${escapeHtml(item.href)}"${cls}${title}>${escapeHtml(item.label)}${badge}</a>`;
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
 * The single, consistent "this feature is off" banner shown on every gated
 * `/me/*` page when its feature is disabled (#709). Replaces the old mix of
 * hard 404s, bespoke per-page notices, and silent omissions with one
 * predictable message. Members can't enable features (that's admin-only), so
 * the banner is purely informational — no action button.
 *
 * `label` names the feature (e.g. "Voice presets"). When `presettable` is
 * true the copy reassures the member their choice is saved and will apply
 * once an admin turns the feature on; when false (read-only surfaces like
 * Rewind, where there is nothing to pre-set) it simply says the content will
 * appear once the feature is enabled. Returns "" when `enabled` is true so
 * callers can drop it in unconditionally.
 */
export function renderUserFeatureDisabledNotice(opts: {
  enabled: boolean;
  label: string;
  presettable: boolean;
}): string {
  if (opts.enabled) return "";
  const label = escapeHtml(opts.label);
  const tail = opts.presettable
    ? "Your choice is saved and will apply automatically once they turn it on."
    : "Once they enable it, it'll show up here.";
  return `<div class="notice info"><strong>Your server admin hasn't enabled ${label} yet.</strong> ${tail}</div>`;
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
  // Whether the feature-gated Rewind page is enabled (#608). When false, its
  // card is still shown but tagged "off" (#709) so the overview lists every
  // manageable surface consistently rather than making some vanish.
  rewindEnabled?: boolean;
  // Whether the feature-gated Voice page is enabled (#656). When false, its
  // card is shown tagged "off" (#709), mirroring `rewindEnabled`.
  presetsEnabled?: boolean;
  // Whether the feature-gated Birthday page is enabled (#657). When false,
  // its card is shown tagged "off" (#709), mirroring `rewindEnabled`.
  birthdayEnabled?: boolean;
  // The member's poll-participation summary (#655), or null/undefined when
  // poll-participation capture is off or the member has never voted. When
  // present, a small read-only "Poll participation" card surfaces their
  // lifetime + this-year votes and when they last voted. `lastVoted` is a
  // pre-formatted ISO date (or null when never).
  pollParticipation?: {
    totalVotes: number;
    thisYearVotes: number;
    lastVoted: string | null;
  } | null;
}): string {
  const greeting = opts.isAdmin
    ? `<p class="subtitle">Signed in as an administrator viewing your own preferences. Use the <em>Back to admin panel</em> link above to manage the server.</p>`
    : `<p class="subtitle">These pages are scoped to <strong>you</strong> — what you see and change here only affects your own data on this server.</p>`;
  // Each manageable surface is always listed (#709); a disabled feature is
  // tagged "off" rather than dropped, so the overview reads the same whether
  // or not an admin has flipped the feature on.
  const offTag = ' <span class="tag tag-off">off</span>';
  const featureCard = (
    href: string,
    label: string,
    desc: string,
    enabled: boolean,
  ): string =>
    `<li><span class="feature-name"><a href="${href}">${label}</a>${enabled ? "" : offTag}</span>` +
    `<span class="feature-desc">${desc}</span></li>`;
  const voiceCard = featureCard(
    "/me/voice",
    "Voice",
    "Manage your channel name pattern and saved voice-channel presets.",
    opts.presetsEnabled !== false,
  );
  const birthdayCard = featureCard(
    "/me/birthday",
    "Birthday",
    "Set your birthday (the year is optional) so Koolbot can celebrate it on the day — in your own timezone.",
    opts.birthdayEnabled !== false,
  );
  const rewindCard = featureCard(
    "/me/rewind",
    "Rewind",
    "Your personal year-in-review of voice activity, top voice companions, peak day, and badges earned.",
    opts.rewindEnabled !== false,
  );
  // Read-only poll-participation summary (#655). Only rendered when the
  // route supplies a summary (capture on + the member has a tracking row).
  const poll = opts.pollParticipation;
  const pollCard = poll
    ? [
        '<div class="card">',
        "<h2>Poll participation</h2>",
        '<p class="muted">Your votes on server polls. Capture this and ' +
          "you'll see your yearly tally on Rewind too.</p>",
        '<div class="rw-grid">',
        '<div class="rw-stat"><div class="label">Votes cast (all time)</div>' +
          `<div class="value">${poll.totalVotes}</div></div>`,
        '<div class="rw-stat"><div class="label">Votes cast this year</div>' +
          `<div class="value">${poll.thisYearVotes}</div></div>`,
        '<div class="rw-stat"><div class="label">Last voted</div>' +
          (poll.lastVoted
            ? `<div class="value">${escapeHtml(poll.lastVoted)}</div></div>`
            : '<div class="value">—</div></div>'),
        "</div>",
        "</div>",
      ].join("")
    : "";

  return [
    "<h1>My preferences</h1>",
    greeting,
    '<div class="card">',
    "<h2>What you can manage</h2>",
    `<p>Self-service settings scoped to you on this server.</p>`,
    '<ul class="feature-list">',
    '<li><span class="feature-name"><a href="/me/notifications">Notifications</a></span>' +
      '<span class="feature-desc">Opt in or out of DM nudges from Koolbot.</span></li>',
    '<li><span class="feature-name"><a href="/me/timezone">Timezone</a></span>' +
      '<span class="feature-desc">Choose the timezone Koolbot uses when it shows you times in digests, Rewind, and voicestats.</span></li>',
    voiceCard,
    birthdayCard,
    rewindCard,
    "</ul>",
    "</div>",
    pollCard,
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

export interface RewindTextChannelView {
  channelId: string;
  channelName: string;
  count: number;
}

export interface RewindCompanionView {
  userId: string;
  displayName: string;
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
  // People the user shared voice channels with most this year (#567).
  // Replaces the old Top channels card, which was noise under dynamic VCs.
  topCompanions: RewindCompanionView[];
  peakDay: { date: string; duration: string } | null;
  // Longest single voice session of the year (#568): pre-formatted duration,
  // the ISO date it started, and the (often ephemeral) channel name. Null
  // when the user had no qualifying session that year.
  longestSession: {
    duration: string;
    date: string;
    channelName: string | null;
  } | null;
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
  // Text-message activity (#496). Mirrors the voice fields above; the
  // card is hidden when `messagesSent` is 0 (no data or tracking off).
  messagesSent: number;
  topTextChannels: RewindTextChannelView[];
  peakMessageDay: { date: string; count: number } | null;
  // Reaction activity (#653). Given / received counts for the year; the
  // block is hidden when both are 0 (no data or reaction tracking off).
  reactionsGiven: number;
  reactionsReceived: number;
  // Voice activity heatmap (#675). Duration-weighted minutes per hour-of-day
  // (length 24, index 0 = midnight) and per weekday (length 7, index 0 =
  // Sunday), in the member's timezone. The block is hidden when both are
  // empty / all-zero (no data or voice tracking off).
  hourOfDayDistribution: number[];
  dayOfWeekDistribution: number[];
  // Poll votes cast for the year (#655). The stat is hidden when 0 (no data
  // or poll-participation capture off).
  pollVotesCast: number;
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

/**
 * Text-message activity card (#496). Reuses the voice Rewind styling
 * (`.rw-stat`, `.rw-channels`). Returns "" when the user has no text
 * activity for the year so the route can append it unconditionally and
 * the card simply disappears.
 */
function renderTextActivity(opts: RewindBodyOptions): string {
  if (opts.messagesSent <= 0) return "";

  const peak = opts.peakMessageDay
    ? `<div class="value">${escapeHtml(opts.peakMessageDay.date)}</div><div class="detail">${opts.peakMessageDay.count} message${opts.peakMessageDay.count === 1 ? "" : "s"} that day</div>`
    : '<div class="value">—</div>';

  const channels =
    opts.topTextChannels.length === 0
      ? '<div class="empty">No tracked text channels this year.</div>'
      : '<ul class="rw-channels">' +
        opts.topTextChannels
          .map(
            (c) =>
              "<li>" +
              `<span class="name">${escapeHtml(c.channelName)}</span>` +
              `<span class="dur">${c.count} msg${c.count === 1 ? "" : "s"}</span>` +
              "</li>",
          )
          .join("") +
        "</ul>";

  return [
    "<h2>Text activity</h2>",
    '<div class="rw-grid">',
    '<div class="rw-stat"><div class="label">Messages sent</div>' +
      `<div class="value">${opts.messagesSent}</div></div>`,
    '<div class="rw-stat"><div class="label">Peak message day</div>' +
      peak +
      "</div>",
    "</div>",
    '<div class="card"><h2>Top text channels</h2>' + channels + "</div>",
  ].join("");
}

/**
 * Reaction-activity stat pair (#653). Reuses the voice/text `.rw-stat`
 * styling. Returns "" when the user gave and received no reactions this
 * year (no data or reaction tracking off) so the route can append it
 * unconditionally and the block simply disappears.
 */
function renderReactionActivity(opts: RewindBodyOptions): string {
  const given = opts.reactionsGiven > 0 ? opts.reactionsGiven : 0;
  const received = opts.reactionsReceived > 0 ? opts.reactionsReceived : 0;
  if (given <= 0 && received <= 0) return "";

  return [
    "<h2>Reactions</h2>",
    '<div class="rw-grid">',
    '<div class="rw-stat"><div class="label">Reactions given</div>' +
      `<div class="value">${given}</div></div>`,
    '<div class="rw-stat"><div class="label">Reactions received</div>' +
      `<div class="value">${received}</div></div>`,
    "</div>",
  ].join("");
}

/** Format a whole-minute weight as a compact "X hr Y min" tooltip / value. */
function heatMinutesLabel(minutes: number): string {
  if (minutes <= 0) return "0 min";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

/**
 * Voice activity heatmap card (#675): a 24-bar hour-of-day histogram and a
 * 7-bar weekday breakdown, both duration-weighted in the member's timezone,
 * with the peak hour/day called out. Reuses the indigo Rewind palette.
 * Returns "" when neither axis has any positive activity (no data or voice
 * tracking off) so the route can append it unconditionally and the card
 * simply disappears — mirroring the text/reaction blocks.
 */
function renderActivityHeatmap(opts: RewindBodyOptions): string {
  const hours = opts.hourOfDayDistribution ?? [];
  const days = opts.dayOfWeekDistribution ?? [];
  const peakHour = peakIndex(hours);
  const peakDayIdx = peakIndex(days);
  if (peakHour === null && peakDayIdx === null) return "";

  const maxHour = hours.reduce((m, v) => (v > m ? v : m), 0);
  const maxDay = days.reduce((m, v) => (v > m ? v : m), 0);

  const peakParts: string[] = [];
  if (peakDayIdx !== null) peakParts.push(escapeHtml(DAY_NAMES[peakDayIdx]));
  if (peakHour !== null) peakParts.push(escapeHtml(formatHourLabel(peakHour)));
  const peakLabel = peakParts.length
    ? `<p class="peak">Most active: <strong>${peakParts.join(" · ")}</strong></p>`
    : "";

  const hourSection =
    peakHour === null
      ? ""
      : '<div class="heat-section"><p class="heat-title">By hour of day</p>' +
        '<div class="rw-hours">' +
        hours
          .map((v, h) => {
            const pct = maxHour > 0 ? Math.round((v / maxHour) * 100) : 0;
            const cls = h === peakHour ? " peak" : "";
            return (
              `<div class="hb${cls}" title="${escapeHtml(formatHourLabel(h))}: ${escapeHtml(heatMinutesLabel(v))}">` +
              `<div class="fill" style="height:${pct}%"></div></div>`
            );
          })
          .join("") +
        "</div>" +
        '<div class="rw-hour-axis"><span>12 AM</span><span>6 AM</span>' +
        "<span>12 PM</span><span>6 PM</span><span>11 PM</span></div></div>";

  const daySection =
    peakDayIdx === null
      ? ""
      : '<div class="heat-section"><p class="heat-title">By day of week</p>' +
        '<div class="rw-days">' +
        days
          .map((v, d) => {
            const pct = maxDay > 0 ? Math.round((v / maxDay) * 100) : 0;
            const cls = d === peakDayIdx ? " peak" : "";
            return (
              `<div class="db${cls}">` +
              `<span class="dl">${escapeHtml(DAY_NAMES[d].slice(0, 3))}</span>` +
              `<span class="track"><span class="fill" style="width:${pct}%"></span></span>` +
              `<span class="dv">${escapeHtml(heatMinutesLabel(v))}</span>` +
              "</div>"
            );
          })
          .join("") +
        "</div></div>";

  return (
    '<div class="card"><h2>When you\'re online</h2>' +
    '<div class="rw-heat">' +
    peakLabel +
    hourSection +
    daySection +
    "</div></div>"
  );
}

/**
 * Poll-participation stat (#655). A single "Votes cast" stat reusing the
 * voice/text/reaction `.rw-stat` styling. Returns "" when the user cast no
 * votes this year (no data or poll-participation capture off) so the route
 * can append it unconditionally and the block simply disappears.
 */
function renderPollActivity(opts: RewindBodyOptions): string {
  const votes = opts.pollVotesCast > 0 ? opts.pollVotesCast : 0;
  if (votes <= 0) return "";

  return [
    "<h2>Polls</h2>",
    '<div class="rw-grid">',
    '<div class="rw-stat"><div class="label">Poll votes cast</div>' +
      `<div class="value">${votes}</div></div>`,
    "</div>",
  ].join("");
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
      `<p class="muted">We didn't find any voice or text activity or badges for you in ${opts.year}. Hop into a tracked voice channel or send a few messages and your stats will start filling in.</p>`,
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

  // Longest single session (#568): show its duration, then the date (and
  // channel when known) as the supporting detail.
  const longestSession = opts.longestSession
    ? `<div class="value">${escapeHtml(opts.longestSession.duration)}</div>` +
      `<div class="detail">on ${escapeHtml(opts.longestSession.date)}` +
      (opts.longestSession.channelName
        ? ` in ${escapeHtml(opts.longestSession.channelName)}`
        : "") +
      "</div>"
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

  // Top voice companions (#567) — with dynamic VCs *who* you sat with
  // matters more than the throwaway room, so this replaces Top channels.
  const companions =
    opts.topCompanions.length === 0
      ? '<div class="empty">No voice companions yet — hop in a channel with someone!</div>'
      : '<ul class="rw-channels">' +
        opts.topCompanions
          .map(
            (c) =>
              "<li>" +
              `<span class="name">${escapeHtml(c.displayName)}</span>` +
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
    '<div class="rw-stat"><div class="label">Longest session</div>' +
      longestSession +
      "</div>",
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
    '<div class="card"><h2>Top voice companions</h2>' + companions + "</div>",
    renderTextActivity(opts),
    renderReactionActivity(opts),
    renderActivityHeatmap(opts),
    renderPollActivity(opts),
    '<div class="card"><h2>Rank journey</h2>' +
      renderJourney(opts.weeklyJourney) +
      "</div>",
    '<div class="card"><h2>Badges earned this year</h2>' +
      renderBadges([...opts.accolades, ...opts.achievements]) +
      "</div>",
  ].join("");
}

// --------------------------------------------------------------------
// Birthday page (#657)
// --------------------------------------------------------------------

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export interface BirthdayPageBodyOptions {
  csrfToken: string;
  /** Currently stored birthday, or null when none is set. */
  selected: { month: number; day: number; year: number | null } | null;
  /**
   * Whether birthday announcements are enabled on the server. When off,
   * the page still lets a member pre-set their date (mirroring how the
   * notifications page exposes not-yet-active toggles) but shows a notice
   * that nothing will be posted until an admin turns the feature on.
   */
  featureEnabled: boolean;
}

function renderMonthOptions(selected: number | null): string {
  const blank = `<option value=""${selected === null ? " selected" : ""}>— Month —</option>`;
  const months = MONTH_NAMES.map((name, i) => {
    const value = i + 1;
    const sel = value === selected ? " selected" : "";
    return `<option value="${value}"${sel}>${escapeHtml(name)}</option>`;
  }).join("");
  return blank + months;
}

function renderDayOptions(selected: number | null): string {
  const blank = `<option value=""${selected === null ? " selected" : ""}>— Day —</option>`;
  const days = Array.from({ length: 31 }, (_, i) => {
    const value = i + 1;
    const sel = value === selected ? " selected" : "";
    return `<option value="${value}"${sel}>${value}</option>`;
  }).join("");
  return blank + days;
}

// Keeps the Day dropdown consistent with the chosen Month: options past the
// selected month's length are disabled (Feb → 29, Apr/Jun/Sep/Nov → 30) so
// impossible combinations like Feb 30 can't be picked. Feb allows 29 since
// the year is optional and may be a leap year. With no JS the full 1–31 list
// still submits and the server-side calendar check catches invalid dates.
const BIRTHDAY_DAY_SCRIPT =
  "(function(){var m=document.getElementById('bd-month');" +
  "var d=document.getElementById('bd-day');if(!m||!d)return;" +
  "var max=[31,29,31,30,31,30,31,31,30,31,30,31];" +
  "function sync(){var mv=parseInt(m.value,10);" +
  "var lim=mv>=1&&mv<=12?max[mv-1]:31;" +
  "for(var i=0;i<d.options.length;i++){var o=d.options[i];" +
  "var dv=parseInt(o.value,10);if(!dv)continue;" +
  "var bad=dv>lim;o.disabled=bad;o.hidden=bad;}" +
  "var cur=parseInt(d.value,10);if(cur>lim)d.value=''}" +
  "m.addEventListener('change',sync);sync()})();";

/**
 * Inner HTML for `GET /me/birthday` (#657). Month + day dropdowns (the day
 * list reacts to the selected month, see BIRTHDAY_DAY_SCRIPT) plus an
 * optional year number input, one POST. Year is optional (privacy): leave it
 * blank to share the date without the age. A second "Remove" button clears
 * the stored birthday.
 */
export function renderUserBirthdayBody(opts: BirthdayPageBodyOptions): string {
  const month = opts.selected?.month ?? null;
  const day = opts.selected?.day ?? null;
  const year = opts.selected?.year ?? null;
  const disabledNotice = renderUserFeatureDisabledNotice({
    enabled: opts.featureEnabled,
    label: "birthday announcements",
    presettable: true,
  });
  const hasBirthday = opts.selected !== null;
  return [
    "<h1>Birthday</h1>",
    `<p class="subtitle">Set your birthday so Koolbot can celebrate it on the day — evaluated in your own timezone (set that on the <a href="/me/timezone">Timezone</a> page). The year is optional; leave it blank to share the date without your age.</p>`,
    disabledNotice,
    '<form method="POST" action="/me/birthday">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<div class="card">',
    '<div style="display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end">',
    '<div><label for="bd-month"><strong>Month</strong></label>' +
      `<div style="margin-top:.35rem"><select id="bd-month" name="month" class="tz-select" style="max-width:12rem">${renderMonthOptions(month)}</select></div></div>`,
    '<div><label for="bd-day"><strong>Day</strong></label>' +
      `<div style="margin-top:.35rem"><select id="bd-day" name="day" class="tz-select" style="max-width:6rem">${renderDayOptions(day)}</select></div></div>`,
    '<div><label for="bd-year"><strong>Year</strong> <span class="muted">(optional)</span></label>' +
      `<div style="margin-top:.35rem"><input id="bd-year" name="year" type="number" min="1900" placeholder="—" class="tz-select" style="max-width:8rem" value="${year ?? ""}"></div></div>`,
    "</div>",
    '<div class="form-actions">',
    '<button class="btn" type="submit">Save birthday</button>',
    hasBirthday
      ? '<button class="btn" type="submit" name="clear" value="1" style="background:#4b5563">Remove my birthday</button>'
      : "",
    "</div>",
    "</div>",
    "</form>",
    `<script>${BIRTHDAY_DAY_SCRIPT}</script>`,
  ].join("");
}

// --------------------------------------------------------------------
// Timezone page (#524)
// --------------------------------------------------------------------

export interface TimezonePageBodyOptions {
  csrfToken: string;
  /** Sorted IANA zone identifiers (from `Intl.supportedValuesOf`). */
  zones: string[];
  /** Currently stored zone, or null when unset (server default). */
  selected: string | null;
  /** Host/server timezone shown as the fallback in the preview. */
  serverTimezone: string;
}

function renderTimezoneOptions(
  zones: string[],
  selected: string | null,
): string {
  // Group by the region prefix ("Europe/Berlin" → "Europe"); zones with
  // no "/" (e.g. "UTC") land under "Other".
  const groups = new Map<string, string[]>();
  for (const zone of zones) {
    const slash = zone.indexOf("/");
    const region = slash === -1 ? "Other" : zone.slice(0, slash);
    const list = groups.get(region) ?? [];
    list.push(zone);
    groups.set(region, list);
  }
  const regions = [...groups.keys()].sort();
  const optgroups = regions
    .map((region) => {
      const opts = (groups.get(region) ?? [])
        .map((zone) => {
          const sel = zone === selected ? " selected" : "";
          return `<option value="${escapeHtml(zone)}"${sel}>${escapeHtml(zone)}</option>`;
        })
        .join("");
      return `<optgroup label="${escapeHtml(region)}">${opts}</optgroup>`;
    })
    .join("");
  const serverSelected = selected === null ? " selected" : "";
  return (
    `<option value=""${serverSelected}>— Server default —</option>` + optgroups
  );
}

// Live client-side preview: shows the current time in the selected zone
// (or the server default when unset) so the user can confirm the right
// zone before saving. No third-party date picker — just `Intl`.
const TZ_PREVIEW_SCRIPT =
  "(function(){var sel=document.getElementById('tz-select');" +
  "var out=document.getElementById('tz-now');if(!sel||!out)return;" +
  "var serverTz=out.getAttribute('data-server-tz')||'UTC';" +
  "function render(){var tz=sel.value||serverTz;try{" +
  "var s=new Intl.DateTimeFormat('en-GB',{timeZone:tz,dateStyle:'medium',timeStyle:'medium'}).format(new Date());" +
  "out.textContent=s+' ('+tz+')'}catch(e){out.textContent='— invalid zone —'}}" +
  "sel.addEventListener('change',render);render();setInterval(render,1000)})();";

/**
 * Inner HTML for `GET /me/timezone` (#524). One `<select>`, one POST.
 * Choosing "Server default" and saving clears the stored preference.
 */
export function renderUserTimezoneBody(opts: TimezonePageBodyOptions): string {
  return [
    "<h1>Timezone</h1>",
    `<p class="subtitle">Koolbot renders the times in your weekly digest, Rewind, and <code>/voicestats</code> in this zone. Leave it on <em>Server default</em> to use the server's timezone (<span class="mono">${escapeHtml(opts.serverTimezone)}</span>).</p>`,
    '<form method="POST" action="/me/timezone">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<div class="card">',
    '<label for="tz-select"><strong>Your timezone</strong></label>',
    `<div style="margin-top:.5rem"><select id="tz-select" name="timezone" class="tz-select">${renderTimezoneOptions(opts.zones, opts.selected)}</select></div>`,
    `<div class="tz-preview">Current time: <span id="tz-now" class="now" data-server-tz="${escapeHtml(opts.serverTimezone)}">—</span></div>`,
    '<div class="form-actions">',
    '<button class="btn" type="submit">Save timezone</button>',
    '<span class="muted">Pick <em>Server default</em> and save to clear your preference.</span>',
    "</div>",
    "</div>",
    "</form>",
    `<script>${TZ_PREVIEW_SCRIPT}</script>`,
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
    `<p class="subtitle">Choose which DMs Koolbot may send you on this server. Every channel is off until you turn it on — Koolbot never DMs you unprompted. Untoggling a row stops the matching DM immediately.</p>`,
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
    '<span class="muted">DMs are opt-in: every channel starts off until you enable it here.</span>',
    "</div>",
    "</div>",
    "</form>",
  ].join("");
}

// --------------------------------------------------------------------
// Voice preferences page (#656)
// --------------------------------------------------------------------

export interface VoicePresetView {
  /** Stable index into the user's preset array (the form's row key). */
  index: number;
  name: string;
  channelName: string | null;
  /** null = inherit Discord's default (unlimited); 0 = explicitly unlimited. */
  userLimit: number | null;
  bitrate: number | null;
  isDefault: boolean;
}

export interface VoicePageBodyOptions {
  csrfToken: string;
  /** Current name pattern, or null when unset. */
  namePattern: string | null;
  /** Member display name, used to preview the pattern. */
  displayName: string;
  presets: VoicePresetView[];
  /** Configured max presets per user (shown as guidance). */
  maxPerUser: number;
  /**
   * Whether the voice-presets feature is enabled on the server. When off the
   * page still renders the editable form (so a member can pre-set their name
   * pattern and manage presets) but shows the shared "off" banner (#709),
   * mirroring the birthday page's pre-set affordance.
   */
  featureEnabled: boolean;
}

function renderPresetRow(p: VoicePresetView, csrfToken: string): string {
  const bits: string[] = [];
  if (p.channelName) bits.push(`name "${escapeHtml(p.channelName)}"`);
  if (p.userLimit !== null)
    bits.push(p.userLimit === 0 ? "no limit" : `limit ${p.userLimit}`);
  if (p.bitrate !== null) bits.push(`${p.bitrate}kbps`);
  const summary = bits.length ? bits.join(" · ") : "(empty)";

  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">`;
  // The hidden `index`/`expectedName` pair lets the server reject a stale
  // form whose row shifted (e.g. another tab deleted a preset first).
  const idFields =
    `<input type="hidden" name="index" value="${p.index}">` +
    `<input type="hidden" name="expectedName" value="${escapeHtml(p.name)}">`;

  return [
    '<div class="card">',
    `<h2>${escapeHtml(p.name)} ${p.isDefault ? "⭐" : ""}</h2>`,
    `<p class="muted">${summary}</p>`,
    // Edit form (name + channel name + limit + bitrate in one save).
    '<form method="POST" action="/me/voice/preset/edit">',
    csrf,
    idFields,
    '<div class="preset-grid">',
    `<label>Preset name<input type="text" name="name" value="${escapeHtml(p.name)}" maxlength="50" required></label>`,
    `<label>Channel name<input type="text" name="channelName" value="${escapeHtml(p.channelName ?? "")}" maxlength="100" placeholder="(unchanged)"></label>`,
    `<label>User limit<input type="number" name="userLimit" value="${p.userLimit ?? ""}" min="0" max="99" placeholder="(default)"></label>`,
    `<label>Bitrate (kbps)<input type="number" name="bitrate" value="${p.bitrate ?? ""}" min="8" max="384" placeholder="(default)"></label>`,
    "</div>",
    '<div class="form-actions"><button class="btn" type="submit">Save changes</button></div>',
    "</form>",
    // Default + delete as separate small forms so each is a single POST.
    '<div class="preset-actions">',
    '<form method="POST" action="/me/voice/preset/default">',
    csrf,
    idFields,
    `<button class="btn-secondary" type="submit">${p.isDefault ? "Unset default" : "Set as default"}</button>`,
    "</form>",
    '<form method="POST" action="/me/voice/preset/delete">',
    csrf,
    idFields,
    '<button class="btn-danger" type="submit">Delete</button>',
    "</form>",
    "</div>",
    "</div>",
  ].join("");
}

/**
 * Inner HTML for `GET /me/voice` (#656). One form to edit the name
 * pattern, then a card per saved preset (edit / set-default / delete).
 * Presets themselves are created in Discord by snapshotting a live
 * channel — the web surface manages the ones you already have.
 */
export function renderUserVoiceBody(opts: VoicePageBodyOptions): string {
  const presetCards =
    opts.presets.length === 0
      ? '<div class="card"><div class="empty">No saved presets yet. Open a voice channel\'s control panel in Discord and choose <strong>Presets → Save current as preset</strong> to create one.</div></div>'
      : opts.presets.map((p) => renderPresetRow(p, opts.csrfToken)).join("");

  return [
    "<h1>Voice preferences</h1>",
    '<p class="subtitle">Manage how your dynamic voice channels are named and the presets you can apply to them.</p>',
    renderUserFeatureDisabledNotice({
      enabled: opts.featureEnabled,
      label: "voice presets",
      presettable: true,
    }),
    // ---- Name pattern ----
    '<form method="POST" action="/me/voice/name-pattern">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<div class="card">',
    "<h2>Channel name pattern</h2>",
    '<p class="muted">Applied to every new channel you spawn from the lobby. Use <code>{username}</code> as a placeholder for your display name. Leave blank to use the server default naming.</p>',
    `<div style="margin-top:.5rem"><input type="text" name="namePattern" class="tz-select" maxlength="100" value="${escapeHtml(opts.namePattern ?? "")}" placeholder="e.g. {username}'s Room"></div>`,
    `<p class="muted" style="margin-top:.5rem">Preview: <span class="mono">${escapeHtml(
      opts.namePattern
        ? opts.namePattern
            .replace(/\{username\}/gi, opts.displayName)
            .replace(/\{displayname\}/gi, opts.displayName)
        : "(server default)",
    )}</span></p>`,
    '<div class="form-actions"><button class="btn" type="submit">Save name pattern</button>',
    '<span class="muted">Save an empty value to clear it.</span></div>',
    "</div>",
    "</form>",
    // ---- Presets ----
    `<h2>Saved presets <span class="muted" style="font-size:.85rem">(max ${opts.maxPerUser})</span></h2>`,
    presetCards,
  ].join("");
}
