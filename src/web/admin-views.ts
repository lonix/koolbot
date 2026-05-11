/**
 * Read-only page renderers for #381. Each renderer takes already-shaped
 * data so the route handler stays thin and the renderer is testable
 * without a Discord client or MongoDB.
 */

import { escapeHtml, renderAdminPage } from "./admin-layout.js";

interface CommonProps {
  csrfToken: string;
  remainingMs: number;
}

function tagOnOff(on: boolean, onLabel = "ON", offLabel = "OFF"): string {
  return `<span class="tag ${on ? "tag-on" : "tag-off"}">${on ? onLabel : offLabel}</span>`;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return `<span class="muted">—</span>`;
  }
  if (typeof value === "boolean") {
    return tagOnOff(value, "true", "false");
  }
  if (value === "") {
    return `<span class="muted">(empty)</span>`;
  }
  return `<span class="mono">${escapeHtml(value)}</span>`;
}

// ---------- Dashboard ----------

export interface DashboardProps extends CommonProps {
  guild: {
    name: string | null;
    id: string;
    memberCount: number | null;
    voiceUsers: number | null;
    botTag: string | null;
  };
  mongoState: string;
  counts: {
    announcements: number;
    pollSchedules: number;
    pollItems: number;
    reactionRoles: number;
    notices: number;
  };
  features: Array<{ key: string; label: string; on: boolean }>;
}

export function renderDashboardPage(props: DashboardProps): string {
  const featuresHtml = props.features
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.label)}</td><td>${tagOnOff(f.on)}</td>` +
        `<td class="mono muted">${escapeHtml(f.key)}</td></tr>`,
    )
    .join("");

  const body = `
<h1>Dashboard</h1>
<p class="subtitle">Read-only overview of the bot's current state.</p>

<div class="card">
  <h2>Discord</h2>
  <dl class="kv">
    <dt>Guild</dt><dd>${escapeHtml(props.guild.name ?? "(unknown)")} <span class="muted mono">${escapeHtml(props.guild.id)}</span></dd>
    <dt>Members</dt><dd>${props.guild.memberCount ?? "—"}</dd>
    <dt>In voice now</dt><dd>${props.guild.voiceUsers ?? "—"}</dd>
    <dt>Bot user</dt><dd>${escapeHtml(props.guild.botTag ?? "(not ready)")}</dd>
  </dl>
</div>

<div class="card">
  <h2>Database</h2>
  <dl class="kv">
    <dt>Connection</dt><dd>${tagOnOff(props.mongoState === "connected", props.mongoState, props.mongoState)}</dd>
    <dt>Scheduled announcements</dt><dd>${props.counts.announcements}</dd>
    <dt>Poll schedules</dt><dd>${props.counts.pollSchedules}</dd>
    <dt>Poll questions</dt><dd>${props.counts.pollItems}</dd>
    <dt>Active reaction roles</dt><dd>${props.counts.reactionRoles}</dd>
    <dt>Notices</dt><dd>${props.counts.notices}</dd>
  </dl>
</div>

<div class="card">
  <h2>Features</h2>
  <table>
    <thead><tr><th>Feature</th><th>Status</th><th>Config key</th></tr></thead>
    <tbody>${featuresHtml}</tbody>
  </table>
</div>
`;
  return renderAdminPage({
    title: "Dashboard",
    active: "/admin/",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}

// ---------- Bootstrap ----------

export interface BootstrapProps extends CommonProps {
  groups: Array<{
    category: string;
    rows: Array<{
      key: string;
      present: boolean;
      isSecret: boolean;
      display?: string;
    }>;
  }>;
}

export function renderBootstrapPage(props: BootstrapProps): string {
  const sections = props.groups
    .map((group) => {
      const rows = group.rows
        .map((r) => {
          const status = r.present
            ? `<span class="tag tag-on">configured</span>`
            : `<span class="tag tag-off">unset</span>`;
          const value = r.present
            ? r.isSecret
              ? `<span class="muted mono">${escapeHtml(r.display ?? "")}</span>`
              : `<span class="mono">${escapeHtml(r.display ?? "")}</span>`
            : "";
          return `<tr><td class="mono">${escapeHtml(r.key)}</td><td>${status}</td><td>${value}</td></tr>`;
        })
        .join("");
      return `
