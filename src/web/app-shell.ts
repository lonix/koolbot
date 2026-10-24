/**
 * The app shell (#1317): the top bar that says who you are and what you may do,
 * the sidebar with one section per scope, and the "why you see this" line.
 *
 * One app for everyone: a person signs in once and each scope they hold adds
 * its own section (Member: You, Event host: Hosting, Moderator: Moderation);
 * admins also get the console. `user-layout.ts` and `admin-layout.ts` call the
 * renderers here, so the markup (`docs/design/components.md`: TopBar, SideNav,
 * ScopeBadge) lives in exactly one place and uses the shared `kb-` stylesheet,
 * including its 760px reflow (#855).
 *
 * Who is looking. The layouts are pure functions of their options and have no
 * request, and there are fifty page renderers between them. The session
 * middleware therefore puts a `ShellViewer` in an `AsyncLocalStorage` for the
 * rest of the request (`runWithViewer`) and the layouts read it with
 * `currentViewer()`; a caller may also pass `viewer` explicitly (tests do).
 * With neither, the layouts fall back to what the page itself knows.
 *
 * Adding a page to the sidebar is one entry in `SHELL_NAV` below.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ConfigSchema } from "../services/config-schema.js";
import type { WebScope } from "../models/web-session.js";
import { escapeHtml } from "./html.js";
import { roleMention } from "./discord-labels.js";
import { icon, type IconName } from "./icons.js";
import { getBotVersion } from "../utils/version.js";
import { formatVersion } from "../utils/semver.js";

// ---- who is looking --------------------------------------------------------

/** The Discord roles behind the host and moderator scopes (see `WebSessionContext`). */
export interface ShellScopeReasons {
  host: string[];
  staff: string[];
  /** Owner or Administrator: holds both through no role group. */
  elevated: boolean;
}

export interface ShellViewer {
  /** Server nickname or display name. Untrusted: escaped wherever it is rendered. */
  displayName: string | null;
  role: "admin" | "user";
  /** `member` plus the host and moderator scopes held on this request. */
  scopes: WebScope[];
  reasons?: ShellScopeReasons;
  /**
   * State of the features that gate sidebar items (`ShellNavItem.featureKey`),
   * read once per request by the session middleware. Absent means all off.
   */
  features?: ShellFeatureStatus;
}

/** What `viewerFromSession` reads; a structural subset of `WebSessionContext`. */
export interface ShellSessionLike {
  role: "admin" | "user";
  scopes: WebScope[];
  displayName?: string;
  scopeReasons?: ShellScopeReasons;
  shellFeatures?: ShellFeatureStatus;
}

export function viewerFromSession(session: ShellSessionLike): ShellViewer {
  return {
    displayName: session.displayName ?? null,
    role: session.role,
    scopes: session.scopes,
    reasons: session.scopeReasons,
    features: session.shellFeatures,
  };
}

const viewerStorage = new AsyncLocalStorage<ShellViewer>();

/** Run `fn` (and everything it awaits) with `viewer` as the current viewer. */
export function runWithViewer<T>(viewer: ShellViewer, fn: () => T): T {
  return viewerStorage.run(viewer, fn);
}

export function currentViewer(): ShellViewer | null {
  return viewerStorage.getStore() ?? null;
}

const ALL_SCOPES: WebScope[] = ["member", "host", "moderator"];

/**
 * The viewer a layout renders for: the explicit one, else the request's, else
 * a stand-in built from the one fact every page has (`isAdmin`).
 */
export function resolveViewer(
  explicit: ShellViewer | undefined,
  isAdmin: boolean,
): ShellViewer {
  const found = explicit ?? currentViewer();
  if (found) return found;
  return {
    displayName: null,
    role: isAdmin ? "admin" : "user",
    scopes: isAdmin ? [...ALL_SCOPES] : ["member"],
  };
}

function holds(viewer: ShellViewer, scope: WebScope): boolean {
  return (
    scope === "member" ||
    viewer.role === "admin" ||
    viewer.scopes.includes(scope)
  );
}

