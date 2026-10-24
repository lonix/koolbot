import { URLSearchParams } from "node:url";
import { ChannelType } from "discord.js";
import { icon, toneIcon } from "./icons.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import type {
  ChannelFlags,
  ReadinessIssue,
  ScanChannel,
  ScanSeverity,
  ServerScan,
} from "../services/server-scan-service.js";
import { claimKeyFor, featureTarget } from "../services/channel-claims.js";
import {
  channelMention,
  missingMention,
  missingText,
  namedChannelMention,
  roleMention,
  roleText,
} from "./discord-labels.js";
import { GUILD_MEMBERS_INTENT_HOWTO } from "../utils/guild-members-intent.js";
import { findRemovedBotCandidates } from "../services/bot-removal-cleanup.js";
import {
  buildBotReplacementReport,
  type BotCard,
  type BotReplacementReport,
  type ReportCapability,
} from "../services/bot-replacement-report.js";

/**
 * Read-only "Server scan" page (#1019, #1323). Renders a `ServerScan` as an
 * Overview (the verdict, tiles, what to fix, suggestions that link to the page
 * that acts) and a tab per inventory: roles, channels, other bots and what
 * Discord handles itself. The tabs are plain links to `?tab=`, so they work
 * without JavaScript. The page has no write routes: its only form is a GET
 * that switches the ownership hints, and every dynamic value is escaped.
 */

const DOCS =
  "https://github.com/lonix/koolbot/blob/main/TROUBLESHOOTING.md#bot-cant-manage-roles-or-channels";
const CATALOG_DOCS =
  "https://github.com/lonix/koolbot/blob/main/CONTRIBUTING.md#adding-a-known-bot-entry";
const ISSUES = "https://github.com/lonix/koolbot/issues";

const SCAN_PAGE = "/admin/adopt";
const BOT_PERMISSIONS_PAGE = "/admin/bot-permissions";
const CLAIMS_PAGE = "/admin/adopt/claims";
const CLEANUP_PAGE = "/admin/adopt/cleanup";

export const SCAN_TABS = [
  "overview",
  "roles",
  "channels",
  "bots",
  "discord",
] as const;
export type ScanTab = (typeof SCAN_TABS)[number];

/** The tab a `?tab=` value names; anything unknown is the Overview. */
export function parseScanTab(raw: unknown): ScanTab {
  return typeof raw === "string" &&
    (SCAN_TABS as readonly string[]).includes(raw)
    ? (raw as ScanTab)
    : "overview";
}

export const CHANNEL_FILTERS = ["all", "used", "claimable", "custom"] as const;
export type ChannelFilter = (typeof CHANNEL_FILTERS)[number];

/** The filter a `?filter=` value names; anything unknown shows every channel. */
export function parseChannelFilter(raw: unknown): ChannelFilter {
  return typeof raw === "string" &&
    (CHANNEL_FILTERS as readonly string[]).includes(raw)
    ? (raw as ChannelFilter)
    : "all";
}

export interface AdoptPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus: NavFeatureStatus;
  /** Null when the scan failed outright. */
  scan: ServerScan | null;
  error?: string;
  /** Channel ownership hints (reads recent messages) are on. */
  sampled: boolean;
  tab: ScanTab;
  /** Channels tab: which channels to list. Defaults to all. */
  filter?: ChannelFilter;
}

const SEVERITY_LABEL: Record<ScanSeverity, string> = {
  error: "Blocker",
  warning: "Warning",
  info: "Note",
};

/** Issue codes whose fix is on Bot permissions (the permission or role position). */
export function fixedOnBotPermissions(code: string): boolean {
  return (
    code.startsWith("missing-") ||
    code.startsWith("bound-role-unmanageable-") ||
    code === "role-hierarchy-low"
  );
}

