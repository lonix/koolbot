/**
 * Shared layout for the read-only admin pages added in #381. The scaffold's
 * `views.ts` keeps tiny static pages for sign-in / sign-out flows; this
 * module renders the navigated pages with the always-visible "session
 * expires in X · [Finish]" banner mandated by #367.
 */

import type { ConfigSchema } from "../services/config-schema.js";
import { getPermissionIssueCount } from "../services/bot-permission-status.js";
import { designStylesheetLinks } from "./design-assets.js";
import { icon } from "./icons.js";
import { SAVEBAR_SCRIPT } from "./savebar.js";
import { NUMBER_INPUT_SCRIPT } from "./number-input.js";
import {
  COLOUR_INPUT_SCRIPT,
  DURATION_PRESETS_SCRIPT,
  STEPPER_SCRIPT,
  TIMEZONE_SELECT_SCRIPT,
  CHANNEL_PICKER_SCRIPT,
} from "./setting-pickers.js";
import { groupRowsScript } from "./event-group-form.js";
import { getInactivityWindowMs } from "./session.js";
import {
  CONFIRM_SCRIPT,
  escapeHtml,
  escapeJsInAttr,
  scriptTag,
} from "./html.js";
import {
  SESSION_LOW_MS,
  renderTopBar,
  renderVersionPill,
  resolveViewer,
  type ShellViewer,
} from "./app-shell.js";

// Re-exported from session.ts so the renderer and the cookie middleware
// share a single source of truth for the inactivity sliding window.
// Existing call sites and tests can keep importing it from this module.
export { getInactivityWindowMs };

/**
 * Enabled-state of feature-gated nav items, keyed by config-schema key.
 * `Partial` because callers legitimately omit keys — an absent key is
 * treated as enabled (fail-open) by `renderNav`.
 */
export type NavFeatureStatus = Partial<Record<keyof ConfigSchema, boolean>>;

// Escaping helpers live in `html.ts` so the admin and user renderers share
// one implementation; re-exported here for the existing call sites (#851).
export { escapeHtml, escapeJsInAttr };

/**
 * Sidebar groups, rendered in this fixed order (#613, regrouped by task in
 * #1296). The admin is looking for a job to do, so the groups name the job:
 *   - Top           - Dashboard, alone and without a heading.
 *   - Features      - the feature pages (these line up with `featureKey`); the
 *                     switched-on ones A to Z, the rest folded away.
 *   - Access        - who may do what: command and bot permissions, role groups.
 *   - Server setup  - the shape of the Discord server and how KoolBot adopts it.
 *   - Bot           - the bot itself: presence, database, environment, audit, metrics.
 *   - Pinned        - All settings, at the bottom and without a heading.
 */
export type NavGroup =
  "Top" | "Features" | "Access" | "Server setup" | "Bot" | "Pinned";

/** Fixed render order of the sidebar groups. */
export const NAV_GROUP_ORDER: readonly NavGroup[] = [
  "Top",
  "Features",
  "Access",
  "Server setup",
  "Bot",
  "Pinned",
];

/** The groups that carry a heading; Top and Pinned stand on their own. */
export const NAV_HEADED_GROUPS: readonly NavGroup[] = [
  "Features",
  "Access",
  "Server setup",
  "Bot",
];

/**
 * Who may open the page. Every console page is admin-only, and the refusal of
 * a host or moderator session is walked route by route in
 * `__tests__/web/admin-scope-refusal.test.ts`. It is a literal type of its own,
 * not a `WebScope`: `admin` is not a `/me` scope, and a `/me` scope must never
 * be put on a console page.
 */
export type NavScope = "admin";

interface NavItem {
  href: string;
  label: string;
  /** Which sidebar section this item belongs to (#613, #1296). */
  group: NavGroup;
  /** Whose sidebar this is (#1333): the admin console's only. */
  scope: NavScope;
  /**
   * Config key (a `<feature>.enabled` boolean) that gates this page. When
   * set and the feature resolves to `false`, the item is still reachable but
   * sits under the folded "N turned off" list, greyed with an "off" badge
   * (#610, #1296) — hiding it left the page undiscoverable, since the natural
   * place to enable a feature is its own page. Items without a `featureKey` —
   * Dashboard, All settings, etc. — render as plain links. The page URL is
   * reachable either way; the gating only changes how the nav advertises it.
   *
   * Typed as `keyof ConfigSchema` so a typo in `NAV_ITEMS` fails at
   * compile time rather than silently never matching at runtime.
   */
  featureKey?: keyof ConfigSchema;
  /**
   * A second page of the feature above it (it shares that feature's key), so
   * the dashboard's feature list names the feature once, not once per page.
   */
  subpage?: boolean;
}