<div class="card">
  <h2>${escapeHtml(group.category)}</h2>
  <table><thead><tr><th>Variable</th><th>Status</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
    })
    .join("");

  const body = `
<h1>Bootstrap</h1>
<p class="subtitle">Process startup variables loaded from <code>.env</code>. Read-only — change them by editing <code>.env</code> and restarting the bot.</p>
<div class="notice info">Secrets are surfaced as presence + last 4 characters only. Never edited from the WebUI, never written to MongoDB.</div>
${sections}
`;
  return renderAdminPage({
    title: "Bootstrap",
    active: "/admin/bootstrap",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}

// ---------- Settings ----------

export interface SettingRow {
  key: string;
  current: unknown;
  defaultValue: unknown;
  type: string;
  description: string;
  category: string;
}

export interface SettingsProps extends CommonProps {
  groups: Array<{ category: string; rows: SettingRow[] }>;
}

export function renderSettingsPage(props: SettingsProps): string {
  const sections = props.groups
    .map((g) => {
      const rows = g.rows
        .map(
          (r) => `<tr>
<td class="mono">${escapeHtml(r.key)}</td>
<td>${formatValue(r.current)}</td>
<td><span class="tag tag-info">${escapeHtml(r.type)}</span></td>
<td>${formatValue(r.defaultValue)}</td>
<td class="muted">${escapeHtml(r.description)}</td>
</tr>`,
        )
        .join("");
      return `
<div class="card">
  <h2>${escapeHtml(g.category)}</h2>
  <table>
    <thead><tr><th>Key</th><th>Value</th><th>Type</th><th>Default</th><th>Description</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
    })
    .join("");

  const body = `
<h1>Settings</h1>
<p class="subtitle">All DB-backed configuration, grouped by feature. Mirrors <code>SETTINGS.md</code> and <code>config-service.ts</code>. Read-only.</p>
${sections}
`;
  return renderAdminPage({
    title: "Settings",
    active: "/admin/settings",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}

// ---------- Permissions ----------

export interface PermissionsProps extends CommonProps {
  commands: string[];
  roleIds: string[];
  roleNames: Map<string, string>;
  perCommand: Map<string, string[]>;
}

export function renderPermissionsPage(props: PermissionsProps): string {
  const headerRoles = props.roleIds
    .map(
      (rid) =>
        `<th title="${escapeHtml(rid)}">${escapeHtml(props.roleNames.get(rid) ?? rid)}</th>`,
    )
    .join("");

  const matrixRows = props.commands
    .map((cmd) => {
      const allowed = new Set(props.perCommand.get(cmd) ?? []);
      const cells = props.roleIds
        .map(
          (rid) =>
            `<td>${allowed.has(rid) ? '<span class="tag tag-on">✓</span>' : '<span class="muted">—</span>'}</td>`,
        )
        .join("");
      const status =
        allowed.size === 0
          ? `<span class="tag tag-info">open</span>`
          : `<span class="tag tag-warn">restricted</span>`;
      return `<tr><td class="mono">/${escapeHtml(cmd)}</td><td>${status}</td>${cells}</tr>`;
    })
    .join("");

  const matrixHtml =
    props.roleIds.length === 0
      ? `<div class="empty">No restricted commands. All registered commands are open by default.</div>`
      : `<table><thead><tr><th>Command</th><th>Status</th>${headerRoles}</tr></thead><tbody>${matrixRows}</tbody></table>`;

  const perCommandRows = props.commands
    .map((cmd) => {
      const allowed = props.perCommand.get(cmd) ?? [];
      if (allowed.length === 0) {
        return `<tr><td class="mono">/${escapeHtml(cmd)}</td><td><span class="tag tag-info">open</span></td><td class="muted">All members</td></tr>`;
      }
      const pills = allowed
        .map(
          (rid) =>
            `<span class="tag tag-info" title="${escapeHtml(rid)}">${escapeHtml(props.roleNames.get(rid) ?? rid)}</span>`,
        )
        .join(" ");
      return `<tr><td class="mono">/${escapeHtml(cmd)}</td><td><span class="tag tag-warn">restricted</span></td><td>${pills}</td></tr>`;
    })
    .join("");

  const body = `
<h1>Permissions</h1>
<p class="subtitle">Discord command access derived from <code>permissions-service.ts</code>. Administrators always bypass these checks.</p>

<div class="card"><h2>Matrix</h2>${matrixHtml}</div>

<div class="card">
  <h2>Per-command</h2>
  <table>
    <thead><tr><th>Command</th><th>Status</th><th>Allowed roles</th></tr></thead>
    <tbody>${perCommandRows}</tbody>
  </table>
</div>
`;
  return renderAdminPage({
    title: "Permissions",
    active: "/admin/permissions",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}

// ---------- Announcements ----------

export interface AnnouncementRow {
  id: string;
  channelName: string;
  cron: string;
  enabled: boolean;
  messagePreview: string;
  embedTitle: string | null;
  placeholders: boolean;
  createdAt: string;
}

export interface AnnouncementsProps extends CommonProps {
  enabled: boolean;
  rows: AnnouncementRow[];
}

export function renderAnnouncementsPage(props: AnnouncementsProps): string {
  const tableRows = props.rows
    .map(
      (a) => `<tr>
<td class="mono">${escapeHtml(a.id)}</td>
<td>#${escapeHtml(a.channelName)}</td>
<td class="mono">${escapeHtml(a.cron)}</td>
<td>${tagOnOff(a.enabled)}</td>
<td>${escapeHtml(a.messagePreview)}${a.embedTitle ? `<div class="muted mono">embed: ${escapeHtml(a.embedTitle)}</div>` : ""}</td>
<td>${a.placeholders ? '<span class="tag tag-info">yes</span>' : '<span class="muted">no</span>'}</td>
<td class="muted">${escapeHtml(a.createdAt)}</td>
</tr>`,
    )
    .join("");

  const tableHtml =
    props.rows.length === 0
      ? `<div class="empty">No scheduled announcements configured.</div>`
      : `<table><thead><tr><th>ID</th><th>Channel</th><th>Cron</th><th>Status</th><th>Message</th><th>Placeholders</th><th>Created</th></tr></thead><tbody>${tableRows}</tbody></table>`;

  const body = `
<h1>Announcements</h1>
<p class="subtitle">Scheduled announcements posted on a cron. Read-only.</p>
<div class="card">
  <h2>Status</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.enabled, "enabled", "disabled")}</dd>
    <dt>Total schedules</dt><dd>${props.rows.length}</dd>
  </dl>
</div>
<div class="card"><h2>Schedules</h2>${tableHtml}</div>
`;
  return renderAdminPage({
    title: "Announcements",
    active: "/admin/announcements",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}

// ---------- Polls ----------

export interface PollScheduleRow {
  id: string;
  channelName: string;
  cron: string;
  durationHours: number;
  pingRoleName: string | null;
  enabled: boolean;
  lastRun: string;
}

export interface PollItemRow {
  question: string;
  answers: string[];
  tags: string[];
  usageCount: number;
  lastUsed: string;
  enabled: boolean;
  source: string;
}

export interface PollsProps extends CommonProps {
  enabled: boolean;
  defaultDurationHours: number;
  cooldownDays: number;
  schedules: PollScheduleRow[];
  items: PollItemRow[];
}

export function renderPollsPage(props: PollsProps): string {
  const scheduleRows = props.schedules
    .map(
      (s) => `<tr>
<td class="mono">${escapeHtml(s.id)}</td>
<td>#${escapeHtml(s.channelName)}</td>
<td class="mono">${escapeHtml(s.cron)}</td>
<td>${s.durationHours}h</td>
<td>${s.pingRoleName ? `@${escapeHtml(s.pingRoleName)}` : '<span class="muted">none</span>'}</td>
<td>${tagOnOff(s.enabled)}</td>
<td class="muted">${escapeHtml(s.lastRun)}</td>
</tr>`,
    )
    .join("");

  const itemRows = props.items
    .map(
      (it) => `<tr>
<td>${escapeHtml(it.question)}<div class="muted mono">${escapeHtml(it.answers.join(" • "))}</div></td>
<td>${it.tags.length === 0 ? '<span class="muted">—</span>' : it.tags.map((t) => `<span class="tag tag-info">${escapeHtml(t)}</span>`).join(" ")}</td>
<td>${it.usageCount}</td>
<td class="muted">${escapeHtml(it.lastUsed)}</td>
<td>${tagOnOff(it.enabled)}</td>
<td class="muted">${escapeHtml(it.source)}</td>
</tr>`,
    )
    .join("");

  const body = `
<h1>Polls</h1>
<p class="subtitle">Poll schedules and question library. Read-only.</p>
<div class="card">
  <h2>Status</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.enabled, "enabled", "disabled")}</dd>
    <dt>Default duration</dt><dd>${props.defaultDurationHours}h</dd>
    <dt>Cooldown</dt><dd>${props.cooldownDays} days</dd>
    <dt>Schedules</dt><dd>${props.schedules.length}</dd>
    <dt>Question library</dt><dd>${props.items.length}</dd>
  </dl>