/** The page that acts on a suggestion; unknown codes get no button. */
export function suggestionAction(
  code: string,
): { href: string; label: string } | null {
  if (code.startsWith("fed-channel-")) {
    return { href: "/admin/adopt/claims", label: "Open Channel claims" };
  }
  if (code === "naming-prefix") {
    return { href: "/admin/voice-channels", label: "Open Voice channels" };
  }
  if (code === "afk-not-excluded") {
    return {
      href: "/admin/settings#section-voicetracking",
      label: "Open voice tracking settings",
    };
  }
  return null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function scanHref(
  tab: ScanTab,
  sampled: boolean,
  extra: Record<string, string> = {},
): string {
  const q = new URLSearchParams();
  if (tab !== "overview") q.set("tab", tab);
  if (sampled) q.set("sample", "1");
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const s = q.toString();
  return s ? `${SCAN_PAGE}?${s}` : SCAN_PAGE;
}

function badge(text: string, kind: "on" | "off" | "warn" | "info"): string {
  return `<span class="kb-badge kb-badge--${kind}">${escapeHtml(text)}</span>`;
}

function chips(items: string[]): string {
  return items
    .map((i) => `<span class="kb-chip kb-chip--ok">${escapeHtml(i)}</span>`)
    .join(" ");
}

function badges(items: string[], kind: "warn" | "info" = "warn"): string {
  return items.map((i) => badge(i, kind)).join(" ");
}

function scannedLabel(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function colorSwatch(color: number): string {
  if (!color) return `<span class="kb-muted">default</span>`;
  const hex = `#${color.toString(16).padStart(6, "0")}`;
  return `<span class="kb-mono">${escapeHtml(hex)}</span>`;
}

function callout(
  kind: "" | "warn" | "ok" | "err",
  title: string,
  text = "",
  actions = "",
): string {
  const role = kind === "err" || kind === "warn" ? "alert" : "status";
  return `<div class="kb-callout${kind ? ` kb-callout--${kind}` : ""}" role="${role}">
  ${toneIcon(kind)}<div class="kb-callout__body"><p class="kb-callout__title">${escapeHtml(title)}</p>${text ? `<p class="kb-callout__text">${text}</p>` : ""}</div>${actions ? `<div class="kb-callout__actions">${actions}</div>` : ""}
</div>`;
}

function panel(
  title: string,
  meta: string,
  body: string,
  opts: { flush?: boolean; id?: string } = {},
): string {
  const id = opts.id ?? `p-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return `<section class="kb-panel" aria-labelledby="${id}">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}">${escapeHtml(title)}</h2>${meta ? `<span class="kb-panel__meta">${meta}</span>` : ""}</header>
  <div class="kb-panel__body${opts.flush ? " kb-panel__body--flush" : ""}">${body}</div>
</section>`;
}

function disclosure(
  label: string,
  hint: string,
  body: string,
  opts: { inline?: boolean } = {},
): string {
  return `<details class="kb-disclosure${opts.inline ? " kb-disclosure--inline" : ""}"><summary>${icon("chevron-right", { className: "kb-chev" })}${escapeHtml(label)}${hint ? `<span class="kb-disclosure__hint">${escapeHtml(hint)}</span>` : ""}</summary><div class="kb-disclosure__body">${body}</div></details>`;
}

// ---- derived facts ----------------------------------------------------------

function otherBots(scan: ServerScan): ServerScan["bots"] {
  return scan.bots.filter((b) => !b.isKoolBot);
}

function blockers(scan: ServerScan): ReadinessIssue[] {
  return scan.readiness.issues.filter((i) => i.severity === "error");
}

function warnings(scan: ServerScan): ReadinessIssue[] {
  return scan.readiness.issues.filter((i) => i.severity === "warning");
}

function notes(scan: ServerScan): ReadinessIssue[] {
  return scan.readiness.issues.filter((i) => i.severity === "info");
}

/** Things that need a decision: blockers, warnings and suggestions. */
function attentionCount(scan: ServerScan): number {
  return (
    blockers(scan).length + warnings(scan).length + scan.suggestions.length
  );
}

// ---- header and tabs --------------------------------------------------------

function renderHeader(scan: ServerScan | null, props: AdoptPageProps): string {
  const name = escapeHtml(scan?.guildName ?? "this server");
  const meta = scan
    ? `<p class="kb-pagehead__meta"><span>Read from Discord ${escapeHtml(scannedLabel(scan.scannedAt))}</span><span>Ownership hints read recent messages, so they are slower.</span></p>`
    : "";
  const filter = props.tab === "channels" ? (props.filter ?? "all") : "all";
  const tabField =
    (props.tab === "overview"
      ? ""
      : `<input type="hidden" name="tab" value="${escapeHtml(props.tab)}">`) +
    (filter === "all"
      ? ""
      : `<input type="hidden" name="filter" value="${escapeHtml(filter)}">`);
  const hints = scan
    ? `<form method="get" action="${SCAN_PAGE}" class="kb-toolbar__end">${tabField}
      <label class="kb-switch"><input type="checkbox" role="switch" name="sample" value="1"${props.sampled ? " checked" : ""}><span class="kb-switch__track" aria-hidden="true"></span><span class="kb-switch__state" aria-hidden="true"></span>Channel ownership hints</label>
      <button type="submit" class="kb-btn kb-btn--sm">Apply</button>
    </form>
    <a class="kb-btn kb-btn--sm" href="${escapeHtml(
      scanHref(props.tab, props.sampled, {
        ...(filter === "all" ? {} : { filter }),
        refresh: "1",
      }),
    )}">Scan again</a>`
    : "";
  return `<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">Server scan</h1>
    <p class="kb-pagehead__sub">A read-only inventory of ${name}. Nothing here changes Discord or KoolBot settings; each suggestion links to the page that acts on it.</p>
    ${meta}
  </div>
  <div class="kb-pagehead__actions">${hints}</div>
</header>`;
}

function renderTabs(scan: ServerScan, props: AdoptPageProps): string {
  const counts: Record<ScanTab, number | null> = {
    overview: attentionCount(scan),
    roles: scan.roles.length,
    channels: scan.channels.length,
    bots: otherBots(scan).length,
    discord: null,
  };
  const labels: Record<ScanTab, string> = {
    overview: "Overview",
    roles: "Roles",
    channels: "Channels",
    bots: "Other bots",
    discord: "Discord",
  };
  const links = SCAN_TABS.map((t) => {
    const n = counts[t];
    const current = t === props.tab ? ` aria-current="page"` : "";
    const count =
      n === null
        ? ""
        : ` <span class="kb-badge kb-badge--count${t === "overview" && n > 0 ? " kb-badge--warn" : ""}">${n}</span>`;
    return `<a href="${escapeHtml(scanHref(t, props.sampled))}"${current}>${labels[t]}${count}</a>`;
  }).join("\n  ");
  return `<nav class="kb-tabs" aria-label="Server scan sections">
  ${links}
</nav>`;
}

// ---- Overview ---------------------------------------------------------------

function renderVerdict(scan: ServerScan): string {
  const r = scan.readiness;
  const link = `<a class="kb-btn kb-btn--sm" href="${BOT_PERMISSIONS_PAGE}">Open Bot permissions</a>`;
  if (r.ready) {
    return callout(
      "ok",
      "KoolBot has what it needs to manage this server.",
      "",
      link,
    );
  }
  const n = blockers(scan).length;
  return callout(
    "err",
    "KoolBot is not ready to manage this server yet.",
    `Fix ${plural(n, "blocker", "blockers")} below first.`,
    link,
  );
}

