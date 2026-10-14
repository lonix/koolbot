import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import type {
  ChannelFlags,
  ScanChannel,
  ScanSeverity,
  ServerScan,
} from "../services/server-scan-service.js";
import { GUILD_MEMBERS_INTENT_HOWTO } from "../utils/guild-members-intent.js";
import {
  buildBotReplacementReport,
  type BotCard,
  type ReportCapability,
} from "../services/bot-replacement-report.js";

/**
 * Read-only "Server scan" page (#1019). Renders a `ServerScan` — roles,
 * categories and channels with their overwrites, other bots, community
 * features and the bot's readiness. The page has no forms and no write
 * routes; every dynamic value is escaped.
 */

const DOCS =
  "https://github.com/lonix/koolbot/blob/main/TROUBLESHOOTING.md#bot-cant-manage-roles-or-channels";

export interface AdoptPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus: NavFeatureStatus;
  /** Null when the scan failed outright. */
  scan: ServerScan | null;
  error?: string;
  sampled: boolean;
}

const SEVERITY_CLASS: Record<ScanSeverity, string> = {
  error: "err",
  warning: "warn",
  info: "info",
};
const SEVERITY_LABEL: Record<ScanSeverity, string> = {
  error: "Blocker",
  warning: "Warning",
  info: "Note",
};

function tags(items: string[], cls = "tag-on"): string {
  return items
    .map((i) => `<span class="tag ${cls}">${escapeHtml(i)}</span>`)
    .join(" ");
}

function colorSwatch(color: number): string {
  if (!color) return `<span class="muted">default</span>`;
  const hex = `#${color.toString(16).padStart(6, "0")}`;
  return `<span class="mono">${escapeHtml(hex)}</span>`;
}

function renderReadiness(scan: ServerScan): string {
  const r = scan.readiness;
  const perms = r.permissions
    .map(
      (p) =>
        `<tr><td class="mono">${escapeHtml(p.name)}</td><td>${
          p.granted
            ? `<span class="tag tag-on">granted</span>`
            : `<span class="tag ${p.required ? "tag-off" : "tag-warn"}">missing</span>`
        }</td><td>${p.required ? "required" : "optional"}</td><td>${escapeHtml(p.purpose)}</td></tr>`,
    )
    .join("");
  const issues = r.issues
    .map(
      (i) =>
        `<div class="notice ${SEVERITY_CLASS[i.severity]}"><strong>${SEVERITY_LABEL[i.severity]}:</strong> ${escapeHtml(i.message)} <a href="${DOCS}" rel="noopener noreferrer">How to fix</a></div>`,
    )
    .join("");
  const verdict = r.ready
    ? `<div class="notice ok">KoolBot has what it needs to manage this server.</div>`
    : `<div class="notice err">KoolBot is not ready to manage this server yet. Fix the blockers below.</div>`;
  return `
<div class="card">
  <h2>Bot readiness</h2>
  ${verdict}
  ${issues}
  <p>Highest KoolBot role: <strong>${escapeHtml(r.highestRoleName ?? "none")}</strong> (position ${r.highestRolePosition} of ${r.roleCount}).${r.administrator ? " The bot has Administrator." : ""}</p>
  <table><caption class="visually-hidden">Bot guild permissions</caption><thead><tr><th scope="col">Permission</th><th scope="col">Status</th><th scope="col">Need</th><th scope="col">Used for</th></tr></thead><tbody>${perms}</tbody></table>
</div>`;
}