// Labels are sentence case and say what the page does. The routes did not
// change with the labels.
export const NAV_ITEMS: NavItem[] = [
  { href: "/admin/", label: "Dashboard", group: "Top", scope: "admin" },
  // Features - every feature-gated page, A to Z (the render sorts them again
  // by state, so a new entry here never has to be placed by hand).
  {
    href: "/admin/announcements",
    label: "Announcements",
    group: "Features",
    scope: "admin",
    featureKey: "announcements.enabled",
  },
  {
    href: "/admin/birthdays",
    label: "Birthdays",
    group: "Features",
    scope: "admin",
    featureKey: "birthdays.enabled",
  },
  {
    href: "/admin/events",
    label: "Events",
    group: "Features",
    scope: "admin",
    featureKey: "events.enabled",
  },
  {
    href: "/admin/events/presets",
    label: "Event presets",
    group: "Features",
    scope: "admin",
    featureKey: "events.enabled",
    subpage: true,
  },
  {
    href: "/admin/leaderboard-roles",
    label: "Leaderboard roles",
    group: "Features",
    scope: "admin",
    featureKey: "leaderboard_roles.enabled",
  },
  {
    href: "/admin/moderation",
    label: "Moderation",
    group: "Features",
    scope: "admin",
    featureKey: "moderation.enabled",
  },
  {
    href: "/admin/notices",
    label: "Notices",
    group: "Features",
    scope: "admin",
    featureKey: "notices.enabled",
  },
  {
    href: "/admin/polls",
    label: "Polls",
    group: "Features",
    scope: "admin",
    featureKey: "polls.enabled",
  },
  {
    href: "/admin/quotes",
    label: "Quotes",
    group: "Features",
    scope: "admin",
    featureKey: "quotes.enabled",
  },
  {
    href: "/admin/reaction-roles",
    label: "Reaction roles",
    group: "Features",
    scope: "admin",
    featureKey: "reactionroles.enabled",
  },
  {
    href: "/admin/rules",
    label: "Rules",
    group: "Features",
    scope: "admin",
    featureKey: "rules.enabled",
  },
  {
    href: "/admin/tickets",
    label: "Tickets",
    group: "Features",
    scope: "admin",
    featureKey: "tickets.enabled",
  },
  {
    href: "/admin/analytics",
    label: "Voice analytics",
    group: "Features",
    scope: "admin",
    featureKey: "voicetracking.enabled",
  },
  {
    href: "/admin/voice-channels",
    label: "Voice channels",
    group: "Features",
    scope: "admin",
    featureKey: "voicechannels.enabled",
  },
  {
    href: "/admin/digest",
    label: "Weekly digest",
    group: "Features",
    scope: "admin",
    featureKey: "digest.enabled",
  },
  // Access - the two permission pages read as a pair.
  {
    href: "/admin/permissions",
    label: "Command permissions",
    group: "Access",
    scope: "admin",
  },
  {
    href: "/admin/role-groups",
    label: "Role groups",
    group: "Access",
    scope: "admin",
  },
  {
    href: "/admin/bot-permissions",
    label: "Bot permissions",
    group: "Access",
    scope: "admin",
  },
  // Server setup.
  {
    href: "/admin/wizard",
    label: "Setup wizard",
    group: "Server setup",
    scope: "admin",
  },
  {
    href: "/admin/adopt",
    label: "Server scan",
    group: "Server setup",
    scope: "admin",
  },
  {
    href: "/admin/adopt/claims",
    label: "Channel claims",
    group: "Server setup",
    scope: "admin",
  },
  {
    href: "/admin/channels",
    label: "Channel manager",
    group: "Server setup",
    scope: "admin",
  },
  {
    href: "/admin/adopt/history",
    label: "Adoption history",
    group: "Server setup",
    scope: "admin",
  },
  // Bot.
  {
    href: "/admin/bot-status",
    label: "Presence",
    group: "Bot",
    scope: "admin",
  },
  { href: "/admin/database", label: "Database", group: "Bot", scope: "admin" },
  {
    href: "/admin/bootstrap",
    label: "Environment",
    group: "Bot",
    scope: "admin",
  },
  {
    href: "/admin/audit/commands",
    label: "Command audit",
    group: "Bot",
    scope: "admin",
  },
  {
    href: "/admin/metrics",
    label: "Command metrics",
    group: "Bot",
    scope: "admin",
  },
  {
    href: "/admin/settings",
    label: "All settings",
    group: "Pinned",
    scope: "admin",
  },
];

/**
 * Resolve the enabled-state of every feature-gated nav item. Takes an
 * async boolean reader (in practice `ConfigService.getBoolean`) so this
 * module stays free of a direct ConfigService dependency and remains
 * unit-testable. The returned map is keyed by `featureKey`.
 *
 * Distinct feature keys are resolved in parallel (and de-duplicated, so
 * two nav items sharing a key would only trigger one read).
 */
export async function resolveNavFeatureStatus(
  isEnabled: (key: keyof ConfigSchema) => Promise<boolean>,
): Promise<NavFeatureStatus> {
  const keys = [
    ...new Set(
      NAV_ITEMS.flatMap((item) => (item.featureKey ? [item.featureKey] : [])),
    ),
  ];
  const results = await Promise.all(keys.map((key) => isEnabled(key)));
  const status: NavFeatureStatus = {};
  keys.forEach((key, i) => {
    status[key] = results[i];
  });
  return status;
}

/**
 * Update-available state for the banner badge (#1029). `null` (or no
 * provider) means "nothing to advertise" — the banner then shows only the
 * running version.
 */
export interface AdminUpdateBadge {
  latest: string;
  kind: "major" | "minor" | "patch";
}

let updateBadgeProvider: (() => AdminUpdateBadge | null) | null = null;

/**
 * Register the synchronous source of the banner's "update available" badge.
 * `createWebRouter` points it at `VersionCheckService`'s cached snapshot, so
 * every admin page shows the badge without each renderer threading it
 * through, and this module stays free of a service dependency.
 */
export function setAdminUpdateBadgeProvider(
  provider: (() => AdminUpdateBadge | null) | null,
): void {
  updateBadgeProvider = provider;
}

function renderVersionPills(): string {
  const running = renderVersionPill();
  let badge: AdminUpdateBadge | null;
  try {
    badge = updateBadgeProvider?.() ?? null;
  } catch {
    // A broken provider must never take an admin page down with it.
    badge = null;
  }
  if (!badge) return running;
  return (
    running +
    `<a class="kb-pill kb-pill--info" href="/admin/#version" title="A newer KoolBot release is available">` +
    `Update available: ${escapeHtml(badge.latest)} (${escapeHtml(badge.kind)})</a>`
  );
}

export interface AdminPageOptions {
  title: string;
  active: string;
  body: string;
  csrfToken: string;
  remainingMs: number;
  /**
   * Enabled-state of feature-gated nav items. When omitted, every nav
   * item is shown (keeps direct callers and tests that don't care about
   * nav filtering working unchanged).
   */
  navFeatureStatus?: NavFeatureStatus;
  /**
   * Who is looking (#1317). Normally omitted: the session middleware sets the
   * request's viewer (see `app-shell.ts`); an admin stand-in is the fallback.
   */
  viewer?: ShellViewer;
}