function renderTiles(scan: ServerScan, sampled: boolean): string {
  const r = scan.readiness;
  const n = blockers(scan).length;
  const unmanageable = scan.roles.filter(
    (x) => !x.isEveryone && !x.botCanManage,
  ).length;
  const used = scan.channels.filter((c) => c.usedBy.length > 0).length;
  const custom = scan.channels.filter((c) => c.syncedToParent === false).length;
  const others = otherBots(scan);
  const report = buildBotReplacementReport(scan, scan.scanned?.config ?? {});
  const known = report.cards.filter((c) => c.kind === "catalogued").length;
  return `<div class="kb-tiles">
  <a class="kb-tile${r.ready ? "" : " kb-tile--warn"}" href="${BOT_PERMISSIONS_PAGE}">
    <div class="kb-tile__top"><span class="kb-overline">Readiness</span>${r.ready ? badge("Ready", "on") : badge("Not ready", "off")}</div>
    <div class="kb-tile__value">${r.ready ? "Ready" : plural(n, "blocker", "blockers")}</div>
    <div class="kb-tile__detail">${escapeHtml(r.highestRoleName ?? "No KoolBot role")} is at position ${r.highestRolePosition} of ${r.roleCount}${r.administrator ? ", with Administrator" : ""}.</div>
  </a>
  <a class="kb-tile" href="${escapeHtml(scanHref("roles", sampled))}">
    <div class="kb-tile__top"><span class="kb-overline">Roles</span></div>
    <div class="kb-tile__value">${scan.roles.length}</div>
    <div class="kb-tile__detail">${unmanageable === 0 ? "KoolBot can manage all of them." : `${unmanageable} KoolBot cannot manage.`}</div>
  </a>
  <a class="kb-tile" href="${escapeHtml(scanHref("channels", sampled))}">
    <div class="kb-tile__top"><span class="kb-overline">Channels</span></div>
    <div class="kb-tile__value">${scan.channels.length}</div>
    <div class="kb-tile__detail">${used} used by KoolBot, ${custom} with custom permissions.</div>
  </a>
  <a class="kb-tile" href="${escapeHtml(scanHref("bots", sampled))}">
    <div class="kb-tile__top"><span class="kb-overline">Other bots</span></div>
    <div class="kb-tile__value">${others.length}</div>
    <div class="kb-tile__detail">${others.length === 0 ? (report.warnings.length ? "None found, but the list may be incomplete." : "None found.") : `${known} in the catalogue.`}</div>
  </a>
</div>`;
}

function renderIssue(i: ReadinessIssue): string {
  const sev = i.severity === "error" ? "err" : "warn";
  const perms = fixedOnBotPermissions(i.code)
    ? `<p><a href="${BOT_PERMISSIONS_PAGE}">Open Bot permissions</a></p>`
    : "";
  return `<article class="kb-issue">
  <div class="kb-issue__icon${sev === "err" ? " kb-issue__icon--err" : ""}" aria-hidden="true">${toneIcon(sev)}</div>
  <div>
    <div class="kb-issue__head"><h3 class="kb-issue__title">${escapeHtml(i.message)}</h3>${badge(SEVERITY_LABEL[i.severity], sev === "err" ? "off" : "warn")}</div>
  </div>
  <div class="kb-issue__fix"><span class="kb-overline">How to fix</span>${perms}<p><a href="${DOCS}" rel="noopener noreferrer">Read the troubleshooting guide</a></p></div>
</article>`;
}

function renderAttention(scan: ServerScan): string {
  const problems = [...blockers(scan), ...warnings(scan)];
  const parts: string[] = [];
  if (problems.length) {
    parts.push(
      `<section class="kb-panel" aria-labelledby="p-fix"><header class="kb-panel__head"><h2 class="kb-panel__title" id="p-fix">Needs fixing</h2>${badge(String(problems.length), "warn")}</header><div class="kb-panel__body kb-panel__body--flush">${problems.map(renderIssue).join("")}</div></section>`,
    );
  }
  const n = notes(scan);
  if (n.length) {
    parts.push(
      `<section class="kb-panel"><div class="kb-panel__body">${disclosure(
        `Notes (${n.length})`,
        "Nothing here blocks KoolBot",
        `<ul>${n.map((i) => `<li>${escapeHtml(i.message)} <a href="${DOCS}" rel="noopener noreferrer">How to fix</a></li>`).join("")}</ul>`,
      )}</div></section>`,
    );
  }
  const suggestions = scan.suggestions
    .map((s) => {
      const act = suggestionAction(s.code);
      return `<li><span class="kb-list__main">${escapeHtml(s.message)}</span>${act ? `<a class="kb-btn kb-btn--sm" href="${act.href}">${escapeHtml(act.label)}</a>` : ""}</li>`;
    })
    .join("");
  const unchecked = scan.webhooks.known
    ? ""
    : `<footer class="kb-panel__foot">Channels fed by webhooks or followed announcement channels were not checked, because webhooks could not be read.</footer>`;
  parts.push(
    `<section class="kb-panel" aria-labelledby="p-suggest"><header class="kb-panel__head"><h2 class="kb-panel__title" id="p-suggest">Suggestions</h2><span class="kb-panel__meta">${scan.suggestions.length}</span></header>${
      suggestions
        ? `<div class="kb-panel__body kb-panel__body--flush"><ul class="kb-list">${suggestions}</ul></div>`
        : `<div class="kb-panel__body"><p class="kb-muted">${scan.webhooks.known ? "Nothing to suggest. The channels and settings the scan checks look fine." : "Nothing to suggest from what could be read."}</p></div>`
    }${unchecked}</section>`,
  );
  return parts.join("\n");
}