function renderRoles(scan: ServerScan): string {
  const rows = scan.roles
    .map((r) => {
      const flags: string[] = [];
      if (r.managed) flags.push("managed");
      if (r.isEveryone) flags.push("@everyone");
      if (r.onboardingManaged) flags.push("Onboarding-managed");
      const manage = r.isEveryone
        ? `<span class="muted">n/a</span>`
        : r.botCanManage
          ? `<span class="tag tag-on">yes</span>`
          : `<span class="tag tag-warn">no</span>`;
      const count = `${r.memberCount}${r.memberCountApproximate ? "+" : ""}`;
      return `<tr><td>${escapeHtml(r.name)}</td><td>${r.position}</td><td>${colorSwatch(r.color)}</td><td>${escapeHtml(count)}</td><td>${tags(flags, "tag-warn")}</td><td>${manage}</td><td>${tags(r.usedBy)}</td></tr>`;
    })
    .join("");
  return `
<div class="card">
  <h2>Roles (${scan.roles.length})</h2>
  <p class="muted">Member counts come from the cache and may be low (marked <code>+</code>)${
    scan.readiness.membersIntent
      ? "."
      : ` unless the bot requests the GuildMembers intent. ${escapeHtml(GUILD_MEMBERS_INTENT_HOWTO)}`
  }</p>
  <table><caption class="visually-hidden">Roles</caption><thead><tr><th scope="col">Role</th><th scope="col">Position</th><th scope="col">Colour</th><th scope="col">Members</th><th scope="col">Flags</th><th scope="col">KoolBot can manage</th><th scope="col">Used by</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
}

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
  if (c.overwrites.length === 0) return `<span class="muted">none</span>`;
  return c.overwrites
    .map(
      (o) =>
        `<div><strong>${escapeHtml(o.label)}</strong> <span class="muted">(${o.type})</span>${
          o.allow.length
            ? ` <span class="tag tag-on">allow</span> ${escapeHtml(o.allow.join(", "))}`
            : ""
        }${
          o.deny.length
            ? ` <span class="tag tag-off">deny</span> ${escapeHtml(o.deny.join(", "))}`
            : ""
        }</div>`,
    )
    .join("");
}

function renderChannels(scan: ServerScan): string {
  const roleName = new Map(scan.roles.map((r) => [r.id, r.name]));
  const rows = scan.channels
    .map((c) => {
      const sync =
        c.syncedToParent === null
          ? `<span class="muted">—</span>`
          : c.syncedToParent
            ? "synced"
            : `<span class="tag tag-warn">custom</span>`;
      const notes: string[] = [];
      if (c.featureGuess && c.usedBy.length === 0)
        notes.push(`looks like: ${c.featureGuess}`);
      if (c.gatedByRoleIds.length)
        notes.push(
          `gated by: ${c.gatedByRoleIds.map((id) => roleName.get(id) ?? id).join(", ")}`,
        );
      if (c.ownerHint)
        notes.push(
          `mostly posted by ${c.ownerHint.botTag} (${Math.round(c.ownerHint.share * 100)}%)`,
        );
      return `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.typeName)}</td><td>${escapeHtml(c.parentName ?? "—")}</td><td>${sync}</td><td>${renderOverwrites(c)}</td><td>${tags(c.usedBy)} ${tags(flagTags(c.flags), "tag-warn")}${notes.length ? `<div class="muted">${escapeHtml(notes.join("; "))}</div>` : ""}</td></tr>`;
    })
    .join("");
  return `
<div class="card">
  <h2>Categories and channels (${scan.channels.length})</h2>
  <table><caption class="visually-hidden">Categories and channels</caption><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Parent</th><th scope="col">Permissions</th><th scope="col">Overwrites</th><th scope="col">Used by / notes</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
}

function renderBots(scan: ServerScan): string {
  const chName = new Map(scan.channels.map((c) => [c.id, c.name]));
  const roleName = new Map(scan.roles.map((r) => [r.id, r.name]));
  const others = scan.bots.filter((b) => !b.isKoolBot);
  const rows = others
    .map(
      (b) =>
        `<tr><td>${escapeHtml(b.tag ?? b.userId)}</td><td>${escapeHtml(b.roleIds.map((id) => roleName.get(id) ?? id).join(", ") || "—")}</td><td>${escapeHtml(b.overwriteChannelIds.map((id) => chName.get(id) ?? id).join(", ") || "—")}</td></tr>`,
    )
    .join("");
  return `
<div class="card">
  <h2>Other bots (${others.length})</h2>
  ${
    others.length === 0
      ? `<p class="muted">No other bots found.</p>`
      : `<table><caption class="visually-hidden">Other bots</caption><thead><tr><th scope="col">Bot</th><th scope="col">Integration role</th><th scope="col">Channels with overwrites</th></tr></thead><tbody>${rows}</tbody></table>`
  }
</div>`;
}

const CATALOG_DOCS =
  "https://github.com/lonix/koolbot/blob/main/CONTRIBUTING.md#adding-a-known-bot-entry";
const ISSUES = "https://github.com/lonix/koolbot/issues";

function renderCoverage(c: ReportCapability): string {
  const cov = c.coverage;
  switch (cov.level) {
    case "full":
      return `<span class="tag tag-on">Full</span>${cov.note ? `<div class="muted">${escapeHtml(cov.note)}</div>` : ""}`;
    case "partial":
      return `<span class="tag tag-warn">Partial</span><div class="muted">Missing: ${escapeHtml(cov.missing)}</div>`;
    case "planned":
      return `<span class="tag tag-info">Planned</span> <a href="${ISSUES}/${cov.issue}">#${cov.issue}</a>`;
    case "keep":
      return `<span class="tag tag-info">Keep</span><div class="muted">${escapeHtml(cov.reason)}</div>`;
    default:
      return `<span class="tag tag-off">Not covered</span><div class="muted">KoolBot does not replace this.</div>`;
  }
}