const STYLE = [
  // kb.css is linked ahead of this sheet but the legacy pages keep their own look until each
  // moves to the kb- classes (#1314): undo its base line-height and colour-scheme here.
  ":root{color-scheme:normal}",
  "*,*::before,*::after{box-sizing:border-box}",
  // Core palette comes from tokens.css, shared with the member and pre-auth pages (issue #569).
  `body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--text);line-height:normal}`,
  `a{color:var(--link);text-decoration:none}`,
  "a:hover{text-decoration:underline}",
  // The top bar is the shared kb-topbar (app-shell.ts, #1317), reflowing at 760px in kb.css; only
  // its Finish form needs a reset here.
  ".kb-topbar form{margin:0}",
  ".shell{display:flex;min-height:calc(100vh - var(--topbar-height))}",
  // The side nav is the shared kb-sidenav (kb.css, #1296): group headings, the folded "N turned off" list and the
  // count badge all come from there.
  // `min-width:0` lets the flex child shrink below its content width so a
  // wide table scrolls inside `main` / its card instead of forcing the whole
  // page to scroll sideways (WCAG 1.4.10 reflow, #855).
  "main{flex:1;padding:1.5rem 2rem;max-width:1100px;min-width:0;overflow-x:auto}",
  // A scroll container is where `position:sticky` resolves, so on a page with a settings
  // save bar `main` must not be one, or the bar sticks inside `main`/the card instead of the
  // viewport. `renderAdminPage` adds `has-savebar` to `main` only for those pages; every
  // other page keeps the scrolling `main` above. `clip` still stops a wide child forcing a
  // sideways page scroll without creating a scroll container.
  "main.has-savebar{overflow-x:clip}",
  // A long unbroken value (a role name to retype) scrolls in its own block.
  "main pre{overflow-x:auto}",
  // The skip-link target itself shouldn't draw a ring around the whole column.
  "#main:focus-visible{outline:none}",
  "h1{margin:0 0 .25rem;font-size:1.5rem}",
  "h2{margin:1.5rem 0 .5rem;font-size:1.15rem;color:var(--text-secondary)}",
  ".subtitle{color:var(--muted);margin:0 0 1rem}",
  ".card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;margin:0 0 1rem;overflow-x:auto}",
  // A card holding a sticky save bar (settings forms) must not be a scroll container either,
  // or the bar sticks inside the card and sits at the end of a long form.
  ".card.card--savebar{overflow-x:clip}",
  // The rows scroll sideways instead: `.kb-settings` is a sibling of the save bar, not an
  // ancestor, so scrolling here leaves the bar's sticky container alone. Wide pickers and
  // their reset buttons stay reachable on narrow screens.
  ".kb-settings{overflow-x:auto}",
  ".card h2{margin-top:0}",
  "table{width:100%;border-collapse:collapse;font-size:.9rem}",
  "th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--border);vertical-align:top}",
  "th{font-weight:600;color:var(--muted);background:var(--surface-alt)}",
  // Row headers (`<th scope="row">`, e.g. the Permissions matrix) read as
  // body cells visually; the semantics are for assistive tech (#855).
  "tbody th[scope=row]{background:transparent;color:inherit;font-weight:500}",
  "tr:hover td,tr:hover th[scope=row]{background:var(--surface-alt)}",
  // Settings page: keep editable controls inside their cell and let long
  // current/default values wrap instead of pushing the table wide (issue #489).
  "td.settings-value{min-width:12rem}",
  "td.settings-value input[type=text],td.settings-value select{width:100%;box-sizing:border-box}",
  "td.settings-default{overflow-wrap:anywhere;word-break:break-word}",
  ".muted{color:var(--muted)}",
  ".mono{font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,monospace;font-size:.85rem}",
  ".tag{display:inline-block;padding:.1rem .45rem;border-radius:4px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}",
  ".tag-on{background:var(--ok-bg);color:var(--ok-text)}",
  ".tag-off{background:var(--err-bg);color:var(--err-text)}",
  ".tag-info{background:var(--info-bg);color:var(--info-text)}",
  ".tag-warn{background:var(--warn-bg);color:var(--warn-text)}",
  ".tag-diff-add{background:var(--ok-bg);color:var(--ok-text)}",
  ".tag-diff-change{background:var(--warn-bg);color:var(--warn-text)}",
  ".tag-diff-reject{background:var(--err-bg);color:var(--err-text)}",
  ".empty{padding:1rem;color:var(--muted);font-style:italic}",
  ".kv{display:grid;grid-template-columns:200px 1fr;gap:.4rem 1rem}",
  ".kv dt{color:var(--muted)}",
  ".kv dd{margin:0}",
  ".notice{padding:.6rem .8rem;border-radius:6px;margin:0 0 1rem}",
  ".notice.info{background:var(--selected);color:var(--info-text)}",
  ".notice.ok{background:var(--ok-bg);color:var(--ok-text)}",
  ".notice.warn{background:var(--warn-bg);color:var(--warn-text)}",
  ".notice.err{background:var(--err-bg);color:var(--err-text)}",
  // Disabled-feature banner (#610): explanatory text on the left, inline
  // enable action + Settings link on the right; wraps on narrow screens.
  "form.stack{display:flex;flex-direction:column;gap:.6rem}",
  "form.stack label{display:flex;flex-direction:column;gap:.25rem;font-size:.85rem;color:var(--text-secondary)}",
  "form.stack label.checkbox{flex-direction:row;align-items:center;gap:.5rem}",
  // Control borders use --control (3.97:1) — the hairline --border was
  // 1.58:1 against the field, far below the 3:1 floor (WCAG 1.4.11, #855).
  `form.stack input[type=text],form.stack input[type=number],form.stack input[type=url],form.stack textarea,form.stack select{background:var(--bg);color:var(--text);border:1px solid var(--control);border-radius:6px;padding:.4rem .55rem;font:inherit;font-size:.9rem}`,
  "form.stack textarea{resize:vertical;min-height:5rem;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,monospace}",
  "form.stack fieldset{border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;display:flex;flex-direction:column;gap:.4rem}",
  "form.stack fieldset legend{color:var(--muted);padding:0 .35rem}",
  ".inline-form{margin:.75rem 0 0;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}",
  ".btn{background:var(--fill);color:var(--text);border:0;padding:.35rem .7rem;border-radius:4px;cursor:pointer;font-size:.8rem;font-weight:600;display:inline-block;text-decoration:none}",
  // `.btn` sets display, which overrides the UA rule for `hidden`; keep a
  // hidden button (a JS-only control before its script runs) out of view.
  ".btn[hidden]{display:none}",
  ".btn:hover{background:var(--fill-hover);text-decoration:none}",
  ".btn-primary{background:var(--primary);color:var(--on-primary)}",
  ".btn-primary:hover{background:var(--primary-hover)}",
  ".btn-secondary{background:var(--fill);color:var(--pill-text)}",
  ".btn-secondary:hover{background:var(--fill-hover)}",
  ".btn-danger{background:var(--danger);color:var(--on-primary)}",
  ".btn-danger:hover{background:var(--danger-hover)}",
  ".btn-sm{padding:.2rem .5rem;font-size:.75rem}",
  ".btn[disabled],.btn[disabled]:hover{opacity:.5;cursor:not-allowed;background:var(--fill)}",
  ".actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}",
  ".actions form{margin:0}",
  ".field-row{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.75rem}",
  ".field-row > label{font-size:.85rem;color:var(--muted)}",
  `.field-row .help{font-size:.75rem;color:var(--muted);margin-top:.15rem}`,
  // Cascade greying: rows whose master `.enabled` toggle is off (#485).
  ".cascade-off{opacity:.5}",
  // Dependency greying: rows whose hard `dependsOn` target is off (#666).
  // A static class (not toggled by the cascade script) so an enabled section
  // master can't strip the greying off a still-dependency-locked control.
  ".dep-off{opacity:.5}",
  // The same lock on a settings row (#1318): dims the row's own content but not
  // the children nested inside its `.kb-setting__extra`. A separate class from
  // the `is-inactive` the cascade script toggles, so turning the master on can
  // never clear a dependency lock.
  ".kb-setting--locked>:not(.kb-setting__extra){opacity:.5}",
  // Off-screen but still in the accessibility tree — used for labels that
  // name a control whose caption is carried by a column header or adjacent
  // cell rather than by text of its own (#854).
  ".visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;" +
    "overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}",
  // A control the last save rejected (#854). The outline gives sighted users
  // the same "this field" signal that `aria-invalid` gives a screen reader.
  '[aria-invalid="true"]{outline:2px solid var(--danger);outline-offset:1px}',
  '.cron-picker[aria-invalid="true"]{outline-offset:3px}',
  // Keyboard focus (WCAG 2.4.7, #855). There were 22 `:hover` rules and no
  // `:focus` rule at all; the UA default ring is near-invisible on this
  // palette. One visible ring for every interactive element, and the nav /
  // button hover surfaces are mirrored so keyboard users get the same
  // affordance. Declared after `[aria-invalid]` so the ring wins on focus.
  `a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`,
  ".btn:focus-visible{text-decoration:none}",
  // Skip link: off-screen until focused, then pinned top-left so keyboard
  // users can jump past the ~20 sidebar links on every page.
  `.skip-link{position:absolute;left:-999px;top:0;z-index:100;background:var(--primary);color:var(--on-primary);padding:.5rem .75rem;border-radius:0 0 4px 0;font-weight:600}`,
  ".skip-link:focus{left:0;text-decoration:none}",
  ".wizard-features{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.75rem;margin-bottom:1rem}",
  ".feature-card{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.75rem 1rem;display:flex;gap:.75rem;align-items:flex-start}",
  ".feature-card input{margin-top:.2rem;flex-shrink:0}",
  ".feature-card .fc-info{flex:1}",
  ".feature-card .fc-name{font-weight:600;font-size:.9rem;color:var(--text);display:block;cursor:pointer}",
  ".feature-card .fc-desc{font-size:.75rem;color:var(--muted);margin-top:.1rem}",
  `select[multiple]{min-height:4rem;background:var(--bg);color:var(--text);border:1px solid var(--control);border-radius:6px;padding:.4rem .55rem;font:inherit;font-size:.9rem}`,
  "td.actions{display:flex;gap:.35rem;flex-wrap:wrap}",
  "td.actions form{margin:0}",
  ".helper{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.4rem .6rem;font-size:.85rem}",
  ".helper summary{cursor:pointer;color:var(--text-secondary);font-weight:600}",
  ".helper ul{margin:.4rem 0;padding-left:1.2rem}",
  "form.inline-order{display:flex;gap:.25rem;align-items:center;margin:0}",
  `form.inline-order input[type=number]{width:5rem;background:var(--bg);color:var(--text);border:1px solid var(--control);border-radius:6px;padding:.25rem .4rem;font:inherit;font-size:.85rem}`,
  ".edit-details{flex:0 0 100%;margin-bottom:.35rem}",
  ".edit-details form.stack{margin-top:.5rem}",
  "button[disabled]{opacity:.5;cursor:not-allowed}",
  ".cron-picker{display:inline-flex;align-items:center;gap:.4rem;flex-wrap:wrap}",
  `.cron-picker select,.cron-picker input{font:inherit;font-size:.85rem;padding:.2rem .35rem;background:var(--bg);color:var(--text);border:1px solid var(--control);border-radius:6px}`,
  ".cron-picker input[type=time]{width:7rem}",
  ".cron-picker[hidden]{display:none}",
  // Voice-analytics heatmap (#675): a 24-column × 7-row hour×weekday grid of
  // colour-intensity cells, plus simple bar summaries for the marginals.
  ".heatgrid{display:grid;grid-template-columns:auto repeat(24,1fr);gap:2px;font-size:.65rem;min-width:560px}",
  ".heatgrid .hg-corner,.heatgrid .hg-col,.heatgrid .hg-rowlabel{color:var(--muted);display:flex;align-items:center}",
  ".heatgrid .hg-col{justify-content:center}",
  ".heatgrid .hg-rowlabel{padding-right:.4rem;white-space:nowrap}",
  ".heatgrid .hg-cell{aspect-ratio:1;border-radius:2px;background:var(--heat-empty);min-height:14px}",
  ".heatgrid .hg-cell.peak{outline:1px solid var(--lore-peak)}",
  ".heat-bars{display:flex;flex-direction:column;gap:.3rem}",
  ".heat-bars .hbar{display:flex;align-items:center;gap:.5rem}",
  ".heat-bars .hbar .lbl{width:3rem;color:var(--muted);flex-shrink:0}",
  ".heat-bars .hbar .track{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:4px;height:.9rem;overflow:hidden}",
  ".heat-bars .hbar .track .fill{height:100%;background:var(--lore-fill)}",
  `.heat-bars .hbar .val{width:6rem;text-align:right;color:var(--muted);flex-shrink:0;font-size:.7rem}`,
  // Reflow (WCAG 1.4.10, #855): below ~760px the sidebar would take most of
  // the viewport, so kb.css puts it above the content and the definition grid stacks.
  "@media (max-width:760px){" +
    ".shell{flex-direction:column}" +
    "main{padding:1rem}" +
    ".kv{grid-template-columns:1fr;gap:.1rem 0}" +
    ".kv dd{margin-bottom:.4rem}" +
    "}",
].join("");

