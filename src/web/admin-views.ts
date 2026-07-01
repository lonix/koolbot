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
import {
  categoryMetadata,
  getDependencies,
  isEnabledValue,
  settingsMetadata,
  type ConfigSchema,
  type SettingMetadata,
  type SettingOption,
} from "../services/config-schema.js";
import { DAY_NAMES, formatHourLabel } from "../services/rewind-service.js";
import type { BotStatusPool } from "../content/statuses.js";
import type { GuildVoiceHeatmap } from "../services/voice-activity-analytics.js";

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
  /**
   * When present, the value control renders as a `<select>` limited to
   * these choices instead of a free-text input. Sourced from the key's
   * `SettingMetadata.options`.
   */
  options?: SettingOption[];
  /**
   * Soft "minimum recommended value" hint. When `current` is a number below
   * `warnBelow.value`, the settings page renders `warnBelow.message` as a
   * non-blocking inline warning. Sourced from `SettingMetadata.warnBelow`.
   */
  warnBelow?: { value: number; message: string };
  /**
   * Which channel picker a `channel` / `channel_list` control draws from:
   * `"voice"` uses the voice (+ stage) list, anything else (the default) uses
   * the text-channel list. Sourced from `SettingMetadata.channelKind`.
   */
  channelKind?: "text" | "voice";
}

/**
 * An unmet hard dependency for a settings row: a `dependsOn` target that
 * isn't currently enabled. `key` is the dotted target key; `label` is its
 * human name from `settingsMetadata`; `category` is its settings section so
 * the hint can link to it. Computed inside {@link renderSettingsPage} from
 * the `dependsOn` graph (#666) — the same graph the write-time validator
 * (#663) enforces, so the UI hint and the server error never disagree.
 */
interface UnmetDependency {
  key: string;
  label: string;
  category: string;
}

/**
 * Compute which of `key`'s hard `dependsOn` targets are not currently enabled,
 * given the page-wide enabled-state of every key. Returns an empty array when
 * the key declares no dependencies or all of them are on. The enabled-state is
 * derived from the same `current` values the page renders, so the "requires X"
 * hint always matches the toggle states shown alongside it.
 */
function unmetDependenciesFor(
  key: string,
  enabledByKey: Map<string, boolean>,
): UnmetDependency[] {
  const unmet: UnmetDependency[] = [];
  for (const target of getDependencies(key as keyof ConfigSchema)) {
    if (enabledByKey.get(target) === true) continue;
    const meta = settingsMetadata[target];
    unmet.push({
      key: target,
      label: meta?.label ?? target,
      category: meta?.category ?? "",
    });
  }
  return unmet;
}

/**
 * Render the inline "requires X enabled" hint shown under a control whose
 * hard dependencies aren't all met (#666). Each unmet dependency links to its
 * settings section so the operator can jump straight to the toggle that
 * unlocks this one. Returns an empty string when nothing is unmet. Uses the
 * dependency's human label from `settingsMetadata`, mirroring the greyed-nav
 * treatment's muted styling.
 */
export function renderDependencyHint(unmet: UnmetDependency[]): string {
  if (unmet.length === 0) return "";
  const names = unmet
    .map((d) => {
      const label = escapeHtml(d.label);
      return d.category
        ? `<a href="#section-${escapeHtml(d.category)}">${label}</a>`
        : label;
    })
    .join(", ");
  // role="note" keeps this advisory out of the assertive live-region path; the
  // muted-grey tone matches the greyed-nav treatment (admin-layout's
  // `.nav-disabled` colour) so a dependency lock reads as a gentle "not
  // available yet" rather than an error.
  return `<div class="settings-dep-hint" role="note" style="margin-top:.4rem;color:#94a3b8;font-size:.85em">Requires ${names} enabled</div>`;
}