function renderCapabilityRow(c: ReportCapability): string {
  const feature = c.featureLabel
    ? `${c.webPath ? `<a href="${escapeHtml(c.webPath)}">${escapeHtml(c.featureLabel)}</a>` : escapeHtml(c.featureLabel)}${c.enabledKey ? ` <code>${escapeHtml(c.enabledKey)}</code>` : ""}`
    : `<span class="muted">—</span>`;
  const state =
    c.enabled === null
      ? `<span class="muted">—</span>`
      : c.enabled
        ? `<span class="tag tag-on">Enabled</span>`
        : `<span class="tag tag-off">Off</span>`;
  const steps = c.steps.length
    ? `<ol>${c.steps.map((st) => `<li>${escapeHtml(st)}</li>`).join("")}</ol>`
    : `<span class="muted">—</span>`;
  return `<tr><td>${escapeHtml(c.label)}</td><td>${renderCoverage(c)}</td><td>${feature}</td><td>${state}</td><td>${steps}</td></tr>`;
}

function renderLeftovers(card: BotCard): string {
  const l = card.leftovers;
  const items: string[] = [];
  if (card.roleNames.length) {
    items.push(
      `Integration role ${card.roleNames.map((n) => `<strong>${escapeHtml(n)}</strong>`).join(", ")} <span class="tag tag-warn">locked</span>: Discord removes it with the bot.`,
    );
  }
  for (const c of l.ownedChannels) {
    items.push(
      `<strong>${escapeHtml(c.name)}</strong> is mostly written by this bot.${c.usedBy.length ? ` ${escapeHtml(c.usedBy.join(", "))} already use it; bind it before removing the bot.` : ""}`,
    );
  }
  for (const c of l.memberOverwriteChannels) {
    items.push(
      `<strong>${escapeHtml(c.name)}</strong> keeps a permission overwrite for the bot's member. Discord does not remove it.`,
    );
  }
  for (const b of l.boundFeatures) {
    items.push(
      `<strong>${escapeHtml(b.channel)}</strong> is bound to ${escapeHtml(b.features.join(", "))}.`,
    );
  }
  return items.length
    ? `<h4>Left over when it is removed</h4><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`
    : `<h4>Left over when it is removed</h4><p class="muted">Nothing found. This report never touches channels or overwrites.</p>`;
}

function renderBotCard(card: BotCard): string {
  const kindTag =
    card.kind === "catalogued"
      ? ""
      : ` <span class="tag tag-warn">${card.kind === "custom" ? "custom" : "unknown"}</span>`;
  const body =
    card.kind === "catalogued"
      ? `<p class="muted">${escapeHtml(card.description ?? "")}</p>
  <p class="muted">Matched by Discord id. The capability list is maintained in this repository and may be out of date: check it against the bot before you rely on it.${card.verifiedAgainst ? ` Id checked against: ${escapeHtml(card.verifiedAgainst)}.` : ""}</p>
  ${card.verifiedAgainst ? "" : `<p><span class="tag tag-warn">unverified entry</span> <span class="muted">Nobody has confirmed this id or capability list against a primary source yet.</span></p>`}
  <table><caption class="visually-hidden">What KoolBot can replace for ${escapeHtml(card.name)}</caption><thead><tr><th scope="col">Capability</th><th scope="col">Coverage</th><th scope="col">KoolBot feature</th><th scope="col">State</th><th scope="col">Switch-over steps</th></tr></thead><tbody>${card.capabilities.map(renderCapabilityRow).join("")}</tbody></table>`
      : card.kind === "unknown"
        ? `<p class="muted">Suggest a catalogue entry: see <a href="${CATALOG_DOCS}">CONTRIBUTING.md</a>.</p>`
        : "";
  return `
  <h3>${escapeHtml(card.name)}${kindTag}</h3>
  <p><strong>${escapeHtml(card.summary)}</strong></p>
  ${body}
  ${renderLeftovers(card)}`;
}

function shareList(
  items: Array<{ label: string; bots: string[] }>,
  empty: string,
): string {
  return items.length
    ? `<ul>${items.map((i) => `<li>${escapeHtml(i.label)} <span class="muted">(${escapeHtml(i.bots.join(", "))})</span></li>`).join("")}</ul>`
    : `<p class="muted">${empty}</p>`;
}