function coverageCounts(card: BotCard): {
  full: number;
  partial: number;
  keep: number;
  none: number;
  total: number;
} {
  const out = { full: 0, partial: 0, keep: 0, none: 0, total: 0 };
  for (const c of card.capabilities) {
    out.total += 1;
    const level = c.coverage.level;
    if (level === "full") out.full += 1;
    else if (level === "partial") out.partial += 1;
    else if (level === "keep") out.keep += 1;
    else out.none += 1;
  }
  return out;
}

function renderCoverageBar(card: BotCard): string {
  const k = coverageCounts(card);
  if (card.kind !== "catalogued" || k.total === 0) return "";
  const pct = Math.round((k.full / k.total) * 100);
  return `<div class="kb-meter" role="img" aria-label="${k.full} of ${k.total} capabilities fully covered by KoolBot"><span style="width:${pct}%"></span></div>
  <p class="kb-muted">${k.full} full · ${k.partial} partial · ${k.keep} keep · ${k.none} not covered</p>`;
}

function renderBotSummaryCard(card: BotCard): string {
  return `<div class="kb-panel__body"><p><strong>${escapeHtml(card.name)}</strong></p><p class="kb-muted">${escapeHtml(card.summary)}</p>${renderCoverageBar(card)}</div>`;
}

function renderDiscordFacts(scan: ServerScan, sampled: boolean): string {
  const c = scan.community;
  const onboarding =
    c.onboardingEnabled === null
      ? "unknown"
      : c.onboardingEnabled
        ? "on"
        : "off";
  return `<section class="kb-panel" aria-labelledby="p-native"><header class="kb-panel__head"><h2 class="kb-panel__title" id="p-native">Handled by Discord</h2></header><div class="kb-panel__body"><dl class="kb-kv"><dt>Community</dt><dd>${c.community ? "On" : "Off"}</dd><dt>Onboarding</dt><dd>${escapeHtml(onboarding)}</dd><dt>Scheduled events</dt><dd>${scan.scheduledEvents.length}</dd></dl><p><a href="${escapeHtml(scanHref("discord", sampled))}">See the Discord tab</a></p></div></section>`;
}

function renderOverview(scan: ServerScan, sampled: boolean): string {
  const report = buildBotReplacementReport(scan, scan.scanned?.config ?? {});
  const bots = report.cards.length
    ? `<section class="kb-panel" aria-labelledby="p-bots"><header class="kb-panel__head"><h2 class="kb-panel__title" id="p-bots">Other bots</h2><span class="kb-panel__meta"><a href="${escapeHtml(scanHref("bots", sampled))}">${report.cards.length} in detail</a></span></header>${report.cards.map(renderBotSummaryCard).join("")}</section>`
    : "";
  const botWarnings = report.warnings.map((w) => callout("warn", w)).join("");
  return `${renderVerdict(scan)}
${botWarnings}
${renderTiles(scan, sampled)}
<div class="kb-cols">
  <div class="kb-stack">${renderAttention(scan)}</div>
  <div class="kb-stack">${bots}
${renderDiscordFacts(scan, sampled)}</div>
</div>`;
}

// ---- Roles ------------------------------------------------------------------

function renderRoles(scan: ServerScan): string {
  const rows = scan.roles
    .map((r) => {
      const flags: string[] = [];
      if (r.managed) flags.push("managed");
      if (r.isEveryone) flags.push("@everyone");
      if (r.onboardingManaged) flags.push("Onboarding-managed");
      const manage = r.isEveryone
        ? `<span class="kb-muted">n/a</span>`
        : r.botCanManage
          ? badge("Yes", "on")
          : badge("No", "warn");
      const count = `${r.memberCount}${r.memberCountApproximate ? "+" : ""}`;
      return `<tr><th scope="row">${r.isEveryone ? escapeHtml(r.name) : roleMention(r.name)}</th><td class="kb-num">${r.position}</td><td>${colorSwatch(r.color)}</td><td class="kb-num">${escapeHtml(count)}</td><td>${badges(flags)}</td><td>${manage}</td><td>${chips(r.usedBy)}</td></tr>`;
    })
    .join("");
  const note = `<p class="kb-muted">Member counts come from the cache and may be low (marked <code>+</code>)${
    scan.readiness.membersIntent
      ? "."
      : ` unless the bot requests the GuildMembers intent. ${escapeHtml(GUILD_MEMBERS_INTENT_HOWTO)}`
  }</p>`;
  return `${panel("Roles", String(scan.roles.length), note, { id: "p-roles" })}
<section class="kb-panel" aria-label="Role list"><div class="kb-panel__body kb-panel__body--flush"><table class="kb-table"><caption class="kb-visually-hidden">Roles</caption><thead><tr><th scope="col">Role</th><th scope="col" class="kb-num">Position</th><th scope="col">Colour</th><th scope="col" class="kb-num">Members</th><th scope="col">Flags</th><th scope="col">KoolBot can manage</th><th scope="col">Used by</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// ---- Channels ---------------------------------------------------------------

function flagTags(f: ChannelFlags): string[] {
  const out: string[] = [];
  if (f.afk) out.push("AFK");
  if (f.rules) out.push("Rules (Discord)");
  if (f.system) out.push("System (Discord)");
  if (f.publicUpdates) out.push("Public updates (Discord)");
  if (f.onboardingDefault) out.push("Onboarding default");
  if (f.webhookFed) out.push("webhook-fed");
  if (f.followed) out.push("followed");
  if (f.announcement) out.push("announcement");
  if (f.forum) out.push("forum");
  if (f.stage) out.push("stage");
  return out;
}

function renderOverwrites(c: ScanChannel): string {
  if (c.overwrites.length === 0) return `<span class="kb-muted">none</span>`;
  return c.overwrites
    .map(
      (o) =>
        `<div>${o.type === "role" && !o.label.startsWith("@") ? roleMention(o.label) : `<strong>${escapeHtml(o.label)}</strong>`} <span class="kb-muted">(${o.type})</span>${
          o.allow.length
            ? ` ${badge("allow", "on")} ${escapeHtml(o.allow.join(", "))}`
            : ""
        }${
          o.deny.length
            ? ` ${badge("deny", "off")} ${escapeHtml(o.deny.join(", "))}`
            : ""
        }</div>`,
    )
    .join("");
}

/** What a "looks like" guess is called in the row, e.g. `voicetracking` is Voice stats. */
const GUESS_LABELS: Record<string, string> = {
  quotes: "Quotes",
  announcements: "Announcements",
  voicetracking: "Voice stats",
  birthdays: "Birthdays",
  tickets: "Tickets",
  polls: "Polls",
  lfg: "Looking for group",
  moderation: "Moderation log",
  notices: "Notices",
  reactionroles: "Reaction roles",
  voicechannels: "Voice lobby",
};

const CHANNEL_FILTER_LABELS: Record<ChannelFilter, string> = {
  all: "All",
  used: "Used by KoolBot",
  claimable: "Could be claimed",
  custom: "Custom permissions",
};

/** The Channel claims link for a row, with the channel and feature filled in. */
export function claimHref(channelId: string, featureKey: string): string {
  const q = new URLSearchParams({ channel: channelId, feature: featureKey });
  return `${CLAIMS_PAGE}?${q.toString()}#claim-${encodeURIComponent(channelId)}`;
}

