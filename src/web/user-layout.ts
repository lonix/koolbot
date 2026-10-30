/**
 * Shared layout for the user self-service surface added in #481.
 *
 * No admin nav, no settings/wizard surfaces: the shared top bar (who you are,
 * your scopes, the session timer, Sign out, and an "Admin console" link for
 * admins), then either one centred column (Member only) or a sidebar with one
 * section per scope plus the column (#1317; see `app-shell.ts`). A new My
 * preferences tab bolts onto `USER_NAV_ITEMS` below, a new sidebar page onto
 * `SHELL_NAV` in `app-shell.ts`, without touching the admin layout.
 */

import { escapeHtml, getInactivityWindowMs } from "./admin-layout.js";
import { channelMention } from "./discord-labels.js";
import { designStylesheetLinks } from "./design-assets.js";
import { CONFIRM_SCRIPT, confirmListAttr, scriptTag } from "./html.js";
import { SAVEBAR_SCRIPT } from "./savebar.js";
import { NUMBER_INPUT_SCRIPT } from "./number-input.js";
import { waitText } from "../utils/member-cooldown.js";
import {
  DURATION_PRESETS_SCRIPT,
  TIMEZONE_SELECT_SCRIPT,
  renderTimezoneSelect,
} from "./setting-pickers.js";
import { hostPanelPath } from "./host-panel-shared.js";
import { icon, type IconName } from "./icons.js";
import { formView, type FormView, type RefusedForm } from "./form-errors.js";
import { FOCUS_FIRST_INVALID_SCRIPT } from "./event-field-errors.js";
import { renderSwitch } from "./setting-controls.js";
import type { MeSurfaceFlags } from "./me-surfaces.js";
import {
  SESSION_LOW_MS,
  renderScopeWhy,
  renderSideNav,
  renderTopBar,
  renderVersionPill,
  resolveViewer,
  scopeOfPath,
  sectionsFor,
  type ShellNavItem,
  type ShellViewer,
} from "./app-shell.js";
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
   * When set, the item is feature-gated and is left out while the feature is
   * off (#1292): a member sees only what their server has switched on, and the
   * page itself answers 404 (#1066). Nothing a member saved is deleted, so
   * turning the feature back on brings the tab and the saved choice back.
   * Names the flag in `GATED_ME_SURFACES`, the one list of what gates `/me`.
   */
  surface?: keyof MeSurfaceFlags;
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
  { href: "/me/voice", label: "Voice", surface: "presetsEnabled" },
  { href: "/me/birthday", label: "Birthday", surface: "birthdayEnabled" },
  { href: "/me/rewind", label: "Rewind", surface: "rewindEnabled" },
  { href: "/me/privacy", label: "Privacy", surface: "privacyEnabled" },
];

/**
 * Enabled-state of every feature-gated `/me/*` surface, threaded from the
 * routes into the layout so the tabs and overview cards leave out whatever is
 * switched off (#1292). Each flag defaults to enabled (`undefined` → treated
 * as on) so non-gating callers and tests that don't care about gating render
 * every item. The routes always pass the strict read of `me-surfaces.ts`.
 */
export type UserFeatureFlags = Partial<MeSurfaceFlags>;

/**
 * Whether a gated `/me` surface is shown: the one predicate behind the tabs
 * and the overview cards (the routes use the same flags for their 404s).
 */
function isSurfaceOn(
  flags: UserFeatureFlags,
  surface: keyof MeSurfaceFlags | undefined,
): boolean {
  return surface === undefined || flags[surface] !== false;
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
   * "Admin console" link in the top bar so the admin can hop
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
   * Enabled-state of the feature-gated `/me` pages (Rewind #608, Voice #656,
   * Birthday #657, Privacy #719). A tab whose flag is `false` is not rendered
   * (#1292, #1066); omitted/`undefined` keeps it, so direct callers and tests
   * that don't care about gating work unchanged.
   */
  rewindEnabled?: boolean;
  presetsEnabled?: boolean;
  birthdayEnabled?: boolean;
  privacyEnabled?: boolean;
  /**
   * Who is looking (#1317). Normally omitted: the session middleware sets the
   * request's viewer and `resolveViewer` reads it, with `isAdmin` as the last
   * resort. Tests pass it to render a scope combination directly.
   */
  viewer?: ShellViewer;
  /** Sidebar entries; defaults to the app's `SHELL_NAV`. Tests inject their own. */
  navRegistry?: readonly ShellNavItem[];
}

const STYLE = [
  // kb.css is linked ahead of this sheet and supplies the base (box-sizing, the body font, links,
  // the focus ring, `.kb-visually-hidden`). What follows is the legacy classes the member and host
  // pages still use, written on the design tokens (spacing steps, radii and the
  // per-style type sizes): no font stack and no literal size, radius or spacing in the shared
  // rules. Each tab-only rule below goes with the tab that moves to the kb- components. Never reset
  // `color-scheme`: the UI is dark only, so native control parts stay dark (#1507).
  "body{line-height:normal}",
  // The top bar and sidebar are the shared kb-topbar / kb-sidenav (app-shell.ts, #1317), reflowing
  // at 760px in kb.css; only the sign-out form needs a reset here.
  ".kb-topbar form{margin:0}",
  // The column is `kb-member` (no sidebar) or `kb-main` > `kb-main__inner` (with one); both come
  // from kb.css with their own padding and 760px reflow. `min-width:0` + `overflow-x:auto` keep a
  // wide table scrolling inside the content column rather than the whole page (WCAG 1.4.10
  // reflow, #855). The old cap of `member-content-max` sat on the padded `main`, so its content was that
  // minus the two `space-8` gutters; the same cap on the unpadded kb-main__inner (the admin's
  // `content-max` otherwise) keeps that content width. `kb-member` carries its gutters, so it is the same.
  "#main{min-width:0;overflow-x:auto}",
  // A scroll container is where `position:sticky` resolves, so on a page with a save bar `#main`
  // must not be one, or the bar sticks inside it instead of the viewport (as `main.has-savebar` in the
  // admin layout). `clip` still stops a wide child forcing a sideways page scroll.
  "#main.has-savebar{overflow-x:clip}",
  // The clip above would cut off the right-hand Save on a narrow screen or at zoom, so the bar wraps instead.
  "#main.has-savebar .kb-savebar{flex-wrap:wrap}",
  ".kb-main__inner{max-width:calc(var(--member-content-max) - 2 * var(--space-8))}",
  "#main:focus-visible{outline:none}",
  "h1{margin:0 0 var(--space-1);font-size:var(--type-page-title-size)}",
  "h2{margin:var(--space-6) 0 var(--space-2);font-size:var(--type-section-title-size);color:var(--text-secondary)}",
  ".subtitle{color:var(--muted);margin:0 0 var(--space-4)}",
  ".card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-4) var(--space-5);margin:0 0 var(--space-4);overflow-x:auto}",
  ".card h2{margin-top:0}",
  ".empty{padding:var(--space-4);color:var(--muted);font-style:italic}",
  ".muted{color:var(--muted)}",
  ".mono{font-family:var(--font-mono);font-size:var(--type-mono-size)}",
  ".tag{display:inline-block;padding:0 var(--space-2);line-height:1.4;border-radius:var(--radius-sm);font-size:var(--type-badge-size);font-weight:600;text-transform:uppercase;letter-spacing:.04em}",
  ".tag-info{background:var(--info-bg);color:var(--info-text)}",
  // Disabled-feature "off" tag on the overview cards, mirroring the admin
  // Settings palette (#709).
  ".notice{padding:var(--space-2) var(--space-3);border-radius:var(--radius-md);margin:0 0 var(--space-4)}",
  ".notice.info{background:var(--selected);color:var(--info-text)}",
  ".notice.ok{background:var(--ok-bg);color:var(--ok-text)}",
  ".notice.warn{background:var(--warn-bg);color:var(--warn-text)}",
  ".notice.err{background:var(--err-bg);color:var(--err-text)}",
  ".prefs-table{width:100%;border-collapse:collapse}",
  ".prefs-table th,.prefs-table td{text-align:left;padding:.6rem .5rem;vertical-align:top;border-bottom:1px solid var(--chrome)}",
  ".prefs-table th{font-weight:600;color:var(--text-secondary);font-size:.85rem;text-transform:uppercase;letter-spacing:.04em}",
  // A row header (`th scope=row`) reads as a body cell; only assistive tech hears the difference.
  ".prefs-table tbody th[scope=row]{font-weight:500;color:inherit;font-size:inherit;text-transform:none;letter-spacing:normal}",
  // The row header rule above sets size and colour, so the cell's own classes are restated after it.
  ".prefs-table tbody th[scope=row].mono{font-size:var(--type-mono-size)}",
  ".prefs-table tbody th[scope=row].muted{color:var(--muted)}",
  ".prefs-table tr:last-child td,.prefs-table tr:last-child th[scope=row]{border-bottom:0}",
  ".btn,.btn-secondary,.btn-danger{border:0;padding:var(--space-2) var(--space-4);border-radius:var(--radius-md);cursor:pointer;font-weight:600;font-size:var(--type-ui-size)}",
  // Neutral by default; `.btn-primary` is the one main button of a view (#1512).
  ".btn{background:var(--fill);color:var(--text)}",
  ".btn:hover{background:var(--fill-hover)}",
  ".btn-primary{background:var(--primary);color:var(--on-primary)}",
  ".btn-primary:hover{background:var(--primary-hover)}",
  // The Privacy page's download control is a link (a plain GET), not a form
  // button, so it needs the block/decoration bits a <button> gets for free.
  "a.btn{display:inline-block;text-decoration:none;color:var(--text)}",
  "a.btn:hover{text-decoration:none;color:var(--text)}",
  "a.btn-primary,a.btn-primary:hover{color:var(--on-primary)}",
  ".btn-secondary{background:var(--fill);color:var(--text)}",
  ".btn-secondary:hover{background:var(--fill-hover)}",
  ".btn-danger{background:var(--danger);color:var(--on-primary)}",
  ".btn-danger:hover{background:var(--danger-hover)}",
  ".form-actions{margin-top:1rem;display:flex;gap:.5rem;align-items:center}",
  // The shared preset editor's form (`form.stack`, on the member presets page; the admin layout styles its own).
  "form.stack label{display:block;margin:0 0 var(--space-3)}",
  "form.stack input[type=text],form.stack input[type=number],form.stack select{display:block;max-width:100%}",
  "form.stack fieldset{margin:0 0 var(--space-3)}",
  "form.inline{display:inline}",
  `.skip-link{position:absolute;left:-999px;top:0;z-index:100;background:var(--primary);color:var(--on-primary);padding:var(--space-2) var(--space-3);border-radius:0 0 var(--radius-sm) 0;font-weight:600}`,
  ".skip-link:focus{left:0;text-decoration:none}",
  // Reflow (WCAG 1.4.10, #855): the column's gutters and the Rewind hero tighten in kb.css.
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
  // Under five minutes the wrapper (`.kb-session`) turns warn.
  `if(el.parentNode&&el.parentNode.classList)el.parentNode.classList.toggle('is-low',r<${SESSION_LOW_MS});` +
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

// Move focus to the post-redirect flash (#855). A live region that is part
// of a freshly loaded document is never announced by itself, so after a PRG
// save the "Preferences saved." notice would otherwise be silent to a
// screen reader. `renderFlash` gives the node `tabindex="-1"` so this plain
// `focus()` works; no-ops on every page without a flash.
const FLASH_FOCUS_SCRIPT =
  "(function(){var n=document.querySelector('.notice[data-flash]');" +
  "if(!n)return;try{n.focus()}catch(e){}})();";

/**
 * Puts the scope's "why you see this" line inside the page's own header, under
 * the title (`.kb-pagehead__sub`, normal text flow so several role mentions wrap), so a page says
 * why once and the line is part of the PageHeader (DESIGN.md Layout). The page
 * bodies are built by our own views, which open with `<header
 * class="kb-pagehead">` whose text block is its first `div`; the line goes at
 * the end of that block. A body without a header (a confirm or result step
 * with no page title) keeps the line first.
 */
export function placeScopeWhy(body: string, why: string): string {
  if (!why) return body;
  // A view may wrap everything in one `kb-stack` (#1603): the header is then its first child.
  const lead = /^\s*(?:<div class="kb-stack">\s*)?/.exec(body)?.[0] ?? "";
  const head = /^<header class="kb-pagehead">[\s\S]*?<\/header>/.exec(
    body.slice(lead.length),
  )?.[0];
  if (!head) return why + body;
  // The text block closes right before the header's actions (if any) or its end.
  const close =
    /<\/div>(?=\s*(?:<div class="kb-pagehead__actions">[\s\S]*?<\/div>\s*)?<\/header>$)/.exec(
      head,
    );
  if (!close) return why + body;
  const at = lead.length + close.index;
  return body.slice(0, at) + why + body.slice(at);
}

export function renderUserPage(opts: UserPageOptions): string {
  const viewer = resolveViewer(opts.viewer, opts.isAdmin);
  const sections = sectionsFor(viewer, opts.navRegistry, viewer.features);
  const sideNav = renderSideNav(sections, opts.active);
  // With a sidebar the page navigation is the sidebar's; the My preferences
  // tabs belong to the You section only. Without one they stay in the column.
  const onMemberPage = scopeOfPath(opts.active) === "member";
  const tabs =
    !sideNav || onMemberPage
      ? renderPageNav(opts.active, {
          rewindEnabled: opts.rewindEnabled,
          presetsEnabled: opts.presetsEnabled,
          birthdayEnabled: opts.birthdayEnabled,
          privacyEnabled: opts.privacyEnabled,
        })
      : "";
  // The tabs get the Stack's gap to what follows; a page without tabs (the
  // sidebar scopes) is one block, so the legacy margins between its parts stay the only spacing
  // inside the column's flex gap.
  const flash = renderFlash(opts.flash);
  const body = placeScopeWhy(opts.body, renderScopeWhy(viewer, opts.active));
  const inner = tabs
    ? `<div class="kb-stack">${tabs}${flash}<div>${body}</div></div>`
    : `<div>${flash}${body}</div>`;
  // A page with a save bar (#1514): `#main` must not be a scroll container, or the bar cannot stick.
  // The literal only comes from `renderSaveBar` (user text in the body is escaped).
  const hasSaveBar = opts.body.includes('class="kb-savebar"');
  const mainClass = (base: string): string =>
    `${base}${hasSaveBar ? " has-savebar" : ""}`;
  const content = sideNav
    ? `<div class="kb-shell">${sideNav}<main id="main" class="${mainClass("kb-main")}" tabindex="-1"><div class="kb-main__inner">${inner}</div></main></div>`
    : `<main id="main" class="${mainClass("kb-member")}" tabindex="-1">${inner}</main>`;
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    `<title>${escapeHtml(opts.title)} — KoolBot</title>`,
    // tokens.css + kb.css first, so this page-local sheet can still override them.
    designStylesheetLinks("/me"),
    `<style>${STYLE}</style>`,
    "</head><body>",
    // First focusable element on every page (#855); `main` carries
    // `tabindex="-1"` so the fragment jump also moves keyboard focus.
    '<a class="skip-link" href="#main">Skip to content</a>',
    // A `<header>` banner landmark (the top bar), so the session countdown and
    // Sign out are not stranded outside every landmark (axe `region`, #856).
    renderTopBar({
      viewer,
      surface: "me",
      home: "/me/",
      brandExtraHtml: renderVersionPill(),
      csrfToken: opts.csrfToken,
      remainingMs: opts.remainingMs,
      inactivityMs: getInactivityWindowMs(),
    }),
    content,
    `${scriptTag(SCRIPT)}`,
    `${scriptTag(CONFIRM_SCRIPT)}`,
    `${scriptTag(FLASH_FOCUS_SCRIPT)}`,
    // Scripts of the controls of a page that has them (#1514): the save bar, the
    // bounded number box and the duration presets. Each is only sent where its markup is.
    ...(hasSaveBar ? [`${scriptTag(SAVEBAR_SCRIPT)}`] : []),
    ...(opts.body.includes("data-number")
      ? [`${scriptTag(NUMBER_INPUT_SCRIPT)}`]
      : []),
    ...(opts.body.includes("data-duration")
      ? [`${scriptTag(DURATION_PRESETS_SCRIPT)}`]
      : []),
    "</body></html>",
  ].join("");
}

function renderPageNav(active: string, flags: UserFeatureFlags): string {
  // A feature the server has switched off has no tab (#1292, extending the
  // Privacy treatment of #1066): the member sees only what they can use, and
  // the page answers 404. `undefined` flags are treated as enabled so
  // non-gating callers/tests render every tab.
  const items = USER_NAV_ITEMS.filter((item) =>
    isSurfaceOn(flags, item.surface),
  )
    .map((item) => {
      const isActive =
        item.href === active ||
        (item.href === "/me/" && (active === "/me" || active === "/me/"));
      const current = isActive ? ' aria-current="page"' : "";
      return `<a href="${escapeHtml(item.href)}"${current}>${escapeHtml(item.label)}</a>`;
    })
    .join("");
  // Named so it stays distinguishable from a page body's own nav (the
  // Rewind year picker) — axe `landmark-unique`, #856.
  return `<nav class="kb-tabs" aria-label="My preferences sections">${items}</nav>`;
}

/**
 * The PageHeader a member tab opens with: the title and one line of what the
 * page is for (`sub` is trusted HTML the caller built). `placeScopeWhy` adds the
 * scope's "why you see this" line at the end of the text block.
 */
function pageHeader(title: string, sub: string): string {
  return (
    '<header class="kb-pagehead"><div class="kb-pagehead__text">' +
    `<h1 class="kb-pagehead__title">${escapeHtml(title)}</h1>` +
    `<p class="kb-pagehead__sub">${sub}</p></div></header>`
  );
}

function renderFlash(flash?: UserFlashMessage | null): string {
  if (!flash) return "";
  const cls =
    flash.type === "ok" ? "ok" : flash.type === "warn" ? "warn" : "err";
  // tabindex="-1" + data-flash: the layout's FLASH_FOCUS_SCRIPT focuses it on
  // load so the outcome of a post-redirect save is actually announced
  // (WCAG 4.1.3, #855). A result is a polite status; a failure is an alert
  // (#1517).
  const role = flash.type === "err" ? "alert" : "status";
  return `<div class="notice ${cls}" role="${role}" tabindex="-1" data-flash>${escapeHtml(flash.text)}</div>`;
}

/**
 * The "this feature is off" banner. Only the Privacy body still renders it,
 * and only as a safety net: the route answers 404 while `privacy.enabled` is
 * off (#1066), so a member never sees it. Every other gated `/me/*` page is
 * left out of the nav and answers 404 while its feature is off (#1292).
 * Returns "" when `enabled` is true so a caller can drop it in unconditionally.
 */
export function renderUserFeatureDisabledNotice(opts: {
  enabled: boolean;
  label: string;
}): string {
  if (opts.enabled) return "";
  const label = escapeHtml(opts.label);
  return `<div class="notice info"><strong>Your server admin hasn't enabled ${label} yet.</strong> Once they enable it, it'll show up here.</div>`;
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
  // Enabled-state of the feature-gated pages (Rewind #608, Voice #656,
  // Birthday #657, Privacy #719). A switched-off feature gets no card at all
  // (#1292, #1066): its page answers 404, so a link would be a dead end.
  // `undefined` keeps the card.
  rewindEnabled?: boolean;
  presetsEnabled?: boolean;
  birthdayEnabled?: boolean;
  privacyEnabled?: boolean;
  // Open events the member created (#1189), each linking to its host panel.
  // Empty or absent hides the card.
  hostedEvents?: Array<{
    id: string;
    title: string;
    when: string;
    state: string;
    /** `isEventRunning`: active and the start has arrived. */
    running: boolean;
  }>;
  /**
   * How each preference is set now, as one short line for its card ("Europe/Oslo ·
   * 10:59 now"). Plain text. A missing entry leaves the line out.
   */
  preferenceValues?: Partial<
    Record<
      "notifications" | "timezone" | "voice" | "birthday" | "privacy",
      string
    >
  >;
  // The member's poll-participation summary (#655), or null/undefined when
  // poll-participation capture is off or the member has never voted. When
  // present, a small read-only "Poll participation" card surfaces their
  // lifetime + this-year votes and when they last voted. `lastVoted` is a
  // pre-formatted ISO date (or null when never).
  pollParticipation?: {
    totalVotes: number;
    thisYearVotes: number;
    // Votes cast in the current ISO week (#816). Optional so a caller that
    // predates the weekly bucket can omit it; the stat is then hidden.
    thisWeekVotes?: number;
    lastVoted: string | null;
  } | null;
}): string {
  const greeting = opts.isAdmin
    ? "Signed in as an administrator viewing your own preferences. Use the <em>Admin console</em> link above to manage the server."
    : "These pages are scoped to <strong>you</strong> — what you see and change here only affects your own data on this server.";
  const header =
    '<header class="kb-pagehead"><div class="kb-pagehead__text">' +
    '<h1 class="kb-pagehead__title">My preferences</h1>' +
    `<p class="kb-pagehead__sub">${greeting}</p></div></header>`;

  // One FeatureCard per preference the server has switched on (#1292), each
  // saying how it is set now. `value` is plain text, escaped here; a missing
  // value leaves the line out rather than printing a placeholder.
  const featureCard = (
    surface: keyof MeSurfaceFlags | null,
    href: string,
    iconName: IconName,
    label: string,
    desc: string,
    value: string | undefined,
  ): string =>
    surface === null || isSurfaceOn(opts, surface)
      ? '<div class="kb-feature">' +
        `<div class="kb-feature__icon">${icon(iconName)}</div>` +
        '<div class="kb-feature__body">' +
        `<a class="kb-feature__name" href="${href}">${label}</a>` +
        `<p class="kb-feature__desc">${desc}</p>` +
        (value ? `<p class="kb-feature__value">${escapeHtml(value)}</p>` : "") +
        "</div>" +
        `<div class="kb-feature__aside">${icon("chevron-right", { className: "kb-chev" })}</div>` +
        "</div>"
      : "";
  const values = opts.preferenceValues ?? {};
  const featureCards = [
    featureCard(
      null,
      "/me/notifications",
      "bell",
      "Notifications",
      "Opt in or out of DM nudges from KoolBot.",
      values.notifications,
    ),
    featureCard(
      null,
      "/me/timezone",
      "clock",
      "Timezone",
      "Choose the timezone KoolBot uses when it shows you times, such as in <code>/voicestats</code>.",
      values.timezone,
    ),
    featureCard(
      "presetsEnabled",
      "/me/voice",
      "mic",
      "Voice",
      "Manage your channel name pattern and saved voice-channel presets.",
      values.voice,
    ),
    featureCard(
      "birthdayEnabled",
      "/me/birthday",
      "cake",
      "Birthday",
      "Set your birthday (the year is optional) so KoolBot can celebrate it on the day — in your own timezone.",
      values.birthday,
    ),
    featureCard(
      "rewindEnabled",
      "/me/rewind",
      "history",
      "Rewind",
      "Your personal year-in-review of voice activity, top voice companions, peak day, and badges earned.",
      undefined,
    ),
    featureCard(
      "privacyEnabled",
      "/me/privacy",
      "shield-check",
      "Privacy",
      "See what KoolBot stores about you — and download all of it as a single JSON file.",
      values.privacy,
    ),
  ].join("");

  // Events the member created (#1189). What is live right now leads the page
  // (a Panel linking to each host panel, with the state as a word badge); the
  // events still ahead are one line with a count that links to Your events.
  // Only a running event is "Live": the words match `stateBadge` in
  // `me-events-page.ts` (not imported, it would make an import cycle).
  const hosted = opts.hostedEvents ?? [];
  const live = hosted.filter((e) => e.running);
  const upcoming = hosted.length - live.length;
  const livePanel =
    live.length > 0
      ? '<section class="kb-panel" aria-labelledby="hosting-now-h">' +
        '<header class="kb-panel__head">' +
        `<h2 class="kb-panel__title" id="hosting-now-h">${live.length === 1 ? "Your event is live" : "Your events are live"}</h2></header>` +
        '<div class="kb-panel__body kb-stack">' +
        live
          .map(
            (e) =>
              '<div class="kb-row">' +
              '<span class="kb-badge kb-badge--on">Live</span>' +
              `<strong>${escapeHtml(e.title)}</strong>` +
              `<span class="kb-muted">${escapeHtml(e.when)}</span>` +
              `<a class="kb-btn kb-btn--sm${live.length === 1 ? " kb-btn--primary" : ""}" href="${escapeHtml(hostPanelPath(e.id))}" aria-label="Open the host panel for ${escapeHtml(e.title)}">Host panel</a>` +
              "</div>",
          )
          .join("") +
        "</div></section>"
      : "";
  const upcomingLine =
    upcoming > 0
      ? `<p class="kb-help"><a href="/me/events">${upcoming} ${upcoming === 1 ? "event" : "events"}</a> you host ${upcoming === 1 ? "is" : "are"} planned.</p>`
      : "";

  // Read-only poll-participation summary (#655). Only rendered when the
  // route supplies a summary (capture on + the member has a tracking row).
  const poll = opts.pollParticipation;
  const tile = (label: string, value: string): string => statTile(label, value);
  const pollPanel = poll
    ? '<section class="kb-panel" aria-labelledby="poll-participation-h">' +
      '<header class="kb-panel__head"><h2 class="kb-panel__title" id="poll-participation-h">Poll participation</h2></header>' +
      '<div class="kb-panel__body kb-stack">' +
      '<p class="kb-help">Your votes on server polls.' +
      // Names Rewind only while it is on (#1292).
      (isSurfaceOn(opts, "rewindEnabled")
        ? " Capture this and you'll see your yearly tally on Rewind too."
        : "") +
      "</p>" +
      '<div class="kb-tiles">' +
      tile("Votes cast (all time)", String(poll.totalVotes)) +
      tile("Votes cast this year", String(poll.thisYearVotes)) +
      (typeof poll.thisWeekVotes === "number"
        ? tile("Votes cast this week", String(poll.thisWeekVotes))
        : "") +
      tile("Last voted", poll.lastVoted ? escapeHtml(poll.lastVoted) : "—") +
      "</div></div></section>"
    : "";

  return [
    '<div class="kb-stack">',
    header,
    livePanel,
    upcomingLine,
    `<div class="kb-features">${featureCards}</div>`,
    pollPanel,
    `<p class="kb-help">User <span class="kb-mono">${escapeHtml(opts.discordUserId)}</span> · Server <span class="kb-mono">${escapeHtml(opts.guildId)}</span>. To sign in as someone else, run <span class="kb-mono">/me</span> with that account.</p>`,
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
  /** Discord channel type; null when the channel no longer resolves. */
  channelType: number | null;
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
  // Voice time by kind of room (#1420), pre-formatted. Rooms are not named on
  // this user-facing page; empty hides the card.
  voiceByKind?: Array<{ kind: string; duration: string }>;
  // Longest single voice session of the year (#568): pre-formatted duration,
  // the ISO date it started, and the kind of room (#1420) — never its name,
  // which is only a label and often belongs to a deleted room. Null when the
  // user had no qualifying session that year.
  longestSession: {
    duration: string;
    date: string;
    roomKind: string;
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

/** A StatTile (components.md). `value` and `detail` are HTML the caller has already escaped. */
function statTile(label: string, value: string, detail = ""): string {
  return (
    '<div class="kb-tile">' +
    `<div class="kb-tile__top"><p class="kb-overline">${label}</p></div>` +
    `<div class="kb-tile__value">${value}</div>` +
    (detail ? `<div class="kb-tile__detail">${detail}</div>` : "") +
    "</div>"
  );
}

/** A Panel (components.md) with a title and one body. `body` is HTML the caller has already escaped. */
function panel(
  title: string,
  body: string,
  opts: { flush?: boolean; meta?: string } = {},
): string {
  return (
    '<section class="kb-panel"><header class="kb-panel__head">' +
    `<h2 class="kb-panel__title">${title}</h2>` +
    (opts.meta ? `<span class="kb-panel__meta">${opts.meta}</span>` : "") +
    "</header>" +
    `<div class="kb-panel__body${opts.flush ? " kb-panel__body--flush" : ""}">${body}</div></section>`
  );
}

/** An EmptyState (components.md): what is missing, then how it fills up. */
function emptyState(title: string, text: string): string {
  return `<div class="kb-empty"><p class="kb-empty__title">${title}</p><p class="kb-empty__text">${text}</p></div>`;
}

/** A name and a figure per row, in a `kb-list`. Both are HTML the caller has already escaped. */
function nameValueList(rows: { name: string; value: string }[]): string {
  return (
    '<ul class="kb-list">' +
    rows
      .map(
        (r) =>
          `<li><span class="kb-list__main">${r.name}</span><span class="kb-muted">${r.value}</span></li>`,
      )
      .join("") +
    "</ul>"
  );
}

/**
 * The year chips. The shown year carries `aria-current="page"`, and the
 * stylesheet adds weight and an underline to the `lore` ground so the state
 * is not colour alone (#1524).
 */
function renderYearPicker(current: number, years: number[]): string {
  if (years.length <= 1) return "";
  const items = years
    .map((y) => {
      const cur = y === current ? ' aria-current="page"' : "";
      return `<a href="/me/rewind/${y}"${cur}>${y}</a>`;
    })
    .join("");
  return `<nav class="kb-years" aria-label="Rewind year">${items}</nav>`;
}

function renderBadges(badges: RewindBadgeView[]): string {
  if (badges.length === 0) {
    return emptyState(
      "No badges this year.",
      "Badges you earn show up here, with the day you earned them.",
    );
  }
  return (
    '<ul class="kb-list">' +
    badges
      .map(
        (b) =>
          `<li><span>${escapeHtml(b.emoji)}</span>` +
          '<span class="kb-list__main">' +
          `<strong>${escapeHtml(b.name)}</strong>` +
          `<span class="kb-list__desc">${escapeHtml(b.description)}</span>` +
          `<span class="kb-list__desc">Earned ${escapeHtml(b.earnedAt)}</span>` +
          "</span></li>",
      )
      .join("") +
    "</ul>"
  );
}

function renderJourney(j: RewindBodyOptions["weeklyJourney"]): string {
  if (!j.first && !j.last && !j.best) {
    return emptyState(
      "No weekly ranking yet.",
      "Your first, best and last place on the weekly leaderboard show up here once you have placed.",
    );
  }
  const cell = (
    label: string,
    entry: { isoYear: number; isoWeek: number; rank: number } | null,
  ): string =>
    entry
      ? statTile(
          escapeHtml(label),
          `#${entry.rank}`,
          `${entry.isoYear} · W${entry.isoWeek}`,
        )
      : statTile(escapeHtml(label), "—");
  return (
    '<div class="kb-tiles">' +
    cell("First", j.first) +
    cell("Best", j.best) +
    cell("Last", j.last) +
    "</div>"
  );
}

/**
 * Text-message activity (#496): two StatTiles and a list of channels.
 * Returns "" when the user has no text activity for the year so the route
 * can append it unconditionally and the block simply disappears.
 */
function renderTextActivity(opts: RewindBodyOptions): string {
  if (opts.messagesSent <= 0) return "";

  const peak = opts.peakMessageDay
    ? statTile(
        "Peak message day",
        escapeHtml(opts.peakMessageDay.date),
        `${opts.peakMessageDay.count} message${opts.peakMessageDay.count === 1 ? "" : "s"} that day`,
      )
    : statTile("Peak message day", "—");

  const channels =
    opts.topTextChannels.length === 0
      ? emptyState(
          "No tracked text channels this year.",
          "Channels you write in show up here, busiest first.",
        )
      : nameValueList(
          opts.topTextChannels.map((c) => ({
            name: channelMention({ name: c.channelName, type: c.channelType }),
            value: `${c.count} msg${c.count === 1 ? "" : "s"}`,
          })),
        );

  return [
    "<h2>Text activity</h2>",
    '<div class="kb-tiles">',
    statTile("Messages sent", String(opts.messagesSent)),
    peak,
    "</div>",
    panel("Top text channels", channels, {
      flush: opts.topTextChannels.length > 0,
    }),
  ].join("");
}

/**
 * Reaction-activity tiles (#653). Returns "" when the user gave and received
 * no reactions this year (no data or reaction tracking off) so the route can
 * append it unconditionally and the block simply disappears.
 */
function renderReactionActivity(opts: RewindBodyOptions): string {
  const given = opts.reactionsGiven > 0 ? opts.reactionsGiven : 0;
  const received = opts.reactionsReceived > 0 ? opts.reactionsReceived : 0;
  if (given <= 0 && received <= 0) return "";

  return [
    "<h2>Reactions</h2>",
    '<div class="kb-tiles">',
    statTile("Reactions given", String(given)),
    statTile("Reactions received", String(received)),
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

/** A bar list (components.md, Heatmap): label, bar, figure; the top row is `is-peak`. */
function barList(
  rows: { label: string; weight: number; value: string }[],
  peak: number | null,
): string {
  const max = rows.reduce((m, r) => (r.weight > m ? r.weight : m), 0);
  return (
    '<div class="kb-bars">' +
    rows
      .map((r, i) => {
        const pct = max > 0 ? Math.round((r.weight / max) * 100) : 0;
        return (
          `<div class="kb-bars__row${i === peak ? " is-peak" : ""}">` +
          `<span>${escapeHtml(r.label)}</span>` +
          `<span class="kb-bars__track"><span class="kb-bars__fill" style="width:${pct}%"></span></span>` +
          `<span class="kb-bars__val">${escapeHtml(r.value)}</span></div>`
        );
      })
      .join("") +
    "</div>"
  );
}

/**
 * "When you're online" (#675): the weekday and the hour of day as two bar
 * lists, both duration-weighted in the member's timezone, with the peak named
 * in the panel's head and marked `is-peak` in its list. Rewind stores the two
 * distributions apart, so a weekday-by-hour grid cannot be drawn (#1524).
 * Returns "" when neither axis has any positive activity (no data or voice
 * tracking off) so the route can append it unconditionally and the panel
 * simply disappears.
 */
function renderActivityHeatmap(opts: RewindBodyOptions): string {
  const hours = opts.hourOfDayDistribution ?? [];
  const days = opts.dayOfWeekDistribution ?? [];
  const peakHour = peakIndex(hours);
  const peakDayIdx = peakIndex(days);
  if (peakHour === null && peakDayIdx === null) return "";

  const peakParts: string[] = [];
  if (peakDayIdx !== null) peakParts.push(escapeHtml(DAY_NAMES[peakDayIdx]));
  if (peakHour !== null) peakParts.push(escapeHtml(formatHourLabel(peakHour)));
  const peakLabel = `Most active: <strong>${peakParts.join(" · ")}</strong>`;

  const daySection =
    peakDayIdx === null
      ? ""
      : '<p class="kb-overline">By day of week</p>' +
        barList(
          days.map((v, d) => ({
            label: DAY_NAMES[d].slice(0, 3),
            weight: v,
            value: heatMinutesLabel(v),
          })),
          peakDayIdx,
        );

  const hourSection =
    peakHour === null
      ? ""
      : '<p class="kb-overline">By hour of day</p>' +
        barList(
          hours.map((v, h) => ({
            label: formatHourLabel(h),
            weight: v,
            value: heatMinutesLabel(v),
          })),
          peakHour,
        );

  return panel(
    "When you're online",
    `<div class="kb-stack">${daySection}${hourSection}</div>`,
    { meta: peakLabel },
  );
}

/**
 * Poll-participation tile (#655). Returns "" when the user cast no votes this
 * year (no data or poll-participation capture off) so the route can append
 * it unconditionally and the block simply disappears.
 */
function renderPollActivity(opts: RewindBodyOptions): string {
  const votes = opts.pollVotesCast > 0 ? opts.pollVotesCast : 0;
  if (votes <= 0) return "";

  return [
    "<h2>Polls</h2>",
    '<div class="kb-tiles">',
    statTile("Poll votes cast", String(votes)),
    "</div>",
  ].join("");
}

/** Room-kind labels for the Rewind page (#1420); `other` is the neutral fallback. */
const ROOM_KIND_PLURAL: Record<string, string> = {
  dynamic: "In dynamic voice channels",
  event: "In event channels",
  permanent: "In permanent voice channels",
  lobby: "In the lobby",
  other: "In other voice channels",
};
const ROOM_KIND_SINGULAR: Record<string, string> = {
  dynamic: "a dynamic voice channel",
  event: "an event channel",
  permanent: "a permanent voice channel",
  lobby: "the lobby",
  other: "a voice channel",
};

export function renderUserRewindBody(opts: RewindBodyOptions): string {
  const years = opts.availableYears.includes(opts.year)
    ? opts.availableYears
    : [opts.year, ...opts.availableYears];
  const picker = renderYearPicker(opts.year, years);

  if (!opts.hasData) {
    return [
      '<div class="kb-stack">',
      `<h1>Rewind ${opts.year}</h1>`,
      '<p class="subtitle">Your personal year-in-review.</p>',
      picker,
      '<div class="kb-panel"><div class="kb-panel__body">',
      emptyState(
        "Nothing to recap yet",
        `We didn't find any voice or text activity or badges for you in ${opts.year}. Hop into a tracked voice channel or send a few messages and your stats will start filling in.`,
      ),
      "</div></div>",
      "</div>",
    ].join("");
  }

  // The year's headline (#1524): a solid lore-deep panel, the total in `stat-hero`.
  const hero = [
    '<div class="kb-hero--lore">',
    `<p class="kb-hero__value">${escapeHtml(opts.totalDuration)}</p>`,
    opts.funComparison
      ? `<p class="kb-hero__line">${escapeHtml(opts.funComparison)}</p>`
      : "",
    `<p class="kb-hero__line kb-hero__line--sub">${opts.sessionCount} session${opts.sessionCount === 1 ? "" : "s"} across ${opts.daysActive} day${opts.daysActive === 1 ? "" : "s"}</p>`,
    "</div>",
  ].join("");

  const peak = opts.peakDay
    ? statTile(
        "Peak day",
        escapeHtml(opts.peakDay.date),
        `${escapeHtml(opts.peakDay.duration)} that day`,
      )
    : statTile("Peak day", "—");

  // Longest single session (#568): show its duration, then the date (and
  // room kind) as the supporting detail.
  const longestSession = opts.longestSession
    ? statTile(
        "Longest session",
        escapeHtml(opts.longestSession.duration),
        `on ${escapeHtml(opts.longestSession.date)} in ${escapeHtml(
          ROOM_KIND_SINGULAR[opts.longestSession.roomKind] ??
            ROOM_KIND_SINGULAR.other,
        )}`,
      )
    : statTile("Longest session", "—");

  // Voice time by kind of room (#1420), in place of per-room names.
  // A summary that never went through snapshot normalisation may omit it.
  const kindRows = opts.voiceByKind ?? [];
  const voiceKinds =
    kindRows.length === 0
      ? ""
      : panel(
          "Where you spent your voice time",
          nameValueList(
            kindRows.map((k) => ({
              name: escapeHtml(
                ROOM_KIND_PLURAL[k.kind] ?? ROOM_KIND_PLURAL.other,
              ),
              value: escapeHtml(k.duration),
            })),
          ),
          { flush: true },
        );

  const streak = opts.longestStreakDays
    ? statTile(
        "Longest streak",
        `${opts.longestStreakDays} day${opts.longestStreakDays === 1 ? "" : "s"}`,
        opts.longestStreakRange
          ? `${escapeHtml(opts.longestStreakRange.startDate)} → ${escapeHtml(opts.longestStreakRange.endDate)}`
          : "",
      )
    : statTile("Longest streak", "—");

  const rankStat =
    opts.annualRank !== null
      ? statTile(
          "Annual rank",
          `#${opts.annualRank}`,
          `of ${opts.annualGuildMembers} active members`,
        )
      : statTile("Annual rank", "—");

  const medianStat =
    opts.percentAboveMedian !== null
      ? statTile(
          "Above median",
          `${opts.percentAboveMedian >= 0 ? "+" : ""}${opts.percentAboveMedian}%`,
          "vs. the guild median",
        )
      : statTile("Above median", "—");

  // Top voice companions (#567) — with dynamic VCs *who* you sat with
  // matters more than the throwaway room, so this replaces Top channels.
  const companions =
    opts.topCompanions.length === 0
      ? emptyState(
          "No voice companions yet.",
          "People you share a voice channel with show up here, most time first.",
        )
      : nameValueList(
          opts.topCompanions.map((c) => ({
            name: escapeHtml(c.displayName),
            value: escapeHtml(c.duration),
          })),
        );

  return [
    '<div class="kb-stack">',
    `<h1>Rewind ${opts.year}</h1>`,
    '<p class="subtitle">Your personal year-in-review.</p>',
    picker,
    hero,
    '<div class="kb-tiles">',
    peak,
    longestSession,
    streak,
    rankStat,
    medianStat,
    "</div>",
    voiceKinds,
    panel("Top voice companions", companions, {
      flush: opts.topCompanions.length > 0,
    }),
    renderTextActivity(opts),
    renderReactionActivity(opts),
    renderActivityHeatmap(opts),
    renderPollActivity(opts),
    panel("Rank journey", renderJourney(opts.weeklyJourney)),
    panel(
      "Badges earned this year",
      renderBadges([...opts.accolades, ...opts.achievements]),
      { flush: opts.accolades.length + opts.achievements.length > 0 },
    ),
    "</div>",
  ].join("");
}

// --------------------------------------------------------------------
// Birthday page (#657)
// --------------------------------------------------------------------

export const MONTH_NAMES = [
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
   * `birthdays.change_cooldown_seconds`; above 0 the removal dialog says how
   * long until a birthday can be set again. Absent or 0 adds no line.
   */
  changeCooldownSeconds?: number;
  /**
   * The save the server just refused (#1535): the page shows what was posted
   * and marks the field it is about. `formId` is {@link BIRTHDAY_FORM_ID}.
   * The field keys are `date` (month and day together) and `year`.
   */
  refusedForm?: RefusedForm | null;
}

/** The `formId` of the Birthday form's {@link RefusedForm}. */
export const BIRTHDAY_FORM_ID = "birthday";

/**
 * The consequence list of the member's *Remove my birthday* dialog, mirroring
 * the admin Birthdays page's list in the member's terms (#1521).
 */
export function birthdayRemoveItems(changeCooldownSeconds = 0): string[] {
  const items = [
    "Your saved birthday is removed.",
    "A birthday role you hold now is taken back.",
    "The bot's birthday posts about you are deleted.",
    "If the role or a post cannot be taken back, your birthday is kept so you can try again.",
  ];
  if (Number.isFinite(changeCooldownSeconds) && changeCooldownSeconds > 0) {
    items.push(
      `You can set a birthday again in ${waitText(Math.ceil(changeCooldownSeconds))}.`,
    );
  }
  return items;
}

// A refused form echoes what was posted, as the text it was posted as; a
// stored value is compared the same way.
function renderMonthOptions(selected: string): string {
  const blank = `<option value=""${selected === "" ? " selected" : ""}>— Month —</option>`;
  const months = MONTH_NAMES.map((name, i) => {
    const value = i + 1;
    const sel = String(value) === selected ? " selected" : "";
    return `<option value="${value}"${sel}>${escapeHtml(name)}</option>`;
  }).join("");
  return blank + months;
}

function renderDayOptions(selected: string): string {
  const blank = `<option value=""${selected === "" ? " selected" : ""}>— Day —</option>`;
  const days = Array.from({ length: 31 }, (_, i) => {
    const value = i + 1;
    const sel = String(value) === selected ? " selected" : "";
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
  const f = formView(opts.refusedForm, BIRTHDAY_FORM_ID);
  const month = f.selected("month", String(opts.selected?.month ?? ""));
  const day = f.selected("day", String(opts.selected?.day ?? ""));
  const year = f.value("year", String(opts.selected?.year ?? ""));
  const hasBirthday = opts.selected !== null;
  // The controls keep their fixed ids (the label and BIRTHDAY_DAY_SCRIPT use
  // them), so the marks are built here instead of with `f.attrs`. Month and day
  // are one refusal ("date") and share its one error line.
  const mark = (key: "date" | "year"): string =>
    f.error(key)
      ? ` aria-invalid="true" aria-describedby="${BIRTHDAY_FORM_ID}-${key}-error"`
      : "";
  return [
    '<div class="kb-stack">',
    pageHeader(
      "Birthday",
      `Set your birthday so KoolBot can celebrate it on the day — evaluated in your own timezone (set that on the <a href="/me/timezone">Timezone</a> page). The year is optional; leave it blank to share the date without your age.`,
    ),
    '<section class="kb-panel" aria-labelledby="birthday-title">',
    '<header class="kb-panel__head"><h2 class="kb-panel__title" id="birthday-title">Your birthday</h2></header>',
    '<div class="kb-panel__body">',
    '<form method="POST" action="/me/birthday" class="kb-stack">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<div class="kb-fields">',
    '<div class="kb-field"><label class="kb-label" for="bd-month">Month</label>' +
      `<select id="bd-month" name="month" class="kb-select"${mark("date")}>${renderMonthOptions(month)}</select></div>`,
    '<div class="kb-field"><label class="kb-label" for="bd-day">Day</label>' +
      `<select id="bd-day" name="day" class="kb-select"${mark("date")}>${renderDayOptions(day)}</select></div>`,
    '<div class="kb-field"><label class="kb-label" for="bd-year">Year <span class="kb-help">(optional)</span></label>' +
      `<input id="bd-year" name="year" type="number" min="1900" placeholder="—" class="kb-input" value="${escapeHtml(year)}"${mark("year")}>${f.error("year")}</div>`,
    "</div>",
    f.error("date"),
    '<div class="kb-row">',
    '<button class="kb-btn kb-btn--primary" type="submit">Save birthday</button>',
    hasBirthday
      ? `<button class="kb-btn kb-btn--danger" type="submit" name="clear" value="1" data-confirm="Remove your birthday?"${confirmListAttr(birthdayRemoveItems(opts.changeCooldownSeconds))}>Remove my birthday</button>`
      : "",
    "</div>",
    "</form>",
    "</div>",
    "</section>",
    "</div>",
    `${scriptTag(BIRTHDAY_DAY_SCRIPT)}`,
    f.refused ? scriptTag(FOCUS_FIRST_INVALID_SCRIPT) : "",
  ].join("");
}

// --------------------------------------------------------------------
// Timezone page (#524)
// --------------------------------------------------------------------

export interface TimezonePageBodyOptions {
  csrfToken: string;
  /** Currently stored zone, or null when unset (server default). */
  selected: string | null;
  /** Host/server timezone shown as the fallback in the preview. */
  serverTimezone: string;
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
 * Inner HTML for `GET /me/timezone` (#524). One searchable `<select>`, one POST.
 * Choosing "Server default" and saving clears the stored preference.
 */
export function renderUserTimezoneBody(opts: TimezonePageBodyOptions): string {
  return [
    '<div class="kb-stack">',
    pageHeader(
      "Timezone",
      `KoolBot renders the times it shows you, such as in <code>/voicestats</code>, in this zone. Leave it on <em>Server default</em> to use the server's timezone (<span class="kb-mono">${escapeHtml(opts.serverTimezone)}</span>).`,
    ),
    '<section class="kb-panel" aria-labelledby="timezone-title">',
    '<header class="kb-panel__head"><h2 class="kb-panel__title" id="timezone-title">Your timezone</h2></header>',
    '<div class="kb-panel__body">',
    '<form method="POST" action="/me/timezone" class="kb-stack">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<div class="kb-field">',
    '<label class="kb-label" for="tz-select">Timezone</label>',
    // The shared searchable select (#1436): "Server default" posts "" to clear,
    // a stored zone the runtime no longer lists stays selected as "(custom)".
    renderTimezoneSelect("timezone", opts.selected ?? "", {
      id: "tz-select",
      defaultZone: opts.serverTimezone,
      blank: true,
      firstLabel: "Server default",
    }),
    `<p class="kb-help">Current time: <span id="tz-now" data-server-tz="${escapeHtml(opts.serverTimezone)}">—</span></p>`,
    "</div>",
    '<div class="kb-row">',
    '<button class="kb-btn kb-btn--primary" type="submit">Save timezone</button>',
    '<span class="kb-help">Pick <em>Server default</em> and save to clear your preference.</span>',
    "</div>",
    "</form>",
    "</div>",
    "</section>",
    "</div>",
    `${scriptTag(TIMEZONE_SELECT_SCRIPT)}`,
    `${scriptTag(TZ_PREVIEW_SCRIPT)}`,
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
  // Only DMs the server can send are offered (#1292). With none on there is
  // nothing to toggle, so no form and no Save button.
  if (opts.rows.length === 0) {
    return [
      "<h1>Notifications</h1>",
      // EmptyState (docs/design/components.md): what is missing, then how it
      // fills up.
      '<div class="kb-empty"><p class="kb-empty__title">No direct messages to offer</p>' +
        '<p class="kb-empty__text">KoolBot has no direct messages to offer you on this server right now. Options appear here when the server turns a feature on.</p></div>',
    ].join("");
  }
  const rows = opts.rows
    .map((row) => {
      const nameId = `notify-${row.key}-name`;
      const descId = `notify-${row.key}-desc`;
      const soon = row.comingSoon
        ? `<div class="kb-setting__extra"><p class="kb-help">${escapeHtml(row.comingSoon)}</p></div>`
        : "";
      return [
        '<div class="kb-setting">',
        "<div>",
        `<p class="kb-setting__name" id="${nameId}">${escapeHtml(row.label)}</p>`,
        `<p class="kb-setting__desc" id="${descId}">${escapeHtml(row.description)}</p>`,
        "</div>",
        '<div class="kb-setting__control">',
        // Mirrors the admin "checkbox + hidden flag" pattern: when the
        // switch is off the browser submits nothing for that name, so the
        // hidden `submitted` flag lets the server tell "explicitly off" from
        // "key not in form". The switch posts `value="true"` when on.
        `<input type="hidden" name="submitted_${escapeHtml(row.key)}" value="1">`,
        renderSwitch(row.key, row.enabled, {
          labelledBy: nameId,
          describedBy: descId,
        }),
        "</div>",
        soon,
        "</div>",
      ].join("");
    })
    .join("");
  return [
    "<h1>Notifications</h1>",
    `<p class="subtitle">Choose which DMs KoolBot may send you on this server. Every channel is off until you turn it on — KoolBot never DMs you unprompted. Switch a message off and save, and the bot stops sending it.</p>`,
    '<form method="POST" action="/me/notifications">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<section class="kb-panel" aria-label="Direct-message notification channels">',
    `<div class="kb-panel__body"><div class="kb-settings">${rows}</div>`,
    '<div class="form-actions">',
    '<button class="btn btn-primary" type="submit">Save preferences</button>',
    '<span class="muted">DMs are opt-in: every channel starts off until you enable it here.</span>',
    "</div>",
    "</div>",
    "</section>",
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
   * The save the server just refused (#1535): that one form shows what was
   * posted and marks the field. `formId` is {@link VOICE_NAME_PATTERN_FORM_ID}
   * or {@link voicePresetFormId}.
   */
  refusedForm?: RefusedForm | null;
}

/** The `formId` of the name pattern form's {@link RefusedForm}. */
export const VOICE_NAME_PATTERN_FORM_ID = "voice-name-pattern";

/** The `formId` of one preset's edit form (`index` is the preset's row). */
export function voicePresetFormId(index: number): string {
  return `voice-preset-${index}`;
}

/**
 * ` id` (always, so the label can point at it), plus `aria-invalid` and
 * `aria-describedby` for a control the last save refused. `describedBy` lists
 * help text the control already points at.
 */
function fieldAttrs(
  f: FormView,
  formId: string,
  name: string,
  describedBy = "",
): string {
  const id = `${formId}-${name}`;
  const invalid = f.error(name) !== "";
  const ids = [describedBy, invalid ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    ` id="${escapeHtml(id)}"` +
    (invalid ? ' aria-invalid="true"' : "") +
    (ids ? ` aria-describedby="${escapeHtml(ids)}"` : "")
  );
}

function renderPresetRow(
  p: VoicePresetView,
  csrfToken: string,
  refusedForm?: RefusedForm | null,
): string {
  const formId = voicePresetFormId(p.index);
  const f = formView(refusedForm, formId);
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
    `<section class="kb-panel" aria-labelledby="${formId}-title">`,
    // The star alone carried "default" (WCAG 1.4.1, #855); the word does now,
    // with the glyph kept as decoration.
    `<header class="kb-panel__head"><h3 class="kb-panel__title" id="${formId}-title">${escapeHtml(p.name)}${p.isDefault ? ' <span class="kb-badge kb-badge--on"><span aria-hidden="true">⭐</span> Default</span>' : ""}</h3></header>`,
    '<div class="kb-panel__body kb-stack">',
    `<p class="kb-help">${summary}</p>`,
    // Edit form (name + channel name + limit + bitrate in one save).
    '<form method="POST" action="/me/voice/preset/edit" class="kb-stack">',
    csrf,
    idFields,
    '<div class="kb-fields">',
    `<div class="kb-field"><label class="kb-label" for="${formId}-name">Preset name</label><input type="text" name="name" class="kb-input" value="${escapeHtml(f.value("name", p.name))}" maxlength="50" required${fieldAttrs(f, formId, "name")}>${f.error("name")}</div>`,
    `<div class="kb-field"><label class="kb-label" for="${formId}-channelName">Channel name</label><input type="text" name="channelName" class="kb-input" value="${escapeHtml(f.value("channelName", p.channelName ?? ""))}" maxlength="100" placeholder="(unchanged)"${fieldAttrs(f, formId, "channelName")}>${f.error("channelName")}</div>`,
    `<div class="kb-field"><label class="kb-label" for="${formId}-userLimit">User limit</label><input type="number" name="userLimit" class="kb-input" value="${escapeHtml(f.value("userLimit", String(p.userLimit ?? "")))}" min="0" max="99" placeholder="(default)"${fieldAttrs(f, formId, "userLimit")}>${f.error("userLimit")}</div>`,
    `<div class="kb-field"><label class="kb-label" for="${formId}-bitrate">Bitrate (kbps)</label><input type="number" name="bitrate" class="kb-input" value="${escapeHtml(f.value("bitrate", String(p.bitrate ?? "")))}" min="8" max="384" placeholder="(default)"${fieldAttrs(f, formId, "bitrate")}>${f.error("bitrate")}</div>`,
    "</div>",
    '<div class="kb-row"><button class="kb-btn" type="submit">Save changes</button></div>',
    "</form>",
    // Default + delete as separate small forms so each is a single POST.
    '<div class="kb-row">',
    '<form method="POST" action="/me/voice/preset/default">',
    csrf,
    idFields,
    `<button class="kb-btn" type="submit">${p.isDefault ? "Unset default" : "Set as default"}</button>`,
    "</form>",
    `<form method="POST" action="/me/voice/preset/delete" data-confirm="Delete the preset '${escapeHtml(p.name)}'?">`,
    csrf,
    idFields,
    `<button class="kb-btn kb-btn--danger" type="submit" aria-label="Delete ${escapeHtml(p.name)}">Delete</button>`,
    "</form>",
    "</div>",
    "</div>",
    "</section>",
  ].join("");
}

/**
 * Inner HTML for `GET /me/voice` (#656). One form to edit the name
 * pattern, then a card per saved preset (edit / set-default / delete).
 * Presets themselves are created in Discord by snapshotting a live
 * channel — the web surface manages the ones you already have.
 */
export function renderUserVoiceBody(opts: VoicePageBodyOptions): string {
  const np = formView(opts.refusedForm, VOICE_NAME_PATTERN_FORM_ID);
  const npHelp = `${VOICE_NAME_PATTERN_FORM_ID}-help`;
  const presetCards =
    opts.presets.length === 0
      ? '<div class="kb-empty"><p class="kb-empty__title">No saved presets yet</p><p class="kb-empty__text">Open a voice channel\'s control panel in Discord and choose <strong>Presets → Save current as preset</strong> to create one.</p></div>'
      : opts.presets
          .map((p) => renderPresetRow(p, opts.csrfToken, opts.refusedForm))
          .join("");
  const preview = opts.namePattern
    ? opts.namePattern
        .replace(/\{username\}/gi, opts.displayName)
        .replace(/\{displayname\}/gi, opts.displayName)
    : "(server default)";

  return [
    '<div class="kb-stack">',
    pageHeader(
      "Voice preferences",
      "Manage how your dynamic voice channels are named and the presets you can apply to them.",
    ),
    // ---- Name pattern ----
    '<section class="kb-panel" aria-labelledby="name-pattern-title">',
    '<header class="kb-panel__head"><h2 class="kb-panel__title" id="name-pattern-title">Channel name pattern</h2></header>',
    '<div class="kb-panel__body">',
    '<form method="POST" action="/me/voice/name-pattern" class="kb-stack">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    `<div class="kb-field"><label class="kb-label" for="${VOICE_NAME_PATTERN_FORM_ID}-namePattern">Name pattern</label><input type="text" name="namePattern" class="kb-input" maxlength="100" value="${escapeHtml(np.value("namePattern", opts.namePattern ?? ""))}" placeholder="e.g. {username}'s Room"${fieldAttrs(np, VOICE_NAME_PATTERN_FORM_ID, "namePattern", npHelp)}>${np.error("namePattern")}` +
      `<p class="kb-help" id="${npHelp}">Applied to every new channel you spawn from the lobby. Use <code>{username}</code> as a placeholder for your display name. Leave blank to use the server default naming.</p>` +
      `<p class="kb-help">Preview: <span class="kb-mono">${escapeHtml(preview)}</span></p></div>`,
    '<div class="kb-row">',
    '<button class="kb-btn kb-btn--primary" type="submit">Save name pattern</button>',
    '<span class="kb-help">Save an empty value to clear it.</span>',
    "</div>",
    "</form>",
    "</div>",
    "</section>",
    // ---- Presets ----
    '<section class="kb-panel" aria-labelledby="presets-title">',
    `<header class="kb-panel__head"><h2 class="kb-panel__title" id="presets-title">Saved presets</h2><span class="kb-panel__meta">Up to ${opts.maxPerUser}</span></header>`,
    `<div class="kb-panel__body kb-stack">${presetCards}</div>`,
    "</section>",
    "</div>",
    opts.refusedForm ? scriptTag(FOCUS_FIRST_INVALID_SCRIPT) : "",
  ].join("");
}

// --------------------------------------------------------------------
// Privacy / data export page (#719)
// --------------------------------------------------------------------

export interface PrivacyDataRow {
  /** Registry collection label, shown verbatim so the file and page agree. */
  collection: string;
  /** The registry's note — why it is in (or out of) the export. */
  note: string;
}

export interface PrivacyPageBodyOptions {
  /** `privacy.enabled` — when false the download is refused, so hide it. */
  featureEnabled: boolean;
  /** `rewind.enabled` — the recap link is left out while Rewind is off (#1292). Omitted keeps it. */
  rewindEnabled?: boolean;
  /** Collections the export includes, in registry order. */
  included: PrivacyDataRow[];
  /** Collections deliberately left out, with the reason. */
  excluded: PrivacyDataRow[];
  /** `privacy.export.max_items`, so the page states the ceiling up front. */
  maxItems: number;
  /**
   * The self-service reset (#917). Omitted — or `enabled: false` — when
   * `privacy.delete.enabled` is off, in which case no danger zone renders.
   */
  reset?: {
    enabled: boolean;
    /** `privacy.delete.cooldown_hours`; 0 means no cooldown. */
    cooldownHours: number;
    csrfToken: string;
  };
  /**
   * The member tracking opt-out (#918). The card renders when the opt-out is
   * offered (`privacy.tracking_opt_out.enabled` and the export on), and
   * always when the member is already opted out — opting back in must stay
   * reachable whatever an operator later switches off.
   */
  trackingOptOut?: {
    /** Whether a member who is tracked may opt out. */
    offered: boolean;
    /** When the member opted out, or null while they are tracked. */
    optedOutAt: Date | null;
    csrfToken: string;
  };
}

/**
 * The tracking opt-out card (#918). Honest about the one awkward part: the
 * opt-out is itself stored, and it is the single row a reset keeps.
 */
function renderTrackingOptOutCard(
  optOut: NonNullable<PrivacyPageBodyOptions["trackingOptOut"]>,
  resetAvailable: boolean,
): string {
  // Only point at the reset when its card is actually on the page (#918).
  const removeIt = resetAvailable
    ? "reset your data below to remove it"
    : "only a data reset removes it, and this server has not enabled one";
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(optOut.csrfToken)}">`;
  const head =
    '<header class="kb-panel__head"><h2 class="kb-panel__title" id="tracking-title">Activity tracking</h2></header>';
  if (optOut.optedOutAt) {
    return [
      '<section id="tracking" class="kb-panel" aria-labelledby="tracking-title">',
      head,
      '<div class="kb-panel__body kb-stack">',
      `<p><strong>You are opted out</strong> (since ${escapeHtml(optOut.optedOutAt.toISOString().slice(0, 10))}). ` +
        "KoolBot does not record your messages, reactions, poll votes or voice sessions, " +
        "and no longer adds you to other members' voice history. Older entries in other " +
        "members' records can still mention you.</p>",
      '<p class="kb-help">What was stored before you opted out is still there, and still shows on ' +
        `leaderboards, digests and your Rewind — ${removeIt}. Opting back ` +
        "in starts tracking again from that moment (time in voice counts from the next channel " +
        "you join); nothing from the time you were opted out can be restored, because it was " +
        "never recorded.</p>",
      '<form method="POST" action="/me/privacy/tracking" class="kb-row">',
      csrf,
      '<input type="hidden" name="action" value="opt-in">',
      '<button class="kb-btn" type="submit">Opt back in to tracking</button>',
      "</form>",
      "</div>",
      "</section>",
    ].join("");
  }
  return [
    '<section id="tracking" class="kb-panel" aria-labelledby="tracking-title">',
    head,
    '<div class="kb-panel__body kb-stack">',
    "<p>KoolBot records your messages, reactions, poll votes and time in voice channels " +
      "to power stats, leaderboards, achievements, digests and Rewind. You can opt out.</p>",
    "<ul>",
    "<li>Nothing new is recorded about you from the moment you opt out, and you are no " +
      "longer added to other members' voice history. Older entries in their records can " +
      "still mention you.</li>",
    "<li>What is already stored stays, and keeps showing on leaderboards, digests and Rewind" +
      (resetAvailable
        ? " until you reset it. Opting out and then resetting is a real deletion.</li>"
        : ". Only a data reset removes it, and this server has not enabled one.</li>"),
    "<li>KoolBot has to remember that you opted out, so the opt-out itself is stored — it is " +
      "the one thing a reset does not remove. Opting back in deletes it.</li>",
    "</ul>",
    '<form method="POST" action="/me/privacy/tracking" class="kb-row">',
    csrf,
    '<input type="hidden" name="action" value="opt-out">',
    '<button class="kb-btn" type="submit">Opt out of tracking</button>',
    "</form>",
    "</div>",
    "</section>",
  ].join("");
}

/** The word a member types to confirm the reset (#917). */
export const PRIVACY_RESET_CONFIRM_WORD = "RESET";

/**
 * The danger-zone card for the self-service reset (#917). The copy is
 * deliberately blunt about four things a member could otherwise assume the
 * wrong way: tracking starts again, moderation records stay, other members'
 * rows may still mention them, and preferences go back to defaults. The
 * export link sits above the button — download first, then reset.
 */
function renderPrivacyResetCard(
  reset: NonNullable<PrivacyPageBodyOptions["reset"]>,
  optOut: PrivacyPageBodyOptions["trackingOptOut"],
): string {
  // #918: only an opted-out member's reset is a deletion — for everyone
  // else the trackers start writing again, and the copy has to say so.
  const tracking = optOut?.optedOutAt
    ? "<li><strong>This is a deletion.</strong> You have opted out of tracking, so KoolBot " +
      "will not start recording again. The opt-out itself is kept — it is the one thing a " +
      "reset does not remove — until you opt back in.</li>"
    : "<li><strong>This is a reset, not a deletion.</strong> KoolBot starts recording again the " +
      "next time you send a message, react or join a voice channel." +
      (optOut?.offered
        ? ' <a href="#tracking">Opt out of tracking</a> first to make it a deletion.'
        : "") +
      "</li>";
  const word = PRIVACY_RESET_CONFIRM_WORD;
  const cooldown =
    reset.cooldownHours > 0
      ? `<p class="kb-help">You can reset once every ${reset.cooldownHours} hour${reset.cooldownHours === 1 ? "" : "s"}.</p>`
      : "";
  return [
    '<section id="reset" class="kb-panel kb-panel--danger" aria-labelledby="reset-title">',
    '<header class="kb-panel__head"><h2 class="kb-panel__title" id="reset-title">Reset my data</h2></header>',
    '<div class="kb-panel__body kb-stack">',
    "<p>Wipes what KoolBot has stored about you on this server — voice history, activity " +
      "counters, achievements, poll participation, Rewind, reminders, RSVPs and the rest of " +
      "the collections listed above — then signs you out. It cannot be undone.</p>",
    "<p>Before you go ahead, know that:</p>",
    "<ul>",
    tracking,
    "<li><strong>Moderation records and audit logs are kept.</strong> Warnings, timeouts and " +
      "the server's audit trail are not yours to erase — the reset itself is recorded there too.</li>",
    "<li><strong>Other members' records may still mention you.</strong> Voice history rows " +
      "belonging to people you shared a channel with can still name you as present.</li>",
    "<li><strong>Your preferences go back to defaults.</strong> Timezone, notification opt-ins " +
      "and voice presets are cleared; every DM goes back to off.</li>",
    "</ul>",
    '<div class="kb-row">',
    '<a class="kb-btn" href="/me/privacy/export" download>Download my data first (JSON)</a>',
    "</div>",
    cooldown,
    `<form method="POST" action="/me/privacy/delete" class="kb-stack" data-confirm="Reset all of your KoolBot data on this server? This cannot be undone.">`,
    `<input type="hidden" name="_csrf" value="${escapeHtml(reset.csrfToken)}">`,
    '<div class="kb-field">',
    `<label class="kb-label" for="reset-confirm">Type <code>${word}</code> to confirm</label>`,
    `<input class="kb-input" type="text" id="reset-confirm" name="confirm" autocomplete="off" placeholder="${word}" required>`,
    "</div>",
    '<div class="kb-row">',
    '<button class="kb-btn kb-btn--danger" type="submit">Reset my data</button>',
    "</div>",
    "</form>",
    "</div>",
    "</section>",
  ].join("");
}

function renderPrivacyTable(
  caption: string,
  rows: PrivacyDataRow[],
  noteHeading: string,
): string {
  const body = rows
    .map(
      (row) =>
        `<tr><th scope="row" class="kb-mono">${escapeHtml(row.collection)}</th>` +
        `<td>${escapeHtml(row.note)}</td></tr>`,
    )
    .join("");
  // The panel's title names the table; the caption says it to a screen reader.
  return (
    '<div class="kb-panel__body kb-panel__body--flush"><table class="kb-table">' +
    `<caption class="kb-visually-hidden">${escapeHtml(caption)}</caption>` +
    `<thead><tr><th scope="col">Collection</th><th scope="col">${escapeHtml(noteHeading)}</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}

/**
 * Inner HTML for `GET /me/privacy` (#719). Three parts: what the download
 * contains, what it deliberately does not, and the download button itself.
 *
 * The two tables are rendered from the same registry the export reads, so the
 * page cannot drift from the file a member actually receives — the drift the
 * registry exists to prevent would otherwise just move from the code into the
 * copy describing it.
 */
export function renderUserPrivacyBody(opts: PrivacyPageBodyOptions): string {
  const resetAvailable = opts.featureEnabled && opts.reset?.enabled === true;
  const disabledNotice = renderUserFeatureDisabledNotice({
    enabled: opts.featureEnabled,
    label: "self-service data export",
  });
  const download = opts.featureEnabled
    ? '<div class="kb-row">' +
      '<a class="kb-btn kb-btn--primary" href="/me/privacy/export" download>Download my data (JSON)</a>' +
      '<span class="kb-help">Served as a file, not a page. Large histories may take a moment.</span>' +
      "</div>"
    : "";
  return [
    '<div class="kb-stack">',
    pageHeader(
      "Privacy",
      "What KoolBot stores about you on this server, and how to get a copy of it.",
    ),
    disabledNotice,
    '<section class="kb-panel" aria-labelledby="download-title">',
    '<header class="kb-panel__head"><h2 class="kb-panel__title" id="download-title">Download your data</h2></header>',
    '<div class="kb-panel__body kb-stack">',
    "<p>One JSON file with every row KoolBot holds that is about <strong>you</strong> — " +
      "your voice history, activity counters, preferences, quotes, RSVPs and reminders. " +
      "It is a record" +
      (opts.rewindEnabled === false
        ? "."
        : ', not a recap: for the readable version of your year, see <a href="/me/rewind">Rewind</a>.') +
      "</p>",
    `<p class="kb-help">Long histories are capped at ${opts.maxItems} entries per collection; ` +
      "anything clipped is listed under <code>truncated</code> in the file. Each download is " +
      "recorded in the server's Web UI audit log.</p>",
    download,
    "</div>",
    "</section>",
    '<section class="kb-panel" aria-labelledby="included-title">',
    '<header class="kb-panel__head"><h2 class="kb-panel__title" id="included-title">What\'s in the file</h2></header>',
    renderPrivacyTable(
      "Collections included in your export.",
      opts.included,
      "What it holds",
    ),
    '<footer class="kb-panel__foot">Where a row is shared with other members ' +
      "(poll turnout, event RSVPs, leaderboard role rosters), the export contains only your " +
      "own slice of it — never the other members on that row.</footer>",
    "</section>",
    '<section class="kb-panel" aria-labelledby="excluded-title">',
    '<header class="kb-panel__head"><h2 class="kb-panel__title" id="excluded-title">What\'s not in it</h2></header>',
    '<div class="kb-panel__body"><p>Some things KoolBot stores are deliberately out of reach of this download.</p></div>',
    renderPrivacyTable(
      "Collections deliberately excluded from your export.",
      opts.excluded,
      "Why it's excluded",
    ),
    '<footer class="kb-panel__foot">Moderation records in particular are not ' +
      "self-service: ask a server moderator if you need to know where you stand.</footer>",
    "</section>",
    opts.trackingOptOut &&
    ((opts.featureEnabled && opts.trackingOptOut.offered) ||
      opts.trackingOptOut.optedOutAt)
      ? renderTrackingOptOutCard(opts.trackingOptOut, resetAvailable)
      : "",
    resetAvailable && opts.reset
      ? renderPrivacyResetCard(opts.reset, opts.trackingOptOut)
      : "",
    "</div>",
  ].join("");
}