// Session banner script (#367, refreshed in #435).
//
// In addition to the per-second local tick from #367, this:
//   - polls `GET /admin/session/ping` every 30s and re-syncs the local
//     deadline from the server's authoritative remaining time (the ping
//     endpoint is read-only and does NOT itself extend the session).
//   - resets the local deadline on `mousemove` / `keydown` (debounced)
//     to the inactivity window length so the visible number stays
//     snappy between polls when the admin is actually interacting.
//
// `data-inactivity-ms` is the full sliding window (matches the server's
// `WEBUI_INACTIVITY_TIMEOUT_MINUTES`); activity-driven local resets
// never push the deadline past that. The server's hard cap
// (`expiresAt`, from the ping response) is also tracked and used as a
// ceiling on the optimistic activity reset so the UI can't briefly
// promise more time than the session can actually deliver.
const SCRIPT =
  "(function(){var el=document.getElementById('session-countdown');if(!el)return;" +
  "function toMs(v){var n=Math.floor(Number(v));return isFinite(n)&&n>0?n:0}" +
  "var deadline=Date.now()+toMs(el.getAttribute('data-remaining-ms'));" +
  "var inactivityMs=toMs(el.getAttribute('data-inactivity-ms'));" +
  // Absolute timestamp (ms since epoch) of the server's hard cap; 0
  // means "unknown yet" — filled in on the first successful ping.
  "var hardCapAt=0;var fired=false;var lastReset=0;" +
  "function expire(){if(fired)return;fired=true;window.location.href='/admin/'}" +
  "function tick(){var r=Math.max(0,deadline-Date.now());var s=Math.floor(r/1000);" +
  "var m=Math.floor(s/60);var ss=s%60;el.textContent=m+':'+(ss<10?'0'+ss:ss);" +
  // Under five minutes the wrapper (`.kb-session`) turns warn.
  `if(el.parentNode&&el.parentNode.classList)el.parentNode.classList.toggle('is-low',r<${SESSION_LOW_MS});` +
  // When the countdown hits 0, navigate to /admin/. The session middleware
  // will reject the now-expired cookie and render the scaffold's 401 page.
  "if(r<=0)expire()}" +
  "function applyRemaining(ms){deadline=Date.now()+toMs(ms);tick()}" +
  "function onActivity(){if(inactivityMs<=0||fired)return;" +
  // Debounce so a stream of mousemove events doesn't reset every frame.
  // Only nudge the deadline forward (never back) — and never past the
  // server's hard cap if we know it.
  "var now=Date.now();if(now-lastReset<5000)return;lastReset=now;" +
  "var target=inactivityMs;" +
  "if(hardCapAt>0){var cap=hardCapAt-now;if(cap<target)target=cap}" +
  "if(target>0&&deadline-now<target)applyRemaining(target)}" +
  "function poll(){if(fired)return;" +
  "fetch('/admin/session/ping',{credentials:'same-origin',headers:{'Accept':'application/json'},cache:'no-store'})" +
  ".then(function(res){if(res.status===401){expire();return null}" +
  "if(!res.ok)return null;return res.json()})" +
  ".then(function(data){if(!data)return;" +
  "if(typeof data.expiresAt==='string'){var t=Date.parse(data.expiresAt);if(!isNaN(t))hardCapAt=t}" +
  "if(typeof data.remainingMs==='number')applyRemaining(data.remainingMs)})" +
  ".catch(function(){})}" +
  // Initial poll fills `hardCapAt` quickly so the activity reset has a
  // ceiling even before the first 30s interval elapses.
  "tick();poll();setInterval(tick,1000);setInterval(poll,30000);" +
  "document.addEventListener('mousemove',onActivity,{passive:true});" +
  "document.addEventListener('keydown',onActivity)})();";