</div>
<div class="card">
  <h2>Schedules</h2>
  ${
    props.schedules.length === 0
      ? `<div class="empty">No poll schedules configured.</div>`
      : `<table><thead><tr><th>ID</th><th>Channel</th><th>Cron</th><th>Duration</th><th>Ping role</th><th>Status</th><th>Last run</th></tr></thead><tbody>${scheduleRows}</tbody></table>`
  }
</div>
<div class="card">
  <h2>Question library</h2>
  ${
    props.items.length === 0
      ? `<div class="empty">No poll questions stored.</div>`
      : `<table><thead><tr><th>Question</th><th>Tags</th><th>Used</th><th>Last used</th><th>Status</th><th>Source</th></tr></thead><tbody>${itemRows}</tbody></table>`
  }
</div>
`;
  return renderAdminPage({
    title: "Polls",
    active: "/admin/polls",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}

// ---------- Reaction Roles ----------

export interface ReactionRoleRow {
  emoji: string;
  roleName: string;
  roleId: string;
  categoryName: string;
  channelName: string;
  messageId: string;
  isArchived: boolean;
  archivedAt: string | null;
}

export interface ReactionRolesProps extends CommonProps {
  enabled: boolean;
  configChannel: { name: string; id: string } | null;
  active: ReactionRoleRow[];
  archived: ReactionRoleRow[];
}

function reactionRoleRow(rr: ReactionRoleRow): string {
  return `<tr>
