/**
 * Read-only page renderers for #381. Each renderer takes already-shaped
 * data so the route handler stays thin and the renderer is testable
 * without a Discord client or MongoDB.
 */

import { CONFIRM_NEUTRAL_ATTR, confirmListAttr, scriptTag } from "./html.js";
import {
  EVENT_WHEN_CHOICES,
  EVENT_WHEN_LABELS,
  EVENT_WHEN_SCRIPT,
} from "./event-when.js";
import {
  channelGroupLabel,
  channelKindOf,
  channelMention,
  channelText,
  missingText,
  roleText,
} from "./discord-labels.js";
import { ChannelType } from "discord.js";
import {
  ACTION_WORDS,
  CASE_OUTCOME_WORDS,
  CASE_STATUS_WORDS,
  DECISION_CONFIRM_TEXT,
  DECISION_LABELS,
  PERMANENT_CONFIRM_ITEMS,
  REVIEW_JOB_NOTE,
} from "../utils/moderation-labels.js";
import { icon } from "./icons.js";
import { renderSaveBar } from "./savebar.js";
import {
  pickPreset,
  renderColourInput,
  renderDurationPresets,
  renderEmojiField,
  renderReactionRoleMessageSelect,
  renderStepper,
  renderTimezoneSelect,
} from "./setting-pickers.js";
import type { ReactionRoleMessageOptions } from "./reaction-role-messages.js";
import { getServerTimezone } from "../utils/timezone.js";
import type { SettingFormat } from "../utils/setting-formats.js";
import {
  CHEVRON_ICON,
  SETTINGS_FOLD_SCRIPT,
  renderStatusLine,
  settingHref,
} from "./feature-page.js";
import { hostPanelPath } from "./host-panel-shared.js";
import { renderEndEventForm } from "./event-end-view.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { sanitizeCronExpression } from "../utils/cron.js";
import { pickCascadeMasterKey } from "./cascade-master.js";
import {
  buildSettingTree,
  renderChangedMark,
  renderManagedValue,
  renderNumberInput,
  renderResetControl,
  renderSegmented,
  renderSwitch,
  segmentedFits,
  splitDescription,
  type SettingNode,
} from "./setting-controls.js";
import { MAX_TIER_TOP_N } from "./leaderboard-tiers.js";
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
import { COVER_MAX_BYTES } from "../services/event-cover.js";
import { EVENT_COVER_UPLOAD_SCRIPT } from "./event-cover-upload.js";
import {
  CHANNEL_LEAD_MAX,
  CHANNEL_LEAD_MIN,
  DEFAULT_GROUP_LABEL,
  DEFAULT_LEADER_LABEL,
  GROUP_FORM_FIELDS,
  GROUP_FORM_MAX_ROWS,
  GROUP_LABEL_MAX,
  GROUP_MARKER_MAX_CHARS,
  GROUP_NAME_MAX,
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  GROUP_TAG_MAX,
  resolveGroupCountLimits,
} from "../services/event-groups.js";
import {
  EVENT_GROUP_PRESETS,
  LIBRARY_PRESET_PREFIX,
  PERSONAL_PRESET_PREFIX,
  type EventGroupPreset,
} from "../content/event-group-presets.js";
import {
  MARKER_COLOURS,
  deriveTagScript,
  groupRowsScript,
} from "./event-group-form.js";
import type { GroupFormPrefill } from "../services/event-last-setup-service.js";
import {
  MAX_GROUP_ENTRIES,
  reactionRoleGroupPresets,
} from "../content/reaction-role-groups.js";
import { MONTH_NAMES } from "./user-layout.js";
import type { BotStatusPool } from "../content/statuses.js";
import type { GuildVoiceHeatmap } from "../services/voice-activity-analytics.js";
import type {
  ModerationAction,
  ModerationSource,
} from "../models/moderation-log.js";
import type { TicketStatus } from "../models/ticket.js";
import type { CaseGroups, CaseView } from "./moderation-case-groups.js";
import type { VersionCheckSnapshot } from "../services/version-check-service.js";
import { ROLE_GROUP_SETTING_KEYS } from "../services/role-group-access.js";
import { renderDashboardBody, renderVersionCard } from "./dashboard-view.js";
import type { DashboardData } from "./dashboard-data.js";
import { renderAccessReview, renderWizardSteps } from "./wizard-access-view.js";
import type { HostReview } from "../services/wizard-host-role.js";
import {
  renderPermissionNotice,
  type PermissionNotice,
} from "./permission-notice.js";
import type { AccessChange, AccessGap } from "../services/wizard-access.js";

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

/** "1 schedule", "3 schedules". */
function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function tagOnOff(on: boolean, onLabel = "ON", offLabel = "OFF"): string {
  return `<span class="tag ${on ? "tag-on" : "tag-off"}">${on ? onLabel : offLabel}</span>`;
}

// ---------- Dashboard ----------

export interface DashboardProps extends CommonProps {
  /** What the page reads, each source on its own (see `dashboard-data.ts`). */
  data: DashboardData;
  /** Update-check result (#1029). Omitted: the Version tile says nothing is known. */
  version?: VersionCheckSnapshot;
  flash?: FlashMessage | null;
}

// The Version panel moved with the Dashboard (#1322); the name stays importable from here.
export { renderVersionCard };

/** Consequence lists for the confirmation dialogs (#1343); see `confirmListAttr`. */
export const REACTION_ROLE_DELETE_ITEMS: readonly string[] = [
  "The reaction message is deleted.",
  "If no other mapping uses the role, the role is deleted and members lose it.",
  "If no other mapping uses the role, its category is deleted with every channel in it, including channels added by hand and their history.",
  "If another mapping uses the role, the role and category are kept.",
  "This cannot be undone.",
];
const REACTION_ROLE_DELETE_LIST = confirmListAttr(REACTION_ROLE_DELETE_ITEMS);
export const REACTION_ROLE_GROUP_DELETE_ITEMS: readonly string[] = [
  "The shared reaction message is deleted.",
  "If the bot created every mapping, the group's category is deleted with every channel in it, including channels added by hand and their history.",
  "If any mapping uses an existing category, that category and its channels are kept.",
  "Roles the bot created are deleted; reused roles, and roles a mapping outside the group still uses, are kept.",
  "This cannot be undone.",
];
const REACTION_ROLE_GROUP_DELETE_LIST = confirmListAttr(
  REACTION_ROLE_GROUP_DELETE_ITEMS,
);
const EVENT_CANCEL_COMMON = [
  "Its announcement post is updated to show it as cancelled.",
  "Channels the bot made for it are removed.",
];
/** Discord's side of a cancel depends on event sync and on who made the event. */
function eventCancelDiscordLine(adopted: boolean): string {
  return adopted
    ? "Its Discord event was adopted, so it is left unchanged in Discord."
    : "With event sync on, its Discord event is cancelled, or marked completed if it has already started.";
}
export function eventCancelItems(
  adopted: boolean,
  recurring: boolean,
): string[] {
  return [
    recurring
      ? "This occurrence is marked cancelled and stops running."
      : "The event is marked cancelled and stops running.",
    ...EVENT_CANCEL_COMMON,
    eventCancelDiscordLine(adopted),
    ...(recurring ? ["The series continues with its next occurrence."] : []),
  ];
}
function eventCancelList(adopted: boolean, recurring: boolean): string {
  return confirmListAttr(eventCancelItems(adopted, recurring));
}
export const EVENT_CANCEL_SERIES_ITEMS: readonly string[] = [
  "Every unfinished occurrence of the series is marked cancelled, and no further ones are created.",
  "Their announcement posts are updated to show them as cancelled.",
  "Channels the bot made for them are removed.",
  "With event sync on, Discord events the bot created are cancelled or marked completed; adopted Discord events are left unchanged.",
];
const EVENT_CANCEL_SERIES_LIST = confirmListAttr(EVENT_CANCEL_SERIES_ITEMS);