// Cron schedule picker (#444). Each .cron-picker on the page wraps a
// hidden input (located via the `.cron-hidden` class — its form-field
// name varies per row under the per-section save form, e.g.
// `value_<key>`) that the form actually submits, plus a mode <select>
// ("daily" / "weekly" / "monthly" / "custom"), a time picker, and
// day-of-week / day-of-month controls. This script keeps the hidden
// input in sync as the operator changes the controls so the form posts
// a canonical cron string. Custom mode just mirrors the raw text input
// verbatim, which is what server-side coercion expects for a `cron`-
// typed key today.
const CRON_PICKER_SCRIPT =
  "(function(){" +
  "function clamp(n,lo,hi){return Math.max(lo,Math.min(hi,n))}" +
  "function wire(p){var hidden=p.querySelector('.cron-hidden');" +
  "var mode=p.querySelector('.cron-mode');" +
  "var time=p.querySelector('.cron-time');" +
  "var dow=p.querySelector('.cron-dow');" +
  "var dom=p.querySelector('.cron-dom');" +
  "var custom=p.querySelector('.cron-custom');" +
  "var timeWrap=p.querySelector('.cron-time-wrap');" +
  "var dowWrap=p.querySelector('.cron-dow-wrap');" +
  "var domWrap=p.querySelector('.cron-dom-wrap');" +
  "var customWrap=p.querySelector('.cron-custom-wrap');" +
  "function show(el,on){if(el)el.hidden=!on}" +
  "function compute(){var m=mode.value;" +
  "if(m==='custom'){return custom.value}" +
  // Clamp every numeric field defensively. The day-of-month <input>
  // carries min/max but browsers only enforce that on form-submit
  // (and unevenly across vendors), so an operator typing 32 or 0 can
  // still end up with an invalid cron string here. Time inputs are
  // browser-constrained but we clamp anyway in case parseInt yields
  // something silly.
  "var parts=(time.value||'00:00').split(':');" +
  "var h=clamp(parseInt(parts[0],10)||0,0,23);" +
  "var mi=clamp(parseInt(parts[1],10)||0,0,59);" +
  "if(m==='daily')return mi+' '+h+' * * *';" +
  "if(m==='weekly')return mi+' '+h+' * * '+clamp(parseInt(dow.value,10)||0,0,6);" +
  "if(m==='monthly')return mi+' '+h+' '+clamp(parseInt(dom.value,10)||1,1,31)+' * *';" +
  "return hidden.value}" +
  "function refresh(){var m=mode.value;" +
  "show(timeWrap,m==='daily'||m==='weekly'||m==='monthly');" +
  "show(dowWrap,m==='weekly');" +
  "show(domWrap,m==='monthly');" +
  "show(customWrap,m==='custom');" +
  "hidden.value=compute();p.setAttribute('data-mode',m)}" +
  "function update(){hidden.value=compute()}" +
  "mode.addEventListener('change',refresh);" +
  // Listen for both `input` and `change`. Text/number inputs fire
  // `input` continuously; <select> elements only reliably fire
  // `change` (some browsers don't fire `input` for selects at all).
  "[time,dow,dom,custom].forEach(function(el){if(!el)return;" +
  "el.addEventListener('input',update);el.addEventListener('change',update)});" +
  "refresh()}" +
  "document.querySelectorAll('.cron-picker').forEach(wire)})();";

// Cascading disable (#485). When a master `.enabled` checkbox
// (`[data-cascade-master]`) inside a `[data-cascade-scope]` container is
// unchecked, every other input/select/textarea in that scope is disabled
// and its row greyed via `.cascade-off`. Re-checking re-enables them with
// their values intact (we only toggle `disabled`, never the value). Hidden
// inputs (csrf/keys/category) and buttons are left alone so the form still
// submits correctly. Used by both the wizard step form and the per-section
// Settings forms.
//
// Dependency locks (#666) win over the master: a control marked
// `[data-dep-locked]` (its hard `dependsOn` target is off) stays disabled even
// when the section master is on, and its row keeps the static `.dep-off`
// greying. So `apply()` only ever *adds* disabling to such controls — it never
// re-enables them.
export const CASCADE_DISABLE_SCRIPT =
  "(function(){" +
  "function wire(master){" +
  "var scope=master.closest('[data-cascade-scope]');if(!scope)return;" +
  "function apply(){var off=!master.checked;" +
  "scope.querySelectorAll('input,select,textarea').forEach(function(el){" +
  "if(el===master||el.type==='hidden')return;" +
  "var locked=el.hasAttribute('data-dep-locked');" +
  "el.disabled=off||locked;" +
  "var row=el.closest('.kb-setting,.field-row,tr');" +
  "if(row)row.classList.toggle(row.classList.contains('kb-setting')?'is-inactive':'cascade-off',off)})}" +
  "master.addEventListener('change',apply);apply()}" +
  "document.querySelectorAll('[data-cascade-master]').forEach(wire)})();";