// ---- scopes ----------------------------------------------------------------

interface ScopeInfo {
  /** Badge word (ScopeBadge). */
  badge: string;
  /** Sidebar section heading. */
  section: string;
  icon: IconName;
  /** The verb phrase of the "why you see this" line. */
  can: string;
  /** What to call the capability when no role name is known. */
  capability: string;
}

export const SCOPE_INFO: Record<WebScope, ScopeInfo> = {
  member: {
    badge: "Member",
    section: "You",
    icon: "user",
    can: "use these pages",
    capability: "Member",
  },
  host: {
    badge: "Event host",
    section: "Hosting",
    icon: "calendar",
    can: "host",
    capability: "Event host",
  },
  moderator: {
    badge: "Moderator",
    section: "Moderation",
    icon: "shield-half",
    can: "moderate",
    capability: "Moderator",
  },
};

/**
 * `/me` areas that belong to a scope, matching the guards in `user-routes.ts`
 * (`/me/events*` needs host, `/me/moderation*` needs moderator). Anything else
 * under `/me` is Member.
 */
const SCOPE_PATH_PREFIXES: ReadonlyArray<readonly [string, WebScope]> = [
  ["/me/events", "host"],
  ["/me/moderation", "moderator"],
];

export function scopeOfPath(path: string): WebScope {
  for (const [prefix, scope] of SCOPE_PATH_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return scope;
  }
  return "member";
}

function scopeBadge(label: string, name: IconName): string {
  return `<span class="kb-scope">${icon(name)}${escapeHtml(label)}</span>`;
}

/** The scopes shown as badges: every one above Member, then Admin. */
function badgeScopes(viewer: ShellViewer): string[] {
  const out: string[] = [];
  if (holds(viewer, "host")) out.push(scopeBadge("Event host", "calendar"));
  if (holds(viewer, "moderator")) {
    out.push(scopeBadge("Moderator", "shield-half"));
  }
  if (viewer.role === "admin") out.push(scopeBadge("Admin", "user-cog"));
  return out;
}

// ---- navigation registry ---------------------------------------------------

export interface ShellNavItem {
  /** Whose section it sits in: one section per scope. */
  scope: WebScope;
  label: string;
  href: string;
  icon: IconName;
  /**
   * `<feature>.enabled` key for pages that exist only while a feature is on.
   * Unlike the admin nav, an item gated this way is hidden, not greyed, until
   * the caller says the feature is on (`featureStatus[key] === true`).
   */
  featureKey?: keyof ConfigSchema;
  /**
   * Whether the page is built. An item that is not available is never
   * rendered, so the sidebar cannot link to a 404; the issue that adds the
   * page flips this to `true`.
   */
  available: boolean;
}

/**
 * Every sidebar entry of the non-admin app. Add a page with one line here; a
 * scope's section appears once it has at least one visible item, and the whole
 * sidebar once two sections do (see `renderSideNav`).
 */
export const SHELL_NAV: readonly ShellNavItem[] = [
  {
    scope: "member",
    label: "My preferences",
    href: "/me/",
    icon: "user",
    available: true,
  },
  // Hosting: Your events (#1319), New event (#1305), Event presets (#1216).
  {
    scope: "host",
    label: "Your events",
    href: "/me/events",
    icon: "calendar",
    available: true,
  },
  {
    scope: "host",
    label: "New event",
    href: "/me/events/new",
    icon: "calendar-plus",
    featureKey: "events.enabled",
    available: true,
  },
  {
    scope: "host",
    label: "Event presets",
    href: "/me/events/presets",
    icon: "calendar",
    available: true,
  },
  // Moderation. The case page (/me/moderation/cases/:id) has no entry: it is
  // reached from the Mod log, which stays marked there. Tickets has no page yet.
  {
    scope: "moderator",
    label: "Mod log",
    href: "/me/moderation",
    icon: "gavel",
    available: true,
  },
  {
    scope: "moderator",
    label: "Command audit",
    href: "/me/moderation/audit",
    icon: "scroll-text",
    available: true,
  },
  {
    scope: "moderator",
    label: "Tickets",
    href: "/me/moderation/tickets",
    icon: "ticket",
    featureKey: "tickets.enabled",
    available: false,
  },
];