export function renderDashboardPage(props: DashboardProps): string {
  return renderAdminPage({
    title: "Dashboard",
    active: "/admin/",
    body: renderDashboardBody({
      data: props.data,
      version: props.version,
      csrfToken: props.csrfToken,
      flashHtml: renderFlash(props.flash),
    }),
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
          // Secrets are presence-only: never render `display` for them, even
          // if a caller passes one.
          const value =
            r.present && !r.isSecret
              ? `<span class="mono">${escapeHtml(r.display ?? "")}</span>`
              : "";
          return `<tr><td class="mono">${escapeHtml(r.key)}</td><td>${status}</td><td>${value}</td></tr>`;
        })
        .join("");
      return `
<div class="card">
  <h2>${escapeHtml(group.category)}</h2>
  <table><caption class="visually-hidden">Environment variables</caption><thead><tr><th scope="col">Variable</th><th scope="col">Status</th><th scope="col">Value</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
    })
    .join("");

  const body = `
<h1>Environment</h1>
<p class="subtitle">Process startup variables loaded from <code>.env</code>. Read-only — change them by editing <code>.env</code> and restarting the bot.</p>
<div class="notice info">Secrets are shown as configured or unset only, never any part of their value. Never edited from the WebUI, never written to MongoDB.</div>
${sections}
`;
  return renderAdminPage({
    title: "Environment",
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
  warnBelow?: { value: number; message: string; exemptZero?: boolean };
  /**
   * Inclusive lower bound for a `number` control, rendered as its `min`
   * attribute so the browser refuses a lower value before the server does.
   * Sourced from `SettingMetadata.min` (#835).
   */
  min?: number;
  /**
   * Inclusive upper bound for a `number` control, rendered as `data-max` and
   * the digit cap of the input. Sourced from `SettingMetadata.max` (#1304).
   */
  max?: number;
  /**
   * Bot-managed state (the id of a message the bot posted): rendered
   * read-only, with no field to submit. Sourced from `SettingMetadata.managed`
   * (#1304).
   */
  managed?: { channelKey: string };
  /**
   * The value set of a free-text key, rendered as a picker (#1426): a timezone
   * select, a colour input or an emoji picker. Sourced from
   * `SettingMetadata.format`.
   */
  format?: SettingFormat;
  /** Render the number as a stepper (#1427). Sourced from `SettingMetadata.stepper`. */
  stepper?: boolean;
  /** Preset durations of a number (#1427). Sourced from `SettingMetadata.presets`. */
  presets?: number[];
  /** What the preset `0` is called. Sourced from `SettingMetadata.presetZeroLabel`. */
  presetZeroLabel?: string;
  /**
   * For a `managed` row, the Discord link to the message it points at, when
   * the message and its channel are both known.
   */
  jumpUrl?: string;
  /** For a `managed` row, the feature page where an admin re-posts the message (#1428). */
  repostHref?: string;
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
 * hard dependencies aren't all met (#666). Returns an empty string when nothing
 * is unmet. Uses the dependency's human label from `settingsMetadata`, mirroring
 * the greyed-nav treatment's muted styling.
 *
 * `linkSections` controls whether each dependency name becomes an in-page
 * `#section-<category>` anchor. The Settings page (default) renders those
 * sections, so the link jumps straight to the toggle that unlocks this one. The
 * wizard renders no such anchors, so it passes `false` to emit plain text —
 * otherwise the link would point at a non-existent section (PR #715 review).
 */
export function renderDependencyHint(
  unmet: UnmetDependency[],
  linkSections = true,
  id = "",
): string {
  if (unmet.length === 0) return "";
  const names = unmet
    .map((d) => {
      const label = escapeHtml(d.label);
      return linkSections && d.category
        ? `<a href="#section-${escapeHtml(d.category)}">${label}</a>`
        : label;
    })
    .join(", ");
  // role="note" keeps this advisory out of the assertive live-region path; the
  // muted-grey tone matches the greyed-nav treatment (admin-layout's
  // `.nav-disabled` colour) so a dependency lock reads as a gentle "not
  // available yet" rather than an error.
  // The `id` lets the caller point the control's `aria-describedby` here so
  // the lock reason is announced with the field rather than only being visible
  // beside it (#854).
  const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
  return `<div class="settings-dep-hint"${idAttr} role="note" style="margin-top:.4rem;color:var(--muted);font-size:.85em">Requires ${names} enabled</div>`;
}

export interface SettingsProps extends CommonProps {
  groups: Array<{ category: string; rows: SettingRow[] }>;
  textChannels: ChannelOption[];
  voiceChannels: ChannelOption[];
  categoryChannels: ChannelOption[];
  roles: RoleOption[];
  /** Roles with role groups ahead of them, for keys that take groups (#1023). */
  groupRoles?: RoleOption[];
  /** The bot's reaction-role messages, for a key that picks one (#1433). */
  reactionRoleMessages?: ReactionRoleMessageOptions | null;
  /** Guild id of the session, used as the reset-confirmation fallback. */
  guildId: string;
  /** Guild name (when fetchable); the preferred reset-confirmation phrase. */
  guildName: string | null;
  flash?: FlashMessage | null;
  /**
   * Config keys the last save rejected, echoed back by the no-JS redirect
   * (#854). Their controls render `aria-invalid="true"` with an inline
   * "rejected" note, and an inline script moves focus to the first of them —
   * so a screen-reader user is told *which* of the ~318 fields was refused,
   * not just that something was.
   */
  invalidKeys?: string[];
  /**
   * The stored config could not be read. The per-section forms are replaced
   * by a notice: rendering them from schema defaults would let a save
   * overwrite the real stored values.
   */
  settingsUnavailable?: boolean;
}

/**
 * Reduce an arbitrary stored value to a primitive that's safe to drop into
 * an HTML form attribute. Mongo can hand us complex shapes from older rows
 * (arrays, objects); they're rare for typed config keys but we coerce
 * defensively so the form never crashes on a stray value.
 */
/**
 * The Discord link to a posted message, or undefined when either id is not a
 * snowflake (the key is unset, or holds something that is not an id). Both
 * ids are checked so a stored value can never shape the URL (#1304).
 */
export function messageJumpUrl(
  guildId: string,
  channelId: unknown,
  messageId: unknown,
): string | undefined {
  const snowflake = /^\d{17,20}$/;
  if (
    typeof channelId !== "string" ||
    typeof messageId !== "string" ||
    !snowflake.test(guildId) ||
    !snowflake.test(channelId.trim()) ||
    !snowflake.test(messageId.trim())
  ) {
    return undefined;
  }
  return `https://discord.com/channels/${guildId}/${channelId.trim()}/${messageId.trim()}`;
}

export interface RepostCardOptions {
  /** Anchor id; All settings links here (see `managed-messages.ts`). */
  id: string;
  heading: string;
  /** What the message is and when re-posting it helps. Plain text. */
  intro: string;
  /** POST target, e.g. "/admin/quotes/header/repost". */
  action: string;
  csrfInput: string;
  /** The id the page shows now, sent back so a double submit re-posts once. */
  messageId: string;
  buttonLabel: string;
  /** The confirm dialog's question. */
  confirmText: string;
  /** The confirm dialog's consequence list. */
  consequences: readonly string[];
  /** Why the button is off, or null when it can be used. */
  blockedReason: string | null;
}

/**
 * The Re-post card of a bot-managed message (#1428). The action deletes the old
 * message and posts a new one in Discord, so it goes through the confirm dialog
 * with its consequences listed (the confirm tone stays the red default: it
 * deletes a message). It sits on the feature's own page; All settings only
 * links here.
 */
export function renderRepostCard(o: RepostCardOptions): string {
  const state = o.messageId
    ? `Current message ID <code>${escapeHtml(o.messageId)}</code>.`
    : "Not posted yet.";
  const blocked = o.blockedReason
    ? `<p class="kb-help" role="status">${escapeHtml(o.blockedReason)}</p>`
    : "";
  const titleId = `${o.id}-title`;
  // Design-system Panel and Button (docs/design/patterns.md); the red button
  // matches the red confirm, as the action deletes a message.
  return `<section class="kb-panel" id="${escapeHtml(o.id)}" aria-labelledby="${escapeHtml(titleId)}">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="${escapeHtml(titleId)}">${escapeHtml(o.heading)}</h2></header>
  <div class="kb-panel__body">
    <p class="kb-help">${escapeHtml(o.intro)} ${state}</p>
    <form method="POST" action="${escapeHtml(o.action)}" data-confirm="${escapeHtml(o.confirmText)}"${confirmListAttr(o.consequences)}>
      ${o.csrfInput}
      <input type="hidden" name="expectedId" value="${escapeHtml(o.messageId)}">
      <button type="submit" class="kb-btn kb-btn--danger"${o.blockedReason ? " disabled" : ""}>${escapeHtml(o.buttonLabel)}</button>
    </form>
    ${blocked}
  </div>
</section>`;
}

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
 * `⚠ <id> (unavailable)` options that stay `selected` on render. Without this
 * the browser would default the single-select to the first option
 * (typically the "(none)" row) and an operator could silently clear the
 * setting by saving the form without touching the control.
 */
function buildOptionsHtml(
  options: ChannelOption[] | RoleOption[],
  selected: Set<string>,
  includeNoneRow: boolean,
  meta?: PickerMeta[],
): string {
  const parts: string[] = [];
  if (includeNoneRow) {
    const noneSel = selected.size === 0 ? " selected" : "";
    parts.push(`<option value=""${noneSel}>(none)</option>`);
    meta?.push(null);
  }
  const knownIds = new Set(options.map((o) => o.id));
  // Channels are grouped the way Discord's autocomplete groups them (#1303):
  // one <optgroup> per kind, in the order the kinds first appear. `meta` is
  // filled in the order the options end up in the markup.
  const groups = new Map<string, Array<{ html: string; meta: PickerMeta }>>();
  const roleGroupEntries: Array<{ html: string; meta: PickerMeta }> = [];
  const roleEntries: Array<{ html: string; meta: PickerMeta }> = [];
  for (const opt of options) {
    const sel = selected.has(opt.id) ? " selected" : "";
    const html = `<option value="${escapeHtml(opt.id)}"${sel}>${escapeHtml(optionText(opt))}</option>`;
    if (!isChannelOption(opt)) {
      // Roles are headed like the channels (#1394): references to role groups
      // (#1023) under "Role groups", real roles under "Roles".
      const entry = { html, meta: ["role", opt.name, ""] as PickerMeta };
      (opt.id.startsWith("group:") ? roleGroupEntries : roleEntries).push(
        entry,
      );
      continue;
    }
    const group = channelGroupLabel(opt.type);
    const entry = { html, meta: pickerMetaOf(opt) };
    const members = groups.get(group);
    if (members) members.push(entry);
    else groups.set(group, [entry]);
  }
  for (const [label, members] of [
    ...(roleGroupEntries.length
      ? [["Role groups", roleGroupEntries] as const]
      : []),
    ...(roleEntries.length ? [["Roles", roleEntries] as const] : []),
    ...groups,
  ]) {
    parts.push(
      `<optgroup label="${escapeHtml(label)}">${members.map((m) => m.html).join("")}</optgroup>`,
    );
    for (const m of members) meta?.push(m.meta);
  }
  for (const id of selected) {
    if (id === "" || knownIds.has(id)) continue;
    parts.push(
      `<option value="${escapeHtml(id)}" selected>${escapeHtml(missingText(id))}</option>`,
    );
    meta?.push(["missing", id, ""]);
  }
  return parts.join("");
}

/**
 * What the searchable picker script needs about one option (#1394): its kind
 * (the icon and the `#` / `#!` / `@` filter), bare name and category, or null
 * for the "(none)" row. It travels on the wrapper (`data-picker-meta`, one
 * entry per option in markup order) so the options stay what a browser
 * without JavaScript posts and shows.
 */
type PickerMeta = [kind: string, name: string, category: string] | null;

function pickerMetaOf(o: ChannelOption): PickerMeta {
  const kind = channelKindOf(o.type) ?? "missing";
  return [kind, o.name, kind === "category" ? "" : (o.parentName ?? "")];
}

function isChannelOption(o: ChannelOption | RoleOption): o is ChannelOption {
  return "type" in o;
}

/** Plain-text label of one picker option: a channel by kind, a role as `@Name`. */
function optionText(o: ChannelOption | RoleOption): string {
  return isChannelOption(o)
    ? channelText(o, o.parentName ?? undefined)
    : roleText(o.name);
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
  // Strip surrounding quotes the same way the runtime services do — they all
  // normalise through `sanitizeCronExpression` before handing the string to
  // CronJob. Without it a stored value like `"0 16 * * 5"` would silently fall
  // back to custom mode here even though the bot treats it as the unquoted form.
  const stripped = sanitizeCronExpression(cron);
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
  a11y: ControlA11y = {},
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

  // A cron value is edited through several coordinated inputs, so there is no
  // single control a `<label for>` can point at. Expose the cluster as a
  // labelled group instead: the row caption names it and any help / warning
  // text describes it (#854). Each inner control keeps its own `aria-label`.
  // Making an invalid group focusable is left to the client scripts, which do
  // it for both the server-rendered and the AJAX rejection and tag what they
  // added so it can be undone — emitting `tabindex` here would have covered
  // only the former and left the attribute behind once the value was accepted.
  const groupAttrs =
    a11y.labelledBy || a11y.describedBy
      ? ` role="group"` +
        (a11y.id ? ` id="${escapeHtml(a11y.id)}"` : "") +
        (a11y.labelledBy
          ? ` aria-labelledby="${escapeHtml(a11y.labelledBy)}"`
          : "") +
        (a11y.describedBy
          ? ` aria-describedby="${escapeHtml(a11y.describedBy)}"`
          : "") +
        (a11y.invalid
          ? ` aria-invalid="true"` +
            ` data-describedby-base="${escapeHtml(a11y.describedByBase ?? "")}"`
          : "")
      : "";

  // The hidden input is what the form actually submits. The bootstrap
  // script in admin-layout keeps it in sync with the controls; it locates
  // the input via the `.cron-hidden` class so the form-field name can vary
  // per row (e.g. `value_<key>` under the per-section save form).
  return (
    `<div class="cron-picker" data-mode="${state.mode}"${groupAttrs}>` +
    `<input type="hidden" class="cron-hidden" name="${escapeHtml(valueName)}" value="${escapeHtml(currentValue)}">` +
    `<select class="cron-mode" aria-label="Schedule type"${lockAttr}>` +
    `<option value="daily"${sel(state.mode === "daily")}>Daily</option>` +
    `<option value="weekly"${sel(state.mode === "weekly")}>Weekly</option>` +
    `<option value="monthly"${sel(state.mode === "monthly")}>Monthly</option>` +
    `<option value="custom"${sel(state.mode === "custom")}>Custom (cron)</option>` +
    `</select>` +
    `<span class="cron-time-wrap"${hidden(state.mode === "custom")}>` +
    ` at <input type="time" class="cron-time" aria-label="Time of day" value="${timeAttr}"${lockAttr}>` +
    `</span>` +
    `<span class="cron-dow-wrap"${hidden(state.mode !== "weekly")}>` +
    ` on <select class="cron-dow" aria-label="Day of week"${lockAttr}>${dowOptions}</select>` +
    `</span>` +
    `<span class="cron-dom-wrap"${hidden(state.mode !== "monthly")}>` +
    ` on day <input type="number" class="cron-dom" aria-label="Day of month" min="1" max="31" value="${state.dayOfMonth}" style="width:5rem"${lockAttr}>` +
    `</span>` +
    `<span class="cron-custom-wrap"${hidden(state.mode !== "custom")}>` +
    `<input type="text" class="cron-custom" aria-label="Cron expression" value="${escapeHtml(state.raw)}" placeholder="0 16 * * 5" style="width:12rem"${lockAttr}>` +
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
 * Form-field name of a colour setting's "Use default" checkbox (#1426). A
 * colour input cannot post an empty value, and `""` is how the key says
 * "Discord's default", so the checkbox is a real control that the save
 * handlers read through `readSettingField`.
 */
export function settingDefaultFieldName(key: string): string {
  return `use_default_${key}`;
}

/** Form-field name of a colour setting's "Keep the stored value" checkbox (#1426). */
export function settingKeepFieldName(key: string): string {
  return `keep_${key}`;
}

/**
 * Form-field name of the preset radio group of a duration setting (#1427). The
 * box keeps `value_<key>`, so the invalid marker, the id and a single-key post
 * still address the same field.
 */
export function settingPresetFieldName(key: string): string {
  return `preset_${key}`;
}

/**
 * True when a colour setting's "Keep the stored value" box is ticked (and Use
 * default, which wins, is not). The save handlers then resolve the stored value
 * with `ConfigService.getStringStrict()` and pass it to `readSettingField`: a
 * failed read must refuse the save, never fall back to the swatch placeholder.
 */
export function wantsKeptColour(
  body: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return (
    settingsMetadata[key as keyof typeof settingsMetadata]?.format ===
      "colour" &&
    body?.[settingDefaultFieldName(key)] !== "true" &&
    body?.[settingKeepFieldName(key)] === "true"
  );
}

/** Why a Keep colour is refused when its stored value cannot be read. */
export const KEEP_READ_FAILED_REASON =
  "the stored colour could not be read, so it was left unchanged; try again";

/**
 * The raw posted value of a setting: its `value_<key>` field, or `""` when the
 * key is a colour and "Use default" is ticked, or a preset when a duration's
 * preset radio is ticked (Custom… and no radio both mean the box). Every save path reads values
 * through this so the checkbox means the same on the Settings page and the
 * wizard.
 */
export function readSettingField(
  body: Record<string, unknown> | undefined,
  key: string,
  current?: unknown,
): unknown {
  if (
    settingsMetadata[key as keyof typeof settingsMetadata]?.format === "colour"
  ) {
    // Use default wins over Keep, which wins over the swatch (see
    // `renderColourInput`). Keep means the stored value, whatever it is, so a
    // crafted post can only ask for what is already there.
    if (body?.[settingDefaultFieldName(key)] === "true") return "";
    if (
      body?.[settingKeepFieldName(key)] === "true" &&
      current !== undefined &&
      current !== null
    ) {
      return String(current);
    }
  }
  const presets =
    settingsMetadata[key as keyof typeof settingsMetadata]?.presets;
  if (presets) {
    const preset = pickPreset(body?.[settingPresetFieldName(key)], presets);
    if (preset !== null) return preset;
  }
  return body?.[settingValueFieldName(key)];
}

/**
 * Pick the cascade "master" toggle for a settings section: the boolean
 * two-segment `<category>.enabled` key (the top-level feature switch).
 * Sub-feature toggles like `voicetracking.announcements.enabled` are
 * dependents, never masters, and a section without a top-level switch (such
 * as `core`) has no cascade at all (#1068). Shared by the wizard and Settings
 * page, and with the server via `pickCascadeMasterKey`.
 */
export function findCascadeMasterKey(rows: SettingRow[]): string | null {
  return pickCascadeMasterKey(
    rows.map((r) => ({
      key: r.key,
      isBoolean: r.type === "boolean",
      category: r.category,
    })),
  );
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
  return `<select class="kb-select" name="${valueName}"${extraAttr}>${opts}${placeholder}</select>`;
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
 * Role option list for a `role` / `role_list` control. A key that also takes
 * role groups (`ROLE_GROUP_SETTING_KEYS`) uses the list with the groups ahead
 * of the roles when the caller supplied one; every other key keeps raw roles,
 * so a group token can never be picked where nothing resolves it (#1023).
 */
function rolesFor(
  r: SettingRow,
  pickers: { roles: RoleOption[]; groupRoles?: RoleOption[] },
): RoleOption[] {
  return pickers.groupRoles &&
    (ROLE_GROUP_SETTING_KEYS as readonly string[]).includes(r.key)
    ? pickers.groupRoles
    : pickers.roles;
}

/**
 * Render a compact, readable summary of the currently-selected entries below a
 * multi-select. A `<select multiple>` buries its picks among unselected rows,
 * and a long voice-exclusion list otherwise reads as an unseparated blob
 * (issue #611); this surfaces them as a clean, comma-separated list labelled
 * by kind (`# general`, `🔊 Lobby`, `@Moderators`, #1303). Ids no longer in the
 * live option set render as `⚠ <id> (unavailable)`, so a stale selection is
 * visible rather than silently dropped (the same label `buildOptionsHtml`
 * emits). Returns an empty string when nothing is selected.
 */
function renderSelectionSummary(
  options: ChannelOption[] | RoleOption[],
  selected: Set<string>,
): string {
  if (selected.size === 0) return "";
  const byId = new Map<string, ChannelOption | RoleOption>(
    (options as Array<ChannelOption | RoleOption>).map((o) => [o.id, o]),
  );
  const tokens = Array.from(selected).map((id) => {
    const opt = byId.get(id);
    return opt ? optionText(opt) : missingText(id);
  });
  return (
    `<div class="settings-selected muted" style="margin-top:.4rem;font-size:.85em">` +
    `Selected: ${escapeHtml(tokens.join(", "))}` +
    `</div>`
  );
}

/**
 * Accessibility wiring for a rendered setting control (#854).
 *
 * The Settings table and the wizard both caption a control with text that
 * lives outside the control itself, so the association has to be made
 * explicitly: `id` is stamped on the primary control so a `<label for>` can
 * target it, `describedBy` links the help / warning / dependency text that
 * renders beside it, and `invalid` marks a value the server just rejected.
 * `labelledBy` is only used by the cron picker, which has no single control to
 * hang a `<label for>` on and is exposed as a labelled group instead.
 */
export interface ControlA11y {
  /** DOM id for the primary control, so a `<label for>` can point at it. */
  id?: string;
  /** Space-separated id list for the control's `aria-describedby`. */
  describedBy?: string;
  /** Render `aria-invalid="true"` — the last save rejected this value. */
  invalid?: boolean;
  /**
   * `describedBy` minus the ids that only exist while the value is rejected.
   * Emitted as `data-describedby-base` so the AJAX save script can restore the
   * control's normal description after a later save clears the rejection,
   * instead of leaving `aria-describedby` pointing at a removed note (#854).
   */
  describedByBase?: string;
  /** id of the element naming the control (cron groups only). */
  labelledBy?: string;
}

/** DOM id of the value control for a config key on the Settings page. */
export function settingControlId(key: string): string {
  return `set-${key}`;
}

/**
 * Render a setting's value control, plus — when the control is
 * dependency-locked (#666) — a hidden input that round-trips its current value.
 * A `disabled` control isn't submitted by the browser, and the per-section Save
 * handler coerces a missing value to `false`/`""` (see `coerceConfigValue` in
 * `src/web/routes/write/helpers.ts`), so without this a dep-locked boolean would
 * be silently flipped off (and other types blanked) whenever its section is
 * saved while the lock is
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
    /** Role list with role groups ahead of the roles, for group-aware keys. */
    groupRoles?: RoleOption[];
    reactionRoleMessages?: ReactionRoleMessageOptions | null;
  },
  isCascadeMaster = false,
  depLocked = false,
  a11y: ControlA11y = {},
): string {
  const control = renderControlInput(
    r,
    pickers,
    isCascadeMaster,
    depLocked,
    a11y,
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
    /** Role list with role groups ahead of the roles, for group-aware keys. */
    groupRoles?: RoleOption[];
    reactionRoleMessages?: ReactionRoleMessageOptions | null;
  },
  isCascadeMaster = false,
  depLocked = false,
  // Accessibility wiring for the control (#703, #854). Both the wizard and the
  // Settings page stamp an `id` here so their row caption can be a real
  // `<label for>`, and pass the ids of the help / warning / dependency text
  // that renders alongside so it is announced with the field. The cron picker
  // manages its own inputs, so it takes the group-level attributes instead.
  a11y: ControlA11y = {},
): string {
  const primitive = coerceToDisplayValue(r.current);
  const currentStr = typeof primitive === "string" ? primitive : "";
  const valueName = escapeHtml(settingValueFieldName(r.key));
  const a11yAttr =
    (a11y.id ? ` id="${escapeHtml(a11y.id)}"` : "") +
    (a11y.describedBy
      ? ` aria-describedby="${escapeHtml(a11y.describedBy)}"`
      : "") +
    (a11y.invalid
      ? ` aria-invalid="true" data-describedby-base="${escapeHtml(a11y.describedByBase ?? "")}"`
      : "");
  // When a hard dependency is unmet (#666), the control renders disabled so it
  // can't be edited before its requirement is on — the same rule the write-time
  // validator (#663) enforces. `data-dep-locked` tells the cascade-disable
  // script (admin-layout) never to re-enable it when a section master is on, so
  // a dependency lock survives an enabled parent section. The current value is
  // round-tripped via a sibling hidden input in `renderSettingControl` so the
  // disabled (and therefore unsubmitted) control can't be clobbered on Save.
  const lockAttr = depLocked ? " disabled data-dep-locked" : "";

  // Bot-managed state is text with a link, never a field (#1304).
  if (r.managed) {
    return renderManagedValue(String(primitive), r.jumpUrl, r.repostHref);
  }
  // A boolean is always a switch, even if a key ever carried options (#1318).
  if (r.type === "boolean") {
    return renderSwitch(
      valueName,
      primitive === true,
      {
        id: a11y.id,
        describedBy: a11y.describedBy,
        labelledBy: a11y.labelledBy,
        invalid: a11y.invalid,
        describedByBase: a11y.describedByBase,
        disabled: depLocked,
      },
      isCascadeMaster ? " data-cascade-master" : "",
    );
  }
  // Fixed-options keys: two to four short options are a segmented control, the
  // rest a single-select dropdown, so operators pick from the valid set
  // instead of typing a value the server will reject.
  if (r.options && r.options.length > 0) {
    if (segmentedFits(r.options, currentStr)) {
      return renderSegmented(valueName, r.options, currentStr, {
        id: a11y.id,
        describedBy: a11y.describedBy,
        labelledBy: a11y.labelledBy,
        invalid: a11y.invalid,
        describedByBase: a11y.describedByBase,
        disabled: depLocked,
      });
    }
    return renderOptionsSelect(
      valueName,
      r.options,
      currentStr,
      lockAttr + a11yAttr,
    );
  }
  if (r.type === "number" && (r.stepper || r.presets)) {
    const controlAttrs = {
      id: a11y.id,
      describedBy: a11y.describedBy,
      labelledBy: a11y.labelledBy,
      invalid: a11y.invalid,
      describedByBase: a11y.describedByBase,
      disabled: depLocked,
    };
    const shown = primitive as string | number;
    if (r.presets) {
      return renderDurationPresets(
        settingPresetFieldName(r.key),
        valueName,
        shown,
        r.presets,
        { min: r.min, max: r.max },
        {
          ...controlAttrs,
          label: r.label,
          unit: durationUnit(r.key),
          zeroLabel: r.presetZeroLabel,
        },
      );
    }
    return renderStepper(
      valueName,
      shown,
      { min: r.min, max: r.max },
      r.label,
      controlAttrs,
    );
  }
  if (r.type === "number") {
    // A bounded whole-number box (#1304): `required` so a cleared field is
    // caught by the browser rather than posted as "" (which the server rejects,
    // #835), `data-min` / `data-max` mirroring the schema bounds the server
    // enforces. A dep-locked / cascade-disabled control is `disabled`, which
    // exempts it from both constraints.
    return renderNumberInput(
      valueName,
      primitive as string | number,
      { min: r.min, max: r.max },
      {
        id: a11y.id,
        describedBy: a11y.describedBy,
        invalid: a11y.invalid,
        describedByBase: a11y.describedByBase,
        disabled: depLocked,
      },
    );
  }
  if (r.type === "channel" || r.type === "category" || r.type === "role") {
    const options =
      r.type === "channel"
        ? channelOptionsFor(r, pickers)
        : r.type === "category"
          ? pickers.categoryChannels
          : rolesFor(r, pickers);
    const selected = currentStr ? new Set([currentStr]) : new Set<string>();
    // `span.kb-picker` is where `CHANNEL_PICKER_SCRIPT` puts its search box
    // (#1394); without JavaScript this is just the select it wraps.
    const meta: PickerMeta[] = [];
    const optionsHtml = buildOptionsHtml(options, selected, true, meta);
    return (
      `<span class="kb-picker" data-picker data-picker-meta="${escapeHtml(JSON.stringify(meta))}">` +
      `<select class="kb-select"${a11yAttr} name="${valueName}"${lockAttr}>` +
      optionsHtml +
      `</select></span>`
    );
  }
  if (r.type === "channel_list" || r.type === "role_list") {
    const options =
      r.type === "channel_list"
        ? channelOptionsFor(r, pickers)
        : rolesFor(r, pickers);
    const selected = new Set(
      currentStr
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== ""),
    );
    return (
      `<select${a11yAttr} name="${valueName}" multiple size="${Math.min(8, Math.max(3, options.length))}"${lockAttr}>` +
      buildOptionsHtml(options, selected, false) +
      `</select>` +
      renderSelectionSummary(options, selected)
    );
  }
  if (r.type === "cron") {
    return renderCronPicker(
      currentStr,
      settingValueFieldName(r.key),
      depLocked,
      a11y,
    );
  }
  // Free-text keys with a known value set get a picker (#1426); the server
  // checks the value again, and a stored value the picker cannot produce is
  // shown and posted unchanged.
  if (r.format === "timezone") {
    return renderTimezoneSelect(valueName, currentStr, {
      id: a11y.id,
      describedBy: a11y.describedBy,
      invalid: a11y.invalid,
      describedByBase: a11y.describedByBase,
      disabled: depLocked,
      defaultZone: getServerTimezone(),
      blank: true,
    });
  }
  if (r.format === "colour") {
    return renderColourInput(
      valueName,
      escapeHtml(settingDefaultFieldName(r.key)),
      currentStr,
      {
        id: a11y.id,
        describedBy: a11y.describedBy,
        invalid: a11y.invalid,
        describedByBase: a11y.describedByBase,
        disabled: depLocked,
      },
    );
  }
  if (r.format === "reaction_role_message") {
    return renderReactionRoleMessageSelect(valueName, currentStr, {
      id: a11y.id,
      describedBy: a11y.describedBy,
      invalid: a11y.invalid,
      describedByBase: a11y.describedByBase,
      disabled: depLocked,
      messages: pickers.reactionRoleMessages ?? null,
    });
  }
  if (r.format === "affix") {
    return renderEmojiField(valueName, currentStr, {
      label: r.label,
      id: a11y.id,
      describedBy: a11y.describedBy,
      invalid: a11y.invalid,
      describedByBase: a11y.describedByBase,
      disabled: depLocked,
    });
  }
  // string or unknown type → plain text input. The maxlength mirrors the
  // server-side `TEXT_LIMITS.configValue` cap in
  // `src/web/routes/write/helpers.ts` (#508) — kept as a literal here to avoid a
  // circular import (the write routers import this file).
  return `<input type="text" class="kb-input"${a11yAttr} name="${valueName}" maxlength="2000" value="${escapeHtml(primitive)}"${lockAttr}>`;
}

/**
 * Render the soft "minimum recommended value" warning when a numeric setting
 * is below its `warnBelow` threshold. Returns an empty string when there's no
 * hint or the value clears the threshold, so it adds nothing to rows that
 * don't need it. Shown unconditionally (not gated on a feature toggle) so the
 * degraded state is visible without editing — and it re-renders after a save.
 */
export function renderWarnBelow(r: SettingRow, id = ""): string {
  if (!r.warnBelow) return "";
  // Only warn on a value that's genuinely a number below the threshold.
  // An unset key (null/undefined/empty string) renders as a blank input via
  // coerceToDisplayValue, so coercing it to 0 here would flash a misleading
  // warning — guard those out rather than letting Number("") become 0.
  if (r.current === null || r.current === undefined || r.current === "")
    return "";
  const value = typeof r.current === "number" ? r.current : Number(r.current);
  if (!Number.isFinite(value) || value >= r.warnBelow.value) return "";
  // On retention keys `0` means "keep forever" (#835), which can't degrade
  // the feature the hint protects, so the hint opts that value out.
  if (value === 0 && r.warnBelow.exemptZero) return "";
  // role="status" (implicit aria-live=polite) keeps this persistent advisory
  // from being announced assertively on every page load like role="alert".
  // As with the dependency hint, an `id` lets the caller wire this into the
  // control's `aria-describedby` (#854).
  const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
  // --warn is 8.1:1 on the card; a darker amber was 3.47:1 (#855).
  return `<div class="settings-warn"${idAttr} role="status" style="margin-top:.4rem;color:var(--warn);font-size:.85em">${escapeHtml(r.warnBelow.message)}</div>`;
}

/**
 * DOM id of the Settings page's flash banner. Shared with `admin-layout`'s
 * client script and with the controls of rejected keys, whose
 * `aria-describedby` points here so the field carries the server's actual
 * rejection reason (#854).
 */
export const SETTINGS_FLASH_ID = "settings-flash";

/**
 * Inline "this value was rejected" marker for a control the last save
 * refused (#854). `role="alert"` announces it when the page loads with the
 * rejection already rendered; the id is wired into the control's
 * `aria-describedby` so the marker is also read when the field takes focus.
 */
function renderInvalidNote(id: string): string {
  return `<div class="settings-error" id="${escapeHtml(id)}" role="alert" style="margin-top:.4rem;color:var(--err-text);font-size:.85em">Rejected — not saved. See the error message above for the reason.</div>`;
}

/**
 * True for a control that edits through several inputs or a radio group, so
 * the row name labels it with `aria-labelledby` instead of `<label for>`
 * (neither a cron picker nor a radiogroup is a labelable element).
 */
function isGroupControl(r: SettingRow): boolean {
  if (r.type === "cron") return true;
  if (r.type === "number" && r.presets) return true;
  if (r.type === "boolean") return false;
  return segmentedFits(r.options, currentStringOf(r));
}

/** "minutes" for `events.reminder_minutes`: the unit a duration key's name ends in. */
function durationUnit(key: string): string {
  return /_(seconds|minutes|hours|days)$/.exec(key)?.[1] ?? "";
}

function currentStringOf(r: SettingRow): string {
  const v = coerceToDisplayValue(r.current);
  return typeof v === "string" ? v : "";
}

/** A value as people read it: On/Off, an option's label, or "not set". */
function describeSettingValue(r: SettingRow, value: unknown, max = 60): string {
  const v = coerceToDisplayValue(value);
  if (r.type === "boolean") return v === true ? "On" : "Off";
  if (v === "") return "not set";
  const text = String(v);
  const option = r.options?.find((o) => o.value === text);
  const shown = option ? option.label : text;
  return shown.length > max ? `${shown.slice(0, max - 1)}…` : shown;
}

/**
 * Whether a row's value differs from the schema default. An unset current
 * value means the default is in force, so it never counts as changed.
 */
function differsFromDefault(r: SettingRow): boolean {
  if (r.current === null || r.current === undefined) return false;
  const norm = (v: unknown): string => {
    const d = coerceToDisplayValue(v);
    return r.type === "boolean" ? String(d === true) : String(d);
  };
  return norm(r.current) !== norm(r.defaultValue);
}

/** Everything {@link renderSettingRows} needs besides the rows. */
interface SettingRowsContext {
  pickers: {
    textChannels: ChannelOption[];
    voiceChannels: ChannelOption[];
    categoryChannels: ChannelOption[];
    roles: RoleOption[];
    groupRoles?: RoleOption[];
    reactionRoleMessages?: ReactionRoleMessageOptions | null;
  };
  /** The form's master toggle: every other row nests under it. */
  masterKey: string | null;
  /** On/off state of every key the rows may depend on, on or off this form. */
  enabledByKey: Map<string, boolean>;
  /** Id of the card's reset form, which the reset buttons submit. */
  resetFormId: string;
  /** Whether a dependency name links to its `#section-` anchor. */
  linkSections: boolean;
  /** Keys the last save rejected (Settings page only). */
  invalidKeys?: ReadonlySet<string>;
  /** Id of the page flash to point rejected controls at, when one shows. */
  flashId?: string;
}

/**
 * The hidden input that keeps a row's stored value in the form when its control
 * is absent: the save handler coerces a missing value to `false` / `""`, so
 * without it such a row would be blanked on every save.
 */
function renderValueRoundTrip(r: SettingRow): string {
  const primitive = coerceToDisplayValue(r.current);
  const value =
    r.type === "boolean"
      ? primitive === true
        ? "true"
        : "false"
      : escapeHtml(primitive);
  return `<input type="hidden" name="${escapeHtml(settingValueFieldName(r.key))}" value="${value}">`;
}

function renderMoreDisclosure(key: string, rest: string): string {
  const restHtml = rest ? `<p>${escapeHtml(rest)}</p>` : "";
  return (
    `<details class="kb-disclosure kb-disclosure--inline">` +
    `<summary>${icon("chevron-right", { className: "kb-chev" })}More</summary>` +
    `<div class="kb-disclosure__body">${restHtml}<p>Setting key: <code class="kb-mono">${escapeHtml(key)}</code></p></div>` +
    `</details>`
  );
}

/**
 * The rows of a settings form (#1318, design system SettingRow): name and one
 * line left, control right, the rest behind More, and a dot with a reset button
 * once the value differs from its default. Shared by the Settings page and the
 * feature cards so the two cannot drift.
 *
 * Dependents nest under their parent in `div.kb-nested` (see
 * `buildSettingTree`), so a control is never shown disabled without the toggle
 * it waits for right above it. A row whose dependency lives on another form
 * cannot be nested; it renders without a control, naming (and on the Settings
 * page linking to) what to turn on, and keeps its stored value in the form.
 */
function renderSettingRows(
  rows: SettingRow[],
  ctx: SettingRowsContext,
): string {
  const inForm = new Set(rows.map((r) => r.key));
  const tree = buildSettingTree(
    rows,
    ctx.masterKey,
    (key) => getDependencies(key as keyof ConfigSchema),
    (key) => ctx.enabledByKey.get(key) === true,
  );
  // `lockedBelow`: an ancestor is waiting on a dependency from another card and
  // is off, so it has no control to switch off and the cascade script has no
  // master to disable these rows with. They are locked here instead, which
  // keeps them from being edited and then dropped by the save (the server
  // writes only the master of a form whose master is off).
  const renderNode = (
    node: SettingNode<SettingRow>,
    lockedBelow = false,
  ): string => {
    const r = node.row;
    const unmet = unmetDependenciesFor(r.key, ctx.enabledByKey);
    const depLocked = unmet.length > 0 || lockedBelow;
    const offForm = unmet.some((d) => !inForm.has(d.key));
    const lockChildren = lockedBelow || (offForm && !isEnabledValue(r.current));
    const controlId = settingControlId(r.key);
    const labelId = `${controlId}-label`;
    const helpId = `${controlId}-help`;
    const warnId = `${controlId}-warn`;
    const depId = `${controlId}-dep`;
    const errId = `${controlId}-err`;
    const { short, rest } = splitDescription(r.description);
    const warnHtml = renderWarnBelow(r, warnId);
    const depHtml = renderDependencyHint(unmet, ctx.linkSections, depId);
    const invalid = ctx.invalidKeys?.has(r.key) ?? false;
    const errHtml = invalid ? renderInvalidNote(errId) : "";
    const describedByBase = [
      short ? helpId : "",
      warnHtml ? warnId : "",
      depHtml ? depId : "",
    ]
      .filter(Boolean)
      .join(" ");
    const describedBy = invalid
      ? [describedByBase, errId, ctx.flashId ?? ""].filter(Boolean).join(" ")
      : describedByBase;
    const a11y: ControlA11y = {
      id: controlId,
      describedBy,
      describedByBase,
      invalid,
      labelledBy: labelId,
    };
    const managed = r.managed !== undefined;
    const changed = !offForm && !managed && differsFromDefault(r);
    const label = escapeHtml(r.label || r.key);
    const mark = changed ? renderChangedMark() : "";
    const nameHtml =
      offForm || managed || isGroupControl(r)
        ? `<p class="kb-setting__name" id="${labelId}">${label}${mark}</p>`
        : `<p class="kb-setting__name"><label id="${labelId}" for="${escapeHtml(controlId)}">${label}</label>${mark}</p>`;
    const control = managed
      ? renderManagedValue(
          String(coerceToDisplayValue(r.current)),
          r.jumpUrl,
          r.repostHref,
        )
      : offForm
        ? renderValueRoundTrip(r)
        : renderSettingControl(
            r,
            ctx.pickers,
            r.key === ctx.masterKey,
            depLocked,
            a11y,
          ) +
          (changed
            ? renderResetControl(
                r.key,
                r.label,
                describeSettingValue(r, r.defaultValue),
                ctx.resetFormId,
                describeSettingValue(r, r.defaultValue, Infinity),
              )
            : "");
    const nested =
      node.children.length > 0
        ? `<div class="kb-nested">${node.children.map((c) => renderNode(c, lockChildren)).join("")}</div>`
        : "";
    const cls = depLocked ? "kb-setting kb-setting--locked" : "kb-setting";
    return (
      `<div class="${cls}">` +
      `<div>${nameHtml}${short ? `<p class="kb-setting__desc" id="${helpId}">${escapeHtml(short)}</p>` : ""}</div>` +
      `<div class="kb-setting__control">${control}</div>` +
      // A managed value has no field, so it must not be listed in `keys`: the
      // save would read the missing value as "" and blank the stored id.
      `<div class="kb-setting__extra">${managed ? "" : `<input type="hidden" name="keys" value="${escapeHtml(r.key)}">`}` +
      `${renderMoreDisclosure(r.key, rest)}${warnHtml}${depHtml}${errHtml}${nested}</div>` +
      `</div>`
    );
  };
  return `<div class="kb-settings">${tree.map((n) => renderNode(n)).join("")}</div>`;
}

/**
 * The two forms of a settings card: the save form around the rows, and a
 * sibling reset form that the rows' reset buttons submit through their `form`
 * attribute. A form cannot nest inside another, and a submit button inside
 * the save form would become its default button (Enter in a text field would
 * reset a row instead of saving).
 */
function renderSettingsForms(opts: {
  formId: string;
  saveAttrs: string;
  hiddenFields: string;
  rowsHtml: string;
  submitLabel: string;
  /** Names the form's save bar region, which must differ per form. */
  title: string;
  csrfToken: string;
  returnTo?: string;
}): string {
  const redirect = opts.returnTo
    ? `<input type="hidden" name="redirect" value="${escapeHtml(opts.returnTo)}">`
    : "";
  return `<form method="POST" action="/admin/settings/save-section"${opts.saveAttrs} id="${escapeHtml(opts.formId)}">
    ${opts.hiddenFields}
    ${opts.rowsHtml}
    ${renderSaveBar(opts.submitLabel, opts.title)}
  </form>
  <form id="${escapeHtml(opts.formId)}-reset" method="POST" action="/admin/settings/reset">
    <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">${redirect}
  </form>`;
}

export function renderSettingsPage(props: SettingsProps): string {
  const csrf = escapeHtml(props.csrfToken);
  const invalidKeys = new Set(props.invalidKeys ?? []);

  const actionBar = `
<div class="actions">
  <form method="POST" action="/admin/settings/reload" data-confirm="Reload bot slash commands now? This briefly puts the bot into a config-reload status."${CONFIRM_NEUTRAL_ATTR}>
    <input type="hidden" name="_csrf" value="${csrf}">
    <button type="submit" class="btn">Reload commands</button>
  </form>
  <a href="/admin/settings/export" class="btn">Export YAML</a>
  <a href="#import-section" class="btn">Import YAML</a>${
    // The wizard pre-fills from the same store; don't point at it while the
    // store can't be read.
    props.settingsUnavailable
      ? ""
      : `\n  <a href="/admin/wizard" class="btn">Setup wizard</a>`
  }
</div>`;

  const pickers = {
    textChannels: props.textChannels,
    voiceChannels: props.voiceChannels,
    categoryChannels: props.categoryChannels,
    roles: props.roles,
    groupRoles: props.groupRoles,
    reactionRoleMessages: props.reactionRoleMessages,
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
      // they aren't clobbered (issue #485). The rows nest under it.
      const cascadeMasterKey = findCascadeMasterKey(g.rows);
      const rowsHtml = renderSettingRows(g.rows, {
        pickers,
        masterKey: cascadeMasterKey,
        enabledByKey,
        resetFormId: `form-${g.category}-reset`,
        linkSections: true,
        invalidKeys,
        flashId: props.flash ? SETTINGS_FLASH_ID : undefined,
      });
      const descHtml = meta.description
        ? `<p class="muted" style="margin:.25rem 0 .75rem">${escapeHtml(meta.description)}</p>`
        : "";
      // One <form> per category. Save submits every row's value in one
      // atomic request; the per-row reset buttons submit the sibling reset
      // form for a single key (issue #433).
      const scopeAttr = cascadeMasterKey ? " data-cascade-scope" : "";
      return `
<div class="card card--savebar" id="section-${escapeHtml(g.category)}">
  <h2>${escapeHtml(meta.title)}</h2>
  ${descHtml}
  ${renderSettingsForms({
    formId: `form-${g.category}`,
    saveAttrs: scopeAttr,
    hiddenFields: `<input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="category" value="${escapeHtml(g.category)}">`,
    rowsHtml,
    submitLabel: "Save",
    title: meta.title,
    csrfToken: props.csrfToken,
  })}
</div>`;
    })
    .join("");

  const importSection = `
<div id="import-section" class="card">
  <h2>Import YAML</h2>
  <p class="muted" id="import-yaml-help" style="margin:0 0 .75rem">Paste a YAML key→value mapping. A diff preview is shown before anything is written. Bootstrap and environment keys are always refused.</p>
  <form method="POST" action="/admin/settings/import" class="stack">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label for="import-yaml">YAML to import</label>
    <textarea id="import-yaml" name="yaml" rows="12" aria-describedby="import-yaml-help" placeholder="voicechannels.enabled: true&#10;quotes.max_length: 500"></textarea>
    <div>
      <button type="submit" class="btn btn-primary">Preview import</button>
    </div>
  </form>
</div>`;

  // Two-step confirm: the JS confirm() guards the click, and the operator
  // must additionally type the guild name (or guild id when the name can't
  // be fetched) into the text field, which the server re-validates. The
  // `required` attribute and `confirmTarget` keep the client and server in
  // step. See `POST /admin/settings/reset-defaults` in routes/write/settings.ts.
  const confirmTarget = props.guildName ?? props.guildId;
  const dangerSection = `
<div id="danger-zone" class="card" style="border-color:var(--danger)">
  <h2>Danger zone</h2>
  <p class="muted" style="margin:0 0 .75rem">Reset every setting to its built-in default. All keys in the schema are rewritten to their default value, and any orphaned keys left behind by removed features are deleted. Bootstrap / environment variables (Discord token, Mongo URI, WebUI session config) are <strong>not</strong> touched. You may need to <strong>Reload commands</strong> afterwards.</p>
  <form method="POST" action="/admin/settings/reset-defaults" class="stack" data-confirm="Reset ALL settings to their defaults? This cannot be undone."${confirmListAttr(
    [
      "Every setting is rewritten to its built-in default, including channels, roles and feature switches.",
      "Stored keys that are no longer in the schema are deleted.",
      "Bootstrap and environment values (Discord token, Mongo URI, Web UI session) are not touched.",
      "Scheduled jobs restart from the defaults; reload commands yourself afterwards.",
    ],
  )}>
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
<h1>All settings</h1>
<p class="subtitle">All DB-backed configuration, grouped by feature. Mirrors <code>SETTINGS.md</code> and <code>config-service.ts</code>.</p>
${renderFlash(props.flash, SETTINGS_FLASH_ID)}
${actionBar}
${
  props.settingsUnavailable
    ? `<div class="card">${renderSettingsUnavailableNotice()}</div>`
    : sections
}
${importSection}
${dangerSection}
`;
  return renderAdminPage({
    title: "All settings",
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
    <thead><tr><th scope="col">Key</th><th scope="col">Status</th><th scope="col">Current</th><th scope="col">New value</th></tr></thead>
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
  /** Role groups the pickers offer next to raw roles (#1023). */
  groups?: ReadonlyArray<{ id: string; name: string }>;
  /** Group references (`group:<id>[+]`) per command. */
  groupRefsPerCommand?: Map<string, string[]>;
  /** Commands that default to the staff capability, shown while groups exist. */
  staffDefaultCommands?: ReadonlySet<string>;
  /** Whether any staff or admin group exists (the staff default is active). */
  staffDefaultActive?: boolean;
  /**
   * The role groups couldn't be read, so whether the staff default applies is
   * unknown. Runtime checks refuse the moderation commands in that state, so
   * the page must not call them open.
   */
  groupsUnavailable?: boolean;
  flash?: FlashMessage | null;
}

/** Label for a `group:<id>[+]` reference (the picker uses the same text). */
function groupRefLabel(
  ref: string,
  groups: ReadonlyArray<{ id: string; name: string }>,
): string {
  const andAbove = ref.endsWith("+");
  const id = ref.slice("group:".length).replace(/[+]$/, "");
  const name = groups.find((g) => g.id === id)?.name ?? `${id} (missing)`;
  return `${name}${andAbove ? " and above" : ""}`;
}

export function renderPermissionsPage(props: PermissionsProps): string {
  const csrf = escapeHtml(props.csrfToken);
  const groups = props.groups ?? [];
  const groupRefsPerCommand = props.groupRefsPerCommand ?? new Map();
  const usedGroupRefs = Array.from(
    new Set(Array.from(groupRefsPerCommand.values()).flat()),
  ).sort((a, b) =>
    groupRefLabel(a, groups).localeCompare(groupRefLabel(b, groups)),
  );
  /** Status of a command with no explicit restriction. */
  const unrestrictedStatus = (cmd: string): string => {
    if (props.staffDefaultCommands?.has(cmd) !== true) {
      return `<span class="tag tag-info">open</span>`;
    }
    if (props.groupsUnavailable === true) {
      return `<span class="tag tag-warn">unknown (role groups unavailable)</span>`;
    }
    return props.staffDefaultActive === true
      ? `<span class="tag tag-warn">Moderators only (default)</span>`
      : `<span class="tag tag-info">open</span>`;
  };
  const groupHeaders = usedGroupRefs
    .map(
      (ref) =>
        `<th scope="col">${escapeHtml(groupRefLabel(ref, groups))} <span class="muted">(group)</span></th>`,
    )
    .join("");

  const headerRoles = props.roleIds
    .map(
      (rid) =>
        `<th scope="col" title="${escapeHtml(rid)}">${escapeHtml(props.roleNames.get(rid) ?? rid)}</th>`,
    )
    .join("");

  const matrixRows = props.commands
    .map((cmd) => {
      const allowed = new Set([
        ...(props.perCommand.get(cmd) ?? []),
        ...(groupRefsPerCommand.get(cmd) ?? []),
      ]);
      const cells = [...props.roleIds, ...usedGroupRefs]
        .map(
          (rid) =>
            // Each cell's whole content was "✓" or "—" (#855): the glyph stays
            // for sighted users (aria-hidden) and hidden text says what it means.
            `<td>${
              allowed.has(rid)
                ? '<span class="tag tag-on"><span aria-hidden="true">✓</span><span class="visually-hidden">Allowed</span></span>'
                : '<span class="muted" aria-hidden="true">—</span><span class="visually-hidden">Not allowed</span>'
            }</td>`,
        )
        .join("");
      const status =
        allowed.size === 0
          ? unrestrictedStatus(cmd)
          : `<span class="tag tag-warn">restricted</span>`;
      // The command name is the row header of a true 2D grid (#855), so a
      // screen reader can recover "which command, which role" from any cell.
      return `<tr><th scope="row" class="mono">/${escapeHtml(cmd)}</th><td>${status}</td>${cells}</tr>`;
    })
    .join("");

  const matrixHtml =
    props.roleIds.length === 0 && usedGroupRefs.length === 0
      ? `<div class="empty">No restricted commands. ${
          props.groupsUnavailable === true
            ? "The role groups couldn't be read, so the moderation commands are refused until they can be."
            : props.staffDefaultActive === true
              ? "Commands are open by default, except the moderation commands, which are for Moderators only while a Moderator or Admin role group exists."
              : "All registered commands are open by default."
        }</div>`
      : `<table><caption class="visually-hidden">Which roles may run each restricted command</caption><thead><tr><th scope="col">Command</th><th scope="col">Status</th>${headerRoles}${groupHeaders}</tr></thead><tbody>${matrixRows}</tbody></table>`;

  const editRows = props.commands
    .map((cmd) => {
      const current = new Set([
        ...(props.perCommand.get(cmd) ?? []),
        ...(groupRefsPerCommand.get(cmd) ?? []),
      ]);
      const status =
        current.size === 0
          ? unrestrictedStatus(cmd)
          : `<span class="tag tag-warn">restricted</span>`;
      const roleOptions =
        props.allRoleIds.length === 0
          ? `<option disabled>No roles available in this guild</option>`
          : props.allRoleIds
              .map((rid) => {
                const name = props.roleNames.get(rid) ?? rid;
                const sel = current.has(rid) ? " selected" : "";
                return `<option value="${escapeHtml(rid)}"${sel}>${escapeHtml(name)}</option>`;
              })
              .join("");
      // Role groups (#1023): each group alone, or "and above" (that group
      // plus every group ranked higher). A reference to a group that has
      // since been deleted stays visible so saving doesn't drop it silently.
      const knownRefs = new Set(
        groups.flatMap((g) => [`group:${g.id}`, `group:${g.id}+`]),
      );
      const groupOptionHtml = (ref: string, label: string): string =>
        `<option value="${escapeHtml(ref)}"${current.has(ref) ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const groupOptions = [
        ...groups.flatMap((g) => [
          groupOptionHtml(`group:${g.id}`, `${g.name} (group)`),
          groupOptionHtml(`group:${g.id}+`, `${g.name} and above (group)`),
        ]),
        ...Array.from(current)
          .filter((v) => v.startsWith("group:") && !knownRefs.has(v))
          .map((v) => groupOptionHtml(v, groupRefLabel(v, groups))),
      ].join("");
      const options = groupOptions
        ? `<optgroup label="Role groups">${groupOptions}</optgroup><optgroup label="Roles">${roleOptions}</optgroup>`
        : roleOptions;
      // The role picker sits in a column headed "Allowed roles", which a
      // screen reader does not announce as the control's name. Give it a
      // visually-hidden `<label for>` naming the command it governs, and link
      // the "Hold Ctrl/⌘" hint beside it via `aria-describedby` (#854).
      const escapedCmd = escapeHtml(cmd);
      const selectId = `perm-roles-${escapedCmd}`;
      const hintId = `perm-hint-${escapedCmd}`;
      return `<tr>
<th scope="row" class="mono">/${escapedCmd}</th>
<td>${status}</td>
<td>
  <form method="POST" action="/admin/permissions/set" class="inline-form" style="align-items:flex-start">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="command" value="${escapedCmd}">
    <label class="visually-hidden" for="${selectId}">Allowed roles for /${escapedCmd}</label>
    <select id="${selectId}" name="roleIds" multiple size="3" style="min-width:14rem" aria-describedby="${hintId}">${options}</select>
    <div style="display:flex;flex-direction:column;gap:.25rem">
      <button type="submit" class="btn btn-primary btn-sm">Save</button>
      <span class="muted" id="${hintId}" style="font-size:.7rem">Hold Ctrl/⌘<br>for multiple</span>
    </div>
  </form>
</td>
</tr>`;
    })
    .join("");

  const body = `
<h1>Command permissions</h1>
<p class="subtitle">Discord command access. Administrators always bypass these checks. Select roles or role groups to restrict a command; deselect all and save to make it open. "And above" includes every group ranked higher. While at least one Moderator or Admin group exists, the moderation commands (<code>/warn</code>, <code>/timeout</code>, <code>/ban</code>, <code>/modlog</code>) default to Moderators unless you set a restriction here; with no groups they stay open.</p>
${renderFlash(props.flash)}
<div class="card">
  <h2>Edit</h2>
  <table>
    <thead><tr><th scope="col">Command</th><th scope="col">Status</th><th scope="col">Allowed roles (multi-select)</th></tr></thead>
    <tbody>${editRows}</tbody>
  </table>
</div>
<div class="card"><h2>Matrix</h2>${matrixHtml}</div>
`;
  return renderAdminPage({
    title: "Command permissions",
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
  lfg: {
    name: "Looking for Group",
    desc: "Let members post short-lived group-finder requests.",
  },
  moderation: {
    name: "Moderation",
    desc: "Warnings, mod log and how long moderation history is kept.",
  },
  events: {
    name: "Events",
    desc: "Scheduled community events with temporary voice channels.",
  },
  digest: {
    name: "Weekly Digest",
    desc: "Personal weekly voice-activity summary sent by DM.",
  },
  birthdays: {
    name: "Birthdays",
    desc: "Birthday announcements and an optional birthday role.",
  },
  reminders: {
    name: "Reminders",
    desc: "Let members set personal reminders.",
  },
  leaderboard_roles: {
    name: "Leaderboard Roles",
    desc: "Award roles to top voice-activity members each period.",
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
${renderWizardSteps("features")}
<p class="subtitle">Pick the features you want to configure and click <strong>Next</strong>. The wizard walks you through each feature's key settings.</p>
<div class="notice info">Changes are only applied at the final confirmation step. Cancel any time without affecting the current configuration.</div>
<div class="card" id="wizard-adoption">
  <h2>Adopting an existing server?</h2>
  <p>If this server already has roles, categories and channels, let KoolBot take them over instead of creating new ones. Nothing is changed until you preview a plan and apply it, every apply is saved as a snapshot, and you can restore it later. Steps 2 to 4 are optional.</p>
  <ol>
    <li><a href="/admin/adopt">Scan the server</a>: roles, channels, other bots and what to fix first.</li>
    <li><a href="/admin/role-groups">Role groups</a>: tie your Admin, Mod or VIP roles to groups.</li>
    <li><a href="/admin/rules">Rules role</a>: an optional rules acceptance gate.</li>
    <li><a href="/admin/adopt/claims">Channel claims</a>: preview, then apply, read-only and gated channels and feature bindings.</li>
    <li><a href="/admin/adopt/history">History</a>: review snapshots and restore one.</li>
  </ol>
  <p class="muted">Starting from a fresh server? Skip this and pick features below.</p>
</div>
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
  /** Roles with role groups ahead of them, for keys that take groups (#1023). */
  groupRoles?: RoleOption[];
  /** The bot's reaction-role messages, for a key that picks one (#1433). */
  reactionRoleMessages?: ReactionRoleMessageOptions | null;
  /**
   * Enabled-state of every key on this step *plus* the cross-feature
   * dependency targets those keys reference (e.g. `achievements.enabled`
   * depends on `voicetracking.enabled`, which lives on another step). The
   * shared dependency-hint / lock logic (#666) reads this so the wizard greys
   * out the same controls the Settings page does.
   */
  enabledByKey: Record<string, boolean>;
  flash?: FlashMessage | null;
  /**
   * The stored config could not be read, so `currentValues` can't be trusted
   * (`ConfigService.get` returns `null` on a read error). The step form is
   * replaced by a notice so blank values can't be carried into an apply.
   */
  settingsUnavailable?: boolean;
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
    groupRoles: props.groupRoles,
    reactionRoleMessages: props.reactionRoleMessages,
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
      min: meta?.min,
      max: meta?.max,
      managed: meta?.managed,
      format: meta?.format,
      stepper: meta?.stepper,
      presets: meta?.presets,
      presetZeroLabel: meta?.presetZeroLabel,
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
      // associate with it via `for` (#703), and link the help / warning /
      // dependency text beside it via `aria-describedby` (#854). The cron
      // picker manages its own inputs, so its caption names a group instead of
      // pointing `for` at nothing.
      const inputId = `wiz-${r.key}`;
      const labelId = `${inputId}-label`;
      const helpId = `${inputId}-help`;
      const warnId = `${inputId}-warn`;
      const depId = `${inputId}-dep`;
      const warnHtml = renderWarnBelow(r, warnId);
      const depHtml = renderDependencyHint(unmet, false, depId);
      const describedBy = [
        warnHtml ? warnId : "",
        depHtml ? depId : "",
        r.description ? helpId : "",
      ]
        .filter(Boolean)
        .join(" ");
      const control = renderSettingControl(
        r,
        pickers,
        r.key === masterKey,
        depLocked,
        { id: inputId, describedBy, labelledBy: labelId },
      );
      const labelFor = isGroupControl(r) ? "" : ` for="${escapeHtml(inputId)}"`;
      // Human-readable label (#702) with the raw dotted key demoted to
      // monospace helper text — the same treatment the Settings page gives its
      // rows, wrapped in a `<label>` so the whole caption stays clickable.
      return `<div class="field-row${rowClass}">
  <label class="field-label" id="${labelId}"${labelFor}>
    <strong>${escapeHtml(r.label)}</strong>
    <code class="mono muted" style="font-size:.85em">${escapeHtml(r.key)}</code>
  </label>
  ${control}
  ${warnHtml}
  ${depHtml}
  <div class="help" id="${helpId}">${escapeHtml(r.description)}</div>
</div>`;
    })
    .join("");

  // The tiers are not a wizard field (#1433): nobody should type `topN:roleId`.
  // They are chosen in the tier editor, which needs the feature to exist first.
  const stepNote =
    props.featureKey === "leaderboard_roles"
      ? `\n  <p class="muted">Which roles each rank earns is set in the tier editor on the <a href="/admin/leaderboard-roles">Leaderboard Roles</a> page, once you have applied the wizard.</p>`
      : "";
  const stepLabel = `Step ${props.stepIndex + 1} of ${props.totalSteps}`;
  const nextLabel =
    props.stepIndex + 1 < props.totalSteps ? "Next →" : "Review →";

  // A "← Previous" link appears on every step after the first. It's a plain
  // GET back to the prior step — the wizard session already holds the saved
  // values, and the step renderer pre-fills from `wizard.getConfiguration`,
  // so navigating back preserves in-progress state without re-submitting
  // this step's form (issue #485).
  const previousButton = `<a href="/admin/wizard?step=${
    props.stepIndex >= 1 ? props.stepIndex - 1 : "access"
  }" class="btn">← Previous</a>`;

  const body = `
${renderWizardSteps("channels")}
<h1>${escapeHtml(info.name)} <span class="muted" style="font-size:1rem">${escapeHtml(stepLabel)}</span></h1>
<p class="subtitle">${escapeHtml(info.desc)}</p>
${renderFlash(props.flash)}
${
  props.settingsUnavailable
    ? `<div class="card">${renderSettingsUnavailableNotice()}</div>
<div class="actions">
  ${previousButton}
  <a href="/admin/wizard" class="btn">← Back to features</a>
</div>`
    : `<form method="POST" action="/admin/wizard/step/${props.stepIndex}" data-cascade-scope>
  <input type="hidden" name="_csrf" value="${csrf}">
  <div class="card">${fields}</div>${stepNote}
  <div class="actions">
    <button type="submit" class="btn btn-primary">${nextLabel}</button>
    ${previousButton}
    <a href="/admin/wizard" class="btn">← Back to features</a>
  </div>
</form>`
}
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
  /** Role mapping from the Access step, written to role groups on Apply (#1321). */
  accessChanges?: AccessChange[];
  /** Why the role mapping can't be applied; Apply is blocked while set. */
  accessProblem?: string | null;
  /** Switched-on features with nobody mapped to run them. */
  accessGaps?: AccessGap[];
  /** What Review showed; posted back so Apply can tell if it went stale. */
  accessFingerprint?: string;
  /** The plan for creating the Event host role (#1365), when it was chosen. */
  hostRole?: HostReview | null;
  flash?: FlashMessage | null;
}

export function renderWizardConfirmPage(props: WizardConfirmPageProps): string {
  const csrf = escapeHtml(props.csrfToken);
  const accessChanges = props.accessChanges ?? [];
  const hostRole = props.hostRole ?? null;
  const nothingToApply =
    props.pending.length === 0 && accessChanges.length === 0 && !hostRole;
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
${renderWizardSteps("review")}
<h1>Review configuration</h1>
<p class="subtitle">The following settings will be applied when you click <strong>Apply</strong>.</p>
${renderFlash(props.flash)}
${renderAccessReview(accessChanges, props.accessProblem ?? null, props.accessGaps ?? [], hostRole)}
<div class="card">
  <table>
    <thead><tr><th scope="col">Key</th><th scope="col">New value</th><th scope="col">Description</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
<div class="actions">
  <form method="POST" action="/admin/wizard/apply">
    <input type="hidden" name="_csrf" value="${csrf}">
    ${props.accessFingerprint ? `<input type="hidden" name="accessFingerprint" value="${escapeHtml(props.accessFingerprint)}">` : ""}
    ${hostRole?.planId ? `<input type="hidden" name="hostPlanId" value="${escapeHtml(hostRole.planId)}">` : ""}
    <button type="submit" class="btn btn-primary"${nothingToApply || props.accessProblem || (hostRole && hostRole.problems.length > 0) ? " disabled" : ""}>Apply</button>
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
  /** Discord type of the channel; null when it no longer resolves. */
  channelType: ChannelType | null;
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
  /** Discord channel type: decides the icon and the group the option is listed under (#1303). */
  type: ChannelType;
  /** Name of the category the channel sits in, shown after the name where the control cannot show it separately. */
  parentName?: string | null;
}

export interface RoleOption {
  id: string;
  name: string;
}

export interface FlashMessage {
  type: "ok" | "warn" | "err";
  text: string;
  /**
   * The flash belongs to a save or reset of the folded settings on a feature
   * page (#1301): the page shows it inside the settings, opens them, and does
   * not repeat it at the top.
   */
  openSettings?: boolean;
}

export interface AnnouncementsProps extends CommonProps {
  enabled: boolean;
  rows: AnnouncementRow[];
  textChannels: ChannelOption[];
  /**
   * The `announcements.*` keys, edited in place on this page (#977) through
   * {@link renderFeatureSettingsCard}. Includes `announcements.enabled`, so
   * the feature can be switched off here as well as on.
   */
  settingRows?: SettingRow[];
  /** On/off state of off-card dependencies of {@link settingRows}. */
  dependencyState?: ReadonlyMap<string, boolean>;
  /** The stored config could not be read; the card renders a notice. */
  settingsUnavailable?: boolean;
  flash?: FlashMessage | null;
}

/** Who is expected to show up, from the native event's Interested list. */
export type EventExpected =
  | {
      kind: "ok";
      count: number;
      names: string[];
      truncated: boolean;
    }
  | { kind: "unavailable" | "none"; message: string };

export interface EventRow {
  id: string;
  title: string;
  when: string;
  state: string;
  /** Legacy KoolBot RSVP tally, for events posted before native-only events
   * (#1175); null when there are none or the event is over. */
  legacyRsvps?: { going: number; maybe: number; cant: number } | null;
  /** Native "Interested" members, read live from Discord (#1175); null when
   * the event is finished and was not looked up. */
  expected?: EventExpected | null;
  channelId: string | null;
  /** Cadence label (e.g. "weekly") when part of a recurring series, else null (#744). */
  recurrence?: string | null;
  /** 1-based position within the series, for the indicator. */
  occurrence?: number | null;
  /** Finished occurrence whose successor hasn't been created yet, so the
   * series is still live and can be cancelled from this row. */
  awaitingSuccessor?: boolean;
  /** Number of groups when the event has a group setup (#1188), else absent. */
  groupCount?: number;
  /** The event has group voice channels, so "End now" offers to move people
   * back to the main channel first (#1193). */
  hasGroupChannels?: boolean;
  /** Adopted Discord event: ending leaves it as it is (#1177, #1193). */
  nativeAdopted?: boolean;
  /**
   * Cover image control (#1181). `editable`: can be set, replaced or removed
   * (`series` when it applies to a whole recurring series); `adopted`: the
   * event keeps the cover it has in Discord, so no control is offered; null:
   * finished, nothing to show.
   */
  cover?:
    | { kind: "editable"; hasCover: boolean; series: boolean }
    | { kind: "adopted" }
    | { kind: "detached" }
    | null;
}

export interface EventsProps extends CommonProps {
  enabled: boolean;
  categoryConfigured: boolean;
  announcementConfigured: boolean;
  /**
   * What the bot lacks for the event features (#1253), from the registry's
   * check: the Discord Events list card, event channels, host access, moves,
   * clan tags and the announcement channel. Null: nothing to say.
   */
  permissionNotice?: PermissionNotice | null;
  timezone: string;
  rows: EventRow[];
  /**
   * Every `events.*` key, edited in place on this page (#975) through
   * {@link renderFeatureSettingsCard}. Includes `events.enabled`, so the
   * feature can be switched off here as well as on.
   */
  settingRows: SettingRow[];
  /** Picker lists the card's category / channel keys render. */
  settingsPickers?: FeatureSettingsPickers;
  /** On/off state of off-card dependencies of {@link settingRows}. */
  dependencyState?: ReadonlyMap<string, boolean>;
  /**
   * True when the stored config could not be read. The card then renders a
   * notice instead of controls pre-filled with schema defaults.
   */
  settingsUnavailable?: boolean;
  /** Group rows the form offers and the cap (#1188); defaults 2 and 15. */
  groupLimits?: { defaultCount: number; maxCount: number };
  /**
   * The presets the picker offers (#1200): the enabled built-ins and library
   * presets. Absent = every built-in, as before the library existed.
   */
  groupPresets?: readonly EventGroupPreset[];
  /** Shown above the picker when the preset library could not be read. */
  groupPresetsNotice?: string | null;
  /** The host's last group setup, to prefill the form (#1406); absent = defaults. */
  groupRemembered?: { prefill: GroupFormPrefill; resetHref: string } | null;
  flash?: FlashMessage | null;
}

export function renderFlash(flash?: FlashMessage | null, id = ""): string {
  if (!flash) return "";
  const cls =
    flash.type === "ok" ? "ok" : flash.type === "warn" ? "warn" : "err";
  // `id` is optional: the Settings page names its banner so the controls of
  // rejected keys can reference it from `aria-describedby` (#854).
  const idAttr = id ? ` id="${escapeHtml(id)}"` : "";
  // role="status" + tabindex="-1" + data-flash: a polite live region that the
  // layout's on-load script focuses (when nothing is aria-invalid) so the
  // outcome of a post-redirect save is actually announced (WCAG 4.1.3, #855).
  return `<div class="notice ${cls}"${idAttr} role="status" tabindex="-1" data-flash>${escapeHtml(flash.text)}</div>`;
}

/**
 * The flash at the top of a feature page. One that belongs to the folded
 * settings (#1301) is shown inside them by `renderFeatureSettingsCard`, so it
 * is left out here: the page must not say it twice, and the load-time focus
 * then lands on it in the settings instead of scrolling back to the top.
 */
export function renderPageFlash(flash?: FlashMessage | null): string {
  return flash?.openSettings ? "" : renderFlash(flash);
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
  if (options.length === 0 && !selectedId) {
    return `<option value="">(no text channels available)</option>`;
  }
  // buildOptionsHtml keeps a selected channel that's no longer in the list
  // (deleted, or the bot lost access) as a selected "unavailable" option.
  // Without a matching <option> the browser would default to the first
  // channel, so editing only the cron/duration would silently reassign the
  // schedule's channel on submit.
  return buildOptionsHtml(
    options,
    new Set(selectedId ? [selectedId] : []),
    false,
  );
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
      `<option value="${escapeHtml(selectedId)}" selected>${escapeHtml(missingText(selectedId))}</option>`,
    );
  }
  out.push(
    ...options.map(
      (r) =>
        `<option value="${escapeHtml(r.id)}"${r.id === selectedId ? " selected" : ""}>${escapeHtml(roleText(r.name))}</option>`,
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
<td>${channelMention({ name: a.channelName, type: a.channelType })}</td>
<td class="mono">${escapeHtml(a.cron)}</td>
<td>${tagOnOff(a.enabled)}</td>
<td>${escapeHtml(a.messagePreview)}${a.embedTitle ? `<div class="muted mono">embed: ${escapeHtml(a.embedTitle)}</div>` : ""}</td>
<td>${a.placeholders ? '<span class="tag tag-info">yes</span>' : '<span class="muted">no</span>'}</td>
<td class="muted">${escapeHtml(a.createdAt)}</td>
<td class="actions">
  <form method="POST" action="/admin/announcements/${escapeHtml(a.id)}/post-now">${csrfInput}<button type="submit" class="btn btn-primary">Post now</button></form>
  <form method="POST" action="/admin/announcements/${escapeHtml(a.id)}/toggle">${csrfInput}<button type="submit" class="btn">${a.enabled ? "Disable" : "Enable"}</button></form>
  <form method="POST" action="/admin/announcements/${escapeHtml(a.id)}/delete" data-confirm="Delete announcement ${escapeHtml(a.id)}?">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form>
</td>
</tr>`,
    )
    .join("");

  const tableHtml =
    props.rows.length === 0
      ? `<div class="empty">No scheduled announcements configured.</div>`
      : `<table><thead><tr><th scope="col">ID</th><th scope="col">Channel</th><th scope="col">Cron</th><th scope="col">Status</th><th scope="col">Message</th><th scope="col">Placeholders</th><th scope="col">Created</th><th scope="col">Actions</th></tr></thead><tbody>${tableRows}</tbody></table>`;

  const body = `
<h1>Announcements</h1>
<p class="subtitle">Scheduled announcements posted on a cron.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Announcements", featureKey: "announcements.enabled", returnTo: "/admin/announcements", csrfToken: props.csrfToken })}
${renderStatusLine({
  enabled: props.enabled,
  chips: [{ text: countOf(props.rows.length, "schedule") }],
})}

<div class="card">
  <h2>Schedules</h2>${tableHtml}
  <form method="POST" action="/admin/announcements/post-vc-stats" class="inline-form">
    ${csrfInput}
    <button type="submit" class="btn btn-primary">Post weekly VC stats now</button>
    <span class="muted">Posts the weekly voice-stats announcement immediately, off schedule.</span>
  </form>
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
${renderFeatureSettingsCard({
  intro:
    "Switch scheduled announcements on or off here without leaving the page. Saved through the shared settings route.",
  category: "announcements",
  settingRows: props.settingRows ?? [],
  returnTo: "/admin/announcements",
  csrfToken: props.csrfToken,
  dependencyState: props.dependencyState,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
})}
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

// ---------- Events ----------

function eventStateTag(state: string): string {
  const cls =
    state === "active"
      ? "tag-on"
      : state === "cancelled"
        ? "tag-off"
        : state === "ended"
          ? "tag-info"
          : "tag-info";
  return `<span class="tag ${cls}">${escapeHtml(state)}</span>`;
}

function renderExpected(e: EventRow): string {
  const x = e.expected;
  let html: string;
  if (!x) {
    html = '<span class="muted">—</span>';
  } else if (x.kind === "ok") {
    const count = `${x.count}${x.truncated ? "+" : ""}`;
    const names =
      x.names.length > 0
        ? `<br><span class="muted">${x.names.map((n) => escapeHtml(n)).join(", ")}${x.count > x.names.length || x.truncated ? ", …" : ""}</span>`
        : "";
    html = `<span aria-hidden="true">⭐</span> ${count} interested${names}`;
  } else {
    html = `<span class="muted">${escapeHtml(x.message)}</span>`;
  }
  const l = e.legacyRsvps;
  if (l) {
    html += `<br><span class="muted">Old RSVP buttons: ${l.going} going · ${l.maybe} maybe · ${l.cant} can't</span>`;
  }
  return html;
}

function renderCoverCell(
  e: EventRow,
  csrfInput: string,
  csrfToken: string,
): string {
  const c = e.cover;
  if (!c) return '<span class="muted">—</span>';
  if (c.kind === "adopted") {
    return '<span class="muted">Managed in Discord. This event was adopted, so KoolBot keeps its existing cover and never changes it.</span>';
  }
  if (c.kind === "detached") {
    return '<span class="muted">Not available. This event was deleted from Discord\'s Events list and is no longer mirrored, so a cover would never be shown.</span>';
  }
  const id = escapeHtml(e.id);
  const scope = c.series
    ? '<span class="muted">Applies to every occurrence of the series.</span><br>'
    : "";
  const remove = c.hasCover
    ? `<form method="POST" action="/admin/events/${id}/cover/remove" data-confirm="Remove the cover image${c.series ? " from the whole series" : ""}?">${csrfInput}<button type="submit" class="btn btn-danger">Remove cover</button></form>`
    : "";
  return `<details class="helper edit-details"><summary>${c.hasCover ? "Cover set — change" : "Add cover"}</summary>
    ${scope}<form method="POST" action="/admin/events/${id}/cover" class="stack" data-cover-upload data-max-bytes="${COVER_MAX_BYTES}">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <label>Image (PNG, JPEG or GIF, up to ${COVER_MAX_BYTES / (1024 * 1024)} MB)
        <input type="file" accept="image/png,image/jpeg,image/gif">
      </label>
      <button type="submit" class="btn btn-primary">${c.hasCover ? "Replace cover" : "Upload cover"}</button>
      <span class="cover-msg muted" role="status" aria-live="polite"></span>
    </form>
  </details>
  ${remove}`;
}

// ---------- Event groups form section (#1188) ----------

/**
 * The kinds a host can pick for a group. `leads` is not one of them (#1251): the
 * leaders-only channel is the "Captains lobby" switch. It stays valid in stored
 * data and in presets saved before, so a row that already IS `leads` is still
 * rendered with its own option (`LEADS_KIND_OPTION`) and is never turned into a
 * team by opening and saving it.
 */
export const GROUP_KIND_OPTIONS: ReadonlyArray<[string, string]> = [
  ["team", "Team (members belong to it)"],
  ["open", "Open (anyone can join, e.g. spectators)"],
];

/** The option of a row that is already a leads group (an old preset). */
const LEADS_KIND_OPTION: [string, string] = [
  "leads",
  "Leads (leaders and host only; use the Captains lobby tick instead)",
];

/**
 * Changes for a place that renders the rows but posts other field names (the
 * host panel's live edit, whose rows are named `s_<row>`).
 */
export interface GroupRowOptions {
  /** Field names, by column; a column left out keeps `group_<index>_<field>`. */
  names?: Partial<Record<"marker" | "name" | "size" | "tag", string>>;
  /** The group's kind cannot change here: no kind select and no "More" button. */
  fixedKind?: boolean;
  /** This group carries no tag (an open group): the tag box is shown disabled and posts nothing. */
  noTag?: boolean;
  /** Markup inside the row, after the grid: hidden shown-value fields, a note. Built by the caller (escaped there). */
  extra?: string;
}

/**
 * One group row, on one line: marker, name, size, tag, and a "More" button for
 * the kind (Team is right for almost everything). `index` and `position` are
 * numbers for a rendered row and the `__N__` / `__P__` placeholders for the
 * template the script clones.
 *
 * Without scripts the marker is a text box and the kind select is shown, as
 * before; `event-group-form.ts` turns the marker into an emoji picker and folds
 * the kind behind "More".
 */
export function renderGroupRow(
  index: string,
  position: string,
  group?: {
    name?: string;
    kind?: string;
    size?: string;
    tag?: string;
    marker?: string;
  },
  options?: GroupRowOptions,
): string {
  const field = (f: "marker" | "name" | "size" | "tag" | "kind"): string =>
    (f === "kind" ? undefined : options?.names?.[f]) ?? `group_${index}_${f}`;
  const kinds = (
    group?.kind === "leads"
      ? [...GROUP_KIND_OPTIONS, LEADS_KIND_OPTION]
      : GROUP_KIND_OPTIONS
  )
    .map(
      ([value, label]) =>
        `<option value="${value}"${group?.kind === value ? " selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");
  return `<div data-group-row role="group" aria-label="Group ${position}" class="kb-grouprows__item">
        <div class="kb-grouprow">
          <div data-marker-wrap class="kb-emoji-wrap">
            <input type="text" data-marker-input class="kb-input kb-input--sm" name="${field("marker")}" aria-label="Group ${position} marker (optional, e.g. a coloured circle)" maxlength="${GROUP_MARKER_MAX_CHARS * 2}" value="${escapeHtml(group?.marker ?? "")}">
            <button type="button" data-marker-btn class="kb-emoji-btn kb-emoji-btn--sm" aria-haspopup="true" aria-expanded="false" aria-label="Group ${position} marker: choose one" hidden>+</button>
          </div>
          <input type="text" class="kb-input kb-input--sm" name="${field("name")}" aria-label="Group ${position} name" maxlength="${GROUP_NAME_MAX}" value="${escapeHtml(group?.name ?? "")}">
          <input type="number" class="kb-input kb-input--sm" name="${field("size")}" aria-label="Group ${position} size (1 to ${GROUP_SIZE_MAX}, empty = no limit)" min="${GROUP_SIZE_MIN}" max="${GROUP_SIZE_MAX}" value="${escapeHtml(group?.size ?? "")}">
          ${
            options?.noTag
              ? `<input type="text" class="kb-input kb-input--sm" aria-label="Group ${position} tag (only a team carries a tag)" title="Only a team carries a tag" disabled>`
              : `<input type="text" class="kb-input kb-input--sm" name="${field("tag")}" aria-label="Group ${position} tag (optional, up to ${GROUP_TAG_MAX} characters)" maxlength="${GROUP_TAG_MAX}" value="${escapeHtml(group?.tag ?? "")}">`
          }${
            options?.fixedKind
              ? ""
              : `
          <button type="button" data-kind-toggle class="kb-btn kb-btn--ghost kb-btn--sm" aria-expanded="true" aria-label="Group ${position}: more options" hidden>More</button>`
          }
        </div>${
          options?.fixedKind
            ? ""
            : `
        <div data-kind-panel class="kb-grouprows__more">
          <label class="kb-label">Group ${position} kind
            <select class="kb-select kb-input--sm" name="${field("kind")}">${kinds}</select>
          </label>
        </div>`
        }${options?.extra ?? ""}
      </div>`;
}

/** The labels over the group rows' columns, matching `.kb-grouprow`. */
export const GROUP_ROWS_HEAD =
  '<div class="kb-grouprows__head" aria-hidden="true"><span>Marker</span><span>Name</span><span>Max size</span><span>Tag</span><span></span></div>';

const CHECK_ICON = icon("check", { className: "kb-choice__check" });

/** Where a preset comes from, in the words a host would use. */
function presetSource(id: string): string {
  if (id.startsWith(PERSONAL_PRESET_PREFIX)) return "Yours";
  if (id.startsWith(LIBRARY_PRESET_PREFIX)) return "Server preset";
  return "Built in";
}

/** One preset as a choice card: a radio, so the posted field is the same as the old select's. */
function renderPresetCard(
  preset: EventGroupPreset,
  limits: { maxCount: number },
  checked = false,
): string {
  const groups = JSON.stringify(
    preset.groups.map((g) => ({
      name: g.name,
      kind: g.kind,
      size: g.size,
      tag: g.tag,
      marker: g.marker,
    })),
  );
  // A preset bigger than the cap cannot be applied whole, so it is not offered
  // (the server refuses it too).
  const tooBig = preset.groups.length > limits.maxCount;
  // Library presets may carry a leader label and a lead time; the script
  // fills those fields only when the attribute is there. An explicit null
  // (a library preset that uses the server default) is an empty attribute,
  // which clears the field; a built-in has none and leaves it alone.
  const extra =
    (preset.leaderLabel
      ? ` data-leader-label="${escapeHtml(preset.leaderLabel)}"`
      : "") +
    (typeof preset.channelLeadMinutes === "number"
      ? ` data-lead="${preset.channelLeadMinutes}"`
      : preset.channelLeadMinutes === null
        ? ' data-lead=""'
        : "") +
    // The preset's default for the clan tags box (#1194); absent = off. The
    // script sets the box from it when the preset is chosen.
    ` data-tags="${preset.tagsEnabled === true ? "1" : "0"}"`;
  const markers = preset.groups
    .map((g) => g.marker)
    .filter(Boolean)
    .join(" ");
  const shape = `${preset.groups.length} ${preset.groups.length === 1 ? "group" : "groups"}`;
  const meta = tooBig
    ? `needs ${preset.groups.length} groups, limit is ${limits.maxCount}`
    : `${presetSource(preset.id)} · ${shape}`;
  return `<label class="kb-choice"><input type="radio" name="${GROUP_FORM_FIELDS.preset}" value="${escapeHtml(preset.id)}" data-label="${escapeHtml(preset.groupLabel)}"${extra}${checked && !tooBig ? " checked" : ""} data-groups="${escapeHtml(groups)}"${tooBig ? " disabled" : ""}>
          <span class="kb-choice__title">${escapeHtml(preset.label)}</span>
          <span class="kb-choice__meta">${escapeHtml(meta)}</span>${preset.description ? `\n          <span class="kb-choice__meta">${escapeHtml(preset.description)}</span>` : ""}${markers ? `\n          <span class="kb-choice__marks">${escapeHtml(markers)}</span>` : ""}
          ${CHECK_ICON}</label>`;
}

/** A switch with its help line underneath, for the options of the group setup. */
function groupSwitch(
  name: string,
  label: string,
  help: string,
  idSuffix: string,
  checked = false,
): string {
  return `<div class="kb-groupopt">
        <label class="kb-switch"><input type="checkbox" role="switch" name="${name}" value="1"${checked ? " checked" : ""} aria-describedby="groups-${idSuffix}-help"><span class="kb-switch__track" aria-hidden="true"></span><span class="kb-switch__state" aria-hidden="true"></span>${escapeHtml(label)}</label>
        <p class="kb-help" id="groups-${idSuffix}-help">${escapeHtml(help)}</p>
      </div>`;
}

/** Names offered for the group wording; any text is still accepted. */
const GROUP_LABEL_SUGGESTIONS = ["Team", "Squad", "Room", "Party"];

// Exported for the host's New event page (#1305); `presetsHref` is where the
// preset library is managed for the viewer.
export function renderGroupsSection(
  limits: {
    defaultCount: number;
    maxCount: number;
  },
  presets: readonly EventGroupPreset[] = EVENT_GROUP_PRESETS,
  presetsNotice: string | null = null,
  // Where the preset library is managed; an event host's own page for them (#1305).
  presetsHref = "/admin/events/presets",
  // The host's last setup (#1406), already validated against today's limits by
  // `loadGroupPrefill`; `resetHref` reloads the form with the normal defaults.
  remembered: { prefill: GroupFormPrefill; resetHref: string } | null = null,
): string {
  const prefill = remembered?.prefill ?? null;
  const presetCards = presets
    .map((p) =>
      renderPresetCard(
        p,
        limits,
        prefill !== null && prefill.presetId === p.id,
      ),
    )
    .join("");
  const presetPicked =
    prefill !== null &&
    prefill.presetId !== "" &&
    presets.some((p) => p.id === prefill.presetId);
  const rowCount = Math.max(limits.defaultCount, prefill?.rows.length ?? 0);
  const rows = Array.from({ length: rowCount }, (_, i) =>
    renderGroupRow(String(i), String(i + 1), prefill?.rows[i]),
  ).join("\n      ");
  const rememberedNote = remembered
    ? `<p class="kb-help" data-prefilled>Prefilled from your last event. <a href="${escapeHtml(remembered.resetHref)}">Start from the defaults instead</a></p>`
    : "";
  // The quick builder's own fields belong to no form (`form="none"`): they
  // are neither posted nor checked on submit, they only drive the script.
  const detached = ' form="none"';
  const sizeChoices = [
    ["", "No limit"],
    ["5", "5"],
    ["10", "10"],
    ["20", "20"],
  ]
    .map(
      ([value, label], i) =>
        `<label><input type="radio" name="groups_size_quick"${detached} value="${value}"${i === 0 ? " checked" : ""}><span>${label}</span></label>`,
    )
    .join("");
  return `<fieldset data-groups-section>
      <legend>Groups</legend>${rememberedNote ? `\n      ${rememberedNote}` : ""}
      <div class="kb-groupopt">
        <label class="kb-switch"><input type="checkbox" role="switch" name="${GROUP_FORM_FIELDS.enabled}" value="1"${prefill ? " checked" : ""} aria-describedby="groups-enabled-help"><span class="kb-switch__track" aria-hidden="true"></span><span class="kb-switch__state" aria-hidden="true"></span>Split into groups (teams, squads, rooms…)</label>
        <p class="kb-help" id="groups-enabled-help">Each group gets its own voice channel next to the event's channel, made at the channel creation time and removed when the event is over. Leave it off for a plain event.</p>
      </div>
      <div data-groups-body class="kb-stack">
      <div class="kb-field">
        <p class="kb-label" id="groups-setup-label">Group setup</p>
        <div class="kb-choices" role="radiogroup" aria-labelledby="groups-setup-label">${presetCards}
          <label class="kb-choice kb-choice--custom"><input type="radio" name="${GROUP_FORM_FIELDS.preset}" value=""${presetPicked ? "" : " checked"}>
          <span class="kb-choice__title">Custom</span>
          <span class="kb-choice__meta">Any number of groups and names</span>
          ${CHECK_ICON}</label>
        </div>
        ${presetsNotice ? `<div class="notice warn" role="status">${escapeHtml(presetsNotice)}</div>` : ""}
        <p class="kb-help">Choose a setup to fill in the groups, or Custom to write your own. Without scripts, a preset with all rows left empty uses the preset's groups. Presets are managed on the <a href="${escapeHtml(presetsHref)}">group presets page</a>.</p>
      </div>
      <p class="kb-help" data-preset-summary aria-live="polite" hidden></p>
      <button type="button" class="kb-btn kb-btn--sm" data-customise aria-expanded="true" hidden>Customise</button>
      <div class="kb-field" data-size-quick hidden>
        <p class="kb-label" id="groups-size-quick-label">Max per group</p>
        <div class="kb-segmented" role="radiogroup" aria-labelledby="groups-size-quick-label">${sizeChoices}</div>
      </div>
      <div class="kb-field" data-group-builder hidden>
        <p class="kb-label" id="groups-build-label">Build groups</p>
        <div class="kb-row" role="group" aria-labelledby="groups-build-label">
          <input type="number" class="kb-input kb-input--sm kb-input--num" data-build-count${detached} min="1" max="${limits.maxCount}" value="${Math.min(4, limits.maxCount)}" aria-label="Number of groups">
          <span class="kb-unit">groups of</span>
          <input type="number" class="kb-input kb-input--sm kb-input--num" data-build-size${detached} min="${GROUP_SIZE_MIN}" max="${GROUP_SIZE_MAX}" value="5" aria-label="Members in each group (empty = no limit)">
          <div class="kb-segmented" role="radiogroup" aria-label="Names for the groups"><label><input type="radio" name="groups_build_names"${detached} value="colours" checked><span>Colours</span></label><label><input type="radio" name="groups_build_names"${detached} value="numbers"><span>Numbered</span></label></div>
          <button type="button" class="kb-btn kb-btn--sm" data-build>Generate</button>
        </div>
        <p class="kb-help">Fills in the rows below. Colours name the groups Red, Blue, Green… with a matching marker; you can change anything afterwards.</p>
      </div>
      <div data-group-editor class="kb-stack">
      ${GROUP_ROWS_HEAD}
      <div data-group-rows data-max="${limits.maxCount}" class="kb-grouprows">
      ${rows}
      </div>
      <template data-group-row-template>${renderGroupRow("__N__", "__P__")}</template>
      <button type="button" class="kb-btn kb-btn--sm" data-add-group hidden>Add a group</button>
      <p class="kb-help">Up to ${limits.maxCount} groups (<code>events.groups.max_count</code>). Rows left completely empty are ignored. Max size empty means no limit. The tag is shown on nicknames when clan tags are on; it starts as the name in capitals.</p>
      <div class="notice err" role="alert" data-group-errors hidden></div>
      </div>
      ${groupSwitch(GROUP_FORM_FIELDS.captains, "Group leaders", "The host picks one member of each team as its leader and can move just the leaders.", "captains", prefill?.captainsEnabled === true)}
      <div class="kb-nested" data-nested-for="${GROUP_FORM_FIELDS.captains}">
        <div class="kb-field">
          <label class="kb-label" for="groups-leader-label">What a leader is called</label>
          <input type="text" id="groups-leader-label" class="kb-input kb-input--sm" name="${GROUP_FORM_FIELDS.leaderLabel}" maxlength="${GROUP_LABEL_MAX}" placeholder="${DEFAULT_LEADER_LABEL}"${prefill?.leaderLabel ? ` value="${escapeHtml(prefill.leaderLabel)}"` : ""} aria-describedby="groups-leader-label-help">
          <p class="kb-help" id="groups-leader-label-help">For example Leader or Captain. It names the captains lobby and is used in the leader messages.</p>
        </div>
        ${groupSwitch(GROUP_FORM_FIELDS.captainCustom, "Leaders can customise", "Each leader may rename their own team and set its tag from a button in the team's channel chat. The host can reset any team from the host panel.", "captain-custom", prefill?.captainCustomisationEnabled === true)}
        ${groupSwitch(GROUP_FORM_FIELDS.captainsLobby, "Captains lobby", "A separate voice channel only you and the current leaders can join. Nobody is assigned to it. You can switch it on or off from the host panel while the event runs.", "captains-lobby", prefill?.captainsLobby === true)}
      </div>
      ${groupSwitch(GROUP_FORM_FIELDS.tags, "Clan tags", "While the event runs, each team's tag goes on its members' server nicknames (for example [RED] Alice). The original nickname is always put back. Members cannot opt out. Only teams with a tag are tagged.", "tags", prefill?.tagsEnabled === true)}
      <div class="kb-nested" data-nested-for="${GROUP_FORM_FIELDS.tags}">
        ${groupSwitch(GROUP_FORM_FIELDS.tagsSuffix, "Tag after the name", "Alice [RED] instead of [RED] Alice.", "tags-suffix", prefill?.tagsSuffix === true)}
      </div>
      <details class="kb-disclosure" data-groups-advanced open>
        <summary>${icon("chevron-right", { className: "kb-chev" })}Advanced</summary>
        <div class="kb-disclosure__body kb-stack">
          <div class="kb-field">
            <label class="kb-label" for="groups-label">What a group is called</label>
            <input type="text" id="groups-label" class="kb-input kb-input--sm" name="${GROUP_FORM_FIELDS.label}" maxlength="${GROUP_LABEL_MAX}" placeholder="${DEFAULT_GROUP_LABEL}" list="groups-label-options"${prefill?.groupLabel ? ` value="${escapeHtml(prefill.groupLabel)}"` : ""} aria-describedby="groups-label-help">
            <datalist id="groups-label-options">${GROUP_LABEL_SUGGESTIONS.map((s) => `<option value="${s}"></option>`).join("")}</datalist>
            <p class="kb-help" id="groups-label-help">For example Team, Squad, Room or Party. Choosing a preset sets it.</p>
          </div>
          <div class="kb-field">
            <label class="kb-label" for="groups-lead-minutes">Create channels this many minutes before the start</label>
            <input type="number" id="groups-lead-minutes" class="kb-input kb-input--sm kb-input--num" name="${GROUP_FORM_FIELDS.leadMinutes}" min="${CHANNEL_LEAD_MIN}" max="${CHANNEL_LEAD_MAX}" placeholder="Default"${prefill?.channelLeadMinutes ? ` value="${escapeHtml(prefill.channelLeadMinutes)}"` : ""} aria-describedby="groups-lead-minutes-help">
            <p class="kb-help" id="groups-lead-minutes-help">Empty uses the server default. ${CHANNEL_LEAD_MIN} to ${CHANNEL_LEAD_MAX} minutes.</p>
          </div>
        </div>
      </details>
      </div>
    </fieldset>`;
}

// Progressive enhancement for the Groups section. Without scripts everything
// is shown and the form posts as it always has. With them: the switch folds the
// section, a preset card fills the rows and folds them behind a one-line
// summary (Customise opens them), the quick builder generates rows, a tag and a
// size follow the name and the first row until they are edited, and the submit
// is checked in the browser first so a mistake is shown next to the fields
// without losing the filled-in form. The server repeats every check and stays
// the source of truth. If the server still refuses, the entered values are kept
// in sessionStorage (this browser tab only) and put back when the page comes
// back with the error. Everything storage-related is wrapped in try/catch: it
// is a convenience only.
function eventGroupsScript(): string {
  const colours = JSON.stringify(
    MARKER_COLOURS.map((c) => [c.emoji, c.colour]),
  );
  return (
    "(function(){" +
    "var form=document.querySelector('form[data-event-form]');" +
    "var box=form&&form.querySelector('[data-group-rows]');" +
    "var tpl=form&&form.querySelector('template[data-group-row-template]');" +
    "if(!box||!tpl)return;" +
    "var add=form.querySelector('[data-add-group]');" +
    "var errBox=form.querySelector('[data-group-errors]');" +
    "var body=form.querySelector('[data-groups-body]');" +
    "var editor=form.querySelector('[data-group-editor]');" +
    "var summary=form.querySelector('[data-preset-summary]');" +
    "var customise=form.querySelector('[data-customise]');" +
    "var builder=form.querySelector('[data-group-builder]');" +
    "var sizeQuick=form.querySelector('[data-size-quick]');" +
    "var adv=form.querySelector('[data-groups-advanced]');" +
    "var enabled=form.elements['groups_enabled'];" +
    "var KEY='koolbot-event-form-draft';" +
    `var MAXNAME=${GROUP_NAME_MAX},MAXTAG=${GROUP_TAG_MAX},MINSIZE=${GROUP_SIZE_MIN},MAXSIZE=${GROUP_SIZE_MAX},HARDROWS=${GROUP_FORM_MAX_ROWS};` +
    `var COLOURS=${colours};` +
    "var max=parseInt(box.getAttribute('data-max'),10)||15;" +
    "function rows(){return box.querySelectorAll('[data-group-row]')}" +
    "function val(n){var e=form.elements[n];return e?String(e.value||'').trim():''}" +
    "function f(i,k){return form.elements['group_'+i+'_'+k]}" +
    "function kr(){return window.koolGroupRows}" +
    "function tagsOn(){var t=form.elements['groups_tags'];return !!(t&&t.checked)}" +
    "function chosen(){return form.querySelector('input[type=radio][name=groups_preset]:checked')}" +
    // The captains lobby is a channel and counts toward the cap while it will be
    // posted (ticked and not disabled), exactly as the server counts it.
    "function used(){var l=form.elements['groups_captains_lobby'];return rows().length+(l&&l.checked&&!l.disabled?1:0)}" +
    // `force` is for restoring a refused draft only: it bypasses the interactive cap
    // so every row the host had typed is shown again next to the server's error.
    "function addRow(force){var n=rows().length;if(!force&&used()>=max)return false;" +
    "var d=document.createElement('div');" +
    "d.innerHTML=tpl.innerHTML.replace(/__N__/g,String(n)).replace(/__P__/g,String(n+1));" +
    "var r=d.firstElementChild;box.appendChild(r);if(kr())kr().enhance(r);sync();validity();return true}" +
    "function sync(){if(add)add.hidden=used()>=max}" +
    "if(add){add.hidden=false;add.addEventListener('click',function(){addRow()})}" +
    "sync();" +
    // The pieces that need scripts are unhidden here; the Advanced section starts
    // folded; the rows are one line each.
    "if(builder)builder.hidden=false;if(sizeQuick)sizeQuick.hidden=false;if(adv&&!(val('groups_label')||val('groups_lead_minutes')))adv.open=false;" +
    // While groups are off the section's number fields leave native validation
    // (the server ignores them then); ticking the box restores min, max and step.
    "function validity(){var on=enabled.checked;" +
    "Array.prototype.forEach.call(form.querySelectorAll('[data-groups-section] input[type=number]'),function(el){" +
    "if(!el.hasAttribute('data-min')){el.setAttribute('data-min',el.getAttribute('min')||'');el.setAttribute('data-max',el.getAttribute('max')||'')}" +
    "['min','max'].forEach(function(a){var v=el.getAttribute('data-'+a);if(on&&v)el.setAttribute(a,v);else el.removeAttribute(a)});" +
    "if(on)el.removeAttribute('step');else el.setAttribute('step','any')})}" +
    // The switch folds the whole section; an option that depends on another is
    // hidden (and not posted) until its parent is on, never shown greyed out.
    "function show(){body.hidden=!enabled.checked}" +
    "function nest(){Array.prototype.forEach.call(form.querySelectorAll('[data-nested-for]'),function(n){" +
    "var p=form.elements[n.getAttribute('data-nested-for')];var on=!!(p&&p.checked);n.hidden=!on;" +
    "Array.prototype.forEach.call(n.querySelectorAll('input,select'),function(el){el.disabled=!on})})}" +
    "enabled.addEventListener('change',function(){show();validity()});" +
    "show();validity();" +
    // Cap and button follow the lobby box, which nest() disables with its parent.
    "function lobby(){nest();sync()}" +
    // One recompute for every change in the form: the lobby and leaders boxes, and a
    // preset choice, whose handler sets boxes by hand (that fires no change event of
    // its own, and the preset's own event bubbles here after its handler has run).
    "form.addEventListener('change',function(){lobby();summarise()});" +
    "lobby();" +
    "function setEditor(open){editor.hidden=!open;customise.setAttribute('aria-expanded',open?'true':'false');customise.textContent=open?'Hide group rows':'Customise'}" +
    "customise.addEventListener('click',function(){setEditor(editor.hidden)});" +
    // The browser checks min, max and maxlength before the submit listener runs and cannot
    // focus a hidden field, so a control that fails is shown first: its rows, its Advanced
    // section or any other folded container around it.
    "form.addEventListener('invalid',function(e){var el=e.target;if(!el||!el.closest||!body.contains(el))return;" +
    "for(var a=el.parentElement;a&&a!==form;a=a.parentElement){if(a===editor){if(editor.hidden)setEditor(true)}" +
    "else{if(a.hidden)a.hidden=false;if(a.tagName==='DETAILS')a.open=true}}},true);" +
    "function setRow(i,g){while(rows().length<=i){if(!addRow())return}" +
    "f(i,'name').value=g.name||'';f(i,'kind').value=g.kind||'team';" +
    "f(i,'size').value=g.size==null?'':g.size;f(i,'tag').value=g.tag||'';f(i,'marker').value=g.marker||'';" +
    "['size','tag','marker'].forEach(function(k){f(i,k).removeAttribute('data-auto');f(i,k).removeAttribute('data-manual')})}" +
    // The tag follows the name (Red -> RED) while clan tags are on, until it is edited.
    deriveTagScript("MAXTAG") +
    "function deriveTags(){if(!tagsOn())return;Array.prototype.forEach.call(rows(),function(r,i){" +
    "var t=f(i,'tag'),n=val('group_'+i+'_name');if(t.hasAttribute('data-manual')||(t.value&&!t.hasAttribute('data-auto')))return;" +
    "if(n){t.value=derive(n);t.setAttribute('data-auto','1')}else if(t.hasAttribute('data-auto')){t.value='';t.removeAttribute('data-auto')}})}" +
    "function firstFree(){var taken={};Array.prototype.forEach.call(rows(),function(r,i){var m=val('group_'+i+'_marker');if(m)taken[m]=1});" +
    "for(var k=0;k<COLOURS.length;k++)if(!taken[COLOURS[k][0]])return COLOURS[k][0];return ''}" +
    "function anyMarker(){var any=false;Array.prototype.forEach.call(rows(),function(r,i){if(val('group_'+i+'_marker'))any=true});return any}" +
    // A row that gets a name takes the first row's size, and the next colour when the
    // other rows have markers; a row whose name is cleared gives those back, so a row
    // is never left holding only automatic values (it would count as filled in).
    "function autoFill(i,n){var s=f(i,'size'),m=f(i,'marker'),t=f(i,'tag');" +
    "if(n){var s0=val('group_0_size');if(i>0&&s0&&!s.value&&!s.hasAttribute('data-manual')){s.value=s0;s.setAttribute('data-auto','1')}" +
    "if(i>0&&!m.value&&!m.hasAttribute('data-manual')&&anyMarker()){m.value=firstFree();m.setAttribute('data-auto','1');if(kr())kr().syncAll()}}" +
    "else{[s,m,t].forEach(function(el){if(el.hasAttribute('data-auto')){el.value='';el.removeAttribute('data-auto')}});if(kr())kr().syncAll()}}" +
    "function copySize(){var s0=val('group_0_size');Array.prototype.forEach.call(rows(),function(r,i){if(i===0||!val('group_'+i+'_name'))return;" +
    "var s=f(i,'size');if(s.hasAttribute('data-manual'))return;if(!s.value||s.hasAttribute('data-auto')){s.value=s0;if(s0)s.setAttribute('data-auto','1');else s.removeAttribute('data-auto')}})}" +
    // Typing in a group row switches groups on, so rows are never silently dropped.
    "box.addEventListener('input',function(e){enabled.checked=true;show();var t=e.target,m=/^group_(\\d+)_(\\w+)$/.exec(t.name||'');" +
    "if(m){var i=+m[1];if(m[2]==='size'||m[2]==='tag'||m[2]==='marker'){t.removeAttribute('data-auto');t.setAttribute('data-manual','1')}" +
    "if(m[2]==='size'&&i===0)copySize();" +
    "if(m[2]==='name'){autoFill(i,t.value.trim());deriveTags()}}validity()});" +
    "form.elements['groups_tags']&&form.elements['groups_tags'].addEventListener('change',deriveTags);" +
    // The one-line summary of what the rows will create.
    "function sizeText(list){var u={};list.forEach(function(x){u[x]=1});var k=Object.keys(u);" +
    "if(k.length===1)return k[0]?k[0]+' each':'no size limit';return 'sizes differ'}" +
    "function syncQuick(list){var u={};list.forEach(function(x){u[x]=1});var k=Object.keys(u);var v=k.length===1?k[0]:null;" +
    "Array.prototype.forEach.call(form.querySelectorAll('[data-size-quick] input'),function(r){r.checked=v!==null&&r.value===v})}" +
    "function summarise(){var names=[],sizes=[];Array.prototype.forEach.call(rows(),function(r,i){var n=val('group_'+i+'_name');if(!n)return;" +
    "var t=val('group_'+i+'_tag'),m=val('group_'+i+'_marker');names.push(n+(t&&tagsOn()?' ['+t+']':'')+(m?' '+m:''));sizes.push(val('group_'+i+'_size'))});" +
    "if(!names.length){summary.textContent='';syncQuick(['']);return}" +
    "var s=names.length+(names.length===1?' group':' groups')+' · '+names.join(', ')+' · '+sizeText(sizes);" +
    "if(tagsOn())s+=' · clan tags on';var c=form.elements['groups_captains'];if(c&&c.checked)s+=' · leaders on';" +
    "summary.textContent=s;syncQuick(sizes)}" +
    "Array.prototype.forEach.call(form.querySelectorAll('[data-size-quick] input'),function(r){r.addEventListener('change',function(){" +
    "Array.prototype.forEach.call(rows(),function(x,i){if(val('group_'+i+'_name')){var s=f(i,'size');s.value=r.value;s.removeAttribute('data-manual');if(r.value)s.setAttribute('data-auto','1');else s.removeAttribute('data-auto')}});summarise()})});" +
    // A preset card fills the rows, then folds them behind the summary.
    "function compact(on){summary.hidden=!on;customise.hidden=!on;setEditor(!on)}" +
    "function custom(){var c=form.querySelector('input[type=radio][name=groups_preset][value=\"\"]');if(c)c.checked=true;compact(false)}" +
    "function onPreset(){var o=chosen();if(!o||!o.value){compact(false);return}" +
    "var raw=o.getAttribute('data-groups');if(!raw)return;" +
    "var g;try{g=JSON.parse(raw)}catch(x){return}if(!Array.isArray(g))return;" +
    // A preset's leads row (an old preset) is the captains lobby: it ticks the
    // switch instead of becoming a row of the list. It still counts toward the cap.
    "var hadLobby=false;g=g.filter(function(r){if(r&&r.kind==='leads'){hadLobby=true;return false}return true});" +
    "if(g.length+(hadLobby?1:0)>max){custom();return}" +
    "var lb=form.elements['groups_captains_lobby'];if(lb)lb.checked=hadLobby;" +
    "var lbl=o.getAttribute('data-label');if(lbl)form.elements['groups_label'].value=lbl;" +
    "var ll=o.getAttribute('data-leader-label');if(ll)form.elements['groups_leader_label'].value=ll;" +
    "var ld=o.getAttribute('data-lead');if(ld!==null)form.elements['groups_lead_minutes'].value=ld;" +
    // The preset's clan tags default (#1194); the host can still change the box.
    "var tg=o.getAttribute('data-tags');if(tg!==null&&form.elements['groups_tags'])form.elements['groups_tags'].checked=tg==='1';" +
    "var n=Math.max(rows().length,g.length);" +
    // Every existing row past the preset's own is emptied, however many an over-cap
    // restore left; setRow only allocates a new row while the cap has room.
    "for(var i=0;i<n;i++)setRow(i,i<g.length?g[i]:{});" +
    "enabled.checked=true;show();deriveTags();if(kr())kr().syncAll();lobby();validity();summarise();compact(true)}" +
    "Array.prototype.forEach.call(form.querySelectorAll('input[type=radio][name=groups_preset]'),function(r){r.addEventListener('change',onPreset)});" +
    // The quick builder: N groups of S, named by colour or number, one marker each.
    "var build=form.querySelector('[data-build]');" +
    "if(build)build.addEventListener('click',function(){var cnt=form.querySelector('[data-build-count]'),sz=form.querySelector('[data-build-size]');" +
    "var l=form.elements['groups_captains_lobby'];var room=max-(l&&l.checked&&!l.disabled?1:0);" +
    "var n=Math.max(1,Math.min(parseInt(cnt.value,10)||1,room));cnt.value=n;" +
    "var s=parseInt(sz.value,10);var size=s>=MINSIZE&&s<=MAXSIZE?String(s):'';" +
    "var byColour=form.querySelector('input[name=groups_build_names]:checked').value==='colours'&&n<=COLOURS.length;" +
    "var word=val('groups_label')||'Team';" +
    "var total=Math.max(rows().length,n);" +
    "for(var i=0;i<total;i++){if(i<n){var c=COLOURS[i%COLOURS.length];" +
    "setRow(i,{name:byColour?c[1]:word+' '+(i+1),kind:'team',size:size,tag:'',marker:c[0]});" +
    "if(size)f(i,'size').setAttribute('data-auto','1');f(i,'marker').setAttribute('data-auto','1')}else setRow(i,{})}" +
    "enabled.checked=true;show();deriveTags();if(kr())kr().syncAll();custom();compact(true);summarise();validity()});" +
    "function check(){var errs=[],seen=Object.create(null),leads=0,filled=0;" +
    "Array.prototype.forEach.call(rows(),function(r,i){var p=i+1;" +
    "var name=val('group_'+i+'_name').replace(/\\s+/g,' '),size=val('group_'+i+'_size'),tag=val('group_'+i+'_tag'),mk=val('group_'+i+'_marker');" +
    "if(!name&&!size&&!tag&&!mk)return;filled++;" +
    "if(!name)errs.push('Group '+p+' name: a name is required.');" +
    "else if(name.length>MAXNAME)errs.push('Group '+p+' name: at most '+MAXNAME+' characters.');" +
    "else{var f2=name.toLowerCase();if(seen[f2])errs.push('Group '+p+' name: \"'+name+'\" is already used by group '+seen[f2]+'.');else seen[f2]=p}" +
    "if(size&&!(/^\\d{1,3}$/.test(size)&&+size>=MINSIZE&&+size<=MAXSIZE))errs.push('Group '+p+' size: a whole number from '+MINSIZE+' to '+MAXSIZE+', or empty.');" +
    "if(tag.length>MAXTAG)errs.push('Group '+p+' tag: at most '+MAXTAG+' characters.');" +
    "if(val('group_'+i+'_kind')==='leads'&&++leads>1)errs.push('Group '+p+' kind: only one leads group is allowed.')});" +
    "if(!filled&&!val('groups_preset'))errs.push('Add at least one group, or switch groups off.');" +
    "return errs}" +
    "form.addEventListener('submit',function(e){" +
    "if(enabled.checked){var errs=check();" +
    "if(errs.length){e.preventDefault();errBox.textContent='';" +
    "errs.forEach(function(m){var p=document.createElement('p');p.textContent=m;errBox.appendChild(p)});" +
    // The rows are shown so the mistake is next to the field it names.
    "setEditor(true);" +
    "errBox.hidden=false;errBox.setAttribute('tabindex','-1');errBox.focus();return}}" +
    "errBox.hidden=true;" +
    "try{var d={};Array.prototype.forEach.call(form.elements,function(el){" +
    "if(!el.name||el.name==='_csrf'||el.type==='button'||el.type==='submit')return;" +
    // Only the chosen radio is saved, or the last card would win.
    "if(el.type==='radio'){if(el.checked)d[el.name]=el.value;return}" +
    "d[el.name]=el.type==='checkbox'?el.checked:el.value});" +
    "['auto','manual'].forEach(function(a){d['__'+a]=[];Array.prototype.forEach.call(form.querySelectorAll('[data-'+a+']'),function(el){if(el.name)d['__'+a].push(el.name)})});" +
    "window.sessionStorage.setItem(KEY,JSON.stringify(d))}catch(x){}});" +
    "try{var raw=window.sessionStorage.getItem(KEY);window.sessionStorage.removeItem(KEY);" +
    "if(raw&&document.querySelector('.notice.err[data-flash]')){var d=JSON.parse(raw);" +
    // The page may start with remembered rows (#1406): the draft is what was
    // submitted, so rows it does not hold are emptied before it is put back.
    "Array.prototype.forEach.call(rows(),function(r,i){['name','size','tag','marker'].forEach(function(k){f(i,k).value=''});f(i,'kind').value='team'});" +
    // A draft from before the switch can hold a row of kind leads (the select no
    // longer offers it): that row is the captains lobby now, so it ticks the box
    // and is not restored as a team. The other rows are left as they are.
    "Object.keys(d).forEach(function(k){var m=/^group_(\\d+)_kind$/.exec(k);" +
    "if(m&&d[k]==='leads'){['name','kind','size','tag','marker'].forEach(function(x){delete d['group_'+m[1]+'_'+x]});d['groups_captains_lobby']=true}});" +
    // Switches first, rows second. The captains lobby counts toward the cap, and
    // only while it is ticked and not disabled with its parent (the leaders
    // switch), so every switch of the draft is put back and the dependent state
    // reapplied before any row is allocated. Otherwise a remembered switch (#1406)
    // would use up room the host had when they submitted.
    "Object.keys(d).forEach(function(k){var el=form.elements[k];if(el&&el.type==='checkbox')el.checked=d[k]===true});lobby();" +
    "Object.keys(d).forEach(function(k){var m=/^group_(\\d+)_/.exec(k);if(m){var i=+m[1];while(rows().length<=i&&rows().length<HARDROWS)addRow(true)}});" +
    "Object.keys(d).forEach(function(k){" +
    // A saved preset that is no longer offered (e.g. now over the cap, so its card is disabled) is not put back.
    "if(k==='groups_preset'){Array.prototype.forEach.call(form.querySelectorAll('input[type=radio][name=groups_preset]'),function(r){if(r.value===d[k]&&!r.disabled)r.checked=true});return}" +
    "var el=form.elements[k];if(!el||el.type==='file'||el.type==='radio')return;" +
    "if(el.type==='checkbox')el.checked=d[k]===true;else if(typeof d[k]==='string')el.value=d[k]});" +
    // The person gets the rows back, open, so they can fix what the server refused.
    "['auto','manual'].forEach(function(a){(Array.isArray(d['__'+a])?d['__'+a]:[]).forEach(function(n){var el=form.elements[n];if(el&&el.setAttribute)el.setAttribute('data-'+a,'1')})});" +
    "var back=chosen();if(back&&back.value){summary.hidden=false;customise.hidden=false}" +
    "if(adv&&(val('groups_label')||val('groups_lead_minutes')))adv.open=true;" +
    // Setting `checked` fires no change event, so reapply the dependent state by hand.
    "if(kr())kr().syncAll();show();validity();lobby();summarise();setEditor(true)}}catch(x){}" +
    "})();"
  );
}

export const EVENT_GROUPS_SCRIPT = eventGroupsScript();

/** Which optional columns an events table shows (#1301). */
interface EventCols {
  expected: boolean;
  channel: boolean;
  cover: boolean;
}

export function renderEventsPage(props: EventsProps): string {
  const groupLimits = resolveGroupCountLimits(
    props.groupLimits?.defaultCount ?? 2,
    props.groupLimits?.maxCount ?? 15,
  );
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;

  const renderEventRow = (e: EventRow, cols: EventCols): string => {
    const finished = e.state === "cancelled" || e.state === "ended";
    const seriesForm = `<form method="POST" action="/admin/events/${escapeHtml(e.id)}/cancel" data-confirm="Cancel the whole '${escapeHtml(e.title)}' series?"${EVENT_CANCEL_SERIES_LIST}>${csrfInput}<input type="hidden" name="scope" value="series"><button type="submit" class="btn btn-danger">Cancel series</button></form>`;
    // A finished occurrence still awaiting its successor (e.g. recurrence
    // was switched off meanwhile) keeps the series live: allow stopping it.
    // The host panel lives on the member surface (#1189); an admin may open
    // it for any event, including a finished one (read-only summary).
    const hostLink = `<a class="btn" href="${escapeHtml(hostPanelPath(e.id))}">Host panel</a>`;
    // End now (#1193): only a running event, behind a confirmation the server
    // checks again. Shared with the host panel's End section.
    const endNow =
      e.state === "active"
        ? `<details class="end-now"><summary class="btn btn-danger">End now</summary>${renderEndEventForm(
            {
              actionPath: `/admin/events/${encodeURIComponent(e.id)}/end-now`,
              csrfToken: props.csrfToken,
              idSuffix: e.id,
              hasGroupChannels: e.hasGroupChannels === true,
              adopted: e.nativeAdopted === true,
            },
          )}</details>`
        : "";
    // Edit (#1298): an open event of our own, one-off or a series occurrence
    // (the form asks how far the change reaches). An adopted event is edited in
    // Discord, so no link is offered for it.
    const editLink =
      !finished && e.nativeAdopted !== true
        ? `<a class="btn" href="${escapeHtml(hostPanelPath(e.id))}/edit">Edit</a>\n  `
        : "";
    const actions = finished
      ? e.awaitingSuccessor
        ? `${hostLink}\n  ${seriesForm}`
        : hostLink
      : `${hostLink}
  ${editLink}<form method="POST" action="/admin/events/${escapeHtml(e.id)}/start-now">${csrfInput}<button type="submit" class="btn">Start now</button></form>${
    endNow ? `\n  ${endNow}` : ""
  }
  <form method="POST" action="/admin/events/${escapeHtml(e.id)}/cancel" data-confirm="Cancel ${e.recurrence ? "this occurrence of " : ""}event '${escapeHtml(e.title)}'?"${eventCancelList(e.nativeAdopted === true, Boolean(e.recurrence))}>${csrfInput}<button type="submit" class="btn btn-danger">${e.recurrence ? "Cancel occurrence" : "Cancel"}</button></form>${
    e.recurrence ? `\n  ${seriesForm}` : ""
  }`;
    const channelCell = e.channelId
      ? `<span class="mono">${escapeHtml(e.channelId)}</span>`
      : '<span class="muted">—</span>';
    return `<tr>
<td>${escapeHtml(e.title)}${
      e.recurrence
        ? ` <span class="tag" title="Part of a recurring series"><span aria-hidden="true">🔁</span> ${escapeHtml(e.recurrence)}${e.occurrence ? ` · #${e.occurrence}` : ""}</span>`
        : ""
    }${
      e.groupCount
        ? ` <span class="tag" title="Groups set up for this event">${e.groupCount} ${e.groupCount === 1 ? "group" : "groups"}</span> <a href="/admin/events/presets?fromEvent=${encodeURIComponent(e.id)}">Save as server preset</a>`
        : ""
    }</td>
<td class="mono">${escapeHtml(e.when)}</td>
<td>${eventStateTag(e.state)}</td>
${cols.expected ? `<td>${renderExpected(e)}</td>\n` : ""}${cols.channel ? `<td>${channelCell}</td>\n` : ""}${cols.cover ? `<td>${renderCoverCell(e, csrfInput, props.csrfToken)}</td>\n` : ""}<td class="actions">${actions}</td>
</tr>`;
  };

  // A column that is empty for every row of a table is left out (#1301), judged
  // from the data and not from the rendered dash. The raw event id is not a
  // column: the row's own links carry it.
  const colsFor = (rows: EventRow[]): EventCols => ({
    expected: rows.some((e) => e.expected || e.legacyRsvps),
    channel: rows.some((e) => e.channelId),
    cover: rows.some((e) => e.cover),
  });
  const renderEventsTable = (rows: EventRow[]): string => {
    const cols = colsFor(rows);
    return `<table class="data">
<thead><tr><th scope="col">Title</th><th scope="col">When</th><th scope="col">State</th>${cols.expected ? '<th scope="col">Expected to show up</th>' : ""}${cols.channel ? '<th scope="col">Channel</th>' : ""}${cols.cover ? '<th scope="col">Cover image</th>' : ""}<th scope="col">Actions</th></tr></thead>
<tbody>${rows.map((e) => renderEventRow(e, cols)).join("")}</tbody>
</table>`;
  };
  // Ended and cancelled events fold away. A finished occurrence still waiting
  // for its successor stays in the list: its row carries the only way to
  // cancel the series that is still live.
  const isPast = (e: EventRow): boolean =>
    (e.state === "cancelled" || e.state === "ended") && !e.awaitingSuccessor;
  const currentRows = props.rows.filter((e) => !isPast(e));
  const pastRows = props.rows.filter(isPast);
  const currentHtml =
    currentRows.length > 0
      ? renderEventsTable(currentRows)
      : `<p class="muted">${props.rows.length > 0 ? "No upcoming events." : "No events scheduled yet."}</p>`;
  const pastHtml =
    pastRows.length > 0
      ? `<details class="kb-disclosure" id="past-events">
    <summary>${CHEVRON_ICON}Past events <span class="kb-badge kb-badge--count">${pastRows.length}</span></summary>
    <div class="kb-disclosure__body">${renderEventsTable(pastRows)}</div>
  </details>`
      : "";

  // The chips link to the setting that fixes them, but only while the settings
  // card renders controls: with the stored config unreadable it is a notice
  // (#975).
  const settingLink = (key: string): string | undefined =>
    props.settingsUnavailable ? undefined : settingHref(key);
  const needsSetup = !props.categoryConfigured || !props.announcementConfigured;
  const statusLine = renderStatusLine({
    enabled: props.enabled,
    chips: [
      props.categoryConfigured
        ? { text: "Channel category set" }
        : {
            text: "No channel category: event channels won't be created",
            warn: true,
            href: settingLink("events.category_id"),
          },
      props.announcementConfigured
        ? { text: "Announcement channel set" }
        : {
            text: "No announcement channel: announcements and reminders won't be posted",
            warn: true,
            href: settingLink("events.announcement_channel_id"),
          },
      { text: props.timezone, mono: true },
      { text: `${countOf(props.rows.length, "event")} scheduled` },
    ],
  });
  const permissionNote = renderPermissionNotice(
    props.permissionNotice ?? null,
    {
      canLinkToPage: true,
    },
  );

  const body = `
<h1>Events</h1>
<p class="subtitle">Schedule events that spin up a temporary voice channel shortly before they start, are announced with a Discord event link members can mark Interested on, remind attendees, and clean themselves up afterward.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({
  enabled: props.enabled,
  label: "Events",
  featureKey: "events.enabled",
  returnTo: "/admin/events",
  csrfToken: props.csrfToken,
})}
${statusLine}
${permissionNote}
<div class="kb-pagehead__actions"><a class="kb-btn" href="#schedule-event">Schedule event</a></div>

<div class="card">
  <h2>Events</h2>${currentHtml}
  ${pastHtml}
</div>
<div class="card" id="schedule-event">
  <h2>Schedule a new event</h2>
  <form method="POST" action="/admin/events/create" class="stack" data-event-form>
    ${csrfInput}
    <label>Title
      <input type="text" name="title" required maxlength="100" placeholder="Game Night">
    </label>
    <label>Description
      <textarea name="description" rows="3" maxlength="1000" placeholder="What's happening?"></textarea>
    </label>
    <label>When
      <select name="when" data-when>
        ${EVENT_WHEN_CHOICES.map((w) => `<option value="${w}"${w === "pick" ? " selected" : ""}>${EVENT_WHEN_LABELS[w]}</option>`).join("")}
      </select>
    </label>
    <label data-when-pick>Date
      <input type="date" name="date" pattern="\\d{4}-\\d{2}-\\d{2}" placeholder="YYYY-MM-DD">
    </label>
    <label data-when-pick>Time
      <input type="time" name="time" pattern="\\d{2}:\\d{2}" placeholder="HH:MM">
    </label>
    <label>Duration (minutes, optional)
      <input type="number" name="duration" min="1" max="1440" placeholder="120">
    </label>
    <div>
      <label for="admin-event-timezone">Timezone (optional)</label>
      ${renderTimezoneSelect("timezone", "", { id: "admin-event-timezone", defaultZone: props.timezone, blank: true })}
    </div>
    <label>Repeat
      <select name="recurrence">
        <option value="none" selected>Does not repeat</option>
        <option value="weekly">Weekly</option>
        <option value="biweekly">Every 2 weeks</option>
        <option value="monthly">Monthly</option>
      </select>
    </label>
    ${renderGroupsSection(groupLimits, props.groupPresets, props.groupPresetsNotice ?? null, undefined, props.groupRemembered ?? null)}
    <button type="submit" class="btn btn-primary">Schedule event</button>
  </form>
  <p class="muted">A cover image is added to a scheduled event from its row in the list above; it is shown on the Discord event.</p>
</div>
${renderFeatureSettingsCard({
  intro:
    "Change event settings here without leaving the page. Saved through the shared settings route.",
  category: "events",
  settingRows: props.settingRows,
  pickers: props.settingsPickers,
  returnTo: "/admin/events",
  csrfToken: props.csrfToken,
  dependencyState: props.dependencyState,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  needsSetup,
  flash: props.flash,
})}
${scriptTag(EVENT_COVER_UPLOAD_SCRIPT)}
${scriptTag(groupRowsScript())}
${scriptTag(EVENT_GROUPS_SCRIPT)}
${EVENT_WHEN_SCRIPT}
`;

  return renderAdminPage({
    title: "Events",
    active: "/admin/events",
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
  /** Discord type of the channel; null when it no longer resolves. */
  channelType: ChannelType | null;
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
  /**
   * Every `polls.*` key, edited in place on this page (#973) through
   * {@link renderFeatureSettingsCard}. Includes `polls.enabled`, so the
   * feature can be switched off here as well as on.
   */
  settingRows: SettingRow[];
  /** On/off state of off-card dependencies of {@link settingRows}. */
  dependencyState?: ReadonlyMap<string, boolean>;
  /** True when the settings could not be read; the card renders a warning. */
  settingsUnavailable?: boolean;
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
<td>${channelMention({ name: s.channelName, type: s.channelType })}</td>
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
  <form method="POST" action="/admin/polls/schedules/${escapeHtml(s.id)}/delete" data-confirm="Delete schedule ${escapeHtml(s.id)}?">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form>
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
  <form method="POST" action="/admin/polls/items/${escapeHtml(it.id)}/delete" data-confirm="Delete poll question?">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form>
</td>
</tr>`,
    )
    .join("");

  const body = `
<h1>Polls</h1>
<p class="subtitle">Poll schedules and the question library.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Polls", featureKey: "polls.enabled", returnTo: "/admin/polls", csrfToken: props.csrfToken })}
${renderStatusLine({
  enabled: props.enabled,
  chips: [
    { text: `Default duration ${props.defaultDurationHours}h` },
    { text: `Cooldown ${countOf(props.cooldownDays, "day")}` },
    { text: countOf(props.schedules.length, "schedule") },
    { text: `${countOf(props.items.length, "question")} in the library` },
  ],
})}

<div class="card">
  <h2>Schedules</h2>
  ${
    props.schedules.length === 0
      ? `<div class="empty">No poll schedules configured.</div>`
      : `<table><thead><tr><th scope="col">ID</th><th scope="col">Channel</th><th scope="col">Cron</th><th scope="col">Duration</th><th scope="col">Ping role</th><th scope="col">Status</th><th scope="col">Last run</th><th scope="col">Actions</th></tr></thead><tbody>${scheduleRows}</tbody></table>`
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
      : `<table><thead><tr><th scope="col">Question</th><th scope="col">Tags</th><th scope="col">Used</th><th scope="col">Last used</th><th scope="col">Status</th><th scope="col">Source</th><th scope="col">Actions</th></tr></thead><tbody>${itemRows}</tbody></table>`
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
${renderFeatureSettingsCard({
  intro:
    "Change poll settings here without leaving the page. Saved through the shared settings route.",
  category: "polls",
  settingRows: props.settingRows,
  returnTo: "/admin/polls",
  csrfToken: props.csrfToken,
  dependencyState: props.dependencyState,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
})}
${scriptTag(POLL_IMPORT_UPLOAD_SCRIPT)}
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
  /** Stable mapping identity (`_id`); role names are no longer unique (#813). */
  mappingId: string;
  emoji: string;
  roleName: string;
  roleId: string;
  categoryName: string;
  /** Discord types of the category, channel and picker channel; null when one no longer resolves. */
  categoryType: ChannelType | null;
  channelName: string;
  channelType: ChannelType | null;
  messageId: string;
  /**
   * Name of the channel the picker message was posted in, remembered with the
   * mapping (#1207). Null for older rows that lack it: those pickers are looked
   * up in the configured `reactionroles.message_channel_id`.
   */
  pickerChannelName?: string | null;
  pickerChannelType?: ChannelType | null;
  /**
   * Whether the bot auto-created the role + category + channel for this
   * mapping. Bound mappings (issue #813) point at a pre-existing role and set
   * this false. Optional/undefined is treated as `true` for legacy rows.
   */
  autoCreated?: boolean;
  mode: string;
  groupId: string | null;
  isArchived: boolean;
  archivedAt: string | null;
}

export interface ReactionRolesProps extends CommonProps {
  enabled: boolean;
  configChannel: { name: string; id: string; type: ChannelType | null } | null;
  active: ReactionRoleRow[];
  archived: ReactionRoleRow[];
  /**
   * The editable `reactionroles.*` settings rendered in place (#974),
   * including the `reactionroles.enabled` master so the feature can be turned
   * off from this page. Omitted or empty hides the settings card.
   */
  settingRows?: SettingRow[];
  /**
   * The stored config could not be read, so the card is replaced by a notice
   * rather than rendering schema defaults that a save would write back.
   */
  settingsUnavailable?: boolean;
  /** Text-channel options backing the `reactionroles.message_channel_id` picker. */
  textChannels?: ChannelOption[];
  flash?: FlashMessage | null;
}

function reactionRoleRow(rr: ReactionRoleRow, csrfInput: string): string {
  const escapedName = escapeHtml(rr.roleName);
  const jsName = escapeHtml(rr.roleName);
  // Legacy rows lack the flag; treat undefined as managed (auto-created).
  const managed = rr.autoCreated ?? true;
  const escapedEmoji = escapeHtml(rr.emoji);
  const escapedMessageId = escapeHtml(rr.messageId);
  const escapedMappingId = escapeHtml(rr.mappingId);

  let actions: string;
  if (rr.groupId) {
    // Grouped mappings share a message/category/channel, so they can only be
    // torn down as a unit — offer a single group-delete instead of the
    // per-mapping archive/delete controls.
    actions = `<form method="POST" action="/admin/reaction-roles/group/delete" data-confirm="Permanently delete the whole role group ${jsName} belongs to? This removes the roles the bot created for it (reused roles, and roles still used by another mapping, are kept) and its shared category/channel."${REACTION_ROLE_GROUP_DELETE_LIST}>${csrfInput}<input type="hidden" name="groupId" value="${escapeHtml(rr.groupId)}"><button type="submit" class="btn btn-danger">Delete group</button></form>`;
  } else if (!managed) {
    // Bound mappings point at a pre-existing role and may share a picker
    // message, so they are removed per-mapping (message + emoji) and never
    // archived — that would delete a message other mappings still use.
    actions = `<form method="POST" action="/admin/reaction-roles/remove-mapping" data-confirm="Remove the ${escapeHtml(rr.emoji)} → ${jsName} mapping? The existing role is left untouched.">${csrfInput}<input type="hidden" name="messageId" value="${escapedMessageId}"><input type="hidden" name="emoji" value="${escapedEmoji}"><button type="submit" class="btn btn-danger">Remove</button></form>`;
  } else if (rr.isArchived) {
    // Managed rows are keyed by their stable mapping id, not roleName, so
    // identically named pickers can't collide (#813).
    actions = `<form method="POST" action="/admin/reaction-roles/unarchive">${csrfInput}<input type="hidden" name="mappingId" value="${escapedMappingId}"><button type="submit" class="btn">Unarchive</button></form>
  <form method="POST" action="/admin/reaction-roles/delete" data-confirm="Permanently delete reaction role ${jsName}? This removes the Discord role, category, and channel."${REACTION_ROLE_DELETE_LIST}>${csrfInput}<input type="hidden" name="mappingId" value="${escapedMappingId}"><button type="submit" class="btn btn-danger">Delete</button></form>`;
  } else {
    actions = `<form method="POST" action="/admin/reaction-roles/archive" data-confirm="Archive reaction role ${jsName}? The reaction message will be removed but the role/channels are preserved."${CONFIRM_NEUTRAL_ATTR}>${csrfInput}<input type="hidden" name="mappingId" value="${escapedMappingId}"><button type="submit" class="btn">Archive</button></form>
  <form method="POST" action="/admin/reaction-roles/delete" data-confirm="Permanently delete reaction role ${jsName}? This removes the Discord role, category, and channel."${REACTION_ROLE_DELETE_LIST}>${csrfInput}<input type="hidden" name="mappingId" value="${escapedMappingId}"><button type="submit" class="btn btn-danger">Delete</button></form>`;
  }

  const typeTag = managed
    ? `<span class="tag tag-on">managed</span>`
    : `<span class="tag">bound</span>`;
  const channelCell =
    rr.channelName === "—"
      ? "—"
      : channelMention({ name: rr.channelName, type: rr.channelType });
  const categoryCell =
    rr.categoryName === "—"
      ? "—"
      : channelMention({ name: rr.categoryName, type: rr.categoryType });

  const modeCell = rr.groupId
    ? `${escapeHtml(rr.mode)} <span class="tag">group</span>`
    : escapeHtml(rr.mode);

  return `<tr>
<td class="mono">${escapedEmoji}</td>
<td>${escapedName} <span class="muted mono">${escapeHtml(rr.roleId)}</span></td>
<td>${typeTag}</td>
<td>${categoryCell}</td>
<td>${channelCell}</td>
<td class="mono">${escapedMessageId}${rr.pickerChannelName ? `<div class="muted">in ${channelMention({ name: rr.pickerChannelName, type: rr.pickerChannelType })}</div>` : ""}</td>
<td>${modeCell}</td>
<td><span class="tag ${rr.isArchived ? "tag-off" : "tag-on"}">${rr.isArchived ? "archived" : "active"}</span></td>
<td class="muted">${escapeHtml(rr.archivedAt ?? "")}</td>
<td class="actions">${actions}</td>
</tr>`;
}

/**
 * Option rows for the grouped-role forms: the first six are always visible,
 * the rest (up to MAX_GROUP_ENTRIES) sit in a native <details> so the full
 * advertised limit is reachable without JavaScript.
 */
function groupOptionRows(
  formLabel: string,
  placeholders: (i: number) => [string, string],
): string {
  const row = (i: number): string => {
    const [role, emoji] = placeholders(i);
    return `<div class="inline-form">
      <input type="text" name="roleName" maxlength="100" aria-label="${escapeHtml(`${formLabel}: option ${i + 1} role name`)}" placeholder="${escapeHtml(role)}">
      <input type="text" name="emoji" maxlength="100" aria-label="${escapeHtml(`${formLabel}: option ${i + 1} emoji`)}" placeholder="${escapeHtml(emoji)}">
    </div>`;
  };
  const visible = 6;
  const rows = (from: number, to: number): string =>
    Array.from({ length: to - from }, (_unused, i) => row(from + i)).join("");
  return `${rows(0, visible)}
    <details><summary>More options (up to ${MAX_GROUP_ENTRIES})</summary>${rows(visible, MAX_GROUP_ENTRIES)}</details>`;
}

export function renderReactionRolesPage(props: ReactionRolesProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const activeRows = props.active
    .map((rr) => reactionRoleRow(rr, csrfInput))
    .join("");
  const archivedRows = props.archived
    .map((rr) => reactionRoleRow(rr, csrfInput))
    .join("");
  // Active mappings without a remembered picker channel still follow the
  // setting (#1207); only they need the delete-before-changing warning.
  const olderPickers = props.active.filter(
    (rr) => !rr.pickerChannelName,
  ).length;
  const body = `
<h1>Reaction Roles</h1>
<p class="subtitle">Per-message reaction-role mappings.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Reaction Roles", featureKey: "reactionroles.enabled", returnTo: "/admin/reaction-roles", csrfToken: props.csrfToken })}
${renderStatusLine({
  enabled: props.enabled,
  chips: [
    props.configChannel
      ? {
          text: `Message channel ${channelText({ name: props.configChannel.name, type: props.configChannel.type })}`,
        }
      : {
          text: "No message channel set",
          warn: true,
          href: props.settingsUnavailable
            ? undefined
            : settingHref("reactionroles.message_channel_id"),
        },
    { text: `${props.active.length} active` },
    { text: `${props.archived.length} archived` },
  ],
})}
${olderPickers > 0 ? `<div class="notice warn" role="note"><strong>${olderPickers} active ${olderPickers === 1 ? "mapping was" : "mappings were"} created before pickers remembered their channel.</strong> ${olderPickers === 1 ? "Its picker is" : "Their pickers are"} still looked up in the channel set by <code>reactionroles.message_channel_id</code>, and changing that setting does not move ${olderPickers === 1 ? "it" : "them"}. Delete ${olderPickers === 1 ? "that picker and mapping" : "those pickers and mappings"} <em>before</em> changing the channel, or change it back before cleaning up. Startup keeps such mappings while none of them is found in the configured channel, and archives the ones that are missing once another is. Pickers created from now on remember their channel (shown under the message ID) and are not affected by later changes to the setting.</div>` : ""}
<div class="card">
  <h2>Active</h2>
  ${
    props.active.length === 0
      ? `<div class="empty">No active reaction-role mappings.</div>`
      : `<table><thead><tr><th scope="col">Emoji</th><th scope="col">Role grant</th><th scope="col">Type</th><th scope="col">Category</th><th scope="col">Channel</th><th scope="col">Message ID</th><th scope="col">Mode</th><th scope="col">Status</th><th scope="col">Archived</th><th scope="col">Actions</th></tr></thead><tbody>${activeRows}</tbody></table>`
  }
</div>
<div class="card">
  <h2>Create a reaction role</h2>
  <p class="muted">Creates a new Discord role, posts a reaction-role message to the configured channel, and adds the reaction. Tick <em>Create a private channel</em> to also mint a private category + text channel locked to the new role. Untick it for a plain self-assign role.</p>
  <form method="POST" action="/admin/reaction-roles/create" class="stack">
    ${csrfInput}
    <label>Role name
      <input type="text" name="name" required maxlength="100" placeholder="Gamer">
    </label>
    <label>Emoji (Unicode or <code>&lt;:name:id&gt;</code>)
      <input type="text" name="emoji" required maxlength="100" placeholder="🎮">
    </label>
    <label class="inline"><input type="checkbox" name="createChannel" value="1" checked> Create a private category + channel for this role</label>
    <label>Assignment mode
      <select name="mode">
        <option value="toggle" selected>Toggle — react to add, unreact to remove (default)</option>
        <option value="sticky">Sticky — react to add; removing the reaction keeps the role</option>
      </select>
    </label>
    <p class="muted">For one-of-set (pick exactly one) behaviour, use <strong>Create a role group</strong> below — a single message can't enforce "unique" against itself.</p>
    <button type="submit" class="btn btn-primary">Create reaction role</button>
  </form>
</div>
<div class="card">
  <h2>Bind an existing role</h2>
  <p class="muted">Maps an emoji to a role you already manage — no new role, category, or channel is created. Leave <em>Message ID</em> blank to post a fresh message to the configured channel, or paste an existing reaction-role message ID to add this mapping to it (one message can carry many emoji→role mappings).</p>
  <form method="POST" action="/admin/reaction-roles/bind" class="stack">
    ${csrfInput}
    <label>Role ID
      <input type="text" name="roleId" required maxlength="30" placeholder="123456789012345678">
    </label>
    <label>Emoji (Unicode or <code>&lt;:name:id&gt;</code>)
      <input type="text" name="emoji" required maxlength="100" placeholder="🎨">
    </label>
    <label>Message ID <span class="muted">(optional — add to an existing picker message)</span>
      <input type="text" name="messageId" maxlength="30" placeholder="(new message)">
    </label>
    <button type="submit" class="btn btn-primary">Bind existing role</button>
  </form>
</div>
<div class="card">
  <h2>Create a role group</h2>
  <p class="muted">Posts one message offering several roles at once. With <strong>Unique</strong> mode, reacting to one option clears the others (e.g. pick exactly one colour). All options share a single category/channel; delete the group as a unit. Fill at least two rows; blank rows are ignored.</p>
  <form method="POST" action="/admin/reaction-roles/group/create" class="stack">
    ${csrfInput}
    <label>Group name
      <input type="text" name="groupName" required maxlength="100" placeholder="Colour">
    </label>
    <label>Group mode
      <select name="mode">
        <option value="unique" selected>Unique — pick exactly one (reacting swaps your choice)</option>
        <option value="sticky">Sticky — add-only, reactions never revoke</option>
        <option value="toggle">Toggle — independent add/remove per option</option>
      </select>
    </label>
    ${groupOptionRows("Role group", (i) => [`Role name${i < 2 ? " (required)" : ""}`, `Emoji${i < 2 ? " (required)" : ""}`])}
    <button type="submit" class="btn btn-primary">Create role group</button>
  </form>
</div>
<div class="card">
  <h2>Generate a grouped set</h2>
  <p class="muted">Creates a whole set of roles and one picker message in one step. Existing roles with the same name are reused untouched; new roles get no permissions (colour: <code>reactionroles.group_role_colour</code>). Safe to run again: only missing options are added, nothing is removed or duplicated. Up to 20 options per group.</p>
  <form method="POST" action="/admin/reaction-roles/group/generate" class="stack">
    ${csrfInput}
    <label>Source
      <select name="preset">
        ${reactionRoleGroupPresets.map((p) => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.name)} preset — ${escapeHtml(p.description)} (${p.entries.length} roles)</option>`).join("")}
        <option value="custom">Custom group (fill in below)</option>
      </select>
    </label>
    <label>Custom group name <span class="muted">(custom only)</span>
      <input type="text" name="groupName" maxlength="100" placeholder="Platform">
    </label>
    <label>Group mode <span class="muted">(blank = preset default; unique for custom)</span>
      <select name="mode">
        <option value="">Default</option>
        <option value="unique">Unique — pick exactly one</option>
        <option value="sticky">Sticky — add-only</option>
        <option value="toggle">Toggle — independent add/remove</option>
      </select>
    </label>
    ${groupOptionRows("Custom role group", (i) => [`Custom role name${i < 1 ? " (custom only)" : ""}`, "Emoji"])}
    <button type="submit" class="btn btn-primary">Generate roles</button>
  </form>
</div>
<div class="card">
  <h2>Archived (last 50)</h2>
  ${
    props.archived.length === 0
      ? `<div class="empty">No archived mappings.</div>`
      : `<table><thead><tr><th scope="col">Emoji</th><th scope="col">Role grant</th><th scope="col">Type</th><th scope="col">Category</th><th scope="col">Channel</th><th scope="col">Message ID</th><th scope="col">Mode</th><th scope="col">Status</th><th scope="col">Archived</th><th scope="col">Actions</th></tr></thead><tbody>${archivedRows}</tbody></table>`
  }
</div>
${renderFeatureSettingsCard({
  intro:
    "Turn reaction roles on or off, pick the message channel and the surface style for new role messages. Turning the feature off keeps the other settings as they are.",
  category: "reactionroles",
  settingRows: props.settingRows ?? [],
  pickers: { textChannels: props.textChannels },
  returnTo: "/admin/reaction-roles",
  csrfToken: props.csrfToken,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  needsSetup: !props.configChannel,
  flash: props.flash,
})}
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
  channel: { name: string; id: string; type: ChannelType | null } | null;
  total: number;
  /** The auto-managed `notices.header_message_id`, sent back by Re-post. */
  headerMessageId?: string;
  /** `notices.header_enabled`; the Re-post button is off when it is false. */
  headerEnabled?: boolean;
  /**
   * The editable `notices.*` settings rendered in place on the page (#972),
   * built from the config schema the same way the Settings page builds its
   * rows. Excludes the auto-managed `notices.header_message_id`.
   */
  settingRows: SettingRow[];
  /** Text-channel options backing the `notices.channel_id` picker. */
  textChannels: ChannelOption[];
  /**
   * True when the stored config could not be read. The settings card is then
   * withheld rather than rendered with schema defaults a save would persist.
   */
  settingsUnavailable?: boolean;
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
<td><form method="POST" action="/admin/notices/${escapeHtml(n.id)}/order" class="inline-order">${csrfInput}<input type="number" name="order" aria-label="Display order for ${escapeHtml(n.title)}" value="${n.order}" min="-1000" max="10000" required><button type="submit" class="btn" aria-label="Save display order for ${escapeHtml(n.title)}">Save</button></form></td>
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
  <form method="POST" action="/admin/notices/${escapeHtml(n.id)}/delete" data-confirm="Delete notice '${escapeHtml(n.title)}'?">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form>
</td>
</tr>`,
              )
              .join("");
            return `<div class="card">
  <h2>${escapeHtml(g.category)} <span class="muted">(${g.rows.length})</span></h2>
  <table><thead><tr><th scope="col">Order</th><th scope="col">Title</th><th scope="col">Content</th><th scope="col">Message ID</th><th scope="col">Updated</th><th scope="col">Actions</th></tr></thead><tbody>${rows}</tbody></table>
</div>`;
          })
          .join("");

  const body = `
<h1>Notices</h1>
<p class="subtitle">Notice posts grouped by category. Edit the inline <em>Order</em> field to reorder within a category (lower numbers post first).</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Notices", featureKey: "notices.enabled", returnTo: "/admin/notices", csrfToken: props.csrfToken })}

${renderStatusLine({
  enabled: props.enabled,
  chips: [
    props.channel
      ? {
          text: `Channel ${channelText({ name: props.channel.name, type: props.channel.type })}`,
        }
      : {
          text: "No channel set",
          warn: true,
          href: props.settingsUnavailable
            ? undefined
            : settingHref("notices.channel_id"),
        },
    { text: countOf(props.total, "notice") },
  ],
})}
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
${renderRepostCard({
  id: "repost-header",
  heading: "Header post",
  intro:
    "KoolBot keeps one header post in the notices channel and edits it in place when its wording changes. Re-post it to get a fresh message, for example if the post looks broken.",
  action: "/admin/notices/header/repost",
  csrfInput,
  messageId: props.headerMessageId ?? "",
  buttonLabel: "Re-post the header",
  confirmText: "Re-post the notices channel header?",
  consequences: [
    "A new header is posted at the bottom of the notices channel, below the notices, and pinned if pinning is on. Resync notices to channel puts the notices back below it.",
    "The old header is deleted if KoolBot can find it in this channel. If it was already deleted, nothing else happens.",
    "The notices themselves are not touched.",
  ],
  blockedReason: !props.enabled
    ? "Turn on Notices first."
    : props.headerEnabled === false
      ? "The header post is switched off in the settings below."
      : !props.channel
        ? "Set the notices channel first."
        : null,
})}
<div class="card">
  <h2>Resync to the channel</h2>
  <form method="POST" action="/admin/notices/sync" class="inline-form" data-confirm="Resync all notices? This deletes and reposts every notice message."${confirmListAttr(
    [
      "The bot's own messages among the latest 100 in the notices channel are deleted; the header stays.",
      "Every notice is posted again from the saved list.",
    ],
  )}>
    ${csrfInput}
    <button type="submit" class="btn btn-primary">Resync notices to channel</button>
    <span class="muted">Deletes and reposts every notice message in the channel.</span>
  </form>
</div>
${renderFeatureSettingsCard({
  intro:
    "Change notices settings here without leaving the page. Changing the channel does not move notices already posted: after saving, use Resync notices to channel above to repost them in the new channel.",
  category: "notices",
  settingRows: props.settingRows,
  pickers: { textChannels: props.textChannels },
  returnTo: "/admin/notices",
  csrfToken: props.csrfToken,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  needsSetup: !props.channel,
  flash: props.flash,
})}
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

// ---------- Quotes ----------

export interface QuoteRow {
  id: string;
  content: string;
  /** Normalised author snowflake — what the edit form submits back. */
  authorId: string;
  /** Display name when the member resolved, else the raw ID. */
  authorLabel: string;
  addedByLabel: string;
  addedAt: string;
  likes: number;
  dislikes: number;
  messageId: string;
}

export interface QuotesProps extends CommonProps {
  enabled: boolean;
  channel: { name: string; id: string; type: ChannelType | null } | null;
  /** The auto-managed `quotes.header_message_id`, shown read-only. */
  headerMessageId: string;
  /** `quotes.header_enabled`; the Re-post button is off when it is false. */
  headerEnabled?: boolean;
  /**
   * The editable `quotes.*` settings rendered in place on the page (#984).
   * Excludes the auto-managed `quotes.header_message_id`.
   */
  settingRows: SettingRow[];
  settingsPickers?: FeatureSettingsPickers;
  dependencyState?: ReadonlyMap<string, boolean>;
  /** The stored config could not be read; the card shows a notice instead. */
  settingsUnavailable?: boolean;
  /** `quotes.max_length`, applied to the edit form's textarea. */
  maxLength: number;
  rows: QuoteRow[];
  /** Quotes matching {@link search} (every quote when it is empty). */
  total: number;
  page: number;
  pageSize: number;
  search: string;
  flash?: FlashMessage | null;
}

function quotesQueryString(search: string, page: number): string {
  const parts: string[] = [];
  if (search) parts.push(`q=${encodeURIComponent(search)}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export function renderQuotesPage(props: QuotesProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  const page = Math.min(Math.max(1, props.page), totalPages);

  const rowsHtml = props.rows
    .map((q) => {
      const preview =
        q.content.length > 160 ? `${q.content.slice(0, 160)}…` : q.content;
      return `<tr>
<td>${escapeHtml(preview)}<div class="muted mono">id: ${escapeHtml(q.id)}</div></td>
<td title="${escapeHtml(q.authorId)}">${escapeHtml(q.authorLabel)}</td>
<td>${escapeHtml(q.addedByLabel)}</td>
<td class="muted">${escapeHtml(q.addedAt)}</td>
<td>👍 ${q.likes} · 👎 ${q.dislikes}</td>
<td class="mono muted">${escapeHtml(q.messageId)}</td>
<td class="actions">
  <details class="helper edit-details"><summary>Edit</summary>
    <form method="POST" action="/admin/quotes/${escapeHtml(q.id)}/edit" class="stack">${csrfInput}
      <label>Quote<textarea name="content" rows="4" maxlength="${props.maxLength}" required>${escapeHtml(q.content)}</textarea></label>
      <label>Author (Discord user ID)<input type="text" name="author_id" inputmode="numeric" pattern="\\d{17,20}" value="${escapeHtml(q.authorId)}" required></label>
      <button type="submit" class="btn btn-primary">Save changes</button>
    </form>
  </details>
  <form method="POST" action="/admin/quotes/${escapeHtml(q.id)}/delete" data-confirm="Delete quote ${escapeHtml(q.id)}? Its channel post is removed too.">${csrfInput}<button type="submit" class="btn btn-danger" aria-label="Delete quote ${escapeHtml(q.id)}">Delete</button></form>
</td>
</tr>`;
    })
    .join("");

  const emptyText = props.search
    ? "No quotes match this search."
    : "No quotes stored.";
  const tableHtml =
    props.rows.length === 0
      ? `<div class="empty">${emptyText}</div>`
      : `<table><thead><tr><th scope="col">Quote</th><th scope="col">Author</th><th scope="col">Added by</th><th scope="col">Added</th><th scope="col">Votes</th><th scope="col">Message ID</th><th scope="col">Actions</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;

  const prevLink =
    page > 1
      ? `<a class="btn btn-sm" href="/admin/quotes${quotesQueryString(props.search, page - 1)}">← Prev</a>`
      : `<button class="btn btn-sm" disabled>← Prev</button>`;
  const nextLink =
    page < totalPages
      ? `<a class="btn btn-sm" href="/admin/quotes${quotesQueryString(props.search, page + 1)}">Next →</a>`
      : `<button class="btn btn-sm" disabled>Next →</button>`;
  const clearLink = props.search
    ? ` <a class="btn" href="/admin/quotes">Clear</a>`
    : "";

  const body = `
<h1>Quotes</h1>
<p class="subtitle">Every stored quote, newest first. Edits and deletes update the quote channel as well.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Quotes", featureKey: "quotes.enabled", returnTo: "/admin/quotes", csrfToken: props.csrfToken })}
${renderStatusLine({
  enabled: props.enabled,
  chips: [
    props.channel
      ? {
          text: `Channel ${channelText({ name: props.channel.name, type: props.channel.type })}`,
        }
      : {
          text: "No channel set",
          warn: true,
          href: props.settingsUnavailable
            ? undefined
            : settingHref("quotes.channel_id"),
        },
    props.headerMessageId
      ? { text: `Header post ${props.headerMessageId}`, mono: true }
      : { text: "No header post yet" },
    {
      text: `${props.search ? "Matching quotes" : "Total quotes"}: ${props.total}`,
    },
  ],
})}

<div class="card">
  <h2>Quotes</h2>
  <form method="GET" action="/admin/quotes" class="inline-form" role="search">
    <label for="quote-search">Search</label>
    <input type="search" id="quote-search" name="q" value="${escapeHtml(props.search)}" maxlength="200" placeholder="Text, quote ID, message ID or user ID">
    <button type="submit" class="btn">Search</button>${clearLink}
  </form>
  ${tableHtml}
  <div class="inline-form">${prevLink} <span class="muted">Page ${page} of ${totalPages}</span> ${nextLink}</div>
</div>
${renderRepostCard({
  id: "repost-header",
  heading: "Header post",
  intro:
    "KoolBot keeps one header post at the top of the quote channel and edits it in place when its wording changes. Re-post it to get a fresh message, for example if the post looks broken.",
  action: "/admin/quotes/header/repost",
  csrfInput,
  messageId: props.headerMessageId,
  buttonLabel: "Re-post the header",
  confirmText: "Re-post the quote channel header?",
  consequences: [
    "A new header is posted at the bottom of the quote channel, and pinned if pinning is on.",
    "The old header is deleted if KoolBot can find it in this channel. If it was already deleted, nothing else happens.",
    "Quotes are not touched.",
  ],
  blockedReason: !props.enabled
    ? "Turn on Quotes first."
    : props.headerEnabled === false
      ? "The header post is switched off in the settings below."
      : !props.channel
        ? "Set the quote channel first."
        : null,
})}
<div class="card">
  <h2>Quote channel</h2>
  <form method="POST" action="/admin/quotes/sync" class="inline-form" data-confirm="Rebuild the quote channel? This deletes every message in it and reposts all quotes with their saved votes."${confirmListAttr(
    [
      "Every message in the quote channel is deleted, including anything that is not a quote.",
      "The header and every quote are posted again, with their saved votes.",
    ],
  )}>
    ${csrfInput}
    <button type="submit" class="btn btn-primary"${props.enabled ? "" : " disabled"}>Resync quote channel</button>
    <span class="muted">Clears the channel, posts a fresh header and reposts every quote with its saved vote tally.</span>
  </form>
  <p class="inline-form"><a class="btn" href="/admin/quotes/export">Export quotes (JSON)</a> <span class="muted">The same backup <code>/quote export</code> produces; restore it with <code>/quote import</code>.</span></p>
</div>
${renderFeatureSettingsCard({
  intro:
    "Change quote settings here without leaving the page. Changing the channel does not move quotes already posted: after saving, use Resync quote channel above to repost them in the new channel.",
  category: "quotes",
  settingRows: props.settingRows,
  pickers: props.settingsPickers,
  returnTo: "/admin/quotes",
  csrfToken: props.csrfToken,
  dependencyState: props.dependencyState,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
  needsSetup: !props.channel,
})}
`;
  return renderAdminPage({
    title: "Quotes",
    active: "/admin/quotes",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Birthdays ----------

export interface BirthdayRow {
  userId: string;
  /** Display name when the member resolved, else the raw ID. */
  userLabel: string;
  month: number;
  day: number;
  /** A birth year is on file. The year itself is never shown (#986). */
  hasYear: boolean;
  /** Next celebration, `YYYY-MM-DD`. */
  nextDate: string;
  daysUntil: number;
  /** A grant is on record and not yet swept — not a live role check. */
  roleGranted: boolean;
  /** Year the check last handled the member — not proof of a post. */
  lastAnnouncedYear: number | null;
}

export interface BirthdayPreviewView {
  /** The signed-in admin, used as the sample member. */
  mentionUserId: string;
  mentionLabel: string;
  /** `birthdays.mention` — whether `{user}` pings. */
  mention: boolean;
  /** The template rendered with {@link sampleAge}. */
  withAge: string;
  /** The template rendered with no year on file; null when it has no `{age}`. */
  withoutAge: string | null;
  sampleAge: number;
}

export interface BirthdaysProps extends CommonProps {
  enabled: boolean;
  channel: { name: string; id: string; type: ChannelType | null } | null;
  role: { name: string; id: string } | null;
  cron: string;
  /** Every `birthdays.*` key, rendered in place on the page (#986). */
  settingRows: SettingRow[];
  settingsPickers?: FeatureSettingsPickers;
  dependencyState?: ReadonlyMap<string, boolean>;
  /** The stored config could not be read; the card shows a notice instead. */
  settingsUnavailable?: boolean;
  preview: BirthdayPreviewView;
  rows: BirthdayRow[];
  /** The stored birthdays could not be read. */
  listUnavailable?: boolean;
  total: number;
  page: number;
  pageSize: number;
  flash?: FlashMessage | null;
}

/**
 * A rendered birthday message as HTML: escaped, with the sample member's
 * `<@id>` mention drawn as a Discord-style chip instead of raw markup.
 */
function renderBirthdayPreviewText(
  text: string,
  preview: BirthdayPreviewView,
): string {
  const mentionHtml = `<span class="tag tag-info">@${escapeHtml(preview.mentionLabel)}</span>`;
  return escapeHtml(text)
    .split(escapeHtml(`<@${preview.mentionUserId}>`))
    .join(mentionHtml);
}

function formatMonthDay(month: number, day: number): string {
  return `${MONTH_NAMES[month - 1] ?? month} ${day}`;
}

function nextBirthdayLabel(row: BirthdayRow): string {
  if (row.daysUntil === 0) return "today";
  if (row.daysUntil === 1) return "tomorrow";
  return `in ${row.daysUntil} days`;
}

export function renderBirthdaysPage(props: BirthdaysProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  const page = Math.min(Math.max(1, props.page), totalPages);

  const monthOptions = (selected: number): string =>
    MONTH_NAMES.map(
      (name, i) =>
        `<option value="${i + 1}"${i + 1 === selected ? " selected" : ""}>${escapeHtml(name)}</option>`,
    ).join("");
  const dayOptions = (selected: number): string =>
    Array.from(
      { length: 31 },
      (_, i) =>
        `<option value="${i + 1}"${i + 1 === selected ? " selected" : ""}>${i + 1}</option>`,
    ).join("");

  const rowsHtml = props.rows
    .map((b) => {
      const id = escapeHtml(b.userId);
      const clearYear = b.hasYear
        ? `<label class="checkbox"><input type="checkbox" name="clear_year" value="1"> Remove the birth year (the post stops showing an age)</label>`
        : "";
      return `<tr>
<td title="${id}">${escapeHtml(b.userLabel)}<div class="muted mono">${id}</div></td>
<td>${escapeHtml(formatMonthDay(b.month, b.day))}</td>
<td>${escapeHtml(b.nextDate)} <span class="muted">(${nextBirthdayLabel(b)})</span></td>
<td>${b.hasYear ? "on file" : '<span class="muted">none</span>'}</td>
<td>${b.roleGranted ? '<span class="tag tag-on">granted</span>' : '<span class="muted">—</span>'}</td>
<td class="muted">${b.lastAnnouncedYear ?? "—"}</td>
<td class="actions">
  <details class="helper edit-details"><summary>Edit</summary>
    <form method="POST" action="/admin/birthdays/${id}/edit" class="stack">${csrfInput}
      <label>Month<select name="month" required>${monthOptions(b.month)}</select></label>
      <label>Day<select name="day" required>${dayOptions(b.day)}</select></label>
      ${clearYear}
      <button type="submit" class="btn btn-primary">Save changes</button>
    </form>
  </details>
  <form method="POST" action="/admin/birthdays/${id}/remove" data-confirm="Remove the birthday for ${escapeHtml(b.userLabel)}? Any birthday role they hold is taken back and the bot's birthday posts about them are deleted."${confirmListAttr(
    [
      "The saved birthday is removed.",
      "Any birthday role they hold is taken back.",
      "The bot's birthday posts about them are deleted.",
      "If the role or a post cannot be undone, the birthday is kept so you can retry.",
    ],
  )}>${csrfInput}<button type="submit" class="btn btn-danger" aria-label="Remove birthday for ${escapeHtml(b.userLabel)}">Remove</button></form>
</td>
</tr>`;
    })
    .join("");

  const tableHtml = props.listUnavailable
    ? `<div class="notice">Stored birthdays could not be read. Check the bot's logs and reload the page.</div>`
    : props.rows.length === 0
      ? `<div class="empty">No member has set a birthday yet. Members add theirs on <code>/me/birthday</code>.</div>`
      : `<table><thead><tr><th scope="col">Member</th><th scope="col">Birthday</th><th scope="col">Next</th><th scope="col">Birth year</th><th scope="col">Role grant</th><th scope="col">Last handled</th><th scope="col">Actions</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;

  const pageLink = (n: number): string =>
    n > 1 ? `/admin/birthdays?page=${n}` : "/admin/birthdays";
  const prevLink =
    page > 1
      ? `<a class="btn btn-sm" href="${pageLink(page - 1)}">← Prev</a>`
      : `<button class="btn btn-sm" disabled>← Prev</button>`;
  const nextLink =
    page < totalPages
      ? `<a class="btn btn-sm" href="${pageLink(page + 1)}">Next →</a>`
      : `<button class="btn btn-sm" disabled>Next →</button>`;

  const p = props.preview;
  const withoutAgeHtml = p.withoutAge
    ? `<dt>No birth year on file</dt><dd>${renderBirthdayPreviewText(p.withoutAge, p)}</dd>`
    : "";
  const previewNotes = [
    p.mention
      ? "The member is pinged (<code>birthdays.mention</code> is on)."
      : "The member's name shows, but they are not pinged (<code>birthdays.mention</code> is off).",
    props.role
      ? `They get <strong>@${escapeHtml(props.role.name)}</strong> for the configured duration.`
      : "No birthday role is granted (<code>birthdays.role_id</code> is empty).",
  ];

  const runDisabled = !props.enabled || !props.channel;
  const runHint = !props.enabled
    ? "Enable <code>birthdays.enabled</code> first."
    : !props.channel
      ? "Set <code>birthdays.channel_id</code> first."
      : "Runs the scheduled check now: posts for anyone whose birthday it is in their own timezone and has not been announced this year, and removes expired birthday roles. Nobody is announced twice.";

  const body = `
<h1>Birthdays</h1>
<p class="subtitle">Members set their own birthday on <code>/me/birthday</code>. Here you can see who is coming up, correct or remove an entry, and check the message before it goes live.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Birthdays", featureKey: "birthdays.enabled", returnTo: "/admin/birthdays", csrfToken: props.csrfToken })}
${renderStatusLine({
  enabled: props.enabled,
  chips: [
    props.channel
      ? {
          text: `Channel ${channelText({ name: props.channel.name, type: props.channel.type })}`,
        }
      : {
          text: "No channel set",
          warn: true,
          href: props.settingsUnavailable
            ? undefined
            : settingHref("birthdays.channel_id"),
        },
    { text: props.role ? `Role @${props.role.name}` : "No birthday role" },
    { text: `Schedule ${props.cron}`, mono: true },
    {
      text: props.listUnavailable
        ? "Stored birthdays unavailable"
        : `${countOf(props.total, "stored birthday")}`,
    },
  ],
})}
<div class="card">
  <h2>Run the check</h2>
  <form method="POST" action="/admin/birthdays/run-now" class="inline-form" data-confirm="Run the birthday check now?"${CONFIRM_NEUTRAL_ATTR}>
    ${csrfInput}
    <button type="submit" class="btn btn-primary"${runDisabled ? " disabled" : ""}>Run now</button>
    <span class="muted">${runHint}</span>
  </form>
</div>
<div class="card">
  <h2>Message preview</h2>
  <p class="muted">The saved <code>birthdays.message</code>, filled in with you as the member. Save the settings below to update it.</p>
  <dl class="kv">
    <dt>Birth year on file (age ${p.sampleAge})</dt><dd>${renderBirthdayPreviewText(p.withAge, p)}</dd>
    ${withoutAgeHtml}
  </dl>
  <p class="muted">${previewNotes.join(" ")}</p>
</div>

<div class="card">
  <h2>Stored birthdays</h2>
  <p class="muted">Soonest first, by each member's own timezone. <em>Role grant</em> means the bot recorded giving the birthday role and has not swept it yet; the next run removes it once <code>birthdays.role_duration_hours</code> has passed. <em>Last handled</em> is the year the check last dealt with the member: it posted for them, or skipped them because they had left the server. Birth years stay private: the page shows only whether one is on file. Removing an entry takes back a live birthday role and deletes the bot's birthday posts about the member, the same as their own data reset.</p>
  ${tableHtml}
  <div class="inline-form">${prevLink} <span class="muted">Page ${page} of ${totalPages}</span> ${nextLink}</div>
</div>
${renderFeatureSettingsCard({
  intro:
    "Change birthday settings here without leaving the page. A schedule change re-arms the birthday check on save — no restart needed.",
  category: "birthdays",
  settingRows: props.settingRows,
  pickers: props.settingsPickers,
  returnTo: "/admin/birthdays",
  csrfToken: props.csrfToken,
  dependencyState: props.dependencyState,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
  needsSetup: !props.channel,
})}
`;
  return renderAdminPage({
    title: "Birthdays",
    active: "/admin/birthdays",
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

/**
 * Human label for a retention window. Exactly `0` means "keep forever" on
 * every retention key (#835), so it is spelled out rather than shown as
 * "0 days". Any other value — including an invalid negative one that slipped
 * in via an env var — is shown verbatim so a misconfiguration stays visible.
 */
function retentionWindowLabel(value: number, unit: string): string {
  return value === 0 ? "keep forever" : `${value} ${unit}`;
}

export function renderDatabasePage(props: DatabaseProps): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const collectionsHtml =
    props.collections.length === 0
      ? `<div class="empty">No collection statistics available.</div>`
      : `<table><thead><tr><th scope="col">Collection</th><th scope="col">Documents (est.)</th></tr></thead><tbody>${props.collections.map((c) => `<tr><td class="mono">${escapeHtml(c.name)}</td><td>${c.count}</td></tr>`).join("")}</tbody></table>`;

  const historyHtml =
    props.trunkHistory.length === 0
      ? `<div class="empty">No prior cleanup runs recorded.</div>`
      : `<table><thead><tr><th scope="col">When</th><th scope="col">Result</th><th scope="col">Sessions removed</th><th scope="col">Users processed</th><th scope="col">Time</th><th scope="col">Errors</th></tr></thead><tbody>${props.trunkHistory
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
      : "Runs the cleanup now. Subject to the 24-hour minimum interval.";

  const body = `
<h1>Database</h1>
<p class="subtitle">MongoDB connection state and the scheduled voice-tracking data cleanup.</p>
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
  <h2>Voice-tracking cleanup</h2>
  <dl class="kv">
    <dt>Feature</dt><dd>${tagOnOff(props.trunk.enabled, "enabled", "disabled")}</dd>
    <dt>Schedule</dt><dd class="mono">${escapeHtml(props.trunk.schedule || "(unset)")}</dd>
    <dt>Scheduled</dt><dd>${props.trunk.isScheduled ? '<span class="tag tag-on">yes</span>' : '<span class="tag tag-off">no</span>'}</dd>
    <dt>Currently running</dt><dd>${props.trunk.isRunning ? '<span class="tag tag-warn">yes</span>' : '<span class="tag tag-on">idle</span>'}</dd>
    <dt>Last run</dt><dd class="muted">${escapeHtml(props.trunk.lastRun)}</dd>
    <dt>Detailed sessions retention</dt><dd>${retentionWindowLabel(props.trunk.detailedDays, "days")}</dd>
    <dt>Monthly summaries retention</dt><dd>${retentionWindowLabel(props.trunk.monthlyMonths, "months")}</dd>
    <dt>Yearly summaries retention</dt><dd>${retentionWindowLabel(props.trunk.yearlyYears, "years")}</dd>
  </dl>
  <form method="POST" action="/admin/database/run-cleanup" class="inline-form" data-confirm="Run voice-channel data cleanup now?">
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
<td><form method="POST" action="${entryPath(item.id)}/order" class="inline-order">${csrfInput}<input type="number" name="order" aria-label="Display order for ${escapeHtml(item.text)}" value="${item.order}" min="-1000" max="10000" required><button type="submit" class="btn" aria-label="Save display order for ${escapeHtml(item.text)}">Save</button></form></td>
<td>
  <details class="helper edit-details"><summary>${escapeHtml(item.text)}</summary>
    <form method="POST" action="${entryPath(item.id)}/update" class="stack">${csrfInput}
      <label>Text<input type="text" name="text" maxlength="${opts.maxLength}" value="${escapeHtml(item.text)}" required></label>
      <button type="submit" class="btn btn-primary">Save changes</button>
    </form>
  </details>
  <div class="muted mono">id: ${escapeHtml(item.id)}</div>
</td>
<td class="actions"><form method="POST" action="${entryPath(item.id)}/delete" data-confirm="Delete this entry?">${csrfInput}<button type="submit" class="btn btn-danger">Delete</button></form></td>
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
  <table><thead><tr><th scope="col">Order</th><th scope="col">Text</th><th scope="col">Actions</th></tr></thead><tbody>${rows}</tbody></table>
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
<h1>Presence</h1>
<p class="subtitle">The "Watching …" presence messages the bot rotates through, picked by how many users are in voice. Edit, import, or export each pool below — changes take effect without a redeploy. Empty pools fall back to the built-in defaults.</p>
${renderFlash(props.flash)}
${editors}
`;
  return renderAdminPage({
    title: "Presence",
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
  /** What the bot lacks for the voice channel features (#1253). Null: nothing to say. */
  permissionNotice?: PermissionNotice | null;
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
   * Every `voicechannels.*` key, edited in place on the feature page (#705)
   * through {@link renderFeatureSettingsCard}. Includes
   * `voicechannels.enabled` (#979), so the feature can be switched off here
   * as well as on.
   */
  settingRows: SettingRow[];
  /**
   * The stored config could not be read, so the settings card is replaced by
   * a notice rather than rendering schema defaults a save would write back.
   */
  settingsUnavailable?: boolean;
  /** Category options backing the `voicechannels.category_id` picker. */
  categoryChannels: ChannelOption[];
  /** Voice channel options backing the `voicechannels.lobby.channel_id` picker. */
  voiceChannels?: ChannelOption[];
  /**
   * `voicechannels.cleanup.managed_only`: cleanup deletes only channels
   * KoolBot created, so the page words the cleanup actions accordingly.
   */
  managedOnly?: boolean;
  flash?: FlashMessage | null;
}

/**
 * Picker option lists a {@link renderFeatureSettingsCard} needs. Every list is
 * optional: a feature page only fetches (and passes) the lists its own keys
 * render — a card with no role keys never needs the guild's roles (#971).
 */
export interface FeatureSettingsPickers {
  textChannels?: ChannelOption[];
  voiceChannels?: ChannelOption[];
  categoryChannels?: ChannelOption[];
  roles?: RoleOption[];
  /** Roles with role groups ahead of them, for keys that take groups (#1023). */
  groupRoles?: RoleOption[];
  /** The bot's reaction-role messages, for a key that picks one (#1433). */
  reactionRoleMessages?: ReactionRoleMessageOptions | null;
}

export interface FeatureSettingsCardProps {
  /** Card heading. Defaults to "Settings". */
  title?: string;
  /** Plain-text line under the heading (escaped on output). */
  intro?: string;
  /**
   * Settings category the form reports to `save-section` — used in the flash
   * text and the audit row's `targetId`, not for key selection.
   */
  category: string;
  /** Rows to render, typically from `buildSettingRows(KEYS, stored)`. */
  settingRows: SettingRow[];
  pickers?: FeatureSettingsPickers;
  /** Admin path `save-section` redirects back to after the save. */
  returnTo: string;
  csrfToken: string;
  /** Submit button text. Defaults to "Save settings". */
  submitLabel?: string;
  /**
   * On/off state of keys the card does *not* render but its rows depend on
   * (e.g. `voicetracking.enabled` for a Digest card). Rendered rows always
   * judge their own state from `settingRows`, so this only fills the gaps.
   * Without it an off-card dependency counts as unmet and locks the control.
   */
  dependencyState?: ReadonlyMap<string, boolean>;
  /**
   * The stored config snapshot could not be read. The card then renders a
   * notice instead of controls: rows built from an empty snapshot would show
   * schema defaults as if they were stored, and saving them would overwrite
   * the real values.
   */
  unavailable?: boolean;
  /**
   * Whether the feature is on. The settings are folded (#1301) unless the
   * feature is off, since then the usable part cannot work and the admin is
   * here to set it up. A card with a `<feature>.enabled` row also reads that
   * row; pass this for the pages whose master key is not a two-segment one
   * (`core.command_audit.enabled`).
   */
  enabled?: boolean;
  /**
   * A setting the feature cannot work without is missing (no category, no
   * channel). Opens the settings. The caller knows what is required; the
   * card does not guess from the schema.
   */
  needsSetup?: boolean;
  /**
   * The page's flash. When it belongs to a settings save (`openSettings`) it
   * is rendered inside the settings, which then start open.
   */
  flash?: FlashMessage | null;
}

/**
 * Notice shown in place of editable settings when the stored config could not
 * be read, so no form pre-filled with schema defaults is ever offered. Carries
 * the same `tabindex="-1"` + `data-flash` hook as `renderFlash`, so the
 * layout's on-load script focuses it and screen readers announce it (#855).
 */
export function renderSettingsUnavailableNotice(): string {
  return `<div class="notice warn" role="status" tabindex="-1" data-flash>Settings could not be loaded, so they can't be edited here right now. Reload the page to try again.</div>`;
}

/**
 * The feature's top-level master toggle among a card's rows, or null. Only a
 * two-segment `<feature>.enabled` key counts: a card that carries just
 * sub-toggles (e.g. `voicechannels.controlpanel.enabled` without
 * `voicechannels.enabled`) has no master. `findSectionMasterKey` on the server picks the same key from the submitted
 * set, so the cascade the page renders is the one the save applies.
 */
export function findFeatureMasterKey(rows: SettingRow[]): string | null {
  return findCascadeMasterKey(rows);
}

/**
 * Generic in-place settings card for a feature page (#705, #971). Renders the
 * given rows with the same control renderer, caption / description wiring
 * (#854, #856), `warnBelow` hints and dependency locks (#666) the Settings
 * page uses, and posts through the shared `/admin/settings/save-section` route
 * with `redirect` back to the feature page.
 *
 * Enable / disable: when the rows include the feature master
 * (`<feature>.enabled`, see {@link findFeatureMasterKey}) it renders as a
 * normal toggle and the form behaves like a Settings section — the master is
 * the cascade master, unchecking it greys the other controls, and the save
 * writes only the master flag so the dependents keep their stored values
 * rather than being blanked (#485). Without a master the form sets
 * `no_cascade`, so every submitted key is written rather than a sub-toggle
 * being mistaken for the section master.
 */
export function renderFeatureSettingsCard(
  props: FeatureSettingsCardProps,
): string {
  // A flash from a settings save is shown with the settings (#1301). When the
  // card has no form to put it in, it still shows here rather than vanishing.
  const flashHtml = props.flash?.openSettings ? renderFlash(props.flash) : "";
  if (props.unavailable) {
    return `
<div class="card">
  <h2>${escapeHtml(props.title ?? "Settings")}</h2>
  ${flashHtml}${renderSettingsUnavailableNotice()}
</div>`;
  }
  if (props.settingRows.length === 0) return flashHtml;
  const pickers = {
    textChannels: props.pickers?.textChannels ?? [],
    voiceChannels: props.pickers?.voiceChannels ?? [],
    categoryChannels: props.pickers?.categoryChannels ?? [],
    roles: props.pickers?.roles ?? [],
    groupRoles: props.pickers?.groupRoles,
    reactionRoleMessages: props.pickers?.reactionRoleMessages,
  };
  const masterKey = findFeatureMasterKey(props.settingRows);
  const enabledByKey = new Map<string, boolean>(props.dependencyState ?? []);
  for (const r of props.settingRows) {
    enabledByKey.set(r.key, isEnabledValue(r.current));
  }
  // The rows share the Settings page's renderer: caption and description wired
  // to the control by id (#854, #856), `warnBelow` hints, dependents nested
  // under their parent (#666, #1318), and reset buttons for changed values.
  // Keyed by its first setting so two cards of one category on a page keep
  // distinct form ids.
  const formId = `form-${props.category}-${props.settingRows[0].key}`;
  const rowsHtml = renderSettingRows(props.settingRows, {
    pickers,
    masterKey,
    enabledByKey,
    resetFormId: `${formId}-reset`,
    // No `#section-` anchors to jump to on a feature page, so the hint
    // names the dependency without linking it.
    linkSections: false,
  });
  const introHtml = props.intro
    ? `\n  <p class="muted" style="margin:.25rem 0 .75rem">${escapeHtml(props.intro)}</p>`
    : "";
  const scopeAttr = masterKey ? " data-cascade-scope" : "";
  const cascadeInput = masterKey
    ? ""
    : `\n    <input type="hidden" name="no_cascade" value="1">`;
  const title = props.title ?? "Settings";

  // Folded (#1301), except where the admin is here to set things up: the
  // feature is off or misses a required value, or a save just happened and the
  // result (and any rejected field) must be seen where it was made.
  const master = masterKey
    ? props.settingRows.find((r) => r.key === masterKey)
    : undefined;
  const featureOff =
    props.enabled === false ||
    (master ? !isEnabledValue(master.current) : false);
  const forced =
    featureOff ||
    props.needsSetup === true ||
    props.flash?.openSettings === true;
  // Counted exactly as the rows mark themselves changed: a row whose
  // dependency lives on another form has no control and never counts.
  const inForm = new Set(props.settingRows.map((r) => r.key));
  const changed = props.settingRows.filter((r) => {
    const offForm = unmetDependenciesFor(r.key, enabledByKey).some(
      (d) => !inForm.has(d.key),
    );
    return !offForm && differsFromDefault(r);
  }).length;
  const hint =
    changed > 0
      ? `<span class="kb-disclosure__hint" data-fold-hint>${changed} changed from the default</span>`
      : "";
  return `
<div class="card card--savebar">
  <details class="kb-disclosure" id="feature-settings" data-settings-fold data-fold-key="${escapeHtml(props.returnTo)}"${forced ? " open data-fold-forced" : ""}>
    <summary>${CHEVRON_ICON}${escapeHtml(title)} <span class="kb-badge kb-badge--count">${props.settingRows.length}</span>${hint}</summary>
    <div class="kb-disclosure__body">${flashHtml}${introHtml}
  ${renderSettingsForms({
    formId,
    saveAttrs: scopeAttr,
    hiddenFields: `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
    <input type="hidden" name="category" value="${escapeHtml(props.category)}">
    <input type="hidden" name="redirect" value="${escapeHtml(props.returnTo)}">${cascadeInput}`,
    rowsHtml,
    submitLabel: props.submitLabel ?? "Save settings",
    title,
    csrfToken: props.csrfToken,
    returnTo: props.returnTo,
  })}
    </div>
  </details>
  ${scriptTag(SETTINGS_FOLD_SCRIPT)}
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
<td>${channelMention({ name: ch.name, type: ChannelType.GuildVoice })}${live}</td>
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
      : `<table><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Users</th><th scope="col">Custom name</th><th scope="col">Channel ID</th></tr></thead><tbody>${rows}</tbody></table>`;

  const voiceNotice = renderPermissionNotice(props.permissionNotice ?? null, {
    canLinkToPage: true,
  });

  const reloadDisabled = !props.enabled || !props.categoryFound;
  const reloadHint = !props.enabled
    ? "Enable <code>voicechannels.enabled</code> first."
    : !props.categoryFound
      ? "Category not found in this guild."
      : "";

  const body = `
<h1>Voice Channels</h1>
<p class="subtitle">Voice-channel category contents and live state.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Voice Channels", featureKey: "voicechannels.enabled", returnTo: "/admin/voice-channels", csrfToken: props.csrfToken })}
${renderStatusLine({
  enabled: props.enabled,
  chips: [
    props.categoryFound
      ? { text: `Category ${props.categoryName}`, mono: true }
      : {
          text: "Category not found",
          warn: true,
          href: props.settingsUnavailable
            ? undefined
            : settingHref("voicechannels.category_id"),
        },
    { text: `Lobby ${props.lobbyName}`, mono: true },
    { text: `Offline lobby ${props.offlineLobbyName}`, mono: true },
    { text: `Prefix ${props.prefix}`, mono: true },
    { text: `Control panel ${props.controlPanelEnabled ? "on" : "off"}` },
    {
      text: `Cleanup scope: ${props.managedOnly ? "Only channels KoolBot created" : "Every empty voice channel in the category"}`,
    },
    { text: `${props.totalManaged} in the category` },
    { text: `${props.totalEmpty} empty` },
  ],
})}
${voiceNotice}
<div class="card">
  <h2>Cleanup actions</h2>
  <form method="POST" action="/admin/voice-channels/force-reload" class="inline-form" data-confirm="${props.managedOnly ? "Force cleanup of empty channels KoolBot created in the category (channels it did not create are never touched) and ensure the lobby exists? Occupied channels are left alone until they empty." : "Force cleanup of all empty unmanaged channels in the category and ensure the lobby exists? Occupied unmanaged channels are left alone until they empty."}${props.managedOnly ? " An existing lobby is kept, renamed back online if needed, and only created when missing." : " An offline lobby is renamed back online; otherwise the lobby is deleted and re-created, which disconnects anyone currently in it."}">
    ${csrfInput}
    <button type="submit" class="btn btn-danger"${reloadDisabled ? " disabled" : ""}>Force VC cleanup</button>
    <span class="muted">${props.managedOnly ? "Removes empty channels KoolBot created in the category (channels it did not create are never touched, and occupied ones are kept until they empty)" : "Removes all empty unmanaged channels in the category (unmanaged channels with members in them are kept until they empty)"}, then ensures the lobby exists: ${props.managedOnly ? "an existing lobby is kept and renamed back online if needed, and one is only created when missing." : "an offline lobby is renamed back online, otherwise the lobby is deleted and re-created, which disconnects anyone currently in it."}</span>
  </form>
  ${reloadHint ? `<p class="muted">${reloadHint}</p>` : ""}
</div>
<div class="card"><h2>Channels</h2>${channelsHtml}</div>
${renderFeatureSettingsCard({
  intro:
    "Change voice-channel settings here without leaving the page. Saved through the shared settings route.",
  category: "voicechannels",
  settingRows: props.settingRows,
  pickers: {
    categoryChannels: props.categoryChannels,
    voiceChannels: props.voiceChannels ?? [],
  },
  returnTo: "/admin/voice-channels",
  csrfToken: props.csrfToken,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
  needsSetup: !props.categoryFound,
})}
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
  /**
   * Every `digest.*` key, edited in place on this page (#976) through
   * {@link renderFeatureSettingsCard}. Includes `digest.enabled`, so the
   * digest can be switched off here as well as on.
   */
  settingRows: SettingRow[];
  /** Picker lists the card's rows render (none today; kept for parity). */
  settingsPickers?: FeatureSettingsPickers;
  /**
   * On/off state of off-card dependencies of {@link settingRows}
   * (`voicetracking.enabled`, `achievements.enabled`).
   */
  dependencyState?: ReadonlyMap<string, boolean>;
  /**
   * True when the stored config could not be read. The card then renders a
   * notice instead of controls pre-filled with schema defaults.
   */
  settingsUnavailable?: boolean;
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
.digest-embed{border-left:4px solid var(--embed-brand);background:var(--chrome);border-radius:4px;padding:.75rem 1rem;margin:.75rem 0}
.digest-embed-head{display:flex;gap:.5rem;align-items:center;margin-bottom:.35rem;font-size:.9rem}
.digest-embed-title{font-weight:600;margin-bottom:.25rem}
.digest-embed-desc{color:var(--text-secondary);margin-bottom:.6rem}
.digest-fields{display:flex;flex-wrap:wrap;gap:.75rem 1.5rem}
.digest-field{flex:1 1 100%}
.digest-field.inline{flex:1 1 28%;min-width:120px}
.digest-field-name{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.digest-field-value{color:var(--text)}
.digest-embed-footer{margin-top:.75rem;padding-top:.5rem;border-top:1px solid var(--border);font-size:.78rem;color:var(--muted)}
</style>
<h1>Weekly Digest</h1>
<p class="subtitle">Preview the weekly voice digest before it sends — a dry run of the same query and embeds the cron job DMs to qualifying members, with no DMs sent.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Weekly Digest", featureKey: "digest.enabled", returnTo: "/admin/digest", csrfToken: props.csrfToken })}
${renderStatusLine({ enabled: props.enabled, chips: [] })}

<div class="card">
  <h2>Actions</h2>
  <form method="GET" action="/admin/digest" class="inline-form">
    <button type="submit" name="preview" value="1" class="btn btn-primary"${props.enabled ? "" : " disabled"}>Preview digest</button>
    <span class="muted">Renders the digest for the most recent complete week without sending anything.</span>
  </form>
  <form method="POST" action="/admin/digest/send-now" class="inline-form" style="margin-top:.75rem" data-confirm="Send the weekly digest to all qualifying members right now?"${CONFIRM_NEUTRAL_ATTR}>
    ${csrfInput}
    <button type="submit" class="btn btn-danger"${sendDisabled ? " disabled" : ""}>Send now</button>
    <span class="muted">${sendHint}</span>
  </form>
</div>
${previewHtml}
${renderFeatureSettingsCard({
  intro:
    "Change the digest schedule and thresholds here without leaving the page. A schedule change re-arms the digest job on save — no restart needed.",
  category: "digest",
  settingRows: props.settingRows,
  pickers: props.settingsPickers,
  returnTo: "/admin/digest",
  csrfToken: props.csrfToken,
  dependencyState: props.dependencyState,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
})}
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

// ---------- Leaderboard Roles (#985) ----------

export interface LeaderboardTierHolder {
  id: string;
  /** Display name, or the raw id when the member could not be resolved. */
  label: string;
}

export interface LeaderboardTierView {
  topN: number;
  roleId: string;
  /** Role name, or null when the role no longer exists in the guild. */
  roleName: string | null;
  /**
   * Whether the bot can assign the role (it sits below the bot's highest
   * role and is not integration-managed). Null when that could not be
   * checked — the guild or the bot's own member could not be read.
   */
  assignable: boolean | null;
  /** Why the role can't be assigned, when {@link assignable} is false. */
  roleIssue?: "everyone" | "managed" | "hierarchy" | "privileged" | null;
  /** Members the bot last recorded as holding the role. */
  holders: LeaderboardTierHolder[];
  /** When the bot last reconciled this tier (ISO), or null if never. */
  lastUpdated: string | null;
}

export interface LeaderboardRolesProps extends CommonProps {
  enabled: boolean;
  /** `voicetracking.enabled` — the ranking data the tiers are computed from. */
  voiceTrackingEnabled: boolean;
  period: string;
  cron: string;
  /** Configured tiers, ascending by Top N, with their current holders. */
  tiers: LeaderboardTierView[];
  /**
   * Stored tier entries the service skips (malformed or shadowed); the editor
   * can't show them, so saving a change drops them.
   */
  ignoredEntries: string[];
  /** Assignable roles backing the tier editor's role pickers. */
  roles: RoleOption[];
  /**
   * The `leaderboard_roles.*` keys other than `tiers`, edited in place through
   * {@link renderFeatureSettingsCard}. Includes the feature master, so the
   * feature can be switched off here as well as on.
   */
  settingRows: SettingRow[];
  /** Channel list backing the announcement-channel picker. */
  pickers?: FeatureSettingsPickers;
  /** On/off state of off-card dependencies (`voicetracking.enabled`). */
  dependencyState?: ReadonlyMap<string, boolean>;
  /** The stored config could not be read; the card renders a notice. */
  settingsUnavailable?: boolean;
  flash?: FlashMessage | null;
}

// Progressive enhancement for the tier editor: "Add tier" clones the blank
// row template and each row's "Remove" drops it. Both buttons render hidden
// and only this script reveals them, so a no-JS page never shows a dead
// control: it renders one spare blank row, and clearing a row's fields
// removes it on save.
const LEADERBOARD_TIER_EDITOR_SCRIPT =
  "(function(){" +
  "var body=document.getElementById('lb-tier-rows');" +
  "var tpl=document.getElementById('lb-tier-template');" +
  "var add=document.getElementById('lb-tier-add');" +
  "if(!body||!tpl||!add||!('content' in tpl))return;" +
  "function reveal(el){el.querySelectorAll('.lb-tier-remove').forEach(function(b){b.hidden=false})}" +
  "add.hidden=false;reveal(body);" +
  "add.addEventListener('click',function(){" +
  "var row=tpl.content.firstElementChild.cloneNode(true);" +
  "reveal(row);body.appendChild(row);" +
  "var f=row.querySelector('input');if(f)f.focus()});" +
  "body.addEventListener('click',function(e){" +
  "var t=e.target;if(!t||!t.closest)return;" +
  "var b=t.closest('.lb-tier-remove');if(!b)return;" +
  "var row=b.closest('tr');if(row)row.remove();" +
  "add.focus()})})();";

// A stored tier above the editor's cap keeps a max that still admits it, so
// an unchanged save isn't blocked by the browser's own validation; the server
// accepts an unchanged resubmission and applies the cap only to edits.
function renderTierEditorRow(
  roles: RoleOption[],
  tier: { topN: number; roleId: string } | null,
): string {
  return `<tr>
<td><input type="number" name="topN" min="1" max="${Math.max(MAX_TIER_TOP_N, tier?.topN ?? 0)}" step="1" inputmode="numeric" aria-label="Top N" value="${tier ? tier.topN : ""}" style="width:6rem"></td>
<td><select name="roleId" aria-label="Role">${roleOptionsHtml(roles, tier?.roleId)}</select></td>
<td><button type="button" class="btn lb-tier-remove" hidden>Remove</button></td>
</tr>`;
}

const TIER_ROLE_ISSUE_LABELS = {
  everyone: "@everyone can’t be a tier role",
  managed: "managed by an integration",
  hierarchy: "above the bot’s role",
  privileged: "has powerful permissions, so it is not granted",
} as const;

function renderTierRoleIssue(tier: LeaderboardTierView): string {
  if (tier.assignable === false) {
    const label = tier.roleIssue
      ? TIER_ROLE_ISSUE_LABELS[tier.roleIssue]
      : "can’t be assigned";
    return ` <span class="tag tag-warn">${label}</span>`;
  }
  if (tier.assignable === null) {
    return ` <span class="muted">(couldn’t check whether the bot can assign it)</span>`;
  }
  return "";
}

function renderTierHolders(tier: LeaderboardTierView): string {
  if (tier.holders.length === 0) {
    return `<span class="muted">nobody yet</span>`;
  }
  return tier.holders
    .map(
      (h) =>
        `<span class="tag tag-info" title="${escapeHtml(h.id)}">${escapeHtml(h.label)}</span>`,
    )
    .join(" ");
}

export function renderLeaderboardRolesPage(
  props: LeaderboardRolesProps,
): string {
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;

  const trackingNotice = props.voiceTrackingEnabled
    ? ""
    : `<div class="notice warn" role="status">Voice tracking is off (<code>voicetracking.enabled</code>), so there is no ranking to compute tiers from and recalculation is skipped. Enable it under <a href="/admin/settings">Settings</a>.</div>`;

  const holderRows = props.tiers
    .map((t) => {
      const roleCell =
        t.roleName === null
          ? `<span class="mono">${escapeHtml(t.roleId)}</span> <span class="tag tag-warn">role not found</span>`
          : `@${escapeHtml(t.roleName)}${renderTierRoleIssue(t)}`;
      return `<tr>
<td>Top ${t.topN}</td>
<td>${roleCell}</td>
<td>${renderTierHolders(t)}</td>
<td class="muted">${escapeHtml(t.lastUpdated ?? "never")}</td>
</tr>`;
    })
    .join("");
  const holdersHtml =
    props.tiers.length === 0
      ? `<div class="empty">No tiers configured yet. Add one below.</div>`
      : `<table><thead><tr><th scope="col">Tier</th><th scope="col">Role</th><th scope="col">Current holders</th><th scope="col">Last recalculated</th></tr></thead><tbody>${holderRows}</tbody></table>
  <p class="muted">Holders are the members the bot recorded on its last recalculation, not a live read of the role.</p>`;

  const ignoredHtml =
    props.ignoredEntries.length === 0
      ? ""
      : `<div class="notice warn" role="status">The stored tiers contain entries the bot ignores: ${props.ignoredEntries
          .map((e) => `<code>${escapeHtml(e)}</code>`)
          .join(
            ", ",
          )}. They are not shown below, and saving a change removes them.</div>`;

  const editorRows = [
    ...props.tiers.map((t) => renderTierEditorRow(props.roles, t)),
    // One spare row, so a tier can be added without JavaScript.
    renderTierEditorRow(props.roles, null),
  ].join("");

  const runDisabled = !props.enabled;
  const runHint = !props.enabled
    ? "Enable <code>leaderboard_roles.enabled</code> first."
    : "Recalculates every tier now — the same run the schedule triggers, including the announcement. Concurrent runs coalesce, so this is safe during a scheduled run.";

  const body = `
<h1>Leaderboard Roles</h1>
<p class="subtitle">Reward the top voice-leaderboard members with Discord roles. Each tier gives its role to everyone ranked within its Top N.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Leaderboard roles", featureKey: "leaderboard_roles.enabled", returnTo: "/admin/leaderboard-roles", csrfToken: props.csrfToken })}
${trackingNotice}
${renderStatusLine({
  enabled: props.enabled,
  chips: [
    { text: `Period ${props.period}` },
    { text: `Schedule ${props.cron || "(unset)"}`, mono: true },
    { text: countOf(props.tiers.length, "tier") },
  ],
})}

<div class="card">
  <h2>Current holders</h2>
  ${holdersHtml}
  <form method="POST" action="/admin/leaderboard-roles/run-now" class="inline-form" style="margin-top:.75rem" data-confirm="Recalculate leaderboard roles now? Roles are granted and revoked immediately."${CONFIRM_NEUTRAL_ATTR}>
    ${csrfInput}
    <button type="submit" class="btn btn-primary"${runDisabled ? " disabled" : ""}>Run now</button>
    <span class="muted">${runHint}</span>
  </form>
</div>
<div class="card">
  <h2>Tiers</h2>
  <p class="muted">One row per tier. Top N must be unique, and each role must sit below the bot’s highest role so the bot can assign it. Clear a row to remove it.</p>
  ${
    props.settingsUnavailable
      ? // The stored tiers may not be what was read, so offering the editor
        // could overwrite them with an empty or default list.
        renderSettingsUnavailableNotice()
      : `${ignoredHtml}
  <form method="POST" action="/admin/leaderboard-roles/tiers">
    ${csrfInput}
    <table>
      <thead><tr><th scope="col">Top N</th><th scope="col">Role</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
      <tbody id="lb-tier-rows">${editorRows}</tbody>
    </table>
    <template id="lb-tier-template">${renderTierEditorRow(props.roles, null)}</template>
    <div class="actions" style="margin-top:.75rem">
      <button type="button" class="btn" id="lb-tier-add" hidden>Add tier</button>
      <button type="submit" class="btn btn-primary">Save tiers</button>
    </div>
  </form>`
  }
</div>
${renderFeatureSettingsCard({
  intro:
    "Change leaderboard role settings here without leaving the page. Saved through the shared settings route.",
  category: "leaderboard_roles",
  settingRows: props.settingRows,
  pickers: props.pickers,
  returnTo: "/admin/leaderboard-roles",
  csrfToken: props.csrfToken,
  dependencyState: props.dependencyState,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
})}
${scriptTag(LEADERBOARD_TIER_EDITOR_SCRIPT)}
`;
  return renderAdminPage({
    title: "Leaderboard Roles",
    active: "/admin/leaderboard-roles",
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
  /** Discord type of the channel; null when it no longer resolves. */
  channelType: ChannelType | null;
  /** Voice room name stored with the row (#1420); shown when the room is gone. */
  channelStoredName: string | null;
  result: "success" | "error" | "denied";
  errorMessage: string | null;
  durationMs: number;
}

export interface CommandAuditProps extends CommonProps {
  enabled: boolean;
  retentionDays: number;
  /**
   * The command / WebUI audit settings edited in place on this page (#978)
   * through {@link renderFeatureSettingsCard}.
   */
  settingRows: SettingRow[];
  /** The stored config could not be read; the card shows a notice instead. */
  settingsUnavailable?: boolean;
  flash?: FlashMessage | null;
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
      const shown = c.startsWith("component:") ? c : `/${c}`;
      return `<option value="${escapeHtml(c)}"${sel}>${escapeHtml(shown)}</option>`;
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
<th scope="col">When</th><th scope="col">User</th><th scope="col">Command</th><th scope="col">Channel</th>
<th scope="col">Result</th><th scope="col">Duration</th><th scope="col">Error</th>
</tr></thead>
<tbody>${props.rows
          .map((r) => {
            // Component rows (#1147) are not slash commands: no leading "/".
            const lead = r.commandName.startsWith("component:") ? "" : "/";
            const cmd = r.subcommand
              ? `${lead}${escapeHtml(r.commandName)} ${escapeHtml(r.subcommand)}`
              : `${lead}${escapeHtml(r.commandName)}`;
            return `<tr>
<td class="muted mono">${escapeHtml(r.createdAt)}</td>
<td title="${escapeHtml(r.discordUserId)}">${escapeHtml(r.userLabel)}</td>
<td class="mono">${cmd}</td>
<td class="muted">${r.channelId ? channelMention({ name: r.channelLabel ?? r.channelId, type: r.channelType, storedName: r.channelStoredName }) : "—"}</td>
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
<p class="subtitle">One row per Discord slash-command invocation, and per button, select-menu or modal interaction (listed as <code>component:&hellip;</code>). Raw command arguments, custom ids and submitted text are deliberately omitted.</p>
${renderPageFlash(props.flash)}

${renderStatusLine({
  enabled: props.enabled,
  onLabel: "Logging on",
  offLabel: "Logging off",
  chips: [
    { text: `Kept for ${countOf(props.retentionDays, "day")}` },
    { text: `${countOf(props.total, "row")} matched` },
  ],
})}
${props.enabled ? "" : `<p class="muted">Enable <code>core.command_audit.enabled</code> ${props.settingsUnavailable ? "once settings can be loaded again" : "in the settings below"} to start recording.</p>`}


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
${renderFeatureSettingsCard({
  intro:
    "Change audit logging and retention here without leaving the page. Saved through the shared settings route.",
  category: "core",
  settingRows: props.settingRows,
  returnTo: "/admin/audit/commands",
  csrfToken: props.csrfToken,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
})}
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

// ---------- Moderation log (issue #728) ----------

export interface ModerationRow {
  /** The log row's id; the "Open case" form posts it (#908). */
  entryId: string;
  /** The case opened against this row, if any. */
  caseId?: string | null;
  caseNumber: number | null;
  caseStatus: string | null;
  createdAt: string;
  userId: string;
  userLabel: string;
  moderatorId: string | null;
  moderatorLabel: string | null;
  action: ModerationAction;
  reason: string | null;
  source: ModerationSource;
}

export interface ModerationProps extends CommonProps {
  enabled: boolean;
  /** All action types — populates the filter dropdown. */
  actionOptions: readonly ModerationAction[];
  /** Distinct target user IDs on the current page — populates the user filter. */
  userOptions: Array<{ id: string; label: string }>;
  filters: {
    action: string;
    userId: string;
  };
  rows: ModerationRow[];
  total: number;
  page: number;
  pageSize: number;
  /** `moderation.cases.enabled` (and the master) — gates the whole section. */
  casesEnabled?: boolean;
  /** Pre-filled review window on the "Open case" and decision forms. */
  defaultReviewDays?: number;
  /** The review queue; null when cases are off or it could not be read. */
  caseGroups?: CaseGroups | null;
  /**
   * The moderation keys, edited in place on this page (#977) through
   * {@link renderFeatureSettingsCard}: the `moderation.*` master and
   * retention, plus the `core.moderation.*` Discord log channel.
   */
  settingRows?: SettingRow[];
  /** Channel list backing the `core.moderation.channel_id` picker. */
  pickers?: FeatureSettingsPickers;
  /** On/off state of off-card dependencies of {@link settingRows}. */
  dependencyState?: ReadonlyMap<string, boolean>;
  /** The stored config could not be read; the card renders a notice. */
  settingsUnavailable?: boolean;
  flash?: FlashMessage | null;
}

/** Display words for log actions; shared with Discord (`utils/moderation-labels.ts`). */
export const MODERATION_ACTION_LABELS: Record<string, string> = ACTION_WORDS;

function moderationActionTag(action: ModerationAction): string {
  const label = MODERATION_ACTION_LABELS[action] ?? action;
  // Warns/timeouts are cautionary (amber), kicks/bans are severe (red), and the
  // "undo" actions (unban / untimeout) read as positive (green).
  const cls =
    action === "unban" || action === "untimeout" || action === "raid_clear"
      ? "tag-on"
      : action === "ban" || action === "kick" || action === "raid_lockdown"
        ? "tag-off"
        : "tag-warn";
  return `<span class="tag ${cls}">${escapeHtml(label)}</span>`;
}

function buildModerationQueryString(
  filters: ModerationProps["filters"],
  page: number,
): string {
  const parts: string[] = [];
  if (filters.action)
    parts.push(`action=${encodeURIComponent(filters.action)}`);
  if (filters.userId) parts.push(`user=${encodeURIComponent(filters.userId)}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** Display words for case states (stored values are unchanged). */
export const CASE_STATUS_LABELS: Record<string, string> = CASE_STATUS_WORDS;

/** Display words for the decision recorded on a case event. */
export const CASE_OUTCOME_LABELS: Record<string, string> = CASE_OUTCOME_WORDS;

function caseStatusTag(status: string): string {
  const cls =
    status === "under_review"
      ? "tag-warn"
      : status === "lifted"
        ? "tag-on"
        : status === "upheld"
          ? "tag-off"
          : "tag-off";
  return `<span class="tag ${cls}">${escapeHtml(CASE_STATUS_LABELS[status] ?? status)}</span>`;
}

/** The Case column: the case's number and status, or a form to open one. */
function renderRowCaseCell(row: ModerationRow, props: ModerationProps): string {
  if (row.caseNumber !== null) {
    return `#${row.caseNumber} ${caseStatusTag(row.caseStatus ?? "open")}`;
  }
  if (row.action !== "kick" && row.action !== "ban") {
    return '<span class="muted">—</span>';
  }
  return `<details class="helper edit-details"><summary>Open case</summary>
    <form method="POST" action="/admin/moderation/cases/open" class="stack">
      <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
      <input type="hidden" name="entry_id" value="${escapeHtml(row.entryId)}">
      <label>Review in (days)<input type="number" name="review_in_days" min="1" max="3650" value="${props.defaultReviewDays ?? 90}"></label>
      <p class="muted">Clear the days for a case with no review date.</p>
      <label>Note<input type="text" name="note" maxlength="500"></label>
      <button type="submit" class="btn btn-primary btn-sm">Open case</button>
    </form>
  </details>`;
}

function renderCaseHistory(c: CaseView): string {
  if (c.history.length === 0) {
    return '<p class="muted">No earlier actions on file.</p>';
  }
  const items = c.history
    .map(
      (h) =>
        `<li><span class="mono muted">${escapeHtml(h.createdAt.slice(0, 10))}</span> ${moderationActionTag(h.action)} ${
          h.reason
            ? escapeHtml(h.reason.slice(0, 200))
            : '<span class="muted">no reason</span>'
        }</li>`,
    )
    .join("");
  return `<ul class="muted">${items}</ul>`;
}

function renderCaseEvents(c: CaseView): string {
  return `<ul class="muted">${c.events
    .map((e) => {
      const what = e.outcome
        ? escapeHtml(CASE_OUTCOME_LABELS[e.outcome] ?? e.outcome)
        : e.to === "under_review"
          ? "marked as needing a decision"
          : "opened";
      return `<li><span class="mono">${escapeHtml(e.at.slice(0, 10))}</span> ${what} by ${escapeHtml(e.byLabel)}${
        e.note && e.note !== REVIEW_JOB_NOTE ? ` — ${escapeHtml(e.note)}` : ""
      }</li>`;
    })
    .join("")}</ul>`;
}

function renderCaseActions(c: CaseView, props: ModerationProps): string {
  const base = `/admin/moderation/cases/${encodeURIComponent(c.id)}`;
  const days = props.defaultReviewDays ?? 90;
  return `<form method="POST" action="${base}/uphold" class="stack">
      <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
      <label>Next review in (days)<input type="number" name="next_review_in_days" min="1" max="3650" value="${days}"></label>
      <label>Note<input type="text" name="note" maxlength="500"></label>
      <div class="inline-form">
        <button type="submit" class="btn btn-sm">${DECISION_LABELS.uphold}</button>
        <button type="submit" class="btn btn-sm" formaction="${base}/extend">${DECISION_LABELS.extend}</button>
        <button type="submit" class="btn btn-sm btn-danger" formaction="${base}/permanent" data-confirm="${escapeHtml(DECISION_CONFIRM_TEXT.permanent ?? "")}"${confirmListAttr(
          PERMANENT_CONFIRM_ITEMS,
        )}>${DECISION_LABELS.permanent}</button>
        <button type="submit" class="btn btn-primary btn-sm" formaction="${base}/readmit" data-confirm="${escapeHtml(DECISION_CONFIRM_TEXT.readmit ?? "")}"${CONFIRM_NEUTRAL_ATTR}>${DECISION_LABELS.readmit}</button>
      </div>
      <p class="muted">${DECISION_LABELS.uphold}: the member stays out and the next review is set (clear the days for none). ${DECISION_LABELS.extend}: needs a new date. ${DECISION_LABELS.permanent}: closes the case with no more reviews. ${DECISION_LABELS.readmit}: records the decision only; lift the ban in Discord yourself.</p>
    </form>`;
}

function renderCaseCard(c: CaseView, props: ModerationProps): string {
  const review = c.reviewAt
    ? `review ${escapeHtml(c.reviewAt.slice(0, 10))}`
    : "no review date";
  return `<div class="card">
  <h3>Case #${c.caseNumber} · <span title="${escapeHtml(c.userId)}">${escapeHtml(c.userLabel)}</span> ${moderationActionTag(c.action)} ${caseStatusTag(c.status)}</h3>
  <p class="muted">${c.live ? review : `closed ${escapeHtml(c.events[c.events.length - 1]?.at.slice(0, 10) ?? "")}`} · opened ${escapeHtml(c.openedAt.slice(0, 10))} by ${escapeHtml(c.openedByLabel)}${
    c.originModeratorLabel
      ? ` · action by ${escapeHtml(c.originModeratorLabel)}`
      : ""
  }</p>
  <p>${c.reason ? escapeHtml(c.reason.slice(0, 300)) : '<span class="muted">No reason recorded.</span>'}</p>
  <details class="helper" ${c.live ? "open" : ""}><summary>Earlier actions</summary>${renderCaseHistory(c)}</details>
  <details class="helper"><summary>Decisions</summary>${renderCaseEvents(c)}</details>
  ${c.live ? renderCaseActions(c, props) : ""}
</div>`;
}

function renderCaseGroup(
  title: string,
  empty: string,
  cases: CaseView[],
  props: ModerationProps,
): string {
  return `<h3>${escapeHtml(title)} (${cases.length})</h3>${
    cases.length === 0
      ? `<div class="empty">${escapeHtml(empty)}</div>`
      : cases.map((c) => renderCaseCard(c, props)).join("")
  }`;
}

/** The Cases section: the review queue, grouped. Empty string when off. */
function renderCasesSection(props: ModerationProps): string {
  if (!props.casesEnabled) return "";
  const groups = props.caseGroups;
  const body = groups
    ? `${renderCaseGroup("Needs a decision", "No case is waiting for a decision.", groups.overdue, props)}
${renderCaseGroup("Review in the next 7 days", "No review date falls in the next 7 days.", groups.dueSoon, props)}
${renderCaseGroup("Review later", "No open case has a review date more than 7 days away.", groups.scheduled, props)}
${renderCaseGroup("No review date", "No open case is without a review date.", groups.indefinite, props)}
${renderCaseGroup("Closed in the last 30 days", "No case was closed in the last 30 days.", groups.recentlyResolved, props)}`
    : '<div class="notice">The case queue could not be read. Check the bot\'s logs and reload the page.</div>';
  return `<div class="card">
  <h2>Cases</h2>
  <p class="subtitle">A case adds a review date to a kick or ban and records what staff decided once the review date passed. Staff always make the decision. Open a case from the <strong>Case</strong> column of the log below.</p>
  <form method="POST" action="/admin/moderation/cases/run-review" class="inline-form" data-confirm="Mark every case whose review date has passed as needing a decision now?"${CONFIRM_NEUTRAL_ATTR}>
    <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
    <button type="submit" class="btn btn-sm">Check review dates now</button>
  </form>
  ${body}
</div>`;
}

export function renderModerationPage(props: ModerationProps): string {
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  const page = Math.min(Math.max(1, props.page), totalPages);

  const actionOptionsHtml = props.actionOptions
    .map((a) => {
      const sel = a === props.filters.action ? " selected" : "";
      return `<option value="${escapeHtml(a)}"${sel}>${escapeHtml(
        MODERATION_ACTION_LABELS[a] ?? a,
      )}</option>`;
    })
    .join("");
  const userOptionsHtml = props.userOptions
    .map((u) => {
      const sel = u.id === props.filters.userId ? " selected" : "";
      return `<option value="${escapeHtml(u.id)}"${sel}>${escapeHtml(u.label)}</option>`;
    })
    .join("");

  const rowsHtml =
    props.rows.length === 0
      ? `<div class="empty">No moderation actions match the current filters.</div>`
      : `<table>
<thead><tr>
<th scope="col">When</th><th scope="col">User</th><th scope="col">Action</th><th scope="col">Moderator</th>
<th scope="col">Reason</th><th scope="col">Source</th>${props.casesEnabled ? '<th scope="col">Case</th>' : ""}
</tr></thead>
<tbody>${props.rows
          .map((r) => {
            const moderator = r.moderatorId
              ? `<span title="${escapeHtml(r.moderatorId)}">${escapeHtml(
                  r.moderatorLabel ?? r.moderatorId,
                )}</span>`
              : '<span class="muted">Unknown</span>';
            return `<tr>
<td class="muted mono">${escapeHtml(r.createdAt)}</td>
<td title="${escapeHtml(r.userId)}">${escapeHtml(r.userLabel)}</td>
<td>${moderationActionTag(r.action)}</td>
<td>${moderator}</td>
<td class="muted">${r.reason ? escapeHtml(r.reason.slice(0, 200)) : "—"}</td>
<td class="muted">${escapeHtml(r.source)}</td>
${props.casesEnabled ? `<td>${renderRowCaseCell(r, props)}</td>` : ""}
</tr>`;
          })
          .join("")}</tbody></table>`;

  const prevLink =
    page > 1
      ? `<a class="btn btn-sm" href="/admin/moderation${buildModerationQueryString(props.filters, page - 1)}">← Prev</a>`
      : `<button class="btn btn-sm" disabled>← Prev</button>`;
  const nextLink =
    page < totalPages
      ? `<a class="btn btn-sm" href="/admin/moderation${buildModerationQueryString(props.filters, page + 1)}">Next →</a>`
      : `<button class="btn btn-sm" disabled>Next →</button>`;

  const body = `
<h1>Moderation log</h1>
<p class="subtitle">Actions recorded via <code>/warn</code>, <code>/timeout</code> and <code>/ban</code> plus kicks, bans and timeouts made in Discord itself, copied in from the server's audit log. Query per-member history in Discord with <code>/modlog</code>.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Moderation", featureKey: "moderation.enabled", returnTo: "/admin/moderation", csrfToken: props.csrfToken })}

${renderStatusLine({
  enabled: props.enabled,
  onLabel: "Log on",
  offLabel: "Log off",
  chips: [{ text: `${countOf(props.total, "action")} matched` }],
})}
<p class="muted">Actions made in Discord itself need the bot to have the <strong>View Audit Log</strong> permission.</p>


${renderCasesSection(props)}

<div class="card">
  <h2>Filters</h2>
  <form method="GET" action="/admin/moderation" class="inline-form">
    <label>Action
      <select name="action">
        <option value="">— any —</option>
        ${actionOptionsHtml}
      </select>
    </label>
    <label>User
      <select name="user">
        <option value="">— any —</option>
        ${userOptionsHtml}
      </select>
    </label>
    <button type="submit" class="btn btn-primary btn-sm">Apply</button>
    <a class="btn btn-sm" href="/admin/moderation">Reset</a>
  </form>
</div>

<div class="card">
  <h2>Actions (page ${page} of ${totalPages})</h2>
  ${rowsHtml}
  <div class="inline-form" style="margin-top:.75rem">
    ${prevLink}
    ${nextLink}
    <span class="muted">${props.pageSize} per page</span>
  </div>
</div>
${renderFeatureSettingsCard({
  intro:
    "Change moderation-log settings here without leaving the page, including the Discord channel moderation actions are logged to. Saved through the shared settings route.",
  category: "moderation",
  settingRows: props.settingRows ?? [],
  pickers: props.pickers,
  returnTo: "/admin/moderation",
  csrfToken: props.csrfToken,
  dependencyState: props.dependencyState,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
})}
`;
  return renderAdminPage({
    title: "Moderation log",
    active: "/admin/moderation",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

// ---------- Support tickets (issue #1004) ----------

export interface TicketRow {
  id: string;
  createdAt: string;
  authorId: string;
  authorLabel: string;
  channelId: string;
  subject: string;
  status: TicketStatus;
  claimedByLabel: string | null;
  closedByLabel: string | null;
  closedAt: string | null;
}

export interface TicketsProps extends CommonProps {
  enabled: boolean;
  /** `""` shows every status. */
  statusFilter: string;
  statusOptions: readonly TicketStatus[];
  rows: TicketRow[];
  total: number;
  page: number;
  pageSize: number;
  settingRows?: SettingRow[];
  pickers?: FeatureSettingsPickers;
  dependencyState?: ReadonlyMap<string, boolean>;
  settingsUnavailable?: boolean;
  flash?: FlashMessage | null;
}

function ticketStatusTag(status: TicketStatus): string {
  const cls =
    status === "closed"
      ? "tag-off"
      : status === "claimed"
        ? "tag-on"
        : "tag-warn";
  return `<span class="tag ${cls}">${escapeHtml(status)}</span>`;
}

function buildTicketsQueryString(statusFilter: string, page: number): string {
  const parts: string[] = [];
  if (statusFilter) parts.push(`status=${encodeURIComponent(statusFilter)}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export function renderTicketsPage(props: TicketsProps): string {
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  const page = Math.min(Math.max(1, props.page), totalPages);
  // Opening a ticket needs the staff role (`no-staff-role` otherwise), so a
  // missing one keeps the settings open (#1301).
  const staffRoleMissing = (props.settingRows ?? []).some(
    (r) =>
      r.key === "tickets.staff_role_id" &&
      String(r.current ?? "").trim() === "",
  );
  const csrfInput = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;

  const statusOptionsHtml = props.statusOptions
    .map(
      (st) =>
        `<option value="${escapeHtml(st)}"${st === props.statusFilter ? " selected" : ""}>${escapeHtml(st)}</option>`,
    )
    .join("");

  const action = (
    t: TicketRow,
    verb: "claim" | "close" | "reopen",
    label: string,
    cls: string,
  ): string =>
    `<form method="POST" action="/admin/tickets/${escapeHtml(t.id)}/${verb}" class="inline-form">${csrfInput}<button type="submit" class="btn btn-sm ${cls}" aria-label="${escapeHtml(label)} ticket ${escapeHtml(t.id)}">${escapeHtml(label)}</button></form>`;

  const rowsHtml =
    props.rows.length === 0
      ? `<div class="empty">No tickets match the current filter.</div>`
      : `<table>
<thead><tr>
<th scope="col">Opened</th><th scope="col">Member</th><th scope="col">Subject</th><th scope="col">Status</th>
<th scope="col">Handled by</th><th scope="col">Actions</th>
</tr></thead>
<tbody>${props.rows
          .map((t) => {
            const handled = [
              t.claimedByLabel
                ? `Claimed: ${escapeHtml(t.claimedByLabel)}`
                : "",
              t.closedByLabel ? `Closed: ${escapeHtml(t.closedByLabel)}` : "",
            ]
              .filter(Boolean)
              .join("<br>");
            const actions =
              t.status === "closed"
                ? action(t, "reopen", "Reopen", "")
                : [
                    t.status === "open" ? action(t, "claim", "Claim", "") : "",
                    action(t, "close", "Close", "btn-danger"),
                  ].join(" ");
            return `<tr>
<td class="muted mono">${escapeHtml(t.createdAt)}</td>
<td title="${escapeHtml(t.authorId)}">${escapeHtml(t.authorLabel)}</td>
<td>${escapeHtml(t.subject)}<div class="muted mono">id: ${escapeHtml(t.id)} · channel: ${escapeHtml(t.channelId)}</div></td>
<td>${ticketStatusTag(t.status)}</td>
<td class="muted">${handled || "—"}</td>
<td class="actions">${actions}</td>
</tr>`;
          })
          .join("")}</tbody></table>`;

  const prevLink =
    page > 1
      ? `<a class="btn btn-sm" href="/admin/tickets${buildTicketsQueryString(props.statusFilter, page - 1)}">← Prev</a>`
      : `<button class="btn btn-sm" disabled>← Prev</button>`;
  const nextLink =
    page < totalPages
      ? `<a class="btn btn-sm" href="/admin/tickets${buildTicketsQueryString(props.statusFilter, page + 1)}">Next →</a>`
      : `<button class="btn btn-sm" disabled>Next →</button>`;

  const body = `
<h1>Support tickets</h1>
<p class="subtitle">Private help channels members open with <code>/ticket open</code>. Closing archives the channel (locked, never deleted); reopen restores it.</p>
${renderPageFlash(props.flash)}
${renderFeatureDisabledNotice({ enabled: props.enabled, label: "Tickets", featureKey: "tickets.enabled", returnTo: "/admin/tickets", csrfToken: props.csrfToken })}

${renderStatusLine({
  enabled: props.enabled,
  chips: [
    ...(staffRoleMissing
      ? [
          {
            text: "No staff role: members cannot open tickets",
            warn: true,
            href: props.settingsUnavailable
              ? undefined
              : settingHref("tickets.staff_role_id"),
          },
        ]
      : []),
    { text: `${countOf(props.total, "ticket")} matched` },
  ],
})}
<p class="muted">The bot needs <strong>Manage Channels</strong> and <strong>Manage Roles</strong> (to set the private permissions) and, for a category, access to it.</p>


<div class="card">
  <h2>Filter</h2>
  <form method="GET" action="/admin/tickets" class="inline-form">
    <label>Status
      <select name="status">
        <option value="">— any —</option>
        ${statusOptionsHtml}
      </select>
    </label>
    <button type="submit" class="btn btn-primary btn-sm">Apply</button>
    <a class="btn btn-sm" href="/admin/tickets">Reset</a>
  </form>
</div>

<div class="card">
  <h2>Tickets (page ${page} of ${totalPages})</h2>
  ${rowsHtml}
  <div class="inline-form" style="margin-top:.75rem">
    ${prevLink}
    ${nextLink}
    <span class="muted">${props.pageSize} per page</span>
  </div>
</div>
${renderFeatureSettingsCard({
  intro:
    "Choose the staff role and category, and whether a transcript is saved when a ticket closes. Saved through the shared settings route.",
  category: "tickets",
  settingRows: props.settingRows ?? [],
  pickers: props.pickers,
  returnTo: "/admin/tickets",
  csrfToken: props.csrfToken,
  dependencyState: props.dependencyState,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  needsSetup: staffRoleMissing,
  flash: props.flash,
})}
`;
  return renderAdminPage({
    title: "Support tickets",
    active: "/admin/tickets",
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
  /**
   * The metrics-persistence settings edited in place on this page (#978)
   * through {@link renderFeatureSettingsCard}.
   */
  settingRows: SettingRow[];
  /** The stored config could not be read; the card shows a notice instead. */
  settingsUnavailable?: boolean;
  flash?: FlashMessage | null;
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
<th scope="col">Command</th><th scope="col">Invocations</th><th scope="col">Error rate</th><th scope="col">Avg response</th><th scope="col">Last used</th>
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
<thead><tr><th scope="col">Command</th><th scope="col">Error rate</th><th scope="col">Errors</th><th scope="col">Invocations</th></tr></thead>
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
<thead><tr><th scope="col">Command</th><th scope="col">Avg response</th><th scope="col">Invocations</th></tr></thead>
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
<span style="flex:1;background:var(--heat-empty);border-radius:4px;overflow:hidden">
  <span style="display:block;height:1rem;width:${pct.toFixed(1)}%;background:var(--embed-brand)"></span>
</span>
<span class="mono" style="min-width:3rem;text-align:right">${d.usageCount}</span>
</div>`;
          })
          .join("");

  const body = `
<h1>Command metrics</h1>
<p class="subtitle">Historical per-command usage, error rate, and latency persisted to MongoDB. Complements the live in-memory view and the Prometheus <code>/metrics</code> endpoint.</p>
${renderPageFlash(props.flash)}

${renderStatusLine({
  enabled: props.enabled,
  onLabel: "Recording on",
  offLabel: "Recording off",
  chips: [
    { text: `Kept for ${countOf(props.retentionDays, "day")}` },
    {
      text: `${countOf(props.totalUsage, "invocation")} in ${props.windowDays} days`,
    },
    { text: `${countOf(props.totalErrors, "error")}` },
  ],
})}
${props.enabled ? "" : `<p class="muted">Enable <code>monitoring.metrics_persistence.enabled</code> ${props.settingsUnavailable ? "once settings can be loaded again" : "in the settings below"} to start recording. Counts already shown were captured before it was disabled.</p>`}


<div class="card">
  <h2>Commands by usage</h2>
  <p class="inline-form"><span class="muted">Window</span> ${windowToggle}</p>
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
${renderFeatureSettingsCard({
  intro:
    "Change metrics persistence and retention here without leaving the page. Saved through the shared settings route.",
  category: "core",
  settingRows: props.settingRows,
  returnTo: "/admin/metrics",
  csrfToken: props.csrfToken,
  unavailable: props.settingsUnavailable,
  enabled: props.enabled,
  flash: props.flash,
})}
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

  let grid: string;
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

    // The cells are non-focusable and their only data carrier is `title`
    // (mouse-hover only). The weekday and hour bar lists below repeat every
    // marginal as text and "Busiest slot" is stated in prose, so the grid is
    // exposed as one image with a label pointing there (#855).
    const peakText = heatmap.peak
      ? ` Busiest slot: ${DAY_NAMES[heatmap.peak.day]} at ${formatHourLabel(heatmap.peak.hour)}.`
      : "";
    grid = `<div class="heatgrid" role="img" aria-label="${escapeHtml(`Voice activity heatmap by weekday and hour of day.${peakText} Per-weekday and per-hour totals are listed below.`)}">${header}${rows}</div>`;
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