function renderBotReport(scan: ServerScan): string {
  const report = buildBotReplacementReport(scan, scan.scanned?.config ?? {});
  const warnings = report.warnings
    .map((w) => `<div class="notice warn">${escapeHtml(w)}</div>`)
    .join("");
  const c = report.combined;
  const summary = `
  <h3>Combined view</h3>
  <p>${escapeHtml(c.headline)}</p>
  ${
    report.cards.some((b) => b.kind === "catalogued")
      ? `<h4>KoolBot can cover</h4>${shareList(c.covered, "Nothing yet.")}
  <h4>Provided by more than one bot</h4>${shareList(c.duplicated, "No overlap between bots.")}
  <h4>Not covered by KoolBot</h4>${shareList(c.uncovered, "Nothing.")}`
      : ""
  }`;
  return `
<div class="card">
  <h2>Bot replacement report (${report.cards.length})</h2>
  <p class="muted">Read-only. Removing a bot stays manual in Discord, and nothing here changes your server. Data from other bots cannot be imported.</p>
  ${warnings}
  ${summary}
  ${report.cards.map(renderBotCard).join("")}
</div>`;
}

function renderCommunity(scan: ServerScan): string {
  const c = scan.community;
  const nameOf = (id: string | null): string =>
    id ? (scan.channels.find((ch) => ch.id === id)?.name ?? id) : "—";
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
        `<li>${escapeHtml(p.title)}: <span class="muted">${escapeHtml(p.roleIds.map((id) => roleName.get(id) ?? id).join(", ") || "no roles")}</span></li>`,
    )
    .join("");
  const n = scan.naming;
  return `
<div class="card">
  <h2>Handled by Discord</h2>
  ${
    c.community
      ? `<p>Community is on. Rules: <strong>${escapeHtml(nameOf(c.rulesChannelId))}</strong>, system: <strong>${escapeHtml(nameOf(c.systemChannelId))}</strong>, public updates: <strong>${escapeHtml(nameOf(c.publicUpdatesChannelId))}</strong>. Onboarding is ${onboarding}.</p>${prompts ? `<ul>${prompts}</ul>` : ""}`
      : `<p class="muted">Community features are off.</p>`
  }
</div>
<div class="card">
  <h2>Naming convention</h2>
  <p>${
    n.pattern
      ? `Pattern: <strong>${escapeHtml(n.pattern)}</strong> (${Math.round(n.confidence * 100)}% of channels)${n.separator ? `, separator <code>${escapeHtml(n.separator)}</code>` : ""}.`
      : "Not enough channels to tell."
  }${n.categoryEmojiPrefix ? " Categories start with an emoji." : ""}${n.suggestedPrefix ? ` Suggested voice prefix: <code>${escapeHtml(n.suggestedPrefix)}</code>.` : ""}</p>
</div>
<div class="card">
  <h2>Scheduled events (${scan.scheduledEvents.length})</h2>
  ${
    scan.scheduledEvents.length === 0
      ? `<p class="muted">No native scheduled events.</p>`
      : `<ul>${scan.scheduledEvents.map((e) => `<li>${escapeHtml(e.name)} <span class="muted">${escapeHtml(e.startsAt ?? "")}</span></li>`).join("")}</ul>`
  }
</div>`;
}

export function renderAdoptPage(props: AdoptPageProps): string {
  const { scan } = props;
  let content: string;
  if (!scan) {
    content = `<div class="notice err">The scan failed: ${escapeHtml(props.error ?? "unknown error")}. Check that the bot is in the server, then reload.</div>`;
  } else {
    const suggestions = scan.suggestions
      .map((s) => `<li>${escapeHtml(s.message)}</li>`)
      .join("");
    const partial = scan.partial.length
      ? `<div class="notice warn">Some parts could not be read: ${escapeHtml(scan.partial.join(", "))}.</div>`
      : "";
    const webhookNote = scan.webhooks.known
      ? ""
      : `<div class="notice warn">${
          scan.webhooks.unavailable === "missing-permission"
            ? "KoolBot does not hold Manage Webhooks, so"
            : "Webhooks could not be read, so"
        } channels fed by webhooks or followed announcement channels are not marked below. Their absence here does not mean there are none.</div>`;
    content = `
${partial}
${webhookNote}
${renderReadiness(scan)}
${suggestions ? `<div class="card"><h2>Suggestions</h2><ul>${suggestions}</ul></div>` : ""}
${renderRoles(scan)}
${renderChannels(scan)}
${renderBots(scan)}
${renderBotReport(scan)}
${renderCommunity(scan)}`;
  }
  const body = `
<h1>Server scan</h1>
<p class="subtitle">A read-only inventory of ${escapeHtml(scan?.guildName ?? "this server")}. Nothing here changes Discord or KoolBot settings. To act on what you find, use <a href="/admin/role-groups">Role Groups</a> or <a href="/admin/adopt/claims">Channel Claims</a>.</p>
<p>${
    props.sampled
      ? `Channel ownership hints are on. <a href="/admin/adopt">Turn off</a>.`
      : `<a href="/admin/adopt?sample=1">Include channel ownership hints</a> (reads recent messages; slower).`
  }</p>
${content}`;
  return renderAdminPage({
    title: "Server scan",
    active: "/admin/adopt",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