// Focus a control the server rejected (#854). Shared verbatim by the AJAX save
// script and the on-load focus script so the two can't drift. A rejected cron
// key's target is the `.cron-picker` group `<div>`, which isn't focusable on
// its own, so give a non-native target a `tabindex` — tagged with
// `data-a11y-tabindex` so `clearInvalid` removes exactly what was added rather
// than leaving a stale focus target on a field a later save accepted.
const FOCUS_INVALID_FN =
  "function focusInvalid(el){if(!el)return;" +
  "if(!el.hasAttribute('tabindex')&&" +
  "!/^(a|button|input|select|textarea)$/i.test(el.tagName)){" +
  "el.setAttribute('tabindex','-1');el.setAttribute('data-a11y-tabindex','')}" +
  "try{el.focus()}catch(e){}" +
  "try{el.scrollIntoView({block:'center'})}catch(e){}}";

// AJAX section save (#555). Each Settings category is its own
// `POST /admin/settings/save-section` form. A plain submit 303-redirects
// back to /admin/settings, reloading the page and dropping the admin at the
// top — annoying when you just saved a section near the bottom. This
// progressively enhances the Save button: submit via fetch(), show the
// server's flash inline inside the same card, and leave scroll position
// untouched. The server returns JSON for these requests (Accept:
// application/json) and keeps the redirect for the no-JS path, so browsers
// without fetch/FormData/URLSearchParams fall back to the original
// full-page behaviour. The body is urlencoded (not multipart) so the
// router's express.urlencoded parser can read `_csrf` — see the body line.
//
// Per-row Reset buttons retarget /admin/settings/reset via `formaction`;
// those are left to submit natively (full reload). We track the clicked
// submitter manually as well as via `SubmitEvent.submitter` so a Reset on an
// older browser without `submitter` isn't mistakenly AJAX-posted to the
// save-section route.
const SETTINGS_SAVE_SCRIPT =
  "(function(){" +
  FOCUS_INVALID_FN +
  "var forms=document.querySelectorAll('form[action=\"/admin/settings/save-section\"]');" +
  "if(!forms.length)return;" +
  // The flash node is given an id so a rejected control can point its
  // `aria-describedby` at it and carry the server's reason (#854).
  "var seq=0;" +
  "function flashEl(form){var card=form.closest('.card');if(!card)return null;" +
  "var n=card.querySelector('.section-flash');" +
  // role="status" makes the node a polite live region, so every save result
  // (success, CSRF failure, rate-limit, network error) is announced (#855).
  "if(!n){n=document.createElement('div');n.className='notice section-flash';" +
  "n.setAttribute('role','status');n.setAttribute('aria-live','polite');" +
  "form.parentNode.insertBefore(n,form)}" +
  "if(!n.id)n.id='section-flash-'+(++seq);return n}" +
  "function show(form,type,text){var n=flashEl(form);if(!n)return;" +
  "var cls=type==='ok'?'ok':type==='warn'?'warn':'err';" +
  "n.className='notice section-flash '+cls;n.textContent=text;return n}" +
  // Rejected-field marking (#854). Without this an AJAX save tells a screen
  // reader that "3 values were invalid" and nothing about which of the ~318
  // controls on the page they were. The pre-existing `aria-describedby` is
  // stashed on the element so clearing restores it exactly.
  "function clearInvalid(form){" +
  "Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'),function(el){" +
  "el.removeAttribute('aria-invalid');" +
  "var base=el.getAttribute('data-describedby-base');" +
  "if(base===null)return;" +
  "if(base)el.setAttribute('aria-describedby',base);" +
  "else el.removeAttribute('aria-describedby');" +
  "el.removeAttribute('data-describedby-base')});" +
  // Drop the server-rendered "Rejected" notes too, so nothing is left
  // describing a field the new save may have accepted, and give back the
  // focusability `focusInvalid` added to reach a group target.
  "Array.prototype.forEach.call(form.querySelectorAll('.settings-error'),function(el){" +
  "if(el.parentNode)el.parentNode.removeChild(el)});" +
  "Array.prototype.forEach.call(form.querySelectorAll('[data-a11y-tabindex]'),function(el){" +
  "el.removeAttribute('tabindex');el.removeAttribute('data-a11y-tabindex')})}" +
  "function markInvalid(form,keys,msgId){var first=null;" +
  "for(var i=0;i<keys.length;i++){" +
  "if(typeof keys[i]!=='string')continue;" +
  "var el=document.getElementById('set-'+keys[i]);" +
  "if(!el||!form.contains(el))continue;" +
  "var base=el.getAttribute('aria-describedby')||'';" +
  "el.setAttribute('data-describedby-base',base);" +
  "if(msgId)el.setAttribute('aria-describedby',base?base+' '+msgId:msgId);" +
  "el.setAttribute('aria-invalid','true');" +
  "if(!first)first=el}" +
  "focusInvalid(first)}" +
  "function applyResult(form,data,msgId){clearInvalid(form);" +
  "var keys=data&&Object.prototype.toString.call(data.invalidKeys)==='[object Array]'" +
  "?data.invalidKeys:null;" +
  "if(keys&&keys.length)markInvalid(form,keys,msgId)}" +
  "function submit(e,submitter){var form=e.currentTarget;" +
  // Reset buttons retarget via formaction — let those submit natively.
  "if(submitter&&submitter.getAttribute('formaction'))return;" +
  "if(typeof fetch!=='function'||typeof FormData!=='function'||typeof URLSearchParams!=='function')return;" +
  // Build the urlencoded body BEFORE preventDefault so a throw in a
  // partially-supported browser falls back to the native (urlencoded) form
  // POST instead of aborting a half-suppressed submit and breaking Save.
  // Sent as application/x-www-form-urlencoded, NOT multipart: the router
  // only mounts express.urlencoded (no multipart parser), so a multipart
  // FormData body would arrive empty server-side — losing `_csrf` and
  // tripping requireCsrf with "CSRF token missing" (issue #628). Wrapping
  // the FormData in URLSearchParams makes fetch send urlencoded, so the
  // CSRF token and every value_*/keys field round-trip through the parser.
  "var body;try{body=new URLSearchParams(new FormData(form))}catch(err){return}" +
  "e.preventDefault();" +
  "var save=form.querySelector('button[type=submit]:not([formaction]):not([form])');" +
  "if(save)save.disabled=true;" +
  "fetch(form.action,{method:'POST',credentials:'same-origin',cache:'no-store'," +
  "headers:{'Accept':'application/json','X-Requested-With':'fetch'}," +
  "body:body})" +
  ".then(function(res){if(res.status===401){window.location.href='/admin/';return null}" +
  // Read the body once as text and try to parse it as JSON. The server's
  // happy path and its error paths (CSRF/rate-limit/payload/unhandled) all
  // speak JSON now (issue #612); if something still returns non-JSON we keep
  // the HTTP status and the readable body so the toast says what went wrong
  // instead of a flat 'unexpected server response'.
  "var status=res.status;" +
  "return res.text().then(function(t){var d=null;try{d=JSON.parse(t)}catch(e){}" +
  "return{status:status,json:d,text:t}})})" +
  ".then(function(r){if(save)save.disabled=false;" +
  "if(!r)return;" +
  // A structured flash (server's happy path AND its error paths) carries a
  // non-empty `text`; show it, letting the HTTP status decide ok/err when the
  // server omits an explicit `type`. JSON without usable text (e.g. a proxy's
  // own envelope) must NOT be mistaken for a successful save, so fall through.
  "var jt=r.json&&typeof r.json==='object'?r.json.text:null;" +
  "var okStatus=r.status>=200&&r.status<300;" +
  // A feature-card save that flipped an enable flag asks for a reload so
  // the page's banner, Status card and nav reflect the new state; the URL is
  // the no-JS flash redirect, so the result still shows. Same-origin admin
  // paths only.
  "var rl=r.json&&typeof r.json==='object'?r.json.reload:null;" +
  "if(typeof rl==='string'&&rl.indexOf('/admin/')===0&&rl.indexOf('//')<0){window.location.assign(rl);return}" +
  // An accepted save (2xx, nothing rejected) tells the save bar the form's
  // values are now the saved ones (#1330).
  "var rej=r.json&&Object.prototype.toString.call(r.json.invalidKeys)==='[object Array]'&&r.json.invalidKeys.length>0;" +
  "var saved=okStatus&&!rej&&!(r.json&&r.json.type==='err');" +
  "function done(){if(saved){try{form.dispatchEvent(new Event('kb-saved'))}catch(e){}}}" +
  "if(typeof jt==='string'&&jt){" +
  "var n=show(form,(r.json.type)||(okStatus?'ok':'err'),jt);" +
  "applyResult(form,r.json,n?n.id:'');done();return}" +
  "if(okStatus){show(form,'ok','Saved.');clearInvalid(form);done();return}" +
  // Non-2xx with no usable JSON: surface the status plus any readable text.
  "var detail=(r.text||'').replace(/<[^>]*>/g,' ').replace(/\\s+/g,' ').trim();" +
  "var msg='Save failed ('+r.status+').';" +
  "if(detail)msg+=' '+(detail.length>200?detail.slice(0,199)+'…':detail);" +
  "show(form,'err',msg)})" +
  ".catch(function(){if(save)save.disabled=false;" +
  "show(form,'err','Save failed — network error. Your changes were not saved.')})}" +
  "function wire(form){var last=null;" +
  "form.addEventListener('click',function(ev){var t=ev.target;" +
  "if(t&&t.closest){var b=t.closest('button,input[type=submit]');" +
  "if(b&&form.contains(b))last=b}});" +
  "form.addEventListener('submit',function(e){submit(e,e.submitter||last);last=null})}" +
  "forms.forEach(wire)})();";

