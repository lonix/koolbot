/**
 * The Dashboard (#1322, `docs/design/pages.md` DashboardPage): state first, then
 * what needs the admin, and every card links to the page where they act.
 *
 *   1. Four StatTiles: Version, Discord, Database, Permissions.
 *   2. Left: *Needs you* (hidden when there is nothing) and *This week in voice*.
 *   3. Right: Features with On/Off, the server facts and the Version panel.
 *
 * Read-only: no switch here. The only form is the Version panel's *Check now*,
 * which reads public release data and changes no setting. Every source can be
 * `unavailable` (see `dashboard-data.ts`) and says so in its own card; a value
 * that could not be read is never drawn as 0. Every dynamic value is escaped.
 *
 * Icons: only the alert icon is used, from the shared helper (`icons.ts`).
 */

import { icon } from "./icons.js";
import { escapeHtml } from "./html.js";
import { DAY_NAMES } from "../services/rewind-service.js";
import { formatVersion } from "../utils/semver.js";
import type { VersionCheckSnapshot } from "../services/version-check-service.js";
import {
  BOT_PERMISSIONS_HREF,
  NEEDS_YOU_LIMIT,
  SERVER_SCAN_HREF,
  type DashboardData,
  type NeedsYouRow,
} from "./dashboard-data.js";

const CHANGELOG_URL = "https://github.com/lonix/koolbot/blob/main/CHANGELOG.md";
const ANALYTICS_HREF = "/admin/analytics";
const DATABASE_HREF = "/admin/database";

export interface DashboardViewProps {
  data: DashboardData;
  /** Update-check result (#1029). Omitted: the Version tile and panel say nothing is known. */
  version?: VersionCheckSnapshot;
  csrfToken: string;
  /** Already rendered by the caller (`renderFlash`). */
  flashHtml: string;
}

