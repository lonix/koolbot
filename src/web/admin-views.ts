/**
 * Read-only page renderers for #381. Each renderer takes already-shaped
 * data so the route handler stays thin and the renderer is testable
 * without a Discord client or MongoDB.
 */

import {
  escapeHtml,
  escapeJsInAttr,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { categoryMetadata } from "../services/config-schema.js";

interface CommonProps {
  csrfToken: string;
  remainingMs: number;
  /**
   * Enabled-state of feature-gated nav items. Threaded straight through
   * to `renderAdminPage` so the sidebar can hide pages for disabled
   * features. Optional: when absent the nav shows every item.
   */
  navFeatureStatus?: NavFeatureStatus;
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
    navFeatureStatus: props.navFeatureStatus,
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
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Settings ----------

export interface SettingRow {
  key: string;
  label: string;
  current: unknown;
  defaultValue: unknown;
  type: string;
  description: string;
  category: string;
}

export interface SettingsProps extends CommonProps {
  groups: Array<{ category: string; rows: SettingRow[] }>;
  textChannels: ChannelOption[];
  categoryChannels: ChannelOption[];
  roles: RoleOption[];
  flash?: FlashMessage | null;
}

/**
 * Reduce an arbitrary stored value to a primitive that's safe to drop into
 * an HTML form attribute. Mongo can hand us complex shapes from older rows
 * (arrays, objects); they're rare for typed config keys but we coerce
 * defensively so the form never crashes on a stray value.
 */
function coerceToDisplayValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  return String(value);
}

/**
 * Build `<option>` elements where any option whose id is in `selected`
 * (Set) carries the `selected` attribute. Single-select callers pass a
 * Set with at most one entry; multi-select callers pass however many they
 * have.
 *
 * Stored IDs that aren't in the live options list (channel was deleted,
 * role was renamed and the cache is stale, …) are surfaced as
 * `(missing) <id>` options that stay `selected` on render. Without this
 * the browser would default the single-select to the first option
 * (typically the "(none)" row) and an operator could silently clear the
 * setting by saving the form without touching the control.
 */
function buildOptionsHtml(
  options: ChannelOption[] | RoleOption[],
  selected: Set<string>,
  prefix: string,
  includeNoneRow: boolean,
): string {
  const parts: string[] = [];
  if (includeNoneRow) {
    const noneSel = selected.size === 0 ? " selected" : "";
    parts.push(`<option value=""${noneSel}>(none)</option>`);
  }
  const knownIds = new Set(options.map((o) => o.id));
  for (const opt of options) {
    const sel = selected.has(opt.id) ? " selected" : "";
    parts.push(
      `<option value="${escapeHtml(opt.id)}"${sel}>${prefix}${escapeHtml(opt.name)}</option>`,
    );
  }
  for (const id of selected) {
    if (id === "" || knownIds.has(id)) continue;
    parts.push(
      `<option value="${escapeHtml(id)}" selected>(missing) ${escapeHtml(id)}</option>`,
    );
  }
  return parts.join("");
}

/**
 * Parse a 5-field cron string into a "picker" state for the friendly
 * schedule editor (#444). Returns `mode: "custom"` for anything that
 * doesn't cleanly match the three supported shapes (daily, weekly,
 * monthly with single-integer minute/hour and a single weekday or
 * day-of-month), so the editor falls back to a raw cron input and the
 * operator's expression round-trips verbatim.
 *
 * Supported shapes:
 *   daily    `M H * * *`         e.g. "0 0 * * *"     midnight every day
 *   weekly   `M H * * DOW`       e.g. "0 16 * * 5"    Friday 16:00
 *   monthly  `M H DOM * *`       e.g. "0 0 1 * *"     first of every month
 */
export interface CronPickerState {
  mode: "daily" | "weekly" | "monthly" | "custom";
  minute: number; // 0–59, only meaningful when mode !== custom
  hour: number; // 0–23, only meaningful when mode !== custom
  dayOfWeek: number; // 0–6 (Sun–Sat), only meaningful when mode === weekly
  dayOfMonth: number; // 1–31, only meaningful when mode === monthly
  raw: string; // verbatim cron value, used by custom mode
}

export function parseCronToPickerState(cron: string): CronPickerState {
  // Strip surrounding quotes the same way the runtime services do
  // (voice-channel-truncation, voice-channel-announcer,
  // scheduled-announcement-service all apply this normalisation before
  // handing the string to CronJob). Without it a stored value like
  // `"0 16 * * 5"` would silently fall back to custom mode here even
  // though the bot itself treats it as the unquoted form.
  const stripped = cron.replace(/^["']|["']$/g, "");
  const fallback: CronPickerState = {
    mode: "custom",
    minute: 0,
    hour: 0,
    dayOfWeek: 0,
    dayOfMonth: 1,
    raw: stripped,
  };
  const fields = stripped.trim().split(/\s+/);
  if (fields.length !== 5) return fallback;
  const [mStr, hStr, domStr, monStr, dowStr] = fields;
  const isInt = (s: string) => /^\d+$/.test(s);
  const inRange = (n: number, lo: number, hi: number) => n >= lo && n <= hi;

  if (!isInt(mStr) || !isInt(hStr)) return fallback;
  const minute = Number(mStr);
  const hour = Number(hStr);
  if (!inRange(minute, 0, 59) || !inRange(hour, 0, 23)) return fallback;
  // Month must be wildcard for any of the three supported shapes — we
  // don't expose "every N months" / specific-month patterns.
  if (monStr !== "*") return fallback;

  // daily: dom=* dow=*
  if (domStr === "*" && dowStr === "*") {
    return { ...fallback, mode: "daily", minute, hour };
  }
  // weekly: dom=* dow=single integer (sun..sat = 0..6; 7 also means Sun
  // in some implementations, normalise to 0)
  if (domStr === "*" && isInt(dowStr)) {
    let dow = Number(dowStr);
    if (dow === 7) dow = 0;
    if (inRange(dow, 0, 6)) {
      return { ...fallback, mode: "weekly", minute, hour, dayOfWeek: dow };
    }
  }
  // monthly: dom=single integer dow=*
  if (dowStr === "*" && isInt(domStr)) {
    const dom = Number(domStr);
    if (inRange(dom, 1, 31)) {
      return { ...fallback, mode: "monthly", minute, hour, dayOfMonth: dom };
    }
  }
  return fallback;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function renderCronPicker(currentValue: string): string {
  const state = parseCronToPickerState(currentValue);
  const pad = (n: number) => String(n).padStart(2, "0");
  const timeAttr = `${pad(state.hour)}:${pad(state.minute)}`;
  const sel = (cond: boolean) => (cond ? " selected" : "");
  const hidden = (cond: boolean) => (cond ? " hidden" : "");

  const dowOptions = WEEKDAY_NAMES.map(
    (name, i) =>
      `<option value="${i}"${sel(state.dayOfWeek === i)}>${name}</option>`,
  ).join("");

  // Hidden input is the canonical `name="value"` the form submits. The
  // bootstrap script in admin-layout keeps it in sync with the controls.
  return (
    `<div class="cron-picker" data-mode="${state.mode}">` +
    `<input type="hidden" name="value" value="${escapeHtml(currentValue)}">` +
    `<select class="cron-mode" aria-label="Schedule type">` +
    `<option value="daily"${sel(state.mode === "daily")}>Daily</option>` +
    `<option value="weekly"${sel(state.mode === "weekly")}>Weekly</option>` +
    `<option value="monthly"${sel(state.mode === "monthly")}>Monthly</option>` +
    `<option value="custom"${sel(state.mode === "custom")}>Custom (cron)</option>` +
    `</select>` +
    `<span class="cron-time-wrap"${hidden(state.mode === "custom")}>` +
    ` at <input type="time" class="cron-time" value="${timeAttr}">` +
    `</span>` +
    `<span class="cron-dow-wrap"${hidden(state.mode !== "weekly")}>` +
    ` on <select class="cron-dow" aria-label="Day of week">${dowOptions}</select>` +
    `</span>` +
    `<span class="cron-dom-wrap"${hidden(state.mode !== "monthly")}>` +
    ` on day <input type="number" class="cron-dom" min="1" max="31" value="${state.dayOfMonth}" style="width:5rem">` +
    `</span>` +
    `<span class="cron-custom-wrap"${hidden(state.mode !== "custom")}>` +
    `<input type="text" class="cron-custom" value="${escapeHtml(state.raw)}" placeholder="0 16 * * 5" style="width:12rem">` +
    `</span>` +
    `</div>`
  );
}

function renderSettingInput(
  r: SettingRow,
  csrfToken: string,
  pickers: {
    textChannels: ChannelOption[];
    categoryChannels: ChannelOption[];
    roles: RoleOption[];
  },
): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">`;
  const keyField = `<input type="hidden" name="key" value="${escapeHtml(r.key)}">`;
  const primitive = coerceToDisplayValue(r.current);
  const currentStr = typeof primitive === "string" ? primitive : "";

  let control: string;
  if (r.type === "boolean") {
    const checked = primitive === true ? " checked" : "";
    control =
      `<label class="checkbox" style="display:inline-flex;gap:.4rem;align-items:center;cursor:pointer">` +
      `<input type="checkbox" name="value" value="true"${checked}> ` +
      `<span class="mono">${primitive === true ? "true" : "false"}</span>` +
      `</label>`;
  } else if (r.type === "number") {
    control = `<input type="number" name="value" value="${escapeHtml(primitive)}" style="width:8rem">`;
  } else if (
    r.type === "channel" ||
    r.type === "category" ||
    r.type === "role"
  ) {
    const options =
      r.type === "channel"
        ? pickers.textChannels
        : r.type === "category"
          ? pickers.categoryChannels
          : pickers.roles;
    const prefix = r.type === "role" ? "@" : "#";
    const selected = currentStr ? new Set([currentStr]) : new Set<string>();
    control =
      `<select name="value">` +
      buildOptionsHtml(options, selected, prefix, true) +
      `</select>`;
  } else if (r.type === "channel_list" || r.type === "role_list") {
    const options =
      r.type === "channel_list" ? pickers.textChannels : pickers.roles;
    const prefix = r.type === "role_list" ? "@" : "#";
    const selected = new Set(
      currentStr
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== ""),
    );
    control =
      `<select name="value" multiple size="${Math.min(8, Math.max(3, options.length))}">` +
      buildOptionsHtml(options, selected, prefix, false) +
      `</select>`;
  } else if (r.type === "cron") {
    control = renderCronPicker(currentStr);
  } else {
    // string or unknown type → plain text input.
    control = `<input type="text" name="value" value="${escapeHtml(primitive)}">`;
  }

  return (
    `<form method="POST" action="/admin/settings/set" class="inline-form">` +
    csrf +
    keyField +
    control +
    `<button type="submit" class="btn btn-primary btn-sm">Set</button>` +
    `</form>` +
    `<form method="POST" action="/admin/settings/reset" class="inline-form" style="margin-top:.25rem">` +
    csrf +
    keyField +
    `<button type="submit" class="btn btn-sm">Reset</button>` +
    `</form>`
  );
}

export function renderSettingsPage(props: SettingsProps): string {
  const csrf = escapeHtml(props.csrfToken);

  const actionBar = `
<div class="actions">
  <form method="POST" action="/admin/settings/reload" onsubmit="return confirm('Reload bot slash commands now? This briefly puts the bot into a config-reload status.');">
    <input type="hidden" name="_csrf" value="${csrf}">
    <button type="submit" class="btn">Reload commands</button>
  </form>
  <a href="/admin/settings/export" class="btn">Export YAML</a>
  <a href="#import-section" class="btn">Import YAML</a>
  <a href="/admin/wizard" class="btn">Setup wizard</a>
</div>`;

  const pickers = {
    textChannels: props.textChannels,
    categoryChannels: props.categoryChannels,
    roles: props.roles,
  };
  const sections = props.groups
    .map((g) => {
      const meta = categoryMetadata[g.category] ?? {
        title: g.category,
        description: "",
      };
      const rows = g.rows
        .map(
          (r) => `<tr>
<td>
  <div><strong>${escapeHtml(r.label || r.key)}</strong></div>
  <code class="mono muted" style="font-size:.85em">${escapeHtml(r.key)}</code>
</td>
<td>${renderSettingInput(r, props.csrfToken, pickers)}</td>
<td><span class="tag tag-info">${escapeHtml(r.type)}</span></td>
<td style="white-space:nowrap">${formatValue(r.defaultValue)}</td>
<td class="muted">${escapeHtml(r.description)}</td>
</tr>`,
        )
        .join("");
      const descHtml = meta.description
        ? `<p class="muted" style="margin:.25rem 0 .75rem">${escapeHtml(meta.description)}</p>`
        : "";
      return `
<div class="card">
  <h2>${escapeHtml(meta.title)}</h2>
  ${descHtml}
  <table>
    <thead><tr><th>Setting</th><th>Edit</th><th>Type</th><th>Default</th><th>Description</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
    })
    .join("");

  const importSection = `
<div id="import-section" class="card">
  <h2>Import YAML</h2>
  <p class="muted" style="margin:0 0 .75rem">Paste a YAML key→value mapping. A diff preview is shown before anything is written. Bootstrap and environment keys are always refused.</p>
  <form method="POST" action="/admin/settings/import" class="stack">
    <input type="hidden" name="_csrf" value="${csrf}">
    <textarea name="yaml" rows="12" placeholder="voicechannels.enabled: true&#10;quotes.max_length: 500"></textarea>
    <div>
      <button type="submit" class="btn btn-primary">Preview import</button>
    </div>
  </form>
</div>`;

  const body = `
<h1>Settings</h1>
<p class="subtitle">All DB-backed configuration, grouped by feature. Mirrors <code>SETTINGS.md</code> and <code>config-service.ts</code>.</p>
${renderFlash(props.flash)}
${actionBar}
${sections}
${importSection}
`;
  return renderAdminPage({
    title: "Settings",
    active: "/admin/settings",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Import diff preview ----------

export interface ImportDiffRow {
  key: string;
  status: "pending" | "rejected";
  reason?: string;
  before?: unknown;
  after?: unknown;
}

export interface ImportDiffProps extends CommonProps {
  rows: ImportDiffRow[];
  yamlText: string;
}

export function renderImportDiffPage(props: ImportDiffProps): string {
  const csrf = escapeHtml(props.csrfToken);

  const diffRows = props.rows
    .map((r) => {
      if (r.status === "rejected") {
        return `<tr>
<td class="mono">${escapeHtml(r.key)}</td>
<td><span class="tag tag-diff-reject">rejected</span></td>
<td class="muted">${escapeHtml(r.reason ?? "")}</td>
<td></td>
</tr>`;
      }
      const beforeStr =
        r.before === undefined
          ? `<span class="muted">—</span>`
          : `<span class="mono">${escapeHtml(r.before)}</span>`;
      const afterStr = `<span class="mono">${escapeHtml(r.after)}</span>`;
      // String-coerce both sides so YAML `5` (number) and DB `"5"` (string)
      // are treated as equal when they round-trip through the form.
      const same = String(r.before ?? "") === String(r.after ?? "");
      const tag = same
        ? `<span class="tag tag-info">no change</span>`
        : `<span class="tag tag-diff-change">changed</span>`;
      return `<tr>
<td class="mono">${escapeHtml(r.key)}</td>
<td>${tag}</td>
<td>${beforeStr}</td>
<td>${afterStr}</td>
</tr>`;
    })
    .join("");

  const pendingCount = props.rows.filter((r) => r.status === "pending").length;
  const rejectedCount = props.rows.filter(
    (r) => r.status === "rejected",
  ).length;

  const yamlEncoded = escapeHtml(props.yamlText);

  const body = `
<h1>Import preview</h1>
<p class="subtitle">Review the changes below before applying. Rejected rows will not be written.</p>
<div class="notice info">${pendingCount} key(s) will be written; ${rejectedCount} rejected.</div>
<div class="card">
  <table>
    <thead><tr><th>Key</th><th>Status</th><th>Current</th><th>New value</th></tr></thead>
    <tbody>${diffRows}</tbody>
  </table>
</div>
<div class="actions">
  <form method="POST" action="/admin/settings/import/apply">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="yaml" value="${yamlEncoded}">
    <button type="submit" class="btn btn-primary"${pendingCount === 0 ? " disabled" : ""}>Apply import</button>
  </form>
  <a href="/admin/settings" class="btn">Cancel</a>
</div>
`;
  return renderAdminPage({
    title: "Import preview",
    active: "/admin/settings",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Permissions ----------

export interface PermissionsProps extends CommonProps {
  commands: string[];
  /** Role IDs currently used in any restriction (read-only matrix). */
  roleIds: string[];
  /** All guild role IDs in display order — populates the multi-select dropdowns. */
  allRoleIds: string[];
  roleNames: Map<string, string>;
  perCommand: Map<string, string[]>;
  flash?: FlashMessage | null;
}

export function renderPermissionsPage(props: PermissionsProps): string {
  const csrf = escapeHtml(props.csrfToken);

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

  const editRows = props.commands
    .map((cmd) => {
      const current = new Set(props.perCommand.get(cmd) ?? []);
      const status =
        current.size === 0
          ? `<span class="tag tag-info">open</span>`
          : `<span class="tag tag-warn">restricted</span>`;
      const options =
        props.allRoleIds.length === 0
          ? `<option disabled>No roles available in this guild</option>`
          : props.allRoleIds
              .map((rid) => {
                const name = props.roleNames.get(rid) ?? rid;
                const sel = current.has(rid) ? " selected" : "";
                return `<option value="${escapeHtml(rid)}"${sel}>${escapeHtml(name)}</option>`;
              })
              .join("");
      return `<tr>
<td class="mono">/${escapeHtml(cmd)}</td>
<td>${status}</td>
<td>
  <form method="POST" action="/admin/permissions/set" class="inline-form" style="align-items:flex-start">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="command" value="${escapeHtml(cmd)}">
    <select name="roleIds" multiple size="3" style="min-width:14rem">${options}</select>
    <div style="display:flex;flex-direction:column;gap:.25rem">
      <button type="submit" class="btn btn-primary btn-sm">Save</button>
      <span class="muted" style="font-size:.7rem">Hold Ctrl/⌘<br>for multiple</span>
    </div>
  </form>
</td>
</tr>`;
    })
    .join("");

  const body = `
<h1>Permissions</h1>
<p class="subtitle">Discord command access. Administrators always bypass these checks. Select roles to restrict a command; deselect all and save to make it open.</p>
${renderFlash(props.flash)}
<div class="card">
  <h2>Edit</h2>
  <table>
    <thead><tr><th>Command</th><th>Status</th><th>Allowed roles (multi-select)</th></tr></thead>
    <tbody>${editRows}</tbody>
  </table>
</div>
<div class="card"><h2>Matrix</h2>${matrixHtml}</div>
`;
  return renderAdminPage({
    title: "Permissions",
    active: "/admin/permissions",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Setup Wizard ----------

export interface WizardPageProps extends CommonProps {
  featureOrder: string[];
  featureStatus: Record<string, boolean>;
}

const WIZARD_FEATURE_LABELS: Record<string, { name: string; desc: string }> = {
  voicechannels: {
    name: "Voice Channels",
    desc: "Dynamic voice channel management with lobby.",
  },
  voicetracking: {
    name: "Voice Tracking",
    desc: "Track voice activity and generate statistics.",
  },
  quotes: {
    name: "Quote System",
    desc: "Collect and share memorable quotes.",
  },
  achievements: {
    name: "Achievements",
    desc: "Achievement system for voice activity.",
  },
  reactionroles: {
    name: "Reaction Roles",
    desc: "Let users self-assign roles via reactions.",
  },
  announcements: {
    name: "Announcements",
    desc: "Schedule automated announcements.",
  },
  notices: {
    name: "Notices",
    desc: "Curated channel for server notices.",
  },
  polls: {
    name: "Polls",
    desc: "Periodic polls for icebreaker discussions.",
  },
};

export function renderWizardPage(props: WizardPageProps): string {
  const csrf = escapeHtml(props.csrfToken);
  // Checkboxes always render unchecked, regardless of `featureStatus`. The
  // wizard treats each run as a fresh declaration of which features should be
  // on — admins re-tick what they want, untick what they don't. `featureStatus`
  // only feeds the "currently: ON/OFF" indicator so the admin can see what
  // state they're about to override.
  const cards = props.featureOrder
    .map((fk) => {
      const info = WIZARD_FEATURE_LABELS[fk] ?? { name: fk, desc: "" };
      const currentlyOn = Boolean(props.featureStatus[fk]);
      const indicator = `<span class="fc-current">currently ${tagOnOff(currentlyOn)}</span>`;
      const id = `feat-${fk}`;
      return `<div class="feature-card">
  <input type="checkbox" name="features" value="${escapeHtml(fk)}" id="${escapeHtml(id)}">
  <div class="fc-info">
    <label for="${escapeHtml(id)}" class="fc-name">${escapeHtml(info.name)} ${indicator}</label>
    <div class="fc-desc">${escapeHtml(info.desc)}</div>
  </div>
</div>`;
    })
    .join("");

  const body = `
<h1>Setup Wizard</h1>
<p class="subtitle">Pick the features you want to configure and click <strong>Next</strong>. The wizard walks you through each feature's key settings.</p>
<div class="notice info">Changes are only applied at the final confirmation step. Cancel any time without affecting the current configuration.</div>
<form method="POST" action="/admin/wizard/start">
  <input type="hidden" name="_csrf" value="${csrf}">
  <div class="card">
    <h2>Select features to configure</h2>
    <div class="wizard-features">${cards}</div>
  </div>
  <div class="actions">
    <button type="submit" class="btn btn-primary">Next →</button>
    <a href="/admin/" class="btn">Cancel</a>
  </div>
</form>
`;
  return renderAdminPage({
    title: "Setup Wizard",
    active: "/admin/wizard",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

export interface WizardStepPageProps extends CommonProps {
  stepIndex: number;
  totalSteps: number;
  featureKey: string;
  settingKeys: string[];
  currentValues: Record<string, unknown>;
  metadata: Record<string, { description: string; category: string }>;
  defaultValues: Record<string, unknown>;
  flash?: FlashMessage | null;
}

export function renderWizardStepPage(props: WizardStepPageProps): string {
  const csrf = escapeHtml(props.csrfToken);
  const info = WIZARD_FEATURE_LABELS[props.featureKey] ?? {
    name: props.featureKey,
    desc: "",
  };

  const fields = props.settingKeys
    .map((k) => {
      const current = props.currentValues[k];
      const meta = props.metadata[k];
      const defaultVal = props.defaultValues[k];
      const type =
        typeof defaultVal === "boolean"
          ? "boolean"
          : typeof defaultVal === "number"
            ? "number"
            : "string";
      const desc = meta?.description ?? "";
      const inputId = `wiz-${k}`;
      const display =
        typeof current === "boolean" ||
        typeof current === "number" ||
        typeof current === "string"
          ? current
          : "";

      let control: string;
      if (type === "boolean") {
        const checked = current === true ? " checked" : "";
        control = `<label class="checkbox" style="display:inline-flex;gap:.4rem;align-items:center;cursor:pointer"><input type="checkbox" id="${escapeHtml(inputId)}" name="${escapeHtml(k)}" value="true"${checked}> Enable</label>`;
      } else if (type === "number") {
        control = `<input type="number" id="${escapeHtml(inputId)}" name="${escapeHtml(k)}" value="${escapeHtml(display)}">`;
      } else {
        control = `<input type="text" id="${escapeHtml(inputId)}" name="${escapeHtml(k)}" value="${escapeHtml(display)}">`;
      }

      return `<div class="field-row">
  <label for="${escapeHtml(inputId)}">${escapeHtml(k)}</label>
  ${control}
  <div class="help">${escapeHtml(desc)}</div>
</div>`;
    })
    .join("");

  const stepLabel = `Step ${props.stepIndex + 1} of ${props.totalSteps}`;
  const nextLabel =
    props.stepIndex + 1 < props.totalSteps ? "Next →" : "Review →";

  const body = `
<h1>${escapeHtml(info.name)} <span class="muted" style="font-size:1rem">${escapeHtml(stepLabel)}</span></h1>
<p class="subtitle">${escapeHtml(info.desc)}</p>
${renderFlash(props.flash)}
<form method="POST" action="/admin/wizard/step/${props.stepIndex}">
  <input type="hidden" name="_csrf" value="${csrf}">
  <div class="card">${fields}</div>
  <div class="actions">
    <button type="submit" class="btn btn-primary">${nextLabel}</button>
    <a href="/admin/wizard" class="btn">← Back to features</a>
  </div>
</form>
`;
  return renderAdminPage({
    title: `Wizard — ${info.name}`,
    active: "/admin/wizard",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

export interface WizardConfirmPageProps extends CommonProps {
  pending: Array<[string, unknown]>;
  metadata: Record<string, { description: string; category: string }>;
}

export function renderWizardConfirmPage(props: WizardConfirmPageProps): string {
  const csrf = escapeHtml(props.csrfToken);
  const rows =
    props.pending.length === 0
      ? `<tr><td colspan="3" class="empty">No settings configured.</td></tr>`
      : props.pending
          .map(
            ([k, v]) =>
              `<tr>
<td class="mono">${escapeHtml(k)}</td>
<td class="mono">${escapeHtml(v)}</td>
<td class="muted">${escapeHtml(props.metadata[k]?.description ?? "")}</td>
</tr>`,
          )
          .join("");

  const body = `
<h1>Review configuration</h1>
<p class="subtitle">The following settings will be applied when you click <strong>Apply</strong>.</p>
<div class="card">
  <table>
    <thead><tr><th>Key</th><th>New value</th><th>Description</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
<div class="actions">
  <form method="POST" action="/admin/wizard/apply">
    <input type="hidden" name="_csrf" value="${csrf}">
    <button type="submit" class="btn btn-primary"${props.pending.length === 0 ? " disabled" : ""}>Apply</button>
  </form>
  <form method="POST" action="/admin/wizard/cancel">
    <input type="hidden" name="_csrf" value="${csrf}">
    <button type="submit" class="btn btn-danger">Cancel</button>
  </form>
</div>
`;
  return renderAdminPage({
    title: "Wizard — Review",
    active: "/admin/wizard",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
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

export interface ChannelOption {
  id: string;
  name: string;
}

export interface RoleOption {
  id: string;
  name: string;
}

export interface FlashMessage {
  type: "ok" | "warn" | "err";
  text: string;
}

export interface AnnouncementsProps extends CommonProps {
  enabled: boolean;
  rows: AnnouncementRow[];
  textChannels: ChannelOption[];
  flash?: FlashMessage | null;
}

function renderFlash(flash?: FlashMessage | null): string {
  if (!flash) return "";
  const cls =
    flash.type === "ok" ? "ok" : flash.type === "warn" ? "warn" : "err";
  return `<div class="notice ${cls}">${escapeHtml(flash.text)}</div>`;
}

function channelOptionsHtml(options: ChannelOption[]): string {
  if (options.length === 0) {
    return `<option value="">(no text channels available)</option>`;
  }
  return options
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}">#${escapeHtml(c.name)}</option>`,
    )
    .join("");
}

function roleOptionsHtml(options: RoleOption[]): string {
  return [
    `<option value="">(none)</option>`,
    ...options.map(
      (r) =>
        `<option value="${escapeHtml(r.id)}">@${escapeHtml(r.name)}</option>`,
    ),
  ].join("");
}

const CRON_EXAMPLES_HTML = `
<details class="helper">
  <summary>Cron expression examples</summary>
  <ul class="mono">
    <li><code>0 9 * * *</code> — every day at 09:00</li>
    <li><code>0 12 * * 1</code> — every Monday at 12:00</li>
    <li><code>0 16 * * 5</code> — every Friday at 16:00 (weekly VC stats default)</li>
    <li><code>0 0 1 * *</code> — first of every month at 00:00</li>
    <li><code>*/30 * * * *</code> — every 30 minutes</li>
  </ul>
  <p class="muted">Format: <code>minute hour day-of-month month day-of-week</code>.</p>
</details>`;

const PLACEHOLDER_REFERENCE_HTML = `
<details class="helper">
  <summary>Available placeholders</summary>
  <ul class="mono">
    <li><code>{server_name}</code> — guild name</li>
    <li><code>{member_count}</code> — total members</li>
    <li><code>{date}</code> — current date</li>
    <li><code>{time}</code> — current time</li>
    <li><code>{day}</code> — current weekday</li>
    <li><code>{month}</code> — current month</li>
    <li><code>{year}</code> — current year</li>
  </ul>
  <p class="muted">Tick "Process placeholders" on the announcement to expand them at send time.</p>
</details>`;

export function renderAnnouncementsPage(props: AnnouncementsProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;

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
<td class="actions">
  <form method="POST" action="/admin/announcements/${escapeHtml(a.id)}/toggle">${csrfInput}<button type="submit" class="btn">${a.enabled ? "Disable" : "Enable"}</button></form>
  <form method="POST" action="/admin/announcements/${escapeHtml(a.id)}/delete" onsubmit="return confirm('Delete announcement ${escapeHtml(a.id)}?');">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form>
</td>
</tr>`,
    )
    .join("");

  const tableHtml =
    props.rows.length === 0
      ? `<div class="empty">No scheduled announcements configured.</div>`
      : `<table><thead><tr><th>ID</th><th>Channel</th><th>Cron</th><th>Status</th><th>Message</th><th>Placeholders</th><th>Created</th><th>Actions</th></tr></thead><tbody>${tableRows}</tbody></table>`;

  const body = `
<h1>Announcements</h1>
<p class="subtitle">Scheduled announcements posted on a cron. Replaces <code>/announce</code> and <code>/announce-vc-stats</code>; the slash commands still work in parallel during migration.</p>
${renderFlash(props.flash)}
<div class="card">
  <h2>Status</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.enabled, "enabled", "disabled")}</dd>
    <dt>Total schedules</dt><dd>${props.rows.length}</dd>
  </dl>
  <form method="POST" action="/admin/announcements/post-vc-stats" class="inline-form">
    ${csrfInput}
    <button type="submit" class="btn btn-primary">Post weekly VC stats now</button>
    <span class="muted">Runs the same announcement as <code>/announce-vc-stats</code>.</span>
  </form>
</div>
<div class="card">
  <h2>Schedules</h2>${tableHtml}
</div>
<div class="card">
  <h2>Create a new announcement</h2>
  <form method="POST" action="/admin/announcements/create" class="stack">
    ${csrfInput}
    <label>Channel
      <select name="channelId" required>${channelOptionsHtml(props.textChannels)}</select>
    </label>
    <label>Cron schedule
      <input type="text" name="cron" placeholder="0 9 * * *" required pattern=".{3,}">
    </label>
    ${CRON_EXAMPLES_HTML}
    <label>Message
      <textarea name="message" rows="4" required maxlength="2000" placeholder="Hello {server_name}!"></textarea>
    </label>
    <label class="checkbox">
      <input type="checkbox" name="placeholders" value="1">
      Process placeholders (replace <code>{server_name}</code>, <code>{date}</code>, etc.)
    </label>
    ${PLACEHOLDER_REFERENCE_HTML}
    <fieldset>
      <legend>Optional embed</legend>
      <label>Title
        <input type="text" name="embedTitle" maxlength="256">
      </label>
      <label>Description
        <textarea name="embedDescription" rows="3" maxlength="4000"></textarea>
      </label>
      <label>Colour (hex, e.g. <code>#5865F2</code>)
        <input type="text" name="embedColor" pattern="^#?[0-9A-Fa-f]{6}$" placeholder="#5865F2">
      </label>
    </fieldset>
    <button type="submit" class="btn btn-primary">Create announcement</button>
  </form>
</div>
`;
  return renderAdminPage({
    title: "Announcements",
    active: "/admin/announcements",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
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
  id: string;
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
  textChannels: ChannelOption[];
  roles: RoleOption[];
  flash?: FlashMessage | null;
}

export function renderPollsPage(props: PollsProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;

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
<td class="actions">
  <form method="POST" action="/admin/polls/schedules/${escapeHtml(s.id)}/toggle">${csrfInput}<button type="submit" class="btn">${s.enabled ? "Disable" : "Enable"}</button></form>
  <form method="POST" action="/admin/polls/schedules/${escapeHtml(s.id)}/test">${csrfInput}<button type="submit" class="btn">Test</button></form>
  <form method="POST" action="/admin/polls/schedules/${escapeHtml(s.id)}/delete" onsubmit="return confirm('Delete schedule ${escapeHtml(s.id)}?');">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form>
</td>
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
<td class="actions">
  <form method="POST" action="/admin/polls/items/${escapeHtml(it.id)}/toggle">${csrfInput}<button type="submit" class="btn">${it.enabled ? "Disable" : "Enable"}</button></form>
  <form method="POST" action="/admin/polls/items/${escapeHtml(it.id)}/delete" onsubmit="return confirm('Delete poll question?');">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form>
</td>
</tr>`,
    )
    .join("");

  const body = `
<h1>Polls</h1>
<p class="subtitle">Poll schedules and the question library. Replaces <code>/poll create|delete|test|add-item|delete-item|import-url|list|list-items</code>; the slash commands still work in parallel during migration.</p>
${renderFlash(props.flash)}
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
      : `<table><thead><tr><th>ID</th><th>Channel</th><th>Cron</th><th>Duration</th><th>Ping role</th><th>Status</th><th>Last run</th><th>Actions</th></tr></thead><tbody>${scheduleRows}</tbody></table>`
  }
</div>
<div class="card">
  <h2>Create a new schedule</h2>
  <form method="POST" action="/admin/polls/schedules/create" class="stack">
    ${csrfInput}
    <label>Channel
      <select name="channelId" required>${channelOptionsHtml(props.textChannels)}</select>
    </label>
    <label>Cron schedule
      <input type="text" name="cron" placeholder="0 12 * * *" required>
    </label>
    ${CRON_EXAMPLES_HTML}
    <label>Duration (hours, 1–768)
      <input type="number" name="durationHours" min="1" max="768" value="${props.defaultDurationHours}" required>
    </label>
    <label>Ping role
      <select name="pingRoleId">${roleOptionsHtml(props.roles)}</select>
    </label>
    <button type="submit" class="btn btn-primary">Create schedule</button>
  </form>
</div>
<div class="card">
  <h2>Question library</h2>
  ${
    props.items.length === 0
      ? `<div class="empty">No poll questions stored.</div>`
      : `<table><thead><tr><th>Question</th><th>Tags</th><th>Used</th><th>Last used</th><th>Status</th><th>Source</th><th>Actions</th></tr></thead><tbody>${itemRows}</tbody></table>`
  }
</div>
<div class="card">
  <h2>Add a poll question</h2>
  <form method="POST" action="/admin/polls/items/create" class="stack">
    ${csrfInput}
    <label>Question
      <input type="text" name="question" maxlength="300" required>
    </label>
    <label>Answers (comma-separated, 2–10 options)
      <input type="text" name="answers" placeholder="Yes, No, Maybe" required>
    </label>
    <label>Tags (comma-separated, optional)
      <input type="text" name="tags" placeholder="icebreaker, funny">
    </label>
    <label class="checkbox">
      <input type="checkbox" name="multiSelect" value="1">
      Allow multiple answer selections
    </label>
    <button type="submit" class="btn btn-primary">Add question</button>
  </form>
</div>
<div class="card">
  <h2>Bulk import from URL</h2>
  <p class="muted">Fetches a YAML or JSON document shaped as <code>{ polls: [{ question, answers, multiselect?, tags? }] }</code>. Duplicate questions (same text) are skipped.</p>
  <form method="POST" action="/admin/polls/items/import" class="stack">
    ${csrfInput}
    <label>URL
      <input type="url" name="url" placeholder="https://example.com/polls.yaml" required>
    </label>
    <button type="submit" class="btn btn-primary">Import</button>
  </form>
</div>
`;
  return renderAdminPage({
    title: "Polls",
    active: "/admin/polls",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
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
  flash?: FlashMessage | null;
}

function reactionRoleRow(rr: ReactionRoleRow, csrfInput: string): string {
  const escapedName = escapeHtml(rr.roleName);
  const jsName = escapeJsInAttr(rr.roleName);
  const actions = rr.isArchived
    ? `<form method="POST" action="/admin/reaction-roles/unarchive">${csrfInput}<input type="hidden" name="roleName" value="${escapedName}"><button type="submit" class="btn">Unarchive</button></form>
  <form method="POST" action="/admin/reaction-roles/delete" onsubmit="return confirm('Permanently delete reaction role ${jsName}? This removes the Discord role, category, and channel.');">${csrfInput}<input type="hidden" name="roleName" value="${escapedName}"><button type="submit" class="btn btn-danger">Delete</button></form>`
    : `<form method="POST" action="/admin/reaction-roles/archive" onsubmit="return confirm('Archive reaction role ${jsName}? The reaction message will be removed but the role/channels are preserved.');">${csrfInput}<input type="hidden" name="roleName" value="${escapedName}"><button type="submit" class="btn">Archive</button></form>
  <form method="POST" action="/admin/reaction-roles/delete" onsubmit="return confirm('Permanently delete reaction role ${jsName}? This removes the Discord role, category, and channel.');">${csrfInput}<input type="hidden" name="roleName" value="${escapedName}"><button type="submit" class="btn btn-danger">Delete</button></form>`;

  return `<tr>
<td class="mono">${escapeHtml(rr.emoji)}</td>
<td>${escapedName} <span class="muted mono">${escapeHtml(rr.roleId)}</span></td>
<td>${escapeHtml(rr.categoryName)}</td>
<td>#${escapeHtml(rr.channelName)}</td>
<td class="mono">${escapeHtml(rr.messageId)}</td>
<td><span class="tag ${rr.isArchived ? "tag-off" : "tag-on"}">${rr.isArchived ? "archived" : "active"}</span></td>
<td class="muted">${escapeHtml(rr.archivedAt ?? "")}</td>
<td class="actions">${actions}</td>
</tr>`;
}

export function renderReactionRolesPage(props: ReactionRolesProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const activeRows = props.active
    .map((rr) => reactionRoleRow(rr, csrfInput))
    .join("");
  const archivedRows = props.archived
    .map((rr) => reactionRoleRow(rr, csrfInput))
    .join("");
  const channelLine = props.configChannel
    ? `<dt>Message channel</dt><dd>#${escapeHtml(props.configChannel.name)} <span class="muted mono">${escapeHtml(props.configChannel.id)}</span></dd>`
    : `<dt>Message channel</dt><dd class="muted">unset — set <code>reactionroles.message_channel_id</code> before creating reaction roles.</dd>`;

  const body = `
<h1>Reaction Roles</h1>
<p class="subtitle">Per-message reaction-role mappings. Replaces <code>/reactrole create|archive|unarchive|delete|list|status</code>; the slash commands still work in parallel during migration.</p>
${renderFlash(props.flash)}
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
      : `<table><thead><tr><th>Emoji</th><th>Role</th><th>Category</th><th>Channel</th><th>Message ID</th><th>Status</th><th>Archived</th><th>Actions</th></tr></thead><tbody>${activeRows}</tbody></table>`
  }
</div>
<div class="card">
  <h2>Create a reaction role</h2>
  <p class="muted">Creates a Discord role + category + text channel, posts a reaction-role message to the configured channel, and adds the reaction. The new channel preview is <code>${escapeHtml(props.configChannel?.name ?? "(unset)")}</code>.</p>
  <form method="POST" action="/admin/reaction-roles/create" class="stack">
    ${csrfInput}
    <label>Role name
      <input type="text" name="name" required maxlength="100" placeholder="Gamer">
    </label>
    <label>Emoji (Unicode or <code>&lt;:name:id&gt;</code>)
      <input type="text" name="emoji" required maxlength="100" placeholder="🎮">
    </label>
    <button type="submit" class="btn btn-primary">Create reaction role</button>
  </form>
</div>
<div class="card">
  <h2>Archived (last 50)</h2>
  ${
    props.archived.length === 0
      ? `<div class="empty">No archived mappings.</div>`
      : `<table><thead><tr><th>Emoji</th><th>Role</th><th>Category</th><th>Channel</th><th>Message ID</th><th>Status</th><th>Archived</th><th>Actions</th></tr></thead><tbody>${archivedRows}</tbody></table>`
  }
</div>
`;
  return renderAdminPage({
    title: "Reaction Roles",
    active: "/admin/reaction-roles",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Notices ----------

export interface NoticeRow {
  id: string;
  order: number;
  title: string;
  content: string;
  preview: string;
  category: string;
  messageId: string;
  updatedAt: string;
}

export interface NoticeCategoryOption {
  value: string;
  label: string;
}

export interface NoticesProps extends CommonProps {
  enabled: boolean;
  channel: { name: string; id: string } | null;
  headerEnabled: boolean;
  total: number;
  groups: Array<{ category: string; rows: NoticeRow[] }>;
  categoryOptions: NoticeCategoryOption[];
  flash?: FlashMessage | null;
}

function noticeCategoryOptionsHtml(
  options: NoticeCategoryOption[],
  selected?: string,
): string {
  return options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`,
    )
    .join("");
}

export function renderNoticesPage(props: NoticesProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const groupSections =
    props.groups.length === 0
      ? `<div class="empty">No notices stored.</div>`
      : props.groups
          .map((g) => {
            const rows = g.rows
              .map(
                (n) => `<tr>
<td><form method="POST" action="/admin/notices/${escapeHtml(n.id)}/order" class="inline-order">${csrfInput}<input type="number" name="order" value="${n.order}" min="-1000" max="10000" required><button type="submit" class="btn">Save</button></form></td>
<td>${escapeHtml(n.title)}<div class="muted mono">id: ${escapeHtml(n.id)}</div></td>
<td class="muted">${escapeHtml(n.preview)}</td>
<td class="mono muted">${escapeHtml(n.messageId)}</td>
<td class="muted">${escapeHtml(n.updatedAt)}</td>
<td class="actions">
  <details class="helper edit-details"><summary>Edit</summary>
    <form method="POST" action="/admin/notices/${escapeHtml(n.id)}/update" class="stack">${csrfInput}
      <label>Title<input type="text" name="title" maxlength="256" value="${escapeHtml(n.title)}" required></label>
      <label>Content<textarea name="content" rows="6" maxlength="4000" required>${escapeHtml(n.content)}</textarea></label>
      <label>Category<select name="category">${noticeCategoryOptionsHtml(props.categoryOptions, n.category)}</select></label>
      <label>Order<input type="number" name="order" min="-1000" max="10000" value="${n.order}" required></label>
      <button type="submit" class="btn btn-primary">Save changes</button>
    </form>
  </details>
  <form method="POST" action="/admin/notices/${escapeHtml(n.id)}/delete" onsubmit="return confirm('Delete notice \\'${escapeJsInAttr(n.title)}\\'?');">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form>
</td>
</tr>`,
              )
              .join("");
            return `<div class="card">
  <h2>${escapeHtml(g.category)} <span class="muted">(${g.rows.length})</span></h2>
  <table><thead><tr><th>Order</th><th>Title</th><th>Content</th><th>Message ID</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
          })
          .join("");

  const body = `
<h1>Notices</h1>
<p class="subtitle">Notice posts grouped by category. Replaces <code>/notice add|edit|delete|sync</code>; the slash commands still work in parallel during migration. Edit the inline <em>Order</em> field to reorder within a category (lower numbers post first).</p>
${renderFlash(props.flash)}
<div class="card">
  <h2>Status</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.enabled, "enabled", "disabled")}</dd>
    <dt>Channel</dt><dd>${props.channel ? `#${escapeHtml(props.channel.name)} <span class="muted mono">${escapeHtml(props.channel.id)}</span>` : '<span class="muted">unset</span>'}</dd>
    <dt>Header post</dt><dd>${tagOnOff(props.headerEnabled, "enabled", "disabled")}</dd>
    <dt>Total notices</dt><dd>${props.total}</dd>
  </dl>
  <form method="POST" action="/admin/notices/sync" class="inline-form" onsubmit="return confirm('Resync all notices? This deletes and reposts every notice message.');">
    ${csrfInput}
    <button type="submit" class="btn btn-primary">Resync notices to channel</button>
    <span class="muted">Same effect as <code>/notice sync</code>.</span>
  </form>
</div>
<div class="card">
  <h2>Create a notice</h2>
  <form method="POST" action="/admin/notices/create" class="stack">
    ${csrfInput}
    <label>Title<input type="text" name="title" maxlength="256" required></label>
    <label>Content<textarea name="content" rows="5" maxlength="4000" required></textarea></label>
    <label>Category<select name="category" required>${noticeCategoryOptionsHtml(props.categoryOptions)}</select></label>
    <label>Order (lower posts first)<input type="number" name="order" min="-1000" max="10000" value="0" required></label>
    <button type="submit" class="btn btn-primary">Create notice</button>
  </form>
</div>
${groupSections}
`;
  return renderAdminPage({
    title: "Notices",
    active: "/admin/notices",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Database ----------

export interface DbTrunkHistoryRow {
  ranAt: string;
  sessionsRemoved: number;
  dataAggregated: number;
  executionMs: number;
  errors: number;
  result: "success" | "failure";
  errorMessage: string | null;
}

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
    detailedDays: number;
    monthlyMonths: number;
    yearlyYears: number;
  };
  trunkHistory: DbTrunkHistoryRow[];
  collections: Array<{ name: string; count: number }>;
  flash?: FlashMessage | null;
}

export function renderDatabasePage(props: DatabaseProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const collectionsHtml =
    props.collections.length === 0
      ? `<div class="empty">No collection statistics available.</div>`
      : `<table><thead><tr><th>Collection</th><th>Documents (est.)</th></tr></thead><tbody>${props.collections.map((c) => `<tr><td class="mono">${escapeHtml(c.name)}</td><td>${c.count}</td></tr>`).join("")}</tbody></table>`;

  const historyHtml =
    props.trunkHistory.length === 0
      ? `<div class="empty">No prior cleanup runs recorded.</div>`
      : `<table><thead><tr><th>When</th><th>Result</th><th>Sessions removed</th><th>Users processed</th><th>Time</th><th>Errors</th></tr></thead><tbody>${props.trunkHistory
          .map(
            (h) => `<tr>
<td class="muted">${escapeHtml(h.ranAt)}</td>
<td>${h.result === "success" ? '<span class="tag tag-on">ok</span>' : '<span class="tag tag-off">failed</span>'}</td>
<td>${h.sessionsRemoved}</td>
<td>${h.dataAggregated}</td>
<td class="muted">${h.executionMs}ms</td>
<td class="muted">${h.errors === 0 ? "—" : `${h.errors}${h.errorMessage ? `: ${escapeHtml(h.errorMessage.slice(0, 80))}` : ""}`}</td>
</tr>`,
          )
          .join("")}</tbody></table>`;

  const runDisabled = props.trunk.isRunning || !props.trunk.enabled;
  const runHint = !props.trunk.enabled
    ? "Enable <code>voicetracking.cleanup.enabled</code> first."
    : props.trunk.isRunning
      ? "A cleanup is already running."
      : "Same effect as <code>/dbtrunk run</code>. Subject to the 24-hour minimum interval.";

  const body = `
<h1>Database</h1>
<p class="subtitle">MongoDB connection state and the voice-channel <code>dbtrunk</code> cleanup. Replaces <code>/dbtrunk status|run</code>; the slash commands still work in parallel during migration.</p>
${renderFlash(props.flash)}
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
    <dt>Detailed sessions retention</dt><dd>${props.trunk.detailedDays} days</dd>
    <dt>Monthly summaries retention</dt><dd>${props.trunk.monthlyMonths} months</dd>
    <dt>Yearly summaries retention</dt><dd>${props.trunk.yearlyYears} years</dd>
  </dl>
  <form method="POST" action="/admin/database/run-cleanup" class="inline-form" onsubmit="return confirm('Run voice-channel data cleanup now?');">
    ${csrfInput}
    <button type="submit" class="btn btn-primary"${runDisabled ? " disabled" : ""}>Run cleanup now</button>
    <span class="muted">${runHint}</span>
  </form>
</div>
<div class="card">
  <h2>Last 10 cleanup runs</h2>
  ${historyHtml}
</div>
<div class="card"><h2>Collections</h2>${collectionsHtml}</div>
`;
  return renderAdminPage({
    title: "Database",
    active: "/admin/database",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
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
  flash?: FlashMessage | null;
}

export function renderVoiceChannelsPage(props: VoiceChannelsProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
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

  const reloadDisabled = !props.enabled || !props.categoryFound;
  const reloadHint = !props.enabled
    ? "Enable <code>voicechannels.enabled</code> first."
    : !props.categoryFound
      ? "Category not found in this guild."
      : "";

  const body = `
<h1>Voice Channels</h1>
<p class="subtitle">Voice-channel category contents and live state. Replaces <code>/vc reload|force-reload</code>; the slash commands still work in parallel during migration.</p>
${renderFlash(props.flash)}
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
<div class="card">
  <h2>Cleanup actions</h2>
  <form method="POST" action="/admin/voice-channels/reload" class="inline-form" onsubmit="return confirm('Clean up empty dynamic voice channels now?');">
    ${csrfInput}
    <button type="submit" class="btn btn-primary"${reloadDisabled ? " disabled" : ""}>Clean up empty channels</button>
    <span class="muted">Same effect as <code>/vc reload</code>.</span>
  </form>
  <form method="POST" action="/admin/voice-channels/force-reload" class="inline-form" onsubmit="return confirm('Force cleanup of ALL unmanaged channels in the category and re-create lobby channels?');">
    ${csrfInput}
    <button type="submit" class="btn btn-danger"${reloadDisabled ? " disabled" : ""}>Force cleanup &amp; ensure lobby</button>
    <span class="muted">Same effect as <code>/vc force-reload</code>.</span>
  </form>
  ${reloadHint ? `<p class="muted">${reloadHint}</p>` : ""}
</div>
<div class="card"><h2>Channels</h2>${channelsHtml}</div>
`;
  return renderAdminPage({
    title: "Voice Channels",
    active: "/admin/voice-channels",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Command Audit Log ----------

export interface CommandAuditRow {
  createdAt: string;
  discordUserId: string;
  userLabel: string;
  commandName: string;
  subcommand: string | null;
  channelId: string | null;
  channelLabel: string | null;
  result: "success" | "error" | "denied";
  errorMessage: string | null;
  durationMs: number;
}

export interface CommandAuditProps extends CommonProps {
  enabled: boolean;
  retentionDays: number;
  /** All command names registered on the bot — populates the filter dropdown. */
  commandOptions: string[];
  /** All distinct user IDs in the current result page — populates the user filter. */
  userOptions: Array<{ id: string; label: string }>;
  /** Currently-applied filter values, echoed back into the form. */
  filters: {
    commandName: string;
    userId: string;
    result: string;
    from: string;
    to: string;
  };
  rows: CommandAuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

function resultTag(result: "success" | "error" | "denied"): string {
  if (result === "success") return '<span class="tag tag-on">success</span>';
  if (result === "denied") return '<span class="tag tag-warn">denied</span>';
  return '<span class="tag tag-off">error</span>';
}

function buildAuditQueryString(
  filters: CommandAuditProps["filters"],
  page: number,
): string {
  const parts: string[] = [];
  if (filters.commandName)
    parts.push(`command=${encodeURIComponent(filters.commandName)}`);
  if (filters.userId) parts.push(`user=${encodeURIComponent(filters.userId)}`);
  if (filters.result)
    parts.push(`result=${encodeURIComponent(filters.result)}`);
  if (filters.from) parts.push(`from=${encodeURIComponent(filters.from)}`);
  if (filters.to) parts.push(`to=${encodeURIComponent(filters.to)}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export function renderCommandAuditPage(props: CommandAuditProps): string {
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  const page = Math.min(Math.max(1, props.page), totalPages);

  const commandOptionsHtml = props.commandOptions
    .map((c) => {
      const sel = c === props.filters.commandName ? " selected" : "";
      return `<option value="${escapeHtml(c)}"${sel}>/${escapeHtml(c)}</option>`;
    })
    .join("");
  const userOptionsHtml = props.userOptions
    .map((u) => {
      const sel = u.id === props.filters.userId ? " selected" : "";
      return `<option value="${escapeHtml(u.id)}"${sel}>${escapeHtml(u.label)}</option>`;
    })
    .join("");
  const resultOpt = (val: string, label: string): string => {
    const sel = val === props.filters.result ? " selected" : "";
    return `<option value="${escapeHtml(val)}"${sel}>${escapeHtml(label)}</option>`;
  };

  const rowsHtml =
    props.rows.length === 0
      ? `<div class="empty">No command invocations match the current filters.</div>`
      : `<table>
<thead><tr>
<th>When</th><th>User</th><th>Command</th><th>Channel</th>
<th>Result</th><th>Duration</th><th>Error</th>
</tr></thead>
<tbody>${props.rows
          .map((r) => {
            const cmd = r.subcommand
              ? `/${escapeHtml(r.commandName)} ${escapeHtml(r.subcommand)}`
              : `/${escapeHtml(r.commandName)}`;
            return `<tr>
<td class="muted mono">${escapeHtml(r.createdAt)}</td>
<td title="${escapeHtml(r.discordUserId)}">${escapeHtml(r.userLabel)}</td>
<td class="mono">${cmd}</td>
<td class="muted">${escapeHtml(r.channelLabel ?? r.channelId ?? "—")}</td>
<td>${resultTag(r.result)}</td>
<td class="muted">${r.durationMs}ms</td>
<td class="muted">${r.errorMessage ? escapeHtml(r.errorMessage.slice(0, 80)) : "—"}</td>
</tr>`;
          })
          .join("")}</tbody></table>`;

  const prevLink =
    page > 1
      ? `<a class="btn btn-sm" href="/admin/audit/commands${buildAuditQueryString(props.filters, page - 1)}">← Prev</a>`
      : `<button class="btn btn-sm" disabled>← Prev</button>`;
  const nextLink =
    page < totalPages
      ? `<a class="btn btn-sm" href="/admin/audit/commands${buildAuditQueryString(props.filters, page + 1)}">Next →</a>`
      : `<button class="btn btn-sm" disabled>Next →</button>`;

  const body = `
<h1>Slash-command audit log</h1>
<p class="subtitle">One row per Discord slash-command invocation. Raw command arguments are deliberately omitted.</p>

<div class="card">
  <h2>Status</h2>
  <dl class="kv">
    <dt>Audit logging</dt><dd>${props.enabled ? '<span class="tag tag-on">enabled</span>' : '<span class="tag tag-off">disabled</span>'}</dd>
    <dt>Retention</dt><dd>${props.retentionDays} days</dd>
    <dt>Rows matched</dt><dd>${props.total}</dd>
  </dl>
  ${props.enabled ? "" : '<p class="muted">Enable <code>core.command_audit.enabled</code> in Settings to start recording.</p>'}
</div>

<div class="card">
  <h2>Filters</h2>
  <form method="GET" action="/admin/audit/commands" class="inline-form">
    <label>Command
      <select name="command">
        <option value="">— any —</option>
        ${commandOptionsHtml}
      </select>
    </label>
    <label>User
      <select name="user">
        <option value="">— any —</option>
        ${userOptionsHtml}
      </select>
    </label>
    <label>Result
      <select name="result">
        <option value="">— any —</option>
        ${resultOpt("success", "success")}
        ${resultOpt("error", "error")}
        ${resultOpt("denied", "denied")}
      </select>
    </label>
    <label>From
      <input type="date" name="from" value="${escapeHtml(props.filters.from)}">
    </label>
    <label>To
      <input type="date" name="to" value="${escapeHtml(props.filters.to)}">
    </label>
    <button type="submit" class="btn btn-primary btn-sm">Apply</button>
    <a class="btn btn-sm" href="/admin/audit/commands">Reset</a>
  </form>
</div>

<div class="card">
  <h2>Invocations (page ${page} of ${totalPages})</h2>
  ${rowsHtml}
  <div class="inline-form" style="margin-top:.75rem">
    ${prevLink}
    ${nextLink}
    <span class="muted">${props.pageSize} per page</span>
  </div>
</div>
`;
  return renderAdminPage({
    title: "Command audit",
    active: "/admin/audit/commands",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