function channelMatches(c: ScanChannel, filter: ChannelFilter): boolean {
  switch (filter) {
    case "used":
      return c.usedBy.length > 0;
    case "claimable":
      return claimKeyFor(c) !== null;
    case "custom":
      return c.syncedToParent === false;
    default:
      return true;
  }
}

/** Discord's order: text-like channels first, then voice and stage, each by position. */
function inDiscordOrder(list: ScanChannel[]): ScanChannel[] {
  const voiceLike = (c: ScanChannel): number => (c.kind === "voice" ? 1 : 0);
  return list
    .slice()
    .sort((a, b) => voiceLike(a) - voiceLike(b) || a.position - b.position);
}

interface TreeRow {
  channel: ScanChannel;
  /** A child, indented under its category. */
  child: boolean;
}

/**
 * The channels as Discord lists them: channels outside any category first,
 * then each category with its channels under it. A channel whose category is
 * not in the scan counts as outside any category, so it is never dropped. A
 * filter keeps a category as a heading while any of its channels match.
 */
function treeRows(scan: ServerScan, filter: ChannelFilter): TreeRow[] {
  const categories = scan.channels
    .filter((c) => c.kind === "category")
    .sort((a, b) => a.position - b.position);
  const categoryIds = new Set(categories.map((c) => c.id));
  const rows: TreeRow[] = [];
  const loose = scan.channels.filter(
    (c) =>
      c.kind !== "category" && (!c.parentId || !categoryIds.has(c.parentId)),
  );
  for (const c of inDiscordOrder(loose)) {
    if (channelMatches(c, filter)) rows.push({ channel: c, child: false });
  }
  for (const cat of categories) {
    const kids = inDiscordOrder(
      scan.channels.filter(
        (c) => c.kind !== "category" && c.parentId === cat.id,
      ),
    ).filter((c) => channelMatches(c, filter));
    if (!channelMatches(cat, filter) && kids.length === 0) continue;
    rows.push({ channel: cat, child: false });
    for (const k of kids) rows.push({ channel: k, child: true });
  }
  return rows;
}

/** A role id as plain text: `@Name`, or the id as unavailable when the scan has no such role. */
function roleLabel(names: ReadonlyMap<string, string>, id: string): string {
  const name = names.get(id);
  return name === undefined ? missingText(id) : roleText(name);
}

function renderChannelRow(row: TreeRow, roleName: Map<string, string>): string {
  const c = row.channel;
  const claimKey = claimKeyFor(c);
  const target = claimKey ? featureTarget(claimKey) : undefined;
  const bits: string[] = [];
  if (c.usedBy.length) bits.push(chips(c.usedBy));
  if (c.featureGuess && c.usedBy.length === 0) {
    const label = GUESS_LABELS[c.featureGuess] ?? c.featureGuess;
    const claim =
      claimKey && target
        ? ` <a class="kb-btn kb-btn--sm" href="${escapeHtml(claimHref(c.id, claimKey))}">Claim<span class="kb-visually-hidden"> ${escapeHtml(c.name)} as ${escapeHtml(target.label)}</span></a>`
        : "";
    bits.push(
      `<span class="kb-muted">looks like ${escapeHtml(label)}</span>${claim}`,
    );
  }
  const flags = flagTags(c.flags);
  if (flags.length) bits.push(badges(flags));
  if (c.syncedToParent === false)
    bits.push(badge("Custom permissions", "warn"));
  const notes: string[] = [];
  if (c.gatedByRoleIds.length)
    notes.push(
      `gated by: ${c.gatedByRoleIds.map((id) => roleLabel(roleName, id)).join(", ")}`,
    );
  if (c.ownerHint)
    notes.push(
      `mostly posted by ${c.ownerHint.botTag} (${Math.round(c.ownerHint.share * 100)}%)`,
    );
  const overwrites = c.overwrites.length
    ? disclosure(
        plural(c.overwrites.length, "overwrite", "overwrites"),
        "",
        renderOverwrites(c),
        { inline: true },
      )
    : `<span class="kb-muted">none</span>`;
  const rowClass = c.kind === "category" ? ' class="kb-tree__cat"' : "";
  const headClass = row.child ? ' class="kb-tree__child"' : "";
  return `<tr${rowClass}><th scope="row"${headClass}>${channelMention({ name: c.name, type: ChannelType[c.typeName as keyof typeof ChannelType] })}</th><td>${bits.join(" ")}${notes.length ? `<div class="kb-muted">${escapeHtml(notes.join("; "))}</div>` : ""}</td><td>${overwrites}</td></tr>`;
}