export interface SettingsProps extends CommonProps {
  groups: Array<{ category: string; rows: SettingRow[] }>;
  textChannels: ChannelOption[];
  voiceChannels: ChannelOption[];
  categoryChannels: ChannelOption[];
  roles: RoleOption[];
  /** Guild id of the session, used as the reset-confirmation fallback. */
  guildId: string;
  /** Guild name (when fetchable); the preferred reset-confirmation phrase. */
  guildName: string | null;
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
  const isInt = (s: string): boolean => /^\d+$/.test(s);
  const inRange = (n: number, lo: number, hi: number): boolean =>
    n >= lo && n <= hi;

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

function renderCronPicker(
  currentValue: string,
  valueName: string,
  depLocked = false,
): string {
  const state = parseCronToPickerState(currentValue);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const timeAttr = `${pad(state.hour)}:${pad(state.minute)}`;
  const sel = (cond: boolean): string => (cond ? " selected" : "");
  const hidden = (cond: boolean): string => (cond ? " hidden" : "");
  // When the key's dependency is unmet (#666) every interactive cron control
  // renders disabled; `data-dep-locked` on the visible inputs keeps the cascade
  // script from re-enabling them under an enabled section master. The hidden
  // input is left editable-by-name so the row still round-trips its value.
  const lockAttr = depLocked ? " disabled data-dep-locked" : "";

  const dowOptions = WEEKDAY_NAMES.map(
    (name, i) =>
      `<option value="${i}"${sel(state.dayOfWeek === i)}>${name}</option>`,
  ).join("");

  // The hidden input is what the form actually submits. The bootstrap
  // script in admin-layout keeps it in sync with the controls; it locates
  // the input via the `.cron-hidden` class so the form-field name can vary
  // per row (e.g. `value_<key>` under the per-section save form).
  return (
    `<div class="cron-picker" data-mode="${state.mode}">` +
    `<input type="hidden" class="cron-hidden" name="${escapeHtml(valueName)}" value="${escapeHtml(currentValue)}">` +
    `<select class="cron-mode" aria-label="Schedule type"${lockAttr}>` +
    `<option value="daily"${sel(state.mode === "daily")}>Daily</option>` +
    `<option value="weekly"${sel(state.mode === "weekly")}>Weekly</option>` +
    `<option value="monthly"${sel(state.mode === "monthly")}>Monthly</option>` +
    `<option value="custom"${sel(state.mode === "custom")}>Custom (cron)</option>` +
    `</select>` +
    `<span class="cron-time-wrap"${hidden(state.mode === "custom")}>` +
    ` at <input type="time" class="cron-time" value="${timeAttr}"${lockAttr}>` +
    `</span>` +
    `<span class="cron-dow-wrap"${hidden(state.mode !== "weekly")}>` +
    ` on <select class="cron-dow" aria-label="Day of week"${lockAttr}>${dowOptions}</select>` +
    `</span>` +
    `<span class="cron-dom-wrap"${hidden(state.mode !== "monthly")}>` +
    ` on day <input type="number" class="cron-dom" min="1" max="31" value="${state.dayOfMonth}" style="width:5rem"${lockAttr}>` +
    `</span>` +
    `<span class="cron-custom-wrap"${hidden(state.mode !== "custom")}>` +
    `<input type="text" class="cron-custom" value="${escapeHtml(state.raw)}" placeholder="0 16 * * 5" style="width:12rem"${lockAttr}>` +
    `</span>` +
    `</div>`
  );
}

/**
 * Form-field name for a setting's value inside the per-section save form.
 * Prefixed so the section handler can read each row's value via
 * `req.body[settingValueFieldName(key)]` and so the field can't collide
 * with the form-level `_csrf` / `category` / `keys` / clicked-reset `key`
 * fields. The dotted suffix is kept verbatim — `extended: false` on
 * `express.urlencoded` treats names as opaque strings, so no nesting.
 */
export function settingValueFieldName(key: string): string {
  return `value_${key}`;
}

/**
 * Pick the cascade "master" toggle for a settings section: the boolean
 * `.enabled` key with the fewest dotted segments (the top-level feature
 * switch). Sub-feature toggles like `voicetracking.announcements.enabled`
 * are dependents, not masters. Returns null when the section has no
 * `.enabled` boolean to gate on. Shared by the wizard and Settings page so
 * both surfaces grey out the same way (issue #485).
 */
export function findCascadeMasterKey(rows: SettingRow[]): string | null {
  let master: SettingRow | null = null;
  for (const r of rows) {
    if (r.type !== "boolean" || !r.key.endsWith(".enabled")) continue;
    if (
      master === null ||
      r.key.split(".").length < master.key.split(".").length
    ) {
      master = r;
    }
  }
  return master?.key ?? null;
}

/**
 * Render a single-select `<select>` for a fixed-options setting. Each
 * option's `value` is the raw stored value; `label` is the display text.
 * If the current stored value isn't one of the known options it's surfaced
 * as a selected placeholder so the browser doesn't silently default to the
 * first valid choice and overwrite the out-of-range value on save:
 *   - a non-empty unknown value (stale row, hand-edited DB) shows as
 *     `(unknown) <value>`;
 *   - an empty value shows a neutral `(choose a value)` placeholder.
 * Both round-trip the current value, so on save `coerceConfigValue`
 * rejects it with a clear error and forces the operator to pick.
 */
function renderOptionsSelect(
  valueName: string,
  options: SettingOption[],
  current: string,
  extraAttr = "",
): string {
  const known = options.some((o) => o.value === current);
  const opts = options
    .map((o) => {
      const sel = o.value === current ? " selected" : "";
      return `<option value="${escapeHtml(o.value)}"${sel}>${escapeHtml(o.label)}</option>`;
    })
    .join("");
  const placeholder = known
    ? ""
    : `<option value="${escapeHtml(current)}" selected>${
        current === "" ? "(choose a value)" : `(unknown) ${escapeHtml(current)}`
      }</option>`;
  return `<select name="${valueName}"${extraAttr}>${opts}${placeholder}</select>`;
}

/**
 * Pick the channel option list backing a `channel` / `channel_list` control.
 * Voice-oriented keys (`channelKind: "voice"`, e.g.
 * `voicetracking.excluded_channels`) draw from the voice + stage list; every
 * other channel field keeps the text-channel list. Centralised so both the
 * single- and multi-select branches stay in sync (issue #611).
 */
function channelOptionsFor(
  r: SettingRow,
  pickers: { textChannels: ChannelOption[]; voiceChannels: ChannelOption[] },
): ChannelOption[] {
  return r.channelKind === "voice"
    ? pickers.voiceChannels
    : pickers.textChannels;
}

/**
 * Render a compact, readable summary of the currently-selected entries below a
 * multi-select. A `<select multiple>` buries its picks among unselected rows,
 * and a long voice-exclusion list otherwise reads as an unseparated blob
 * (issue #611); this surfaces them as a clean, comma-separated `#name` /
 * `@name` list. Ids no longer in the live option set render as a `(missing)`
 * entry followed by the raw id, so a stale selection is visible rather than
 * silently dropped (mirroring the `(missing)` option label `buildOptionsHtml`
 * emits). Returns an empty string when nothing is selected.
 */
function renderSelectionSummary(
  options: ChannelOption[] | RoleOption[],
  selected: Set<string>,
  prefix: string,
): string {
  if (selected.size === 0) return "";
  const byId = new Map(options.map((o) => [o.id, o.name]));
  const tokens = Array.from(selected).map((id) => {
    const name = byId.get(id);
    return name ? `${prefix}${name}` : `(missing) ${id}`;
  });
  return (
    `<div class="settings-selected muted" style="margin-top:.4rem;font-size:.85em">` +
    `Selected: ${escapeHtml(tokens.join(", "))}` +
    `</div>`
  );
}

/**
 * Render a setting's value control, plus — when the control is
 * dependency-locked (#666) — a hidden input that round-trips its current value.
 * A `disabled` control isn't submitted by the browser, and the per-section Save
 * handler coerces a missing value to `false`/`""` (see `coerceConfigValue` in
 * write-routes), so without this a dep-locked boolean would be silently flipped
 * off (and other types blanked) whenever its section is saved while the lock is
 * active. The same-section / master-off case is already protected by the
 * cascade-skip in `save-section`, but a cross-section dependent (e.g.
 * `digest.include_achievements` under an enabled digest section) is not.
 *
 * Cron is skipped: it already submits via its own non-disabled `.cron-hidden`
 * input, which carries the `value_<key>` name. The disabled visible control
 * keeps the same name but isn't submitted, so only the hidden value is sent.
 */
function renderSettingControl(
  r: SettingRow,
  pickers: {
    textChannels: ChannelOption[];
    voiceChannels: ChannelOption[];
    categoryChannels: ChannelOption[];
    roles: RoleOption[];
  },
  isCascadeMaster = false,
  depLocked = false,
  controlId = "",
): string {
  const control = renderControlInput(
    r,
    pickers,
    isCascadeMaster,
    depLocked,
    controlId,
  );
  if (!depLocked || r.type === "cron") return control;
  const primitive = coerceToDisplayValue(r.current);
  const roundTrip =
    r.type === "boolean"
      ? primitive === true
        ? "true"
        : "false"
      : escapeHtml(primitive);
  const valueName = escapeHtml(settingValueFieldName(r.key));
  return `<input type="hidden" name="${valueName}" value="${roundTrip}">${control}`;
}

function renderControlInput(
  r: SettingRow,
  pickers: {
    textChannels: ChannelOption[];
    voiceChannels: ChannelOption[];
    categoryChannels: ChannelOption[];
    roles: RoleOption[];
  },
  isCascadeMaster = false,
  depLocked = false,
  // Optional DOM id stamped onto the primary control element so a caller can
  // associate a `<label for>` with it (the wizard does this — issue #703). The
  // Settings page omits it (it labels rows with a `<strong>`, not a `<label>`),
  // so it defaults to "" and adds nothing there. The cron picker manages its
  // own inputs and is left unstamped.
  controlId = "",
): string {
  const primitive = coerceToDisplayValue(r.current);
  const currentStr = typeof primitive === "string" ? primitive : "";
  const valueName = escapeHtml(settingValueFieldName(r.key));
  const idAttr = controlId ? ` id="${escapeHtml(controlId)}"` : "";
  // When a hard dependency is unmet (#666), the control renders disabled so it
  // can't be edited before its requirement is on — the same rule the write-time
  // validator (#663) enforces. `data-dep-locked` tells the cascade-disable
  // script (admin-layout) never to re-enable it when a section master is on, so
  // a dependency lock survives an enabled parent section. The current value is
  // round-tripped via a sibling hidden input in `renderSettingControl` so the
  // disabled (and therefore unsubmitted) control can't be clobbered on Save.
  const lockAttr = depLocked ? " disabled data-dep-locked" : "";

  // Fixed-options keys render as a single-select dropdown regardless of
  // their underlying `type`, so operators pick from the valid set instead
  // of typing a value the server will reject.
  if (r.options && r.options.length > 0) {
    return renderOptionsSelect(
      valueName,
      r.options,
      currentStr,
      lockAttr + idAttr,
    );
  }
  if (r.type === "boolean") {
    const checked = primitive === true ? " checked" : "";
    const masterAttr = isCascadeMaster ? " data-cascade-master" : "";
    return (
      `<label class="checkbox" style="display:inline-flex;gap:.4rem;align-items:center;cursor:pointer">` +
      `<input type="checkbox"${idAttr} name="${valueName}" value="true"${checked}${masterAttr}${lockAttr}> ` +
      `<span class="mono">${primitive === true ? "true" : "false"}</span>` +
      `</label>`
    );
  }
  if (r.type === "number") {
    return `<input type="number"${idAttr} name="${valueName}" value="${escapeHtml(primitive)}" style="width:8rem"${lockAttr}>`;
  }
  if (r.type === "channel" || r.type === "category" || r.type === "role") {
    const options =
      r.type === "channel"
        ? channelOptionsFor(r, pickers)
        : r.type === "category"
          ? pickers.categoryChannels
          : pickers.roles;
    const prefix = r.type === "role" ? "@" : "#";
    const selected = currentStr ? new Set([currentStr]) : new Set<string>();
    return (
      `<select${idAttr} name="${valueName}"${lockAttr}>` +
      buildOptionsHtml(options, selected, prefix, true) +
      `</select>`
    );
  }
  if (r.type === "channel_list" || r.type === "role_list") {
    const options =
      r.type === "channel_list" ? channelOptionsFor(r, pickers) : pickers.roles;
    const prefix = r.type === "role_list" ? "@" : "#";
    const selected = new Set(
      currentStr
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== ""),
    );
    return (
      `<select${idAttr} name="${valueName}" multiple size="${Math.min(8, Math.max(3, options.length))}"${lockAttr}>` +
      buildOptionsHtml(options, selected, prefix, false) +
      `</select>` +
      renderSelectionSummary(options, selected, prefix)
    );
  }
  if (r.type === "cron") {
    return renderCronPicker(
      currentStr,
      settingValueFieldName(r.key),
      depLocked,
    );
  }
  // string or unknown type → plain text input. The maxlength mirrors the
  // server-side `TEXT_LIMITS.configValue` cap in write-routes (#508) — kept as
  // a literal here to avoid a circular import (write-routes imports this file).
  return `<input type="text"${idAttr} name="${valueName}" maxlength="2000" value="${escapeHtml(primitive)}"${lockAttr}>`;
}

/**
 * Per-row Reset submit button. Lives inside the per-section save form and
 * uses HTML5 `formaction` to redirect submission to the single-key reset
 * route. Only the clicked button's `name`/`value` is sent on submission,
 * so the `key=<row-key>` it contributes does not collide with the `keys`
 * hidden inputs the section form uses to enumerate its rows.
 */