export type ShellFeatureStatus = Partial<Record<keyof ConfigSchema, boolean>>;

/**
 * Read the state of every feature that gates a built sidebar item, once, for
 * the request. `read` is `ConfigService.getBoolean` in practice; a failed read
 * counts as off (the item stays hidden), never as on. With no gated item built
 * (today) nothing is read.
 */
export async function resolveShellFeatures(
  read: (key: keyof ConfigSchema) => Promise<boolean>,
  registry: readonly ShellNavItem[] = SHELL_NAV,
): Promise<ShellFeatureStatus> {
  const keys = new Set<keyof ConfigSchema>();
  for (const item of registry) {
    if (item.available && item.featureKey) keys.add(item.featureKey);
  }
  const status: ShellFeatureStatus = {};
  await Promise.all(
    Array.from(keys).map(async (key) => {
      try {
        status[key] = (await read(key)) === true;
      } catch {
        status[key] = false;
      }
    }),
  );
  return status;
}

/** The running version as the top bar's pill (the admin bar adds its update link). */
export function renderVersionPill(): string {
  return `<span class="kb-pill kb-mono" title="Running version">${escapeHtml(formatVersion(getBotVersion()))}</span>`;
}

function isVisible(item: ShellNavItem, status?: ShellFeatureStatus): boolean {
  if (!item.available) return false;
  return item.featureKey === undefined || status?.[item.featureKey] === true;
}

export interface ShellSection {
  scope: WebScope;
  title: string;
  icon: IconName;
  items: ShellNavItem[];
}

/** The sections this viewer sees: their scopes' visible items, Member first. */
export function sectionsFor(
  viewer: ShellViewer,
  registry: readonly ShellNavItem[] = SHELL_NAV,
  status?: ShellFeatureStatus,
): ShellSection[] {
  const sections: ShellSection[] = [];
  for (const scope of ALL_SCOPES) {
    if (!holds(viewer, scope)) continue;
    const items = registry.filter(
      (item) => item.scope === scope && isVisible(item, status),
    );
    if (items.length === 0) continue;
    sections.push({
      scope,
      title: SCOPE_INFO[scope].section,
      icon: SCOPE_INFO[scope].icon,
      items,
    });
  }
  return sections;
}

/**
 * A person with one section has no sidebar: there is nothing to choose between,
 * so My preferences keeps its tabs in one centred column.
 */
export function hasSideNav(sections: readonly ShellSection[]): boolean {
  return sections.length > 1;
}

const trimSlash = (p: string): string =>
  p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;

/**
 * The one item that is the current page: the longest href that is the page or
 * a parent of it, within the page's own scope (so `/me/events/presets` is
 * Event presets, not also Your events).
 */
function currentItem(
  sections: readonly ShellSection[],
  active: string,
): ShellNavItem | null {
  const scope = scopeOfPath(active);
  const here = trimSlash(active);
  let best: ShellNavItem | null = null;
  for (const section of sections) {
    for (const item of section.items) {
      if (item.scope !== scope) continue;
      const base = trimSlash(item.href);
      if (here !== base && !here.startsWith(`${base}/`)) continue;
      if (!best || base.length > trimSlash(best.href).length) best = item;
    }
  }
  return best;
}

/** `nav.kb-sidenav`, or "" when there is nothing to choose between. */
export function renderSideNav(
  sections: readonly ShellSection[],
  active: string,
): string {
  if (!hasSideNav(sections)) return "";
  const current = currentItem(sections, active);
  const groups = sections
    .map((section) => {
      const id = `shell-nav-${section.scope}`;
      const items = section.items
        .map((item) => {
          const here = item === current ? ' aria-current="page"' : "";
          return `<li><a href="${escapeHtml(item.href)}"${here}>${icon(item.icon)}${escapeHtml(item.label)}</a></li>`;
        })
        .join("");
      return (
        `<div class="kb-sidenav__group" data-scope="${section.scope}">` +
        `<p class="kb-overline kb-sidenav__heading" id="${id}">${icon(section.icon)}${escapeHtml(section.title)}</p>` +
        `<ul aria-labelledby="${id}">${items}</ul></div>`
      );
    })
    .join("");
  return `<nav class="kb-sidenav" aria-label="Your sections">${groups}</nav>`;
}