function renderChannels(
  scan: ServerScan,
  filter: ChannelFilter,
  sampled: boolean,
): string {
  const roleName = new Map(scan.roles.map((r) => [r.id, r.name]));
  const rows = treeRows(scan, filter);
  const filters = CHANNEL_FILTERS.map((f) => {
    const n = scan.channels.filter((c) => channelMatches(c, f)).length;
    const href = scanHref(
      "channels",
      sampled,
      f === "all" ? {} : { filter: f },
    );
    return `<a href="${escapeHtml(href)}"${f === filter ? ' aria-current="true"' : ""}>${CHANNEL_FILTER_LABELS[f]} <span class="kb-badge kb-badge--count">${n}</span></a>`;
  }).join("\n  ");
  const webhookNote = scan.webhooks.known
    ? ""
    : callout(
        "warn",
        `${
          scan.webhooks.unavailable === "missing-permission"
            ? "KoolBot does not hold Manage Webhooks, so"
            : "Webhooks could not be read, so"
        } channels fed by webhooks or followed announcement channels are not marked below.`,
        "Their absence here does not mean there are none.",
        scan.webhooks.unavailable === "missing-permission"
          ? `<a class="kb-btn kb-btn--sm" href="${BOT_PERMISSIONS_PAGE}">Open Bot permissions</a>`
          : "",
      );
  const none = scan.channels.length === 0;
  const body =
    rows.length === 0
      ? `<div class="kb-panel__body"><div class="kb-empty"><p class="kb-empty__title">${none ? "No channels were found." : "No channels match this filter."}</p>${none ? "" : `<p class="kb-empty__text"><a href="${escapeHtml(scanHref("channels", sampled))}">Show all channels</a></p>`}</div></div>`
      : `<div class="kb-panel__body kb-panel__body--flush"><table class="kb-table"><caption class="kb-visually-hidden">Categories and channels</caption><thead><tr><th scope="col">Channel</th><th scope="col">What uses it</th><th scope="col">Permissions</th></tr></thead><tbody>${rows.map((r) => renderChannelRow(r, roleName)).join("")}</tbody></table></div>`;
  return `${webhookNote}
<section class="kb-panel" aria-labelledby="p-channels"><header class="kb-panel__head"><h2 class="kb-panel__title" id="p-channels">Categories and channels</h2><span class="kb-panel__meta">${rows.length}</span></header>
  <nav class="kb-tabs" aria-label="Filter channels">
  ${filters}
  </nav>
  ${body}</section>`;
}

// ---- Other bots -------------------------------------------------------------

function renderCoverage(c: ReportCapability): string {
  const cov = c.coverage;
  switch (cov.level) {
    case "full":
      return `${badge("Full", "on")}${cov.note ? `<div class="kb-muted">${escapeHtml(cov.note)}</div>` : ""}`;
    case "partial":
      return `${badge("Partial", "warn")}<div class="kb-muted">Missing: ${escapeHtml(cov.missing)}</div>`;
    case "planned":
      return `${badge("Planned", "info")} <a href="${ISSUES}/${cov.issue}">#${cov.issue}</a>`;
    case "keep":
      return `${badge("Keep", "info")}<div class="kb-muted">${escapeHtml(cov.reason)}</div>`;
    default:
      return `${badge("Not covered", "off")}<div class="kb-muted">KoolBot does not replace this.</div>`;
  }
}

function renderCapabilityRow(c: ReportCapability): string {
  const feature = c.featureLabel
    ? `${c.webPath ? `<a href="${escapeHtml(c.webPath)}">${escapeHtml(c.featureLabel)}</a>` : escapeHtml(c.featureLabel)}${c.enabledKey ? ` <code>${escapeHtml(c.enabledKey)}</code>` : ""}`
    : `<span class="kb-muted">—</span>`;
  const state =
    c.enabled === null
      ? `<span class="kb-muted">—</span>`
      : c.enabled
        ? badge("Enabled", "on")
        : badge("Off", "off");
  const steps = c.steps.length
    ? `<ol>${c.steps.map((st) => `<li>${escapeHtml(st)}</li>`).join("")}</ol>`
    : `<span class="kb-muted">—</span>`;
  return `<tr><th scope="row">${escapeHtml(c.label)}</th><td>${renderCoverage(c)}</td><td>${feature}</td><td>${state}</td><td>${steps}</td></tr>`;
}