function renderResetButton(key: string): string {
  const escaped = escapeHtml(key);
  return (
    `<button type="submit" formaction="/admin/settings/reset" ` +
    `name="key" value="${escaped}" class="btn btn-sm" ` +
    `style="margin-left:.4rem">Reset</button>`
  );
}

/**
 * Render the soft "minimum recommended value" warning when a numeric setting
 * is below its `warnBelow` threshold. Returns an empty string when there's no
 * hint or the value clears the threshold, so it adds nothing to rows that
 * don't need it. Shown unconditionally (not gated on a feature toggle) so the
 * degraded state is visible without editing — and it re-renders after a save.
 */
export function renderWarnBelow(r: SettingRow): string {
  if (!r.warnBelow) return "";
  // Only warn on a value that's genuinely a number below the threshold.
  // An unset key (null/undefined/empty string) renders as a blank input via
  // coerceToDisplayValue, so coercing it to 0 here would flash a misleading
  // warning — guard those out rather than letting Number("") become 0.
  if (r.current === null || r.current === undefined || r.current === "")
    return "";
  const value = typeof r.current === "number" ? r.current : Number(r.current);
  if (!Number.isFinite(value) || value >= r.warnBelow.value) return "";
  // role="status" (implicit aria-live=polite) keeps this persistent advisory
  // from being announced assertively on every page load like role="alert".
  return `<div class="settings-warn" role="status" style="margin-top:.4rem;color:#b45309;font-size:.85em">${escapeHtml(r.warnBelow.message)}</div>`;
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
    voiceChannels: props.voiceChannels,
    categoryChannels: props.categoryChannels,
    roles: props.roles,
  };
  // Page-wide enabled-state of every rendered key, derived from the same
  // `current` values shown in the controls. Dependency hints (#666) read from
  // this so they always agree with the toggle states on the page. A dependency
  // target can live in any section, so this must span all groups, not just one.
  const enabledByKey = new Map<string, boolean>();
  for (const g of props.groups) {
    for (const r of g.rows) {
      enabledByKey.set(r.key, isEnabledValue(r.current));
    }
  }
  const sections = props.groups
    .map((g) => {
      const meta = categoryMetadata[g.category] ?? {
        title: g.category,
        description: "",
      };
      // The section's top-level feature toggle is the cascade master: the
      // shortest `.enabled` boolean key in the section (e.g.
      // `voicechannels.enabled`, not `voicechannels.controlpanel.enabled`).
      // When it's off, every other control in the section greys out and is
      // ignored on save — the save-section handler skips the dependents so
      // they aren't clobbered (issue #485).
      const cascadeMasterKey = findCascadeMasterKey(g.rows);
      const rows = g.rows
        .map((r) => {
          // Grey + disable any control whose hard dependencies aren't all on
          // (#666). `dep-off` is a static row class (not the cascade script's
          // `.cascade-off`), so an enabled section master can't strip the
          // greying off a still-dependency-locked control.
          const unmet = unmetDependenciesFor(r.key, enabledByKey);
          const depLocked = unmet.length > 0;
          const rowClass = depLocked ? ' class="dep-off"' : "";
          return `<tr${rowClass}>
<td>
  <div><strong>${escapeHtml(r.label || r.key)}</strong></div>
  <code class="mono muted" style="font-size:.85em">${escapeHtml(r.key)}</code>
  <input type="hidden" name="keys" value="${escapeHtml(r.key)}">
</td>
<td class="settings-value">${renderSettingControl(r, pickers, r.key === cascadeMasterKey, depLocked)}${renderResetButton(r.key)}${renderWarnBelow(r)}${renderDependencyHint(unmet)}</td>
<td><span class="tag tag-info">${escapeHtml(r.type)}</span></td>
<td class="settings-default">${formatValue(r.defaultValue)}</td>
<td class="muted">${escapeHtml(r.description)}</td>
</tr>`;
        })
        .join("");
      const descHtml = meta.description
        ? `<p class="muted" style="margin:.25rem 0 .75rem">${escapeHtml(meta.description)}</p>`
        : "";
      // One <form> per category. Save submits every row's value in one
      // atomic request; Reset buttons inside the same form use formaction
      // to retarget /admin/settings/reset for a single key (issue #433).
      const scopeAttr = cascadeMasterKey ? " data-cascade-scope" : "";
      return `
<div class="card" id="section-${escapeHtml(g.category)}">
  <h2>${escapeHtml(meta.title)}</h2>
  ${descHtml}
  <form method="POST" action="/admin/settings/save-section"${scopeAttr}>
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="category" value="${escapeHtml(g.category)}">
    <table>
      <thead><tr><th>Setting</th><th>Edit</th><th>Type</th><th>Default</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="actions" style="margin-top:.75rem">
      <button type="submit" class="btn btn-primary">Save</button>
    </div>
  </form>
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

  // Two-step confirm: the JS confirm() guards the click, and the operator
  // must additionally type the guild name (or guild id when the name can't
  // be fetched) into the text field, which the server re-validates. The
  // `required` attribute and `confirmTarget` keep the client and server in
  // step. See `POST /admin/settings/reset-defaults` in write-routes.ts.
  const confirmTarget = props.guildName ?? props.guildId;
  const dangerSection = `
<div id="danger-zone" class="card" style="border-color:#7f1d1d">
  <h2>Danger zone</h2>
  <p class="muted" style="margin:0 0 .75rem">Reset every setting to its built-in default. All keys in the schema are rewritten to their default value, and any orphaned keys left behind by removed features are deleted. Bootstrap / environment variables (Discord token, Mongo URI, WebUI session config) are <strong>not</strong> touched. You may need to <strong>Reload commands</strong> afterwards.</p>
  <form method="POST" action="/admin/settings/reset-defaults" class="stack" onsubmit="return confirm('Reset ALL settings to their defaults? This cannot be undone.');">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label>Type <code>${escapeHtml(confirmTarget)}</code> to confirm:
      <input type="text" name="confirm" autocomplete="off" placeholder="${escapeHtml(confirmTarget)}" required>
    </label>
    <div>
      <button type="submit" class="btn btn-danger">Reset all settings to defaults</button>
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
${dangerSection}
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
  // only feeds the ON/OFF indicator so the admin can see what
  // state they're about to override.
  // Sort enabled/on features to the top and let disabled/off ones sink to the
  // bottom, keeping `featureOrder` as a stable secondary sort within each group
  // (Array.prototype.sort is stable). Pure display-order change (#706).
  const orderedKeys = [...props.featureOrder].sort(
    (a, b) =>
      Number(Boolean(props.featureStatus[b])) -
      Number(Boolean(props.featureStatus[a])),
  );
  const cards = orderedKeys
    .map((fk) => {
      const info = WIZARD_FEATURE_LABELS[fk] ?? { name: fk, desc: "" };
      const currentlyOn = Boolean(props.featureStatus[fk]);
      const indicator = `<span class="fc-current">${tagOnOff(currentlyOn)}</span>`;
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
  metadata: Record<string, SettingMetadata>;
  defaultValues: Record<string, unknown>;
  /**
   * Guild channel/role option lists that back the picker dropdowns, shared
   * verbatim with the Settings page's `renderControlInput` so a channel/role/
   * category key gets a real selector in the wizard instead of a free-text ID
   * box (#702 / #703).
   */
  textChannels: ChannelOption[];
  voiceChannels: ChannelOption[];
  categoryChannels: ChannelOption[];
  roles: RoleOption[];
  /**
   * Enabled-state of every key on this step *plus* the cross-feature
   * dependency targets those keys reference (e.g. `achievements.enabled`
   * depends on `voicetracking.enabled`, which lives on another step). The
   * shared dependency-hint / lock logic (#666) reads this so the wizard greys
   * out the same controls the Settings page does.
   */
  enabledByKey: Record<string, boolean>;
  flash?: FlashMessage | null;
}

export function renderWizardStepPage(props: WizardStepPageProps): string {
  const csrf = escapeHtml(props.csrfToken);
  const info = WIZARD_FEATURE_LABELS[props.featureKey] ?? {
    name: props.featureKey,
    desc: "",
  };

  const pickers = {
    textChannels: props.textChannels,
    voiceChannels: props.voiceChannels,
    categoryChannels: props.categoryChannels,
    roles: props.roles,
  };

  // Build the same `SettingRow` shape the Settings page feeds to
  // `renderControlInput`, so the wizard reuses its rich channel/role/category
  // selectors, multi-selects, fixed-option dropdowns, cron picker and
  // dependency handling instead of the old free-text boxes (#702). Metadata is
  // authoritative for the control type; the runtime type of the default value
  // is only a fallback for keys the schema doesn't describe.
  const rows: SettingRow[] = props.settingKeys.map((k) => {
    const meta = props.metadata[k];
    const defaultVal = props.defaultValues[k];
    const fallbackType =
      typeof defaultVal === "boolean"
        ? "boolean"
        : typeof defaultVal === "number"
          ? "number"
          : "string";
    return {
      key: k,
      label: meta?.label ?? k,
      current: props.currentValues[k],
      defaultValue: defaultVal,
      type: meta?.type ?? fallbackType,
      description: meta?.description ?? "",
      category: meta?.category ?? props.featureKey,
      options: meta?.options,
      warnBelow: meta?.warnBelow,
      channelKind: meta?.channelKind,
    };
  });

  // The feature's top-level `.enabled` toggle is the cascade "master" for this
  // step: when it's off, every other control greys out and is ignored on submit
  // (issue #485). Picked the same way as the Settings page (shortest `.enabled`
  // boolean) so both surfaces cascade identically.
  const masterKey = findCascadeMasterKey(rows);

  // Enabled-state map for the shared dependency-hint / lock logic (#666). The
  // route supplies it (covering cross-feature targets); fall back to this
  // step's own current values so within-feature dependencies still resolve.
  const enabledByKey = new Map<string, boolean>(
    Object.entries(props.enabledByKey),
  );
  for (const r of rows) {
    if (!enabledByKey.has(r.key)) {
      enabledByKey.set(r.key, isEnabledValue(r.current));
    }
  }

  const fields = rows
    .map((r) => {
      // Grey + disable any control whose hard dependencies aren't all on
      // (#666), mirroring the Settings page's `dep-off` treatment.
      const unmet = unmetDependenciesFor(r.key, enabledByKey);
      const depLocked = unmet.length > 0;
      const rowClass = depLocked ? " dep-off" : "";
      // Stamp an id onto the primary control so the human-readable label can
      // associate with it via `for` (#703). The cron picker manages its own
      // inputs and takes no id, so its label is left unassociated rather than
      // pointing `for` at nothing.
      const inputId = `wiz-${r.key}`;
      const control = renderSettingControl(
        r,
        pickers,
        r.key === masterKey,
        depLocked,
        inputId,
      );
      const labelFor = r.type === "cron" ? "" : ` for="${escapeHtml(inputId)}"`;
      // Human-readable label (#702) with the raw dotted key demoted to
      // monospace helper text — the same treatment the Settings page gives its
      // rows, wrapped in a `<label>` so the whole caption stays clickable.
      return `<div class="field-row${rowClass}">
  <label class="field-label"${labelFor}>
    <strong>${escapeHtml(r.label)}</strong>
    <code class="mono muted" style="font-size:.85em">${escapeHtml(r.key)}</code>
  </label>
  ${control}
  ${renderWarnBelow(r)}
  ${renderDependencyHint(unmet)}
  <div class="help">${escapeHtml(r.description)}</div>
</div>`;
    })
    .join("");

  const stepLabel = `Step ${props.stepIndex + 1} of ${props.totalSteps}`;
  const nextLabel =
    props.stepIndex + 1 < props.totalSteps ? "Next →" : "Review →";

  // A "← Previous" link appears on every step after the first. It's a plain
  // GET back to the prior step — the wizard session already holds the saved
  // values, and the step renderer pre-fills from `wizard.getConfiguration`,
  // so navigating back preserves in-progress state without re-submitting
  // this step's form (issue #485).
  const previousButton =
    props.stepIndex >= 1
      ? `<a href="/admin/wizard?step=${props.stepIndex - 1}" class="btn">← Previous</a>`
      : "";

  const body = `
<h1>${escapeHtml(info.name)} <span class="muted" style="font-size:1rem">${escapeHtml(stepLabel)}</span></h1>
<p class="subtitle">${escapeHtml(info.desc)}</p>
${renderFlash(props.flash)}
<form method="POST" action="/admin/wizard/step/${props.stepIndex}" data-cascade-scope>
  <input type="hidden" name="_csrf" value="${csrf}">
  <div class="card">${fields}</div>
  <div class="actions">
    <button type="submit" class="btn btn-primary">${nextLabel}</button>
    ${previousButton}
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

/**
 * Banner shown at the top of a feature page when that feature is disabled
 * (#610). Feature pages are reachable even while off — their nav link is now
 * greyed rather than hidden — so a disabled page must explain the state and
 * offer a way to enable it instead of looking empty or broken. Renders a
 * warning notice with an inline "Enable" action (flips the `<feature>.enabled`
 * flag via the existing /admin/settings/set route and returns to this same
 * page) plus a link to the full Settings surface.
 *
 * Returns "" when `enabled` is true so callers can drop it in unconditionally.
 */
function renderFeatureDisabledNotice(opts: {
  enabled: boolean;
  label: string;
  featureKey: string;
  returnTo: string;
  csrfToken: string;
}): string {
  if (opts.enabled) return "";
  const label = escapeHtml(opts.label);
  return `<div class="notice warn feature-disabled">
  <div class="fd-text"><strong>${label} are disabled.</strong> You can still configure things below, but they won't take effect until you enable the feature. Enable it here, or from Settings.</div>
  <div class="fd-actions">
    <form method="POST" action="/admin/settings/set">
      <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">
      <input type="hidden" name="key" value="${escapeHtml(opts.featureKey)}">
      <input type="hidden" name="value" value="true">
      <input type="hidden" name="redirect" value="${escapeHtml(opts.returnTo)}">
      <button type="submit" class="btn btn-primary">Enable ${label}</button>
    </form>
    <a class="btn btn-secondary" href="/admin/settings">Open Settings</a>
  </div>
</div>`;
}

function channelOptionsHtml(
  options: ChannelOption[],
  selectedId?: string,
): string {
  const rendered = options.map(
    (c) =>
      `<option value="${escapeHtml(c.id)}"${c.id === selectedId ? " selected" : ""}>#${escapeHtml(c.name)}</option>`,
  );
  // Preserve a selected channel that's no longer in the list (deleted, or the
  // bot lost access). Without a matching <option> the browser would default to
  // the first channel, so editing only the cron/duration would silently
  // reassign the schedule's channel on submit. Keep the saved id selectable.
  if (selectedId && !options.some((c) => c.id === selectedId)) {
    rendered.unshift(
      `<option value="${escapeHtml(selectedId)}" selected>#${escapeHtml(selectedId)} (unavailable)</option>`,
    );
  }
  if (rendered.length === 0) {
    return `<option value="">(no text channels available)</option>`;
  }
  return rendered.join("");
}

function roleOptionsHtml(options: RoleOption[], selectedId?: string): string {
  const out = [
    `<option value=""${!selectedId ? " selected" : ""}>(none)</option>`,
  ];
  // Same guard as channels: if the saved ping role is no longer in the list,
  // keep it as a selected option so a cron/duration-only edit doesn't silently
  // clear the role by defaulting the select back to "(none)".
  if (selectedId && !options.some((r) => r.id === selectedId)) {
    out.push(
      `<option value="${escapeHtml(selectedId)}" selected>@${escapeHtml(selectedId)} (unavailable)</option>`,
    );
  }
  out.push(
    ...options.map(
      (r) =>
        `<option value="${escapeHtml(r.id)}"${r.id === selectedId ? " selected" : ""}>@${escapeHtml(r.name)}</option>`,
    ),
  );
  return out.join("");
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
    <li><code>{online_count}</code> — members currently online (best effort; shows 0 without presence data)</li>
    <li><code>{owner}</code> — server owner mention</li>
    <li><code>{boost_count}</code> — active Nitro boosts</li>
    <li><code>{boost_tier}</code> — Nitro boost tier (0–3)</li>
    <li><code>{channel_count}</code> — number of channels</li>
    <li><code>{role_count}</code> — number of roles</li>
    <li><code>{random_member}</code> — a random member mention</li>
    <li><code>{date}</code> — current date</li>
    <li><code>{time}</code> — current time</li>
    <li><code>{day}</code> — current weekday</li>
    <li><code>{month}</code> — current month</li>
    <li><code>{year}</code> — current year</li>
    <li><code>{date_iso}</code> — ISO date (YYYY-MM-DD)</li>
    <li><code>{time_iso}</code> — ISO time (HH:MM:SS, UTC)</li>
    <li><code>{datetime_iso}</code> — full ISO 8601 timestamp (UTC)</li>
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
  <form method="POST" action="/admin/announcements/${escapeHtml(a.id)}/post-now">${csrfInput}<button type="submit" class="btn btn-primary">Post now</button></form>
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
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Announcements", featureKey: "announcements.enabled", returnTo: "/admin/announcements", csrfToken: props.csrfToken })}
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
<div class="card">
  <h2>Compose &amp; send once</h2>
  <p class="subtitle">Post a one-off announcement immediately — no cron schedule is stored.</p>
  <form method="POST" action="/admin/announcements/post-once" class="stack">
    ${csrfInput}
    <label>Channel
      <select name="channelId" required>${channelOptionsHtml(props.textChannels)}</select>
    </label>
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
    <button type="submit" class="btn btn-primary">Post now</button>
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
  channelId: string;
  channelName: string;
  cron: string;
  durationHours: number;
  pingRoleId: string | null;
  pingRoleName: string | null;
  enabled: boolean;
  lastRun: string;
}

export interface PollItemRow {
  id: string;
  question: string;
  answers: string[];
  tags: string[];
  multiSelect: boolean;
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

// Progressive enhancement for the poll-import file picker (#646). Reading the
// chosen file in the browser and dropping its text into the existing textarea
// keeps the form a plain application/x-www-form-urlencoded POST — the router
// only mounts express.urlencoded, so a multipart upload would arrive empty and
// drop the CSRF token. The textarea stays the source of truth: an admin can
// review or edit the loaded content before importing, and paste still works
// with no file selected (the input is optional). Browsers without FileReader
// simply keep the paste-only behaviour.
//
// A file that can't actually be submitted is rejected before it is read: the
// cap is the textarea's own maxlength (the binding limit for what the form
// will POST, well under the server's 2 MB importFromString cap), so an admin
// who fat-fingers a huge file gets a clear message instead of a frozen tab or
// silently truncated content. We compare bytes (file.size) to the char cap —
// for ASCII YAML/JSON these are equal, and any multi-byte slack is caught by
// the defensive slice() after the read.
const POLL_IMPORT_UPLOAD_SCRIPT =
  "(function(){" +
  "var file=document.getElementById('poll-import-file');" +
  "var area=document.getElementById('poll-import-content');" +
  "var msg=document.getElementById('poll-import-msg');" +
  "if(!file||!area||typeof FileReader!=='function')return;" +
  "var cap=area.maxLength&&area.maxLength>0?area.maxLength:200000;" +
  "function note(t){if(msg)msg.textContent=t}" +
  "file.addEventListener('change',function(){" +
  "var f=file.files&&file.files[0];if(!f)return;" +
  "if(typeof f.size==='number'&&f.size>cap){" +
  "file.value='';" +
  "note('File is too large (max '+cap+' characters). Trim it or paste a smaller library.');" +
  "return}" +
  "var reader=new FileReader();" +
  "reader.onerror=function(){note('Could not read that file. Try pasting its contents instead.')};" +
  "reader.onload=function(){var t=String(reader.result||'');" +
  "if(t.length>cap){t=t.slice(0,cap);" +
  "note('File was truncated to '+cap+' characters. Review the box before importing.')}" +
  "else{note('')}" +
  "area.value=t};" +
  "reader.readAsText(f)})})();";

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
  <details class="helper edit-details"><summary>Edit</summary>
    <form method="POST" action="/admin/polls/schedules/${escapeHtml(s.id)}/edit" class="stack">${csrfInput}
      <label>Channel<select name="channelId" required>${channelOptionsHtml(props.textChannels, s.channelId)}</select></label>
      <label>Cron schedule<input type="text" name="cron" value="${escapeHtml(s.cron)}" required></label>
      <label>Duration (hours, 1–768)<input type="number" name="durationHours" min="1" max="768" value="${s.durationHours}" required></label>
      <label>Ping role<select name="pingRoleId">${roleOptionsHtml(props.roles, s.pingRoleId ?? undefined)}</select></label>
      <button type="submit" class="btn btn-primary">Save changes</button>
    </form>
  </details>
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
  <details class="helper edit-details"><summary>Edit</summary>
    <form method="POST" action="/admin/polls/items/${escapeHtml(it.id)}/edit" class="stack">${csrfInput}
      <label>Question<input type="text" name="question" maxlength="300" value="${escapeHtml(it.question)}" required></label>
      <label>Answers (comma-separated, 2–10 options, ≤55 chars each)<input type="text" name="answers" maxlength="600" value="${escapeHtml(it.answers.join(", "))}" required></label>
      <label>Tags (comma-separated, optional)<input type="text" name="tags" value="${escapeHtml(it.tags.join(", "))}"></label>
      <label class="checkbox"><input type="checkbox" name="multiSelect" value="1"${it.multiSelect ? " checked" : ""}> Allow multiple answer selections</label>
      <button type="submit" class="btn btn-primary">Save changes</button>
    </form>
  </details>
  <form method="POST" action="/admin/polls/items/${escapeHtml(it.id)}/toggle">${csrfInput}<button type="submit" class="btn">${it.enabled ? "Disable" : "Enable"}</button></form>
  <form method="POST" action="/admin/polls/items/${escapeHtml(it.id)}/delete" onsubmit="return confirm('Delete poll question?');">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form>
</td>
</tr>`,
    )
    .join("");

  const body = `
<h1>Polls</h1>
<p class="subtitle">Poll schedules and the question library. Replaces <code>/poll create|delete|test|add-item|delete-item|list|list-items</code>; the slash commands still work in parallel during migration.</p>
${renderFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Polls", featureKey: "polls.enabled", returnTo: "/admin/polls", csrfToken: props.csrfToken })}
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
    <label>Answers (comma-separated, 2–10 options, ≤55 chars each)
      <input type="text" name="answers" maxlength="600" placeholder="Yes, No, Maybe" required>
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
  <h2>Import questions</h2>
  <p class="muted">Upload a file or paste a YAML or JSON document shaped as <code>{ polls: [{ question, answers, multiselect?, tags? }] }</code>. Choosing a file loads its contents into the box below; you can review or edit before importing. Duplicate questions (same text) are skipped. Nothing is fetched from the network.</p>
  <form method="POST" action="/admin/polls/items/import-text" class="stack">
    ${csrfInput}
    <label>Upload a file (optional)
      <input type="file" id="poll-import-file" accept=".yaml,.yml,.json,.txt,application/json,application/x-yaml,text/yaml,text/plain">
    </label>
    <p id="poll-import-msg" class="muted" role="status" aria-live="polite"></p>
    <label>Poll library (YAML or JSON)
      <textarea id="poll-import-content" name="content" rows="10" maxlength="200000" placeholder="polls:&#10;  - question: Favourite colour?&#10;    answers: [Red, Green, Blue]&#10;    multiselect: false&#10;    tags: [fun]" required></textarea>
    </label>
    <button type="submit" class="btn btn-primary">Import</button>
  </form>
</div>
<script>${POLL_IMPORT_UPLOAD_SCRIPT}</script>
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
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Reaction Roles", featureKey: "reactionroles.enabled", returnTo: "/admin/reaction-roles", csrfToken: props.csrfToken })}
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
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Notices", featureKey: "notices.enabled", returnTo: "/admin/notices", csrfToken: props.csrfToken })}
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

// ---------- Reusable string-array editor (issue #557) ----------

export interface StringArrayEditorItem {
  id: string;
  order: number;
  text: string;
}

/**
 * Options driving the reusable add / edit / remove / reorder / import /
 * export editor for an arbitrary array of strings. Kept free of any
 * bot-status-specific knowledge so the same partial can be dropped onto
 * accolades / notice-categories / etc. later (the "array of data"
 * generalisation in #557). The route handlers own validation; this only
 * renders the controls.
 */
export interface StringArrayEditorOptions {
  csrfToken: string;
  /** Section heading. */
  title: string;
  /** Optional one-line explanation under the heading. */
  description?: string;
  /**
   * Path prefix the CRUD/import forms post to, e.g. `/admin/bot-status`.
   * Per-entry routes use `${basePath}/entry/:id/...`; collection routes
   * use `${basePath}/pool/:collectionId/...`.
   */
  basePath: string;
  /** Identifier of this array within `basePath` (e.g. the pool name). */
  collectionId: string;
  /** Current stored entries, already in display order. */
  items: StringArrayEditorItem[];
  /** Maximum length accepted for a single entry (drives `maxlength`). */
  maxLength: number;
  /** Optional hint shown beside the add input (e.g. the `{count}` rule). */
  inputHint?: string;
  /** Newline-joined effective list, shown in the export/import textarea. */
  exportText: string;
  /**
   * When set, a banner explains the store is empty and the built-in
   * defaults are in use, alongside a "seed defaults" button.
   */
  defaultsNotice?: string;
}

export function renderStringArrayEditor(
  opts: StringArrayEditorOptions,
): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`;
  const poolPath = `${opts.basePath}/pool/${encodeURIComponent(opts.collectionId)}`;
  const entryPath = (id: string): string =>
    `${opts.basePath}/entry/${encodeURIComponent(id)}`;

  const rows =
    opts.items.length === 0
      ? `<tr><td colspan="3"><span class="muted">No entries stored.</span></td></tr>`
      : opts.items
          .map(
            (item) => `<tr>
<td><form method="POST" action="${entryPath(item.id)}/order" class="inline-order">${csrfInput}<input type="number" name="order" value="${item.order}" min="-1000" max="10000" required><button type="submit" class="btn">Save</button></form></td>
<td>
  <details class="helper edit-details"><summary>${escapeHtml(item.text)}</summary>
    <form method="POST" action="${entryPath(item.id)}/update" class="stack">${csrfInput}
      <label>Text<input type="text" name="text" maxlength="${opts.maxLength}" value="${escapeHtml(item.text)}" required></label>
      <button type="submit" class="btn btn-primary">Save changes</button>
    </form>
  </details>
  <div class="muted mono">id: ${escapeHtml(item.id)}</div>
</td>
<td class="actions"><form method="POST" action="${entryPath(item.id)}/delete" onsubmit="return confirm('Delete this entry?');">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form></td>
</tr>`,
          )
          .join("");

  const defaultsBanner = opts.defaultsNotice
    ? `<div class="notice warn">${escapeHtml(opts.defaultsNotice)}
  <form method="POST" action="${poolPath}/seed" class="inline-form">${csrfInput}<button type="submit" class="btn">Seed defaults into store</button></form>
</div>`
    : "";

  const hint = opts.inputHint
    ? `<span class="muted">${escapeHtml(opts.inputHint)}</span>`
    : "";

  return `<div class="card">
  <h2>${escapeHtml(opts.title)} <span class="muted">(${opts.items.length})</span></h2>
  ${opts.description ? `<p class="subtitle">${escapeHtml(opts.description)}</p>` : ""}
  ${defaultsBanner}
  <table><thead><tr><th>Order</th><th>Text</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
  <form method="POST" action="${poolPath}/add" class="stack">
    ${csrfInput}
    <label>Add entry<input type="text" name="text" maxlength="${opts.maxLength}" required></label>
    ${hint}
    <label>Order<input type="number" name="order" min="-1000" max="10000" value="0" required></label>
    <button type="submit" class="btn btn-primary">Add</button>
  </form>
  <details class="helper">
    <summary>Import / export</summary>
    <form method="POST" action="${poolPath}/import" class="stack">
      ${csrfInput}
      <p class="muted">Paste one entry per line, or a JSON array of strings. Exporting: the textarea below shows the current effective list — copy it to back up.</p>
      <label>Entries<textarea name="items" rows="8">${escapeHtml(opts.exportText)}</textarea></label>
      <label class="inline-form"><input type="radio" name="mode" value="replace" checked> Replace pool</label>
      <label class="inline-form"><input type="radio" name="mode" value="append"> Append to pool</label>
      <button type="submit" class="btn btn-primary">Import</button>
    </form>
  </details>
</div>`;
}

// ---------- Bot Status (issue #557) ----------

export interface BotStatusPoolView {
  pool: BotStatusPool;
  label: string;
  description: string;
  requiresCount: boolean;
  items: StringArrayEditorItem[];
  usingDefaults: boolean;
  exportText: string;
}

export interface BotStatusProps extends CommonProps {
  maxLength: number;
  pools: BotStatusPoolView[];
  flash?: FlashMessage | null;
}

export function renderBotStatusPage(props: BotStatusProps): string {
  const editors = props.pools
    .map((p) =>
      renderStringArrayEditor({
        csrfToken: props.csrfToken,
        title: p.label,
        description: p.description,
        basePath: "/admin/bot-status",
        collectionId: p.pool,
        items: p.items,
        maxLength: props.maxLength,
        inputHint: p.requiresCount
          ? "Must contain the {count} placeholder."
          : undefined,
        exportText: p.exportText,
        defaultsNotice: p.usingDefaults
          ? "This pool has no stored entries — the bot is using its built-in defaults. Add, import, or seed below to customise."
          : undefined,
      }),
    )
    .join("");

  const body = `
<h1>Bot Status</h1>
<p class="subtitle">The "Watching …" presence messages the bot rotates through, picked by how many users are in voice. Edit, import, or export each pool below — changes take effect without a redeploy. Empty pools fall back to the built-in defaults.</p>
${renderFlash(props.flash)}
${editors}
`;
  return renderAdminPage({
    title: "Bot Status",
    active: "/admin/bot-status",
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
  /**
   * The editable `voicechannels.*` settings rendered in-place on the feature
   * page (#705). Built from the config schema the same way the Settings page
   * builds its rows, so the shared control renderer produces a category
   * picker, text fields, toggles, etc.
   */
  settingRows: SettingRow[];
  /** Category options backing the `voicechannels.category_id` picker. */
  categoryChannels: ChannelOption[];
  flash?: FlashMessage | null;
}

/**
 * The editable settings card on the Voice Channels feature page (#705). Renders
 * the `voicechannels.*` keys with the same control renderer the Settings page
 * uses, so category is a picker, lobby names / prefix / suffix are text fields,
 * and the control-panel / presets flags are toggles. Posts through the shared
 * `/admin/settings/save-section` route with `redirect` back to this page and
 * `no_cascade` set — this form has no section master toggle (that is
 * `voicechannels.enabled`, owned by the enable notice above), so every
 * submitted key must be written rather than skipped by the cascade rule.
 */
function renderVoiceChannelsSettings(props: VoiceChannelsProps): string {
  if (props.settingRows.length === 0) return "";
  const pickers = {
    textChannels: [] as ChannelOption[],
    voiceChannels: [] as ChannelOption[],
    categoryChannels: props.categoryChannels,
    roles: [] as RoleOption[],
  };
  const rows = props.settingRows
    .map(
      (r) => `<tr>
<td>
  <div><strong>${escapeHtml(r.label || r.key)}</strong></div>
  <code class="mono muted" style="font-size:.85em">${escapeHtml(r.key)}</code>
  <input type="hidden" name="keys" value="${escapeHtml(r.key)}">
</td>
<td class="settings-value">${renderControlInput(r, pickers)}${renderResetButton(r.key)}${renderWarnBelow(r)}</td>
<td><span class="tag tag-info">${escapeHtml(r.type)}</span></td>
<td class="muted">${escapeHtml(r.description)}</td>
</tr>`,
    )
    .join("");
  return `
<div class="card">
  <h2>Settings</h2>
  <p class="muted" style="margin:.25rem 0 .75rem">Change voice-channel settings here without leaving the page. Saved through the shared settings route.</p>
  <form method="POST" action="/admin/settings/save-section">
    <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
    <input type="hidden" name="category" value="voicechannels">
    <input type="hidden" name="redirect" value="/admin/voice-channels">
    <input type="hidden" name="no_cascade" value="1">
    <table>
      <thead><tr><th>Setting</th><th>Edit</th><th>Type</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="actions" style="margin-top:.75rem">
      <button type="submit" class="btn btn-primary">Save settings</button>
    </div>
  </form>
</div>`;
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
<p class="subtitle">Voice-channel category contents and live state. Replaces <code>/vc force-reload</code>; for the gentler empty-channel cleanup use <code>/vc reload</code>. The slash commands still work in parallel during migration.</p>
${renderFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Voice Channels", featureKey: "voicechannels.enabled", returnTo: "/admin/voice-channels", csrfToken: props.csrfToken })}
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
${renderVoiceChannelsSettings(props)}
<div class="card">
  <h2>Cleanup actions</h2>
  <form method="POST" action="/admin/voice-channels/force-reload" class="inline-form" onsubmit="return confirm('Force cleanup of ALL unmanaged channels in the category and re-create lobby channels?');">
    ${csrfInput}
    <button type="submit" class="btn btn-danger"${reloadDisabled ? " disabled" : ""}>Force VC cleanup</button>
    <span class="muted">Removes ALL unmanaged channels in the category and re-creates the lobby. Same effect as <code>/vc force-reload</code>.</span>
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

// ---------- Digest (#539) ----------

export interface DigestPreviewEntryView {
  username: string;
  rank: number;
  title: string;
  description: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  footer: string;
}

export interface DigestPreviewView {
  generatedAt: string;
  weekRange: string;
  qualifying: number;
  optedIn: number;
  skippedOptOut: number;
  alreadySentAt: string | null;
  includeAchievements: boolean;
  limit: number;
  entries: DigestPreviewEntryView[];
}

export interface DigestProps extends CommonProps {
  enabled: boolean;
  cron: string;
  minActiveMinutes: number;
  streakMinMinutes: number;
  includeAchievements: boolean;
  /** Populated only when a preview was requested (`?preview=1`). */
  preview: DigestPreviewView | null;
  flash?: FlashMessage | null;
}

/**
 * Render one dry-run digest embed as an HTML approximation of the Discord
 * embed the user would be DM'd. We mirror the embed's structure (title,
 * description, inline/full-width fields, footer) so an admin previewing
 * sees the real output, not just counts.
 */
function renderDigestEmbedCard(entry: DigestPreviewEntryView): string {
  const fieldsHtml = entry.fields
    .map(
      (f) => `<div class="digest-field${f.inline ? " inline" : ""}">
  <div class="digest-field-name">${escapeHtml(f.name)}</div>
  <div class="digest-field-value">${escapeHtml(f.value).replace(/\n/g, "<br>")}</div>
</div>`,
    )
    .join("");

  return `<div class="digest-embed">
  <div class="digest-embed-head">
    <span class="tag tag-info">#${entry.rank}</span>
    <strong>${escapeHtml(entry.username)}</strong>
  </div>
  <div class="digest-embed-title">${escapeHtml(entry.title)}</div>
  <div class="digest-embed-desc">${escapeHtml(entry.description)}</div>
  <div class="digest-fields">${fieldsHtml}</div>
  <div class="digest-embed-footer">${escapeHtml(entry.footer).replace(/\n/g, "<br>")}</div>
</div>`;
}

export function renderDigestPage(props: DigestProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;

  const sendDisabled = !props.enabled;
  const sendHint = !props.enabled
    ? "Enable <code>digest.enabled</code> first."
    : "Fires the digest immediately — the same path the cron runs, including DM delivery. Concurrent runs coalesce, so this is safe to click during a scheduled tick.";

  let previewHtml = "";
  if (props.preview) {
    const p = props.preview;
    const sentLabel = p.alreadySentAt
      ? `already sent at ${escapeHtml(p.alreadySentAt)}`
      : "digest has not been sent yet this week";
    const summary = `<strong>${p.qualifying}</strong> member${p.qualifying === 1 ? "" : "s"} qualify · <strong>${p.optedIn}</strong> opted in · <strong>${p.skippedOptOut}</strong> opted out (would be skipped) · ${sentLabel}`;

    const achievementsNote = p.includeAchievements
      ? ""
      : `<p class="muted">Achievements are excluded from the digest (<code>digest.include_achievements</code> is off).</p>`;

    const dmsNote = `<p class="muted">Users with DMs closed can't be detected without sending — those skips only show up on a real run.</p>`;

    const capNote =
      p.optedIn > p.entries.length
        ? `<p class="muted">Showing the top ${p.entries.length} of ${p.optedIn} opted-in members (capped at ${p.limit}).</p>`
        : "";

    const embeds =
      p.entries.length === 0
        ? `<div class="empty">No opted-in members qualify for the digest this week.</div>`
        : p.entries.map(renderDigestEmbedCard).join("");

    previewHtml = `<div class="card">
  <h2>Preview <span class="muted">(week of ${escapeHtml(p.weekRange)})</span></h2>
  <div class="notice">${summary}</div>
  ${achievementsNote}
  ${dmsNote}
  ${capNote}
  ${embeds}
  <p class="muted">Generated ${escapeHtml(p.generatedAt)}. No DMs were sent and nothing was written.</p>
</div>`;
  }

  const body = `
<style>
.digest-embed{border-left:4px solid #5865f2;background:#1f2430;border-radius:4px;padding:.75rem 1rem;margin:.75rem 0}
.digest-embed-head{display:flex;gap:.5rem;align-items:center;margin-bottom:.35rem;font-size:.9rem}
.digest-embed-title{font-weight:600;margin-bottom:.25rem}
.digest-embed-desc{color:#cbd5e1;margin-bottom:.6rem}
.digest-fields{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem}
.digest-field{flex:1 1 100%}
.digest-field.inline{flex:1 1 28%;min-width:120px}
.digest-field-name{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:#94a3b8}
.digest-field-value{color:#e2e8f0}
.digest-embed-footer{margin-top:.75rem;padding-top:.5rem;border-top:1px solid #2d3748;font-size:.78rem;color:#94a3b8}
</style>
<h1>Weekly Digest</h1>
<p class="subtitle">Preview the weekly voice digest before it sends — a dry run of the same query and embeds the cron job DMs to qualifying members, with no DMs sent. Configure the thresholds and schedule under <a href="/admin/settings">Settings</a>.</p>
${renderFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Weekly Digest", featureKey: "digest.enabled", returnTo: "/admin/digest", csrfToken: props.csrfToken })}
<div class="card">
  <h2>Configuration</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.enabled, "enabled", "disabled")}</dd>
    <dt>Schedule</dt><dd class="mono">${escapeHtml(props.cron || "(unset)")}</dd>
    <dt>Minimum active time to qualify</dt><dd>${props.minActiveMinutes} min/week</dd>
    <dt>Minimum time counting toward a streak</dt><dd>${props.streakMinMinutes} min/week</dd>
    <dt>Include achievements</dt><dd>${tagOnOff(props.includeAchievements, "yes", "no")}</dd>
  </dl>
</div>
<div class="card">
  <h2>Actions</h2>
  <form method="GET" action="/admin/digest" class="inline-form">
    <button type="submit" name="preview" value="1" class="btn btn-primary"${props.enabled ? "" : " disabled"}>Preview digest</button>
    <span class="muted">Renders the digest for the most recent complete week without sending anything.</span>
  </form>
  <form method="POST" action="/admin/digest/send-now" class="inline-form" style="margin-top:.75rem" onsubmit="return confirm('Send the weekly digest to all qualifying members right now?');">
    ${csrfInput}
    <button type="submit" class="btn btn-danger"${sendDisabled ? " disabled" : ""}>Send now</button>
    <span class="muted">${sendHint}</span>
  </form>
</div>
${previewHtml}
`;
  return renderAdminPage({
    title: "Weekly Digest",
    active: "/admin/digest",
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

// ---------- Command Metrics (issue #648) ----------

export interface CommandMetricsRow {
  command: string;
  usageCount: number;
  errorCount: number;
  /** errorCount / usageCount, in the range 0..1. */
  errorRate: number;
  avgResponseMs: number;
  lastUsedAt: string | null;
}

export interface CommandMetricsDailyView {
  date: string;
  usageCount: number;
  errorCount: number;
}

export interface CommandMetricsProps extends CommonProps {
  enabled: boolean;
  retentionDays: number;
  /** Selected trailing window in days (7 or 30). */
  windowDays: number;
  totalUsage: number;
  totalErrors: number;
  /** Per-command rollup, sorted by usage descending. */
  rows: CommandMetricsRow[];
  /** Per-day totals over the window, sorted by date ascending. */
  dailyTotals: CommandMetricsDailyView[];
}

/** Error rate (as a fraction) at or above which a command is "spotlit". */
const METRICS_ERROR_SPOTLIGHT = 0.1;

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function errorRateTag(rate: number): string {
  if (rate >= METRICS_ERROR_SPOTLIGHT) {
    return `<span class="tag tag-off">${formatPct(rate)}</span>`;
  }
  if (rate > 0) {
    return `<span class="tag tag-warn">${formatPct(rate)}</span>`;
  }
  return `<span class="tag tag-on">0%</span>`;
}

export function renderCommandMetricsPage(props: CommandMetricsProps): string {
  const windowToggle = [7, 30]
    .map((w) => {
      const active = w === props.windowDays;
      const cls = active ? "btn btn-sm btn-primary" : "btn btn-sm";
      return `<a class="${cls}" href="/admin/metrics?window=${w}">${w}d</a>`;
    })
    .join(" ");

  const usageRowsHtml =
    props.rows.length === 0
      ? `<div class="empty">No command metrics recorded in the last ${props.windowDays} days.</div>`
      : `<table>
<thead><tr>
<th>Command</th><th>Invocations</th><th>Error rate</th><th>Avg response</th><th>Last used</th>
</tr></thead>
<tbody>${props.rows
          .map(
            (r) => `<tr>
<td class="mono">/${escapeHtml(r.command)}</td>
<td>${r.usageCount}</td>
<td>${errorRateTag(r.errorRate)} <span class="muted">(${r.errorCount})</span></td>
<td class="muted">${formatMs(r.avgResponseMs)}</td>
<td class="muted mono">${r.lastUsedAt ? escapeHtml(r.lastUsedAt) : "—"}</td>
</tr>`,
          )
          .join("")}</tbody></table>`;

  const spotlight = props.rows.filter(
    (r) => r.errorRate >= METRICS_ERROR_SPOTLIGHT,
  );
  const spotlightHtml =
    spotlight.length === 0
      ? `<p class="muted">No command exceeded a ${formatPct(METRICS_ERROR_SPOTLIGHT)} error rate. 🎉</p>`
      : `<table>
<thead><tr><th>Command</th><th>Error rate</th><th>Errors</th><th>Invocations</th></tr></thead>
<tbody>${spotlight
          .map(
            (r) => `<tr>
<td class="mono">/${escapeHtml(r.command)}</td>
<td>${errorRateTag(r.errorRate)}</td>
<td>${r.errorCount}</td>
<td class="muted">${r.usageCount}</td>
</tr>`,
          )
          .join("")}</tbody></table>`;

  const slowest = [...props.rows]
    .filter((r) => r.usageCount > 0)
    .sort((a, b) => b.avgResponseMs - a.avgResponseMs)
    .slice(0, 10);
  const slowestHtml =
    slowest.length === 0
      ? `<div class="empty">No data yet.</div>`
      : `<table>
<thead><tr><th>Command</th><th>Avg response</th><th>Invocations</th></tr></thead>
<tbody>${slowest
          .map(
            (r) => `<tr>
<td class="mono">/${escapeHtml(r.command)}</td>
<td>${formatMs(r.avgResponseMs)}</td>
<td class="muted">${r.usageCount}</td>
</tr>`,
          )
          .join("")}</tbody></table>`;

  const maxDaily = props.dailyTotals.reduce(
    (max, d) => Math.max(max, d.usageCount),
    0,
  );
  const trendHtml =
    props.dailyTotals.length === 0
      ? `<div class="empty">No data yet.</div>`
      : props.dailyTotals
          .map((d) => {
            const pct = maxDaily > 0 ? (d.usageCount / maxDaily) * 100 : 0;
            return `<div class="field-row" style="align-items:center;gap:.75rem">
<span class="muted mono" style="min-width:6rem">${escapeHtml(d.date)}</span>
<span style="flex:1;background:#1e293b;border-radius:4px;overflow:hidden">
  <span style="display:block;height:1rem;width:${pct.toFixed(1)}%;background:#3b82f6"></span>
</span>
<span class="mono" style="min-width:3rem;text-align:right">${d.usageCount}</span>
</div>`;
          })
          .join("");

  const body = `
<h1>Command metrics</h1>
<p class="subtitle">Historical per-command usage, error rate, and latency persisted to MongoDB. Complements the live in-memory view and the Prometheus <code>/metrics</code> endpoint.</p>

<div class="card">
  <h2>Overview</h2>
  <dl class="kv">
    <dt>Persistence</dt><dd>${props.enabled ? '<span class="tag tag-on">enabled</span>' : '<span class="tag tag-off">disabled</span>'}</dd>
    <dt>Retention</dt><dd>${props.retentionDays} days</dd>
    <dt>Window</dt><dd>${props.windowDays} days &nbsp; ${windowToggle}</dd>
    <dt>Total invocations</dt><dd>${props.totalUsage}</dd>
    <dt>Total errors</dt><dd>${props.totalErrors}</dd>
  </dl>
  ${props.enabled ? "" : '<p class="muted">Enable <code>monitoring.metrics_persistence.enabled</code> in Settings to start recording. Counts already shown were captured before it was disabled.</p>'}
</div>

<div class="card">
  <h2>Commands by usage</h2>
  ${usageRowsHtml}
</div>

<div class="card">
  <h2>Error spotlight</h2>
  <p class="subtitle">Commands with an error rate at or above ${formatPct(METRICS_ERROR_SPOTLIGHT)} over the window.</p>
  ${spotlightHtml}
</div>

<div class="card">
  <h2>Slowest commands</h2>
  ${slowestHtml}
</div>

<div class="card">
  <h2>Usage trend</h2>
  ${trendHtml}
</div>
`;
  return renderAdminPage({
    title: "Command metrics",
    active: "/admin/metrics",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Voice Analytics (#675, Part B) ----------

export interface AnalyticsProps extends CommonProps {
  /** Whether `voicetracking.enabled` is on; drives the disabled-state notice. */
  enabled: boolean;
  /** Trailing window in days the heatmap covers. */
  windowDays: number;
  /** The aggregated guild-wide heatmap (already bucketed by the service). */
  heatmap: GuildVoiceHeatmap;
}

/** Compact "X hr Y min" / "X min" label for a whole-minute weight. */
function heatMinutes(minutes: number): string {
  if (minutes <= 0) return "0 min";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  if (mins === 0) return `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

export function renderAnalyticsPage(props: AnalyticsProps): string {
  const { heatmap } = props;
  const windowToggle = [7, 30, 90]
    .map((w) => {
      const active = w === props.windowDays;
      const cls = active ? "btn btn-sm btn-primary" : "btn btn-sm";
      return `<a class="${cls}" href="/admin/analytics?window=${w}">${w}d</a>`;
    })
    .join(" ");

  const disabledNotice = props.enabled
    ? ""
    : '<div class="card"><p class="muted">Voice tracking is currently disabled (<code>voicetracking.enabled</code>), so no new sessions are being recorded. Any data below was captured before it was turned off.</p></div>';

  // Largest single cell drives the colour intensity scale.
  const maxCell = heatmap.matrix.reduce(
    (max, row) => row.reduce((m, v) => (v > m ? v : m), max),
    0,
  );

  let grid = "";
  if (heatmap.totalMinutes <= 0) {
    grid = `<div class="empty">No voice activity recorded in the last ${props.windowDays} days.</div>`;
  } else {
    const header =
      '<div class="hg-corner"></div>' +
      Array.from({ length: 24 }, (_unused, h) => {
        // Label every third hour to keep the axis readable.
        const label = h % 3 === 0 ? String(h).padStart(2, "0") : "";
        return `<div class="hg-col">${label}</div>`;
      }).join("");

    const rows = heatmap.matrix
      .map((row, day) => {
        const cells = row
          .map((minutes, hour) => {
            const alpha =
              maxCell > 0 && minutes > 0
                ? Math.max(0.08, minutes / maxCell)
                : 0;
            const isPeak =
              heatmap.peak !== null &&
              heatmap.peak.day === day &&
              heatmap.peak.hour === hour;
            const style =
              alpha > 0
                ? ` style="background:rgba(129,140,248,${alpha.toFixed(3)})"`
                : "";
            const cls = isPeak ? "hg-cell peak" : "hg-cell";
            const title = `${escapeHtml(DAY_NAMES[day])} ${escapeHtml(formatHourLabel(hour))} — ${escapeHtml(heatMinutes(minutes))}`;
            return `<div class="${cls}"${style} title="${title}"></div>`;
          })
          .join("");
        return `<div class="hg-rowlabel">${escapeHtml(DAY_NAMES[day].slice(0, 3))}</div>${cells}`;
      })
      .join("");

    grid = `<div class="heatgrid">${header}${rows}</div>`;
  }

  const peakLine = heatmap.peak
    ? `<dt>Busiest slot</dt><dd>${escapeHtml(DAY_NAMES[heatmap.peak.day])} at ${escapeHtml(formatHourLabel(heatmap.peak.hour))} <span class="muted">(${escapeHtml(heatMinutes(heatmap.peak.minutes))})</span></dd>`
    : "";

  const maxDay = heatmap.byDay.reduce((m, v) => (v > m ? v : m), 0);
  const dayBars = heatmap.byDay
    .map((v, d) => {
      const pct = maxDay > 0 ? (v / maxDay) * 100 : 0;
      return `<div class="hbar"><span class="lbl">${escapeHtml(DAY_NAMES[d].slice(0, 3))}</span><span class="track"><span class="fill" style="width:${pct.toFixed(1)}%"></span></span><span class="val">${escapeHtml(heatMinutes(v))}</span></div>`;
    })
    .join("");

  const maxHour = heatmap.byHour.reduce((m, v) => (v > m ? v : m), 0);
  const hourBars = heatmap.byHour
    .map((v, h) => {
      const pct = maxHour > 0 ? (v / maxHour) * 100 : 0;
      return `<div class="hbar"><span class="lbl">${escapeHtml(formatHourLabel(h))}</span><span class="track"><span class="fill" style="width:${pct.toFixed(1)}%"></span></span><span class="val">${escapeHtml(heatMinutes(v))}</span></div>`;
    })
    .join("");

  const body = `
<h1>Voice analytics</h1>
<p class="subtitle">Guild-wide voice activity by hour and weekday, aggregated from tracked sessions. Use it to pick high-reach times for digests, announcements, and polls.</p>
${disabledNotice}
<div class="card">
  <h2>Overview</h2>
  <dl class="kv">
    <dt>Window</dt><dd>${props.windowDays} days &nbsp; ${windowToggle}</dd>
    <dt>Timezone</dt><dd class="mono">${escapeHtml(heatmap.timeZone)}</dd>
    <dt>Total voice time</dt><dd>${escapeHtml(heatMinutes(heatmap.totalMinutes))}</dd>
    ${peakLine}
  </dl>
  <p class="muted">Each cell is total voice minutes for that hour×weekday; darker is busier. Sessions are bucketed by their start time in the server timezone.</p>
</div>

<div class="card">
  <h2>Hour × weekday heatmap</h2>
  ${grid}
</div>

<div class="card">
  <h2>By weekday</h2>
  <div class="heat-bars">${dayBars}</div>
</div>

<div class="card">
  <h2>By hour of day</h2>
  <div class="heat-bars">${hourBars}</div>
</div>
`;
  return renderAdminPage({
    title: "Voice analytics",
    active: "/admin/analytics",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