/** "2 issues", "1 issue". */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatUtc(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "3 hr 12 min", the way Voice analytics writes it. */
function minutesText(minutes: number): string {
  if (minutes <= 0) return "0 min";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

function badge(text: string, kind: "on" | "off" | "info" | "warn"): string {
  return `<span class="kb-badge kb-badge--${kind}">${escapeHtml(text)}</span>`;
}

// ---- Version ---------------------------------------------------------------

/** The status as a badge: the words the Version panel has always used. */
function versionBadge(v: VersionCheckSnapshot): string {
  switch (v.status) {
    case "disabled":
      return badge("check off", "off");
    case "unchecked":
      return badge("not checked yet", "info");
    case "error":
      return badge("couldn't check", "off");
    case "unknown-running":
      return badge("running version unknown", "warn");
    case "up-to-date":
      return badge("up to date", "on");
    case "ahead":
      return badge("newer than latest release", "info");
    case "update-available":
      return badge("update available", "warn");
  }
}

/**
 * The Version panel (#1029): running vs latest release, the update state, a
 * *Check now* button and, when behind, how to update. A failed check is a state
 * of the panel ("couldn't check", with the last good result), never an error
 * page. `id="version"` is the target of the top bar's update pill.
 */
export function renderVersionCard(
  v: VersionCheckSnapshot,
  csrfToken: string,
): string {
  const running = formatVersion(v.running);
  const head = `<header class="kb-panel__head"><h2 class="kb-panel__title" id="version-title">Version</h2><span class="kb-panel__actions">${versionBadge(v)}</span></header>`;

  if (!v.enabled) {
    return `<section class="kb-panel" id="version" aria-labelledby="version-title">${head}
  <div class="kb-panel__body">
    <dl class="kb-kv"><dt>Running</dt><dd class="kb-mono">${escapeHtml(running)}</dd></dl>
    <p class="kb-muted">The update check is off (<span class="kb-mono">core.updatecheck.enabled</span>), so only the running version is shown. Turn it on in <a href="/admin/settings#section-core">All settings</a>.</p>
  </div>
</section>`;
  }

  const latest = v.latest;
  const kind = v.updateKind
    ? ` ${badge(v.updateKind, v.updateKind === "major" ? "off" : "info")}`
    : "";
  const latestHtml = latest
    ? `<span class="kb-mono">${escapeHtml(latest.version)}</span>${kind}` +
      (latest.publishedAt
        ? ` <span class="kb-muted">released ${escapeHtml(formatUtc(latest.publishedAt))}</span>`
        : "")
    : `<span class="kb-muted">—</span>`;

  const errorNotice =
    v.status === "error"
      ? `<div class="kb-callout kb-callout--warn" role="alert"><div class="kb-callout__body"><p class="kb-callout__title">Couldn't check for updates: ${escapeHtml(v.lastError ?? "unknown error")}</p>${
          latest
            ? `<p class="kb-callout__text">Showing the last successful result, fetched ${escapeHtml(formatUtc(latest.fetchedAt))}.</p>`
            : ""
        }</div></div>`
      : "";

  const majorNotice =
    v.updateKind === "major"
      ? `<div class="kb-callout kb-callout--warn" role="status"><div class="kb-callout__body"><p class="kb-callout__title">This is a <strong>major</strong> update and may include breaking changes.</p><p class="kb-callout__text">Read the release notes before updating.</p></div></div>`
      : "";

  const links = latest
    ? `<p><a href="${escapeHtml(latest.url)}" rel="noopener noreferrer" target="_blank">Release notes for ${escapeHtml(latest.version)}</a> · <a href="${CHANGELOG_URL}" rel="noopener noreferrer" target="_blank">CHANGELOG</a></p>`
    : "";

  const instructions = v.updateKind
    ? `<details class="kb-disclosure"><summary>${icon("chevron-right", { className: "kb-chev" })}How to update</summary><div class="kb-disclosure__body">
    <p>Docker Compose (the published image):</p>
    <pre class="kb-mono">docker compose pull &amp;&amp; docker compose up -d</pre>
    <p>Plain Docker: <span class="kb-mono">docker pull ghcr.io/lonix/koolbot:latest</span>, then recreate the container.</p>
    <p>From source:</p>
    <pre class="kb-mono">git pull &amp;&amp; npm ci &amp;&amp; npm run build &amp;&amp; npm start</pre>
    <p class="kb-muted">See <a href="https://github.com/lonix/koolbot#-docker-management" rel="noopener noreferrer" target="_blank">Docker Management</a> in the README for details.</p>
  </div></details>`
    : "";

  return `<section class="kb-panel" id="version" aria-labelledby="version-title">${head}
  <div class="kb-panel__body kb-stack">
    ${errorNotice}${majorNotice}
    <dl class="kb-kv">
      <dt>Running</dt><dd class="kb-mono">${escapeHtml(running)}</dd>
      <dt>Latest release</dt><dd>${latestHtml}</dd>
      <dt>Last checked</dt><dd>${escapeHtml(formatUtc(latest?.fetchedAt ?? null))}</dd>
    </dl>
    ${links}${instructions}
    <form method="POST" action="/admin/version/check">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <button type="submit" class="kb-btn kb-btn--sm">Check now</button>
    </form>
  </div>
  <footer class="kb-panel__foot">Anonymous request for public release data; nothing about this instance is sent.</footer>
</section>`;
}

// ---- tiles -----------------------------------------------------------------

function tile(opts: {
  label: string;
  href: string;
  value: string;
  detail: string;
  /** A badge or status after the label. */
  top?: string;
  warn?: boolean;
}): string {
  const cls = `kb-tile${opts.warn ? " kb-tile--warn" : ""}`;
  return `<a class="${cls}" href="${escapeHtml(opts.href)}">
  <div class="kb-tile__top"><span class="kb-overline">${escapeHtml(opts.label)}</span>${opts.top ?? ""}${opts.warn ? icon("triangle-alert") : ""}</div>
  <div class="kb-tile__value">${opts.value}</div>
  <div class="kb-tile__detail">${escapeHtml(opts.detail)}</div>
</a>`;
}

function versionTile(v: VersionCheckSnapshot | undefined): string {
  if (!v) {
    return tile({
      label: "Version",
      href: "#version",
      value: "—",
      detail: "The running version could not be read.",
    });
  }
  const detail = !v.enabled
    ? "The update check is off."
    : v.latest
      ? `Latest release ${v.latest.version}`
      : v.status === "error"
        ? "The last check failed."
        : "No release read yet.";
  return tile({
    label: "Version",
    href: "#version",
    top: versionBadge(v),
    value: `<span class="kb-mono">${escapeHtml(formatVersion(v.running))}</span>`,
    detail,
  });
}

function discordTile(data: DashboardData): string {
  if (data.guild.state !== "ok") {
    return tile({
      label: "Discord",
      href: SERVER_SCAN_HREF,
      top: `<span class="kb-status kb-status--warn">Unavailable</span>`,
      value: "—",
      detail: "The server could not be read from Discord.",
    });
  }
  const g = data.guild.value;
  const members = g.memberCount === null ? "—" : String(g.memberCount);
  return tile({
    label: "Discord",
    href: SERVER_SCAN_HREF,
    top: g.connected
      ? `<span class="kb-status kb-status--ok">Connected</span>`
      : `<span class="kb-status kb-status--off">Not connected</span>`,
    value: `${escapeHtml(members)} <small>members</small>`,
    detail:
      g.voiceUsers === null
        ? "Who is in voice could not be read."
        : `${g.voiceUsers} in voice now`,
  });
}

function databaseTile(data: DashboardData): string {
  const connected = data.mongoState === "connected";
  let detail: string;
  if (data.counts.state !== "ok") {
    detail = connected
      ? "The counts could not be read."
      : "The counts are unavailable while the database is not connected.";
  } else {
    const c = data.counts.value;
    const part = (n: number | null, one: string, many?: string): string =>
      n === null ? `${one}s unavailable` : plural(n, one, many);
    detail = [
      part(c.notices, "notice"),
      part(c.pollItems, "poll question"),
      part(c.reactionRoles, "reaction role"),
      part(c.announcements, "scheduled announcement"),
    ].join(" · ");
  }
  const word =
    data.mongoState.charAt(0).toUpperCase() + data.mongoState.slice(1);
  return tile({
    label: "Database",
    href: DATABASE_HREF,
    warn: !connected,
    top: connected ? undefined : badge("Needs attention", "warn"),
    value: escapeHtml(word),
    detail,
  });
}

function permissionsTile(data: DashboardData): string {
  if (data.permissions.state !== "ok") {
    return tile({
      label: "Permissions",
      href: BOT_PERMISSIONS_HREF,
      top: `<span class="kb-status kb-status--warn">Not checked</span>`,
      value: "—",
      detail: "The bot's permissions could not be checked just now.",
    });
  }
  const { problems, unchecked } = data.permissions.value;
  const tail =
    unchecked > 0
      ? `${plural(unchecked, "switched-on feature")} could not be fully checked.`
      : "";
  // Nothing missing is only "in place" when everything was looked at.
  const detail =
    problems > 0
      ? `Permissions that switched-on features need are missing. ${tail}`
      : unchecked > 0
        ? `No missing permission found in what could be checked. ${tail}`
        : "Everything the switched-on features need is in place.";
  return tile({
    label: "Permissions",
    href: BOT_PERMISSIONS_HREF,
    warn: problems > 0,
    top:
      problems > 0
        ? badge("Needs fixing", "warn")
        : unchecked > 0
          ? badge("Partly checked", "info")
          : undefined,
    value: `${problems} <small>${problems === 1 ? "issue" : "issues"}</small>`,
    detail: detail.trim(),
  });
}

// ---- panels ----------------------------------------------------------------

function panel(
  id: string,
  title: string,
  meta: string,
  body: string,
  opts: { flush?: boolean; foot?: string } = {},
): string {
  return `<section class="kb-panel" aria-labelledby="${id}">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}">${escapeHtml(title)}</h2>${meta}</header>
  <div class="kb-panel__body${opts.flush ? " kb-panel__body--flush" : ""}">${body}</div>${opts.foot ? `<footer class="kb-panel__foot">${opts.foot}</footer>` : ""}
</section>`;
}

const SEVERITY_BADGE: Record<NeedsYouRow["severity"], string> = {
  blocker: badge("Blocker", "off"),
  warning: badge("Warning", "warn"),
  missing: badge("Missing", "warn"),
};

function needsYouRow(r: NeedsYouRow): string {
  return `<li>${icon("triangle-alert")}<span class="kb-list__main"><span>${escapeHtml(r.title)}</span><span class="kb-muted">${escapeHtml(r.detail)}</span></span>${SEVERITY_BADGE[r.severity]}<a class="kb-btn kb-btn--sm" href="${escapeHtml(r.href)}">${escapeHtml(r.action)}</a></li>`;
}

/** Hidden (empty string) when nothing needs the admin. */
function renderNeedsYou(data: DashboardData): string {
  if (data.needsYou.length === 0) return "";
  const shown = data.needsYou.slice(0, NEEDS_YOU_LIMIT);
  const more = data.needsYou.length - shown.length;
  const rows = shown.map(needsYouRow).join("");
  const rest =
    more > 0
      ? `<li><span class="kb-list__main kb-muted">${plural(more, "more problem")} not listed here.</span><a class="kb-btn kb-btn--sm" href="${BOT_PERMISSIONS_HREF}">Open Bot permissions</a></li>`
      : "";
  const foot = data.scanReadAt
    ? `Server scan rows come from the scan read ${escapeHtml(data.scanReadAt.slice(0, 16).replace("T", " "))} UTC. <a href="${SERVER_SCAN_HREF}?refresh=1">Scan again</a>`
    : "";
  return panel(
    "p-needs",
    "Needs you",
    `<span class="kb-panel__actions">${badge(String(data.needsYou.length), "warn")}</span>`,
    `<ul class="kb-list">${rows}${rest}</ul>`,
    { flush: true, foot },
  );
}

function renderVoiceWeek(data: DashboardData): string | null {
  if (data.voice === null) return null; // voice tracking is off: nothing to show
  const link = `<span class="kb-panel__actions"><a class="kb-btn kb-btn--sm" href="${ANALYTICS_HREF}">Open Voice analytics</a></span>`;
  if (data.voice.state !== "ok") {
    return panel(
      "p-voice",
      "This week in voice",
      link,
      `<p class="kb-muted">Voice activity could not be read just now.</p>`,
    );
  }
  const v = data.voice.value;
  if (v.totalMinutes <= 0) {
    return panel(
      "p-voice",
      "This week in voice",
      link,
      `<p class="kb-muted">No voice activity in the last 7 days. It shows up here as people spend time in voice channels.</p>`,
    );
  }
  const max = v.byDay.reduce((m, n) => (n > m ? n : m), 0);
  const peak = v.byDay.indexOf(max);
  const rows = v.byDay
    .map((n, d) => {
      const pct = max > 0 ? (n / max) * 100 : 0;
      return `<div class="kb-bars__row${d === peak ? " is-peak" : ""}"><span>${escapeHtml(DAY_NAMES[d].slice(0, 3))}</span><span class="kb-bars__track"><span class="kb-bars__fill" style="width:${pct.toFixed(1)}%"></span></span><span class="kb-bars__val">${escapeHtml(minutesText(n))}</span></div>`;
    })
    .join("");
  return panel(
    "p-voice",
    "This week in voice",
    `<span class="kb-panel__meta">Last 7 days · ${escapeHtml(v.timeZone)}</span>${link}`,
    `<div class="kb-bars">${rows}</div>`,
    {
      foot: `Busiest day: ${escapeHtml(DAY_NAMES[peak])}, ${escapeHtml(minutesText(max))}. ${escapeHtml(minutesText(v.totalMinutes))} in total.`,
    },
  );
}

function renderFeatures(data: DashboardData): string {
  const on = data.features.filter((f) => f.on).length;
  const rows = data.features
    .map(
      (f) =>
        `<li${f.on ? "" : ` class="is-off"`}><span class="kb-list__main"><a class="kb-list__link" href="${escapeHtml(f.href)}">${escapeHtml(f.label)}</a><span class="kb-list__sub">${escapeHtml(f.key)}</span></span>${f.on ? badge("On", "on") : badge("Off", "off")}</li>`,
    )
    .join("");
  return panel(
    "p-features",
    "Features",
    `<span class="kb-panel__meta">${on} on · ${data.features.length - on} off</span>`,
    `<ul class="kb-list">${rows}</ul>`,
    {
      flush: true,
      foot: "A feature is switched on or off on its own page.",
    },
  );
}

function renderFacts(data: DashboardData): string {
  const g = data.guild.state === "ok" ? data.guild.value : null;
  const server = g
    ? `${escapeHtml(g.name ?? "(unknown)")} <span class="kb-mono kb-muted">${escapeHtml(g.id)}</span>`
    : `<span class="kb-muted">Unavailable</span>`;
  const bot = g
    ? escapeHtml(g.botTag ?? "(not ready)")
    : `<span class="kb-muted">Unavailable</span>`;
  return panel(
    "p-facts",
    "Server facts",
    "",
    `<dl class="kb-kv"><dt>Server</dt><dd>${server}</dd><dt>Bot user</dt><dd>${bot}</dd></dl>`,
  );
}

// ---- page ------------------------------------------------------------------

export function renderDashboardBody(props: DashboardViewProps): string {
  const { data } = props;
  const left = [renderNeedsYou(data), renderVoiceWeek(data) ?? ""]
    .filter(Boolean)
    .join("\n");
  const right = [
    renderFeatures(data),
    renderFacts(data),
    props.version ? renderVersionCard(props.version, props.csrfToken) : "",
  ]
    .filter(Boolean)
    .join("\n");
  // With nothing to show on the left (no problems, voice tracking off) the
  // right column would sit beside an empty one, so it takes the full width.
  const columns = left
    ? `<div class="kb-cols">
  <div class="kb-stack">${left}</div>
  <div class="kb-stack">${right}</div>
</div>`
    : `<div class="kb-stack">${right}</div>`;
  return `<div class="kb-stack">
<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">Dashboard</h1>
    <p class="kb-pagehead__sub">Where KoolBot stands today. Each card opens the page where you act; nothing here changes a setting.</p>
  </div>
</header>
${props.flashHtml}
<div class="kb-tiles">
${versionTile(props.version)}
${discordTile(data)}
${databaseTile(data)}
${permissionsTile(data)}
</div>
${columns}
</div>`;
}