function renderLeftovers(card: BotCard): string {
  const l = card.leftovers;
  const items: string[] = [];
  if (card.roleNames.length) {
    items.push(
      `Integration role ${card.roleNames.map((n) => roleMention(n)).join(", ")} ${badge("locked", "warn")}: Discord removes it with the bot.`,
    );
  }
  for (const c of l.ownedChannels) {
    items.push(
      `${namedChannelMention(c.name, c.typeName)} is mostly written by this bot.${c.usedBy.length ? ` ${escapeHtml(c.usedBy.join(", "))} already use it; bind it before removing the bot.` : ""}`,
    );
  }
  for (const c of l.memberOverwriteChannels) {
    items.push(
      `${namedChannelMention(c.name, c.typeName)} keeps a permission overwrite for the bot's member. Discord does not remove it.`,
    );
  }
  for (const b of l.boundFeatures) {
    items.push(
      `${namedChannelMention(b.channel, b.typeName)} is bound to ${escapeHtml(b.features.join(", "))}.`,
    );
  }
  return items.length
    ? `<h4>Left over when it is removed</h4><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`
    : `<h4>Left over when it is removed</h4><p class="kb-muted">Nothing found. This report never touches channels or overwrites.</p>`;
}

function renderBotCard(card: BotCard, scan: ServerScan): string {
  const chById = new Map(scan.channels.map((c) => [c.id, c]));
  const bot = scan.bots.find((b) => b.userId === card.userId);
  const overwrites = bot?.overwriteChannelIds.length
    ? bot.overwriteChannelIds
        .map((id) => {
          const ch = chById.get(id);
          return ch
            ? namedChannelMention(ch.name, ch.typeName)
            : missingMention(id);
        })
        .join(" ")
    : "—";
  const kindBadge =
    card.kind === "catalogued"
      ? ""
      : badge(card.kind === "custom" ? "custom" : "unknown", "warn");
  const body =
    card.kind === "catalogued"
      ? `<p class="kb-muted">${escapeHtml(card.description ?? "")}</p>
  <p class="kb-muted">Matched by Discord id. The capability list is maintained in this repository and may be out of date: check it against the bot before you rely on it.${card.verifiedAgainst ? ` Id checked against: ${escapeHtml(card.verifiedAgainst)}.` : ""}</p>
  ${card.verifiedAgainst ? "" : `<p>${badge("unverified entry", "warn")} <span class="kb-muted">Nobody has confirmed this id or capability list against a primary source yet.</span></p>`}
  ${renderCoverageBar(card)}
  ${disclosure(
    "What KoolBot can replace",
    plural(card.capabilities.length, "capability", "capabilities"),
    `<div class="kb-panel__body--flush"><table class="kb-table"><caption class="kb-visually-hidden">What KoolBot can replace for ${escapeHtml(card.name)}</caption><thead><tr><th scope="col">Capability</th><th scope="col">Coverage</th><th scope="col">KoolBot feature</th><th scope="col">State</th><th scope="col">Switch-over steps</th></tr></thead><tbody>${card.capabilities.map(renderCapabilityRow).join("")}</tbody></table></div>`,
  )}`
      : card.kind === "unknown"
        ? `<p class="kb-muted">Suggest a catalogue entry: see <a href="${CATALOG_DOCS}">CONTRIBUTING.md</a>.</p>`
        : "";
  return `<section class="kb-panel" aria-labelledby="bot-${escapeHtml(card.userId)}">
  <header class="kb-panel__head"><h3 class="kb-panel__title" id="bot-${escapeHtml(card.userId)}">${escapeHtml(card.name)} ${kindBadge}</h3></header>
  <div class="kb-panel__body kb-stack">
  <p><strong>${escapeHtml(card.summary)}</strong></p>
  <dl class="kb-kv"><dt>Integration role</dt><dd>${card.roleNames.map((n) => roleMention(n)).join(" ") || "—"}</dd><dt>Channels with overwrites</dt><dd>${overwrites}</dd></dl>
  ${body}
  ${disclosure("Left over when it is removed", "", renderLeftovers(card))}
  </div>
</section>`;
}

function shareList(
  items: Array<{ label: string; bots: string[] }>,
  empty: string,
): string {
  return items.length
    ? `<ul>${items.map((i) => `<li>${escapeHtml(i.label)} <span class="kb-muted">(${escapeHtml(i.bots.join(", "))})</span></li>`).join("")}</ul>`
    : `<p class="kb-muted">${empty}</p>`;
}

function renderCombined(report: BotReplacementReport): string {
  const c = report.combined;
  const detail = report.cards.some((b) => b.kind === "catalogued")
    ? `<h3>KoolBot can cover</h3>${shareList(c.covered, "Nothing yet.")}
  <h3>Provided by more than one bot</h3>${shareList(c.duplicated, "No overlap between bots.")}
  <h3>Not covered by KoolBot</h3>${shareList(c.uncovered, "Nothing.")}`
    : "";
  return `<section class="kb-panel" aria-labelledby="p-combined"><header class="kb-panel__head"><h2 class="kb-panel__title" id="p-combined">Combined view</h2></header><div class="kb-panel__body"><p>${escapeHtml(c.headline)}</p>${detail}</div></section>`;
}

function renderRemovedBots(scan: ServerScan, sampled: boolean): string {
  const q = sampled ? "&amp;sample=1" : "";
  // Only what the scan itself settles. An account it cannot tell from a current
  // member (a bare overwrite, a cached bot without a role) needs Discord to
  // confirm that it is a bot that has left, which the cleanup page does.
  const removed = findRemovedBotCandidates(scan).filter((c) => !c.needsCheck);
  const check = `<p class="kb-muted">Removed a bot already? <a href="${CLEANUP_PAGE}${sampled ? "?sample=1" : ""}">Check with Discord for leftovers</a>.</p>`;
  if (removed.length === 0) return check;
  const items = removed
    .map(
      (c) =>
        `<li><span class="kb-list__main"><strong>${escapeHtml(c.name)}</strong><span class="kb-muted">${escapeHtml(c.reason)} ${plural(c.overwriteChannels.length, "overwrite", "overwrites")} left.</span></span><a class="kb-btn kb-btn--sm" href="${CLEANUP_PAGE}?bot=${encodeURIComponent(c.userId)}${q}">Plan cleanup<span class="kb-visually-hidden"> for ${escapeHtml(c.name)}</span></a></li>`,
    )
    .join("");
  return `${panel(
    "Removed bots with leftovers",
    String(removed.length),
    `<p class="kb-muted">You removed these bots in Discord; KoolBot never does. A cleanup plan removes the permission overwrites they left behind. It is previewed, snapshotted and can be rolled back.</p><ul class="kb-list">${items}</ul>`,
    { id: "p-removed-bots" },
  )}${check}`;
}