<td class="mono">${escapeHtml(rr.emoji)}</td>
<td>${escapeHtml(rr.roleName)} <span class="muted mono">${escapeHtml(rr.roleId)}</span></td>
<td>${escapeHtml(rr.categoryName)}</td>
<td>#${escapeHtml(rr.channelName)}</td>
<td class="mono">${escapeHtml(rr.messageId)}</td>
<td><span class="tag ${rr.isArchived ? "tag-off" : "tag-on"}">${rr.isArchived ? "archived" : "active"}</span></td>
<td class="muted">${escapeHtml(rr.archivedAt ?? "")}</td>
</tr>`;
}

export function renderReactionRolesPage(props: ReactionRolesProps): string {
  const activeRows = props.active.map(reactionRoleRow).join("");
  const archivedRows = props.archived.map(reactionRoleRow).join("");
  const channelLine = props.configChannel
    ? `<dt>Message channel</dt><dd>#${escapeHtml(props.configChannel.name)} <span class="muted mono">${escapeHtml(props.configChannel.id)}</span></dd>`
    : `<dt>Message channel</dt><dd class="muted">unset</dd>`;

  const body = `
<h1>Reaction Roles</h1>
<p class="subtitle">Per-message reaction-role mappings stored in <code>reaction_role_configs</code>. Read-only.</p>
<div class="card">
  <h2>Status</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.enabled, "enabled", "disabled")}</dd>
    ${channelLine}
    <dt>Active mappings</dt><dd>${props.active.length}</dd>
    <dt>Archived mappings</dt><dd>${props.archived.length}</dd>
  </dl>
</div>
<div class="card">
  <h2>Active</h2>
  ${
    props.active.length === 0
      ? `<div class="empty">No active reaction-role mappings.</div>`
      : `<table><thead><tr><th>Emoji</th><th>Role</th><th>Category</th><th>Channel</th><th>Message ID</th><th>Status</th><th>Archived</th></tr></thead><tbody>${activeRows}</tbody></table>`
  }
</div>
<div class="card">
  <h2>Archived (last 50)</h2>
  ${
    props.archived.length === 0
      ? `<div class="empty">No archived mappings.</div>`
      : `<table><thead><tr><th>Emoji</th><th>Role</th><th>Category</th><th>Channel</th><th>Message ID</th><th>Status</th><th>Archived</th></tr></thead><tbody>${archivedRows}</tbody></table>`
  }
</div>
`;
  return renderAdminPage({
    title: "Reaction Roles",
    active: "/admin/reaction-roles",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}

// ---------- Notices ----------

export interface NoticeRow {
  order: number;
  title: string;
  preview: string;
  messageId: string;
  updatedAt: string;
}

export interface NoticesProps extends CommonProps {
  enabled: boolean;
  channel: { name: string; id: string } | null;
  headerEnabled: boolean;
  total: number;
  groups: Array<{ category: string; rows: NoticeRow[] }>;
}

export function renderNoticesPage(props: NoticesProps): string {
  const groupSections =
    props.groups.length === 0
      ? `<div class="empty">No notices stored.</div>`
      : props.groups
          .map((g) => {
            const rows = g.rows
              .map(
                (n) => `<tr>
<td>${n.order}</td>
<td>${escapeHtml(n.title)}</td>
<td class="muted">${escapeHtml(n.preview)}</td>
<td class="mono muted">${escapeHtml(n.messageId)}</td>
<td class="muted">${escapeHtml(n.updatedAt)}</td>
</tr>`,
              )
              .join("");
            return `<div class="card">
  <h2>${escapeHtml(g.category)} <span class="muted">(${g.rows.length})</span></h2>
  <table><thead><tr><th>#</th><th>Title</th><th>Content</th><th>Message ID</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
          })
          .join("");

  const body = `
<h1>Notices</h1>
<p class="subtitle">Notice posts grouped by category. Read-only.</p>
<div class="card">
  <h2>Status</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.enabled, "enabled", "disabled")}</dd>
    <dt>Channel</dt><dd>${props.channel ? `#${escapeHtml(props.channel.name)} <span class="muted mono">${escapeHtml(props.channel.id)}</span>` : '<span class="muted">unset</span>'}</dd>
    <dt>Header post</dt><dd>${tagOnOff(props.headerEnabled, "enabled", "disabled")}</dd>
    <dt>Total notices</dt><dd>${props.total}</dd>
  </dl>
</div>
${groupSections}
`;
  return renderAdminPage({
    title: "Notices",
    active: "/admin/notices",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}

// ---------- Database ----------

export interface DatabaseProps extends CommonProps {
  connection: {
    state: string;
    name: string;
    host: string;
  };
  trunk: {
    enabled: boolean;
    schedule: string;
    isScheduled: boolean;
    isRunning: boolean;
    lastRun: string;
    notificationChannel: { name: string; id: string } | null;
    detailedDays: number;
    monthlyMonths: number;
    yearlyYears: number;
  };
  collections: Array<{ name: string; count: number }>;
}

export function renderDatabasePage(props: DatabaseProps): string {
  const collectionsHtml =
    props.collections.length === 0
      ? `<div class="empty">No collection statistics available.</div>`
      : `<table><thead><tr><th>Collection</th><th>Documents (est.)</th></tr></thead><tbody>${props.collections.map((c) => `<tr><td class="mono">${escapeHtml(c.name)}</td><td>${c.count}</td></tr>`).join("")}</tbody></table>`;

  const body = `
<h1>Database</h1>
<p class="subtitle">MongoDB connection state and the voice-channel <code>dbtrunk</code> cleanup status. Read-only.</p>
<div class="card">
  <h2>Connection</h2>
  <dl class="kv">
    <dt>State</dt><dd>${tagOnOff(props.connection.state === "connected", props.connection.state, props.connection.state)}</dd>
    <dt>Database</dt><dd class="mono">${escapeHtml(props.connection.name)}</dd>
    <dt>Host</dt><dd class="mono">${escapeHtml(props.connection.host)}</dd>
  </dl>
</div>
<div class="card">
  <h2>dbtrunk (voice-tracking cleanup)</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.trunk.enabled, "enabled", "disabled")}</dd>
    <dt>Schedule</dt><dd class="mono">${escapeHtml(props.trunk.schedule || "(unset)")}</dd>
    <dt>Scheduled</dt><dd>${props.trunk.isScheduled ? '<span class="tag tag-on">yes</span>' : '<span class="tag tag-off">no</span>'}</dd>
    <dt>Currently running</dt><dd>${props.trunk.isRunning ? '<span class="tag tag-warn">yes</span>' : '<span class="tag tag-on">idle</span>'}</dd>
    <dt>Last run</dt><dd class="muted">${escapeHtml(props.trunk.lastRun)}</dd>
    <dt>Notification channel</dt><dd>${props.trunk.notificationChannel ? `#${escapeHtml(props.trunk.notificationChannel.name)} <span class="muted mono">${escapeHtml(props.trunk.notificationChannel.id)}</span>` : '<span class="muted">unset</span>'}</dd>
    <dt>Detailed sessions retention</dt><dd>${props.trunk.detailedDays} days</dd>
    <dt>Monthly summaries retention</dt><dd>${props.trunk.monthlyMonths} months</dd>
    <dt>Yearly summaries retention</dt><dd>${props.trunk.yearlyYears} years</dd>
  </dl>