// ---- why you see this ------------------------------------------------------

function roleList(names: string[]): string {
  return names.map(roleMention).join(", ");
}

/**
 * "You can host because you are in @Event hosts." for a page that belongs to
 * the host or moderator scope; "" for any other page. Fed by the scope and the
 * role names the person matches; with no role name it names the capability.
 */
export function renderScopeWhy(viewer: ShellViewer, active: string): string {
  const scope = scopeOfPath(active);
  if (scope === "member") return "";
  const info = SCOPE_INFO[scope];
  const roles = scope === "host" ? viewer.reasons?.host : viewer.reasons?.staff;
  let because: string;
  if (viewer.role === "admin" || viewer.reasons?.elevated) {
    because = "you are an Administrator";
  } else if (roles && roles.length > 0) {
    because = `you are in ${roleList(roles)}`;
  } else {
    because = `you hold the ${escapeHtml(info.capability)} role`;
  }
  return (
    `<div class="kb-callout" role="note" data-why="${scope}">` +
    scopeBadge(info.badge, info.icon) +
    `<span>You can ${info.can} because ${because}.</span></div>`
  );
}

// ---- top bar ---------------------------------------------------------------

function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : "?";
}

function renderWhoami(viewer: ShellViewer): string {
  const name = viewer.displayName?.trim() || "Signed in";
  return (
    `<span class="kb-whoami">` +
    `<span class="kb-avatar" aria-hidden="true">${escapeHtml(initialOf(name))}</span>` +
    `<span class="kb-whoami__name">${escapeHtml(name)}</span>${badgeScopes(viewer).join("")}</span>`
  );
}

export interface TopBarOptions {
  viewer: ShellViewer;
  /** Where the brand links. */
  home: string;
  /** Version pills (and the update badge), already rendered. */
  brandExtraHtml?: string;
  /** Which surface this is: the admin console ends with Finish, the rest Sign out. */
  surface: "me" | "admin";
  csrfToken: string;
  remainingMs: number;
  inactivityMs: number;
}

/** `header.kb-topbar`: brand, then who you are, the session and the way out. */
export function renderTopBar(opts: TopBarOptions): string {
  const admin = opts.surface === "admin";
  // Admins on /me get the console; the console links back to My preferences.
  const link = admin
    ? `<a class="kb-btn kb-btn--ghost kb-btn--sm" href="/me/">My preferences</a>`
    : opts.viewer.role === "admin"
      ? `<a class="kb-btn kb-btn--ghost kb-btn--sm" href="/admin/">Admin console</a>`
      : "";
  const action = admin ? "/admin/finish" : "/me/finish";
  const button = admin
    ? `<button type="submit" class="kb-btn kb-btn--danger kb-btn--sm">Finish</button>`
    : `<button type="submit" class="kb-btn kb-btn--sm">Sign out</button>`;
  return (
    `<header class="kb-topbar">` +
    `<a class="kb-topbar__brand" href="${escapeHtml(opts.home)}">KoolBot</a>` +
    (opts.brandExtraHtml ?? "") +
    `<div class="kb-topbar__end">` +
    renderWhoami(opts.viewer) +
    link +
    `<span class="kb-session">Session expires in ` +
    `<span id="session-countdown" data-remaining-ms="${Math.max(0, Math.floor(opts.remainingMs))}" data-inactivity-ms="${Math.floor(opts.inactivityMs)}">--:--</span></span>` +
    `<form method="POST" action="${action}">` +
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">` +
    `${button}</form></div></header>`
  );
}

/** Marks the timer `is-low` under five minutes (shared by both layouts' scripts). */
export const SESSION_LOW_MS = 5 * 60 * 1000;