function renderBots(scan: ServerScan, sampled: boolean): string {
  const report = buildBotReplacementReport(scan, scan.scanned?.config ?? {});
  const warn = report.warnings.map((w) => callout("warn", w)).join("");
  const removed = renderRemovedBots(scan, sampled);
  if (report.cards.length === 0) {
    return `${warn}${removed}<div class="kb-empty"><p class="kb-empty__title">No other bots found.</p><p class="kb-empty__text">Bots that join this server show up here with what KoolBot can replace.</p></div>`;
  }
  return `<p class="kb-muted">Removing a bot stays manual in Discord, and this report changes nothing on your server. Data from other bots cannot be imported.</p>
${warn}
${renderCombined(report)}
${report.cards.map((c) => renderBotCard(c, scan)).join("\n")}
${removed}`;
}

// ---- Discord ----------------------------------------------------------------

function renderDiscord(scan: ServerScan): string {
  const c = scan.community;
  const nameOf = (id: string | null): string => {
    if (!id) return "—";
    const ch = scan.channels.find((x) => x.id === id);
    return ch ? namedChannelMention(ch.name, ch.typeName) : missingMention(id);
  };
  const onboarding =
    c.onboardingEnabled === null
      ? "unknown"
      : c.onboardingEnabled
        ? "enabled"
        : "disabled";
  const roleName = new Map(scan.roles.map((r) => [r.id, r.name]));
  const prompts = c.onboardingPrompts
    .map(
      (p) =>
        `<li>${escapeHtml(p.title)}: <span class="kb-muted">${escapeHtml(p.roleIds.map((id) => roleLabel(roleName, id)).join(", ") || "no roles")}</span></li>`,
    )
    .join("");
  const n = scan.naming;
  const native = c.community
    ? `<p>Community is on. Rules: ${nameOf(c.rulesChannelId)}, system: ${nameOf(c.systemChannelId)}, public updates: ${nameOf(c.publicUpdatesChannelId)}. Onboarding is ${onboarding}.</p>${prompts ? `<ul>${prompts}</ul>` : ""}`
    : `<p class="kb-muted">Community features are off.</p>`;
  const naming = `<p>${
    n.pattern
      ? `Pattern: <strong>${escapeHtml(n.pattern)}</strong> (${Math.round(n.confidence * 100)}% of channels)${n.separator ? `, separator <code>${escapeHtml(n.separator)}</code>` : ""}.`
      : "Not enough channels to tell."
  }${n.categoryEmojiPrefix ? " Categories start with an emoji." : ""}${n.suggestedPrefix ? ` Suggested voice prefix: <code>${escapeHtml(n.suggestedPrefix)}</code>.` : ""}</p>`;
  const events =
    scan.scheduledEvents.length === 0
      ? `<p class="kb-muted">No native scheduled events.</p>`
      : `<ul>${scan.scheduledEvents.map((e) => `<li>${escapeHtml(e.name)} <span class="kb-muted">${escapeHtml(e.startsAt ?? "")}</span></li>`).join("")}</ul>
  <p><a href="/admin/adopt/events">Adopt these as KoolBot events</a> <span class="kb-muted">(preview first; the Discord events are not changed)</span></p>`;
  return `${panel("Handled by Discord", "", native, { id: "p-discord" })}
${panel("Naming convention", "", naming, { id: "p-naming" })}
${panel("Scheduled events", String(scan.scheduledEvents.length), events, { id: "p-events" })}`;
}

// ---- Page -------------------------------------------------------------------

/** On every tab: an empty list there may be a failed read, not an absence. */
function renderPartial(scan: ServerScan): string {
  return scan.partial.length
    ? callout(
        "warn",
        "Some parts could not be read.",
        `Not read: ${escapeHtml(scan.partial.join(", "))}. Lists that depend on them may be incomplete, and an empty list here does not mean there is nothing.`,
      )
    : "";
}

function renderTab(
  scan: ServerScan,
  tab: ScanTab,
  sampled: boolean,
  filter: ChannelFilter,
): string {
  switch (tab) {
    case "roles":
      return renderRoles(scan);
    case "channels":
      return renderChannels(scan, filter, sampled);
    case "bots":
      return renderBots(scan, sampled);
    case "discord":
      return renderDiscord(scan);
    default:
      return renderOverview(scan, sampled);
  }
}

export function renderAdoptPage(props: AdoptPageProps): string {
  const { scan } = props;
  const content = scan
    ? `${renderTabs(scan, props)}
<div class="kb-stack" id="scan-${props.tab}">
${renderPartial(scan)}
${renderTab(scan, props.tab, props.sampled, props.filter ?? "all")}
</div>`
    : callout(
        "err",
        `The scan failed: ${props.error ?? "unknown error"}.`,
        "Check that the bot is in the server, then reload.",
      );
  const body = `<div class="kb-stack">
${renderHeader(scan, props)}
${content}
</div>`;
  return renderAdminPage({
    title: "Server scan",
    active: "/admin/adopt",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