// Move focus to the first control the server just rejected (#854). The no-JS
// Settings save 303-redirects back with `?invalid=<keys>`, so the rejected
// fields are already marked `aria-invalid` in the delivered HTML — without
// this, a screen-reader user lands at the top of a page of ~318 controls with
// only a banner telling them *something* was refused. The AJAX save path does
// its own focus move in SETTINGS_SAVE_SCRIPT; this one only ever fires on a
// full page load, and no-ops on every page that renders nothing invalid.
//
// With nothing invalid, focus moves to the post-redirect flash instead (the
// `.notice[data-flash]` rendered by `renderFlash`): a live region that is
// part of a freshly loaded document is never announced on its own, so
// focusing it is what gets "Saved." / "Import failed" read out after a PRG
// round-trip (#855).
const INVALID_FOCUS_SCRIPT =
  "(function(){" +
  FOCUS_INVALID_FN +
  "var inv=document.querySelector('[aria-invalid=\"true\"]');" +
  "if(inv){focusInvalid(inv);return}" +
  // Plain focus() for the flash: it sits at the top of the page, so the
  // scroll-to-centre that focusInvalid does for a deep field isn't wanted.
  "var f=document.querySelector('.notice[data-flash]');" +
  "if(f){try{f.focus()}catch(e){}}" +
  "})();";

// Remembers whether the "N turned off" list is open, per browser (#1296).
// Reads and writes sit in try/catch: storage can be blocked, and the page must
// work without it. The state is written on click, before the browser flips
// `open`, so a list the server forced open (the current page is inside it) never
// overwrites what the person chose.
const NAV_OFF_KEY = "koolbot.admin.nav.off-open";
const NAV_OFF_SCRIPT =
  "(function(){" +
  "var d=document.querySelector('details[data-nav-off]');" +
  "if(!d)return;" +
  `var k=${JSON.stringify(NAV_OFF_KEY)};` +
  "if(!d.open){try{if(localStorage.getItem(k)==='1')d.open=true}catch(e){}}" +
  "var s=d.querySelector('summary');" +
  "if(s)s.addEventListener('click',function(){" +
  "try{localStorage.setItem(k,d.open?'0':'1')}catch(e){}" +
  "});" +
  "})();";

const NAV_CHEVRON = icon("chevron-right", { className: "kb-chev" });