</div>
<div class="card"><h2>Collections</h2>${collectionsHtml}</div>
`;
  return renderAdminPage({
    title: "Database",
    active: "/admin/database",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}

// ---------- Voice Channels ----------

export interface VoiceChannelRow {
  name: string;
  isLobby: boolean;
  isLive: boolean;
  memberCount: number;
  customName: string | null;
  channelId: string;
}

export interface VoiceChannelsProps extends CommonProps {
  enabled: boolean;
  controlPanelEnabled: boolean;
  categoryName: string;
  lobbyName: string;
  offlineLobbyName: string;
  prefix: string;
  totalManaged: number;
  totalEmpty: number;
  channels: VoiceChannelRow[];
  categoryFound: boolean;
}

export function renderVoiceChannelsPage(props: VoiceChannelsProps): string {
  const rows = props.channels
    .map((ch) => {
      const tag = ch.isLobby
        ? `<span class="tag tag-info">lobby</span>`
        : `<span class="tag tag-warn">dynamic</span>`;
      const live = ch.isLive ? ' <span class="tag tag-warn">LIVE</span>' : "";
      return `<tr>
<td>${escapeHtml(ch.name)}${live}</td>
<td>${tag}</td>
<td>${ch.memberCount}</td>
<td class="muted">${escapeHtml(ch.customName ?? "")}</td>
<td class="mono muted">${escapeHtml(ch.channelId)}</td>
</tr>`;
    })
    .join("");

  const channelsHtml = !props.categoryFound
    ? `<div class="empty">Voice channel category not found in this guild.</div>`
    : props.channels.length === 0
      ? `<div class="empty">Category exists but contains no voice channels.</div>`
      : `<table><thead><tr><th>Name</th><th>Type</th><th>Users</th><th>Custom name</th><th>Channel ID</th></tr></thead><tbody>${rows}</tbody></table>`;

  const body = `
<h1>Voice Channels</h1>
<p class="subtitle">Voice-channel category contents and live state. Read-only.</p>
<div class="card">
  <h2>Status</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.enabled, "enabled", "disabled")}</dd>
    <dt>Control panel</dt><dd>${tagOnOff(props.controlPanelEnabled, "enabled", "disabled")}</dd>
    <dt>Category</dt><dd class="mono">${escapeHtml(props.categoryName)}</dd>
    <dt>Lobby (online)</dt><dd class="mono">${escapeHtml(props.lobbyName)}</dd>
    <dt>Lobby (offline)</dt><dd class="mono">${escapeHtml(props.offlineLobbyName)}</dd>
    <dt>Channel prefix</dt><dd class="mono">${escapeHtml(props.prefix)}</dd>
    <dt>Total in category</dt><dd>${props.totalManaged}</dd>
    <dt>Empty channels</dt><dd>${props.totalEmpty}</dd>
  </dl>
</div>
<div class="card"><h2>Channels</h2>${channelsHtml}</div>
`;
  return renderAdminPage({
    title: "Voice Channels",
    active: "/admin/voice-channels",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
  });
}