/** Group name as an element id: "Server setup" -> "admin-nav-server-setup". */
function navGroupId(group: NavGroup): string {
  return `admin-nav-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function renderNav(
  active: string,
  navFeatureStatus?: NavFeatureStatus,
): string {
  // Feature-gated items are shown even when their feature is off (#610) so
  // the page stays discoverable; a switched-off item is greyed and tagged
  // "off", lives in the folded "N turned off" list (#1296), but the link still
  // works and the page itself renders an "enable here" prompt. An unknown
  // featureKey (missing from the map) and items without a featureKey render as
  // plain links - a wiring gap fails open, not greyed.
  const isDisabled = (item: NavItem): boolean => {
    if (!navFeatureStatus || !item.featureKey) return false;
    return navFeatureStatus[item.featureKey] === false;
  };
  const isActiveItem = (item: NavItem): boolean =>
    item.href === active || (item.href === "/admin/" && active === "/admin");
  const renderItem = (item: NavItem): string => {
    const disabled = isDisabled(item);
    // The active page is conveyed by `aria-current` (which kb.css styles) so
    // it is said to assistive tech too, not by colour alone (#855).
    const attrs =
      (disabled ? ' class="is-off"' : "") +
      (isActiveItem(item) ? ' aria-current="page"' : "") +
      (disabled
        ? ' title="This feature is disabled — open it to enable it"'
        : "");
    const issues =
      item.href === "/admin/bot-permissions" ? getPermissionIssueCount() : 0;
    const badge = disabled
      ? '<span class="kb-badge kb-badge--off kb-sidenav__end">off</span>'
      : issues > 0
        ? `<span class="kb-badge kb-badge--warn kb-badge--count kb-sidenav__end" title="Missing permissions affect enabled features">${issues}</span>`
        : "";
    return `<li><a href="${escapeHtml(item.href)}"${attrs}>${escapeHtml(item.label)}${badge}</a></li>`;
  };
  const renderList = (items: NavItem[], labelledBy?: string): string => {
    const label = labelledBy ? ` aria-labelledby="${labelledBy}"` : "";
    return `<ul${label}>${items.map(renderItem).join("")}</ul>`;
  };
  const byLabel = (a: NavItem, b: NavItem): number =>
    a.label.localeCompare(b.label, "en");

  return NAV_GROUP_ORDER.map((group) => {
    const items = NAV_ITEMS.filter((item) => item.group === group);
    if (items.length === 0) return "";
    // Dashboard and All settings stand alone, without a heading; All settings
    // is pinned to the bottom of the sidebar.
    if (!NAV_HEADED_GROUPS.includes(group)) {
      const pinned = group === "Pinned" ? " kb-sidenav__pinned" : "";
      return `<div class="kb-sidenav__group${pinned}">${renderList(items)}</div>`;
    }
    const id = navGroupId(group);
    const heading = `<p class="kb-overline kb-sidenav__heading" id="${id}">${escapeHtml(group)}</p>`;
    if (group !== "Features") {
      return `<div class="kb-sidenav__group">${heading}${renderList(items, id)}</div>`;
    }
    // Features: the switched-on ones A to Z, the rest folded into a `details`
    // that stays open when the current page is inside it (an `aria-current`
    // link in a closed list would be hidden from the person who is on it).
    const on = items.filter((item) => !isDisabled(item)).sort(byLabel);
    const off = items.filter(isDisabled).sort(byLabel);
    const fold =
      off.length === 0
        ? ""
        : `<details data-nav-off${off.some(isActiveItem) ? " open" : ""}>` +
          `<summary>${NAV_CHEVRON}${off.length} turned off</summary>` +
          `${renderList(off)}</details>`;
    return `<div class="kb-sidenav__group">${heading}${on.length > 0 ? renderList(on, id) : ""}${fold}</div>`;
  }).join("");
}

export function renderAdminPage(opts: AdminPageOptions): string {
  const remainingMs = Math.max(0, Math.floor(opts.remainingMs));
  const inactivityMs = getInactivityWindowMs();
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    `<title>${escapeHtml(opts.title)} — Koolbot Admin</title>`,
    // tokens.css + kb.css first, so this page-local sheet can still override them.
    designStylesheetLinks("/admin"),
    `<style>${STYLE}</style>`,
    "</head><body>",
    // First focusable element on every page (#855). `main` carries
    // `tabindex="-1"` so the fragment jump also moves keyboard focus.
    '<a class="skip-link" href="#main">Skip to content</a>',
    // A `<header>` banner landmark (the top bar), so the session countdown and
    // Finish aren't stranded outside every landmark (axe `region`, #856). The
    // "My preferences" link goes to the parallel `/me` surface (#481): the same
    // session covers both, so it never forces a re-sign-in or burns a new token.
    renderTopBar({
      viewer: resolveViewer(opts.viewer, true),
      surface: "admin",
      home: "/admin/",
      brandExtraHtml: renderVersionPills(),
      csrfToken: opts.csrfToken,
      remainingMs,
      inactivityMs,
    }),
    '<div class="shell">',
    // Named so it stays distinguishable from any other nav landmark a page
    // body introduces (axe `landmark-unique`, #856).
    `<nav class="kb-sidenav" aria-label="Admin sections">${renderNav(opts.active, opts.navFeatureStatus)}</nav>`,
    // The body is built on the server and user text in it is HTML-escaped (quotes included), so
    // this literal can only come from `renderSaveBar`; a false positive would only clip `main`.
    `<main id="main"${opts.body.includes('class="kb-savebar"') ? ' class="has-savebar"' : ""} tabindex="-1">${opts.body}</main></div>`,
    `${scriptTag(SCRIPT)}`,
    `${scriptTag(CONFIRM_SCRIPT)}`,
    `${scriptTag(CRON_PICKER_SCRIPT)}`,
    `${scriptTag(CASCADE_DISABLE_SCRIPT)}`,
    `${scriptTag(NUMBER_INPUT_SCRIPT)}`,
    // Pickers (#1426): each script is only sent on a page that has its control.
    ...(opts.body.includes("data-tz")
      ? [`${scriptTag(TIMEZONE_SELECT_SCRIPT)}`]
      : []),
    ...(opts.body.includes("data-colour")
      ? [`${scriptTag(COLOUR_INPUT_SCRIPT)}`]
      : []),
    ...(opts.body.includes("data-picker")
      ? [`${scriptTag(CHANNEL_PICKER_SCRIPT)}`]
      : []),
    ...(opts.body.includes("data-stepper")
      ? [`${scriptTag(STEPPER_SCRIPT)}`]
      : []),
    ...(opts.body.includes("data-duration")
      ? [`${scriptTag(DURATION_PRESETS_SCRIPT)}`]
      : []),
    ...(opts.body.includes("data-emoji-field")
      ? [`${scriptTag(groupRowsScript())}`]
      : []),
    `${scriptTag(SETTINGS_SAVE_SCRIPT)}`,
    `${scriptTag(SAVEBAR_SCRIPT)}`,
    `${scriptTag(INVALID_FOCUS_SCRIPT)}`,
    `${scriptTag(NAV_OFF_SCRIPT)}`,
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
  const inactivityMs = getInactivityWindowMs();
  if (!session) return inactivityMs;
  const hardCapMs = Math.max(0, session.expiresAt.getTime() - Date.now());
  return Math.min(inactivityMs, hardCapMs);
}
