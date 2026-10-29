/**
 * Body of the host panel's "Live settings" section and its confirmation page
 * (#1239).
 *
 * One plain server-rendered form, no page script: every editable field posts
 * its new value (`s_<row>`) together with the value the page showed
 * (`b_<row>`), so the server can tell what the host changed from what someone
 * else changed meanwhile (see `services/event-live-edit.ts`, rule 3). A field
 * that cannot be edited now is shown as text with the reason and is not part
 * of the form. Everything dynamic goes through `escapeHtml`.
 */

import { escapeHtml, scriptTag } from "./html.js";
import { renderDurationPresets } from "./setting-pickers.js";
import { renderSaveBar } from "./savebar.js";
import {
  LEAD_PRESETS,
  LEAD_PRESET_FIELD,
  LEAD_ROW_ID,
  hidden,
  renderSettingRow,
} from "./host-settings-rows.js";
import { CONFIRM_FETCH_SCRIPT, CONFIRM_PAGE_MARKER } from "./confirm-fetch.js";
import { renderSeriesTick } from "./host-settings-series.js";
import { groupRowsScript } from "./event-group-form.js";
import {
  CHANNEL_LEAD_MAX,
  CHANNEL_LEAD_MIN,
} from "../services/event-groups.js";
import { baseField, valueField } from "../services/event-live-edit.js";
import {
  renderGroupEditor,
  renderGroupSetForms,
  renderPresetForm,
  type GroupEditViewData,
} from "./host-settings-groups.js";
import {
  renderGroupsSwitchForms,
  showsCustomRows,
  type GroupsSwitchView,
} from "./host-settings-groups-switch.js";
import {
  renderLeadersTagsFields,
  type LeadersTagsView,
} from "./host-settings-leaders-tags-view.js";

export interface SettingsGroupView {
  name: string;
  marker: string;
  size: number | null;
  memberCount: number;
  /** Derived (members above size), never stored. */
  overSize: boolean;
}

export interface LeaderEditView {
  /** ISO time of the edit. */
  at: string;
  who: string;
  text: string;
}

/** The leader label rename and the last edits leaders made from Discord (#1195, #1196). */
export interface LeaderExtrasView {
  /** What leaders are called ("Leader", "Captain"). */
  leaderLabel: string;
  edits: LeaderEditView[];
}

export interface SettingsViewData {
  csrfToken: string;
  actionPath: (name: string) => string;
  /** Why nothing can be edited right now (events off, event unreadable); null = editable. */
  blocker: string | null;
  /** Stored lead time in minutes; null = the server default. */
  leadMinutes: number | null;
  /** Reason the lead time is read-only, or null while it can be edited. */
  leadReadOnly: string | null;
  groupLabel: string;
  groups: SettingsGroupView[];
  /** Names, sizes and the preset switch (#1241); absent = the read-only table. */
  groupEdit?: GroupEditViewData;
  /** Leaders and tags fields (#1240); null when the event has no groups. */
  leadersTags?: LeadersTagsView | null;
  /** The groups on/off forms (#1243); absent = none shown. */
  groupsSwitch?: GroupsSwitchView;
  /** What the host can still do about leaders from here (#1424); absent = nothing shown. */
  leaderExtras?: LeaderExtrasView;
  /** The event repeats: its forms carry the "also for the next occurrences" tick (#1266). */
  seriesTick?: boolean;
}

function leadText(minutes: number | null): string {
  return minutes === null
    ? "the server default"
    : `${minutes} minutes before the start`;
}

/**
 * The channel creation time as a SettingRow: duration presets, a server-default
 * choice and a bounded box under Custom (#1514). Read-only once the channels
 * exist, with the reason.
 */
function renderLead(d: SettingsViewData): string {
  if (d.leadReadOnly !== null) {
    return renderSettingRow({
      id: "host-settings-lead",
      name: "Channel creation time",
      line: d.leadReadOnly,
      control: `<span>${escapeHtml(leadText(d.leadMinutes))}</span>`,
    });
  }
  const base = d.leadMinutes === null ? "" : String(d.leadMinutes);
  return renderSettingRow({
    id: "host-settings-lead",
    name: "Channel creation time",
    line: "How long before the start the event's channels are made. It can only change before they exist.",
    fields: hidden(baseField(LEAD_ROW_ID), base),
    control: renderDurationPresets(
      LEAD_PRESET_FIELD,
      valueField(LEAD_ROW_ID),
      base,
      LEAD_PRESETS,
      { min: CHANNEL_LEAD_MIN, max: CHANNEL_LEAD_MAX },
      {
        id: "host-settings-lead-input",
        labelledBy: "host-settings-lead-name",
        describedBy: "host-settings-lead-desc",
        label: "channel creation time",
        unit: "minutes",
        zeroLabel: "At the start",
        emptyLabel: "Server default",
      },
    ),
  });
}

function renderGroups(d: SettingsViewData): string {
  if (d.groups.length === 0) return "";
  const body = d.groups
    .map(
      (g) =>
        `<tr><td>${g.marker ? `${escapeHtml(g.marker)} ` : ""}${escapeHtml(g.name)}</td>` +
        `<td>${g.size === null ? '<span class="muted">No limit</span>' : escapeHtml(g.size)}</td>` +
        `<td><span class="mono">${escapeHtml(g.memberCount)}</span>${g.overSize ? ' <span class="tag tag-off">over size</span>' : ""}</td></tr>`,
    )
    .join("");
  return `<table class="prefs-table"><thead><tr><th scope="col">${escapeHtml(d.groupLabel)}</th><th scope="col">Size</th><th scope="col">People</th></tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * What leaders changed from Discord. The leader label is renamed in the settings
 * form, so there is one place for it (#1514); this is only the log.
 */
function renderLeaderExtras(d: SettingsViewData): string {
  const x = d.leaderExtras;
  if (!x) return "";
  const lead = x.leaderLabel.toLowerCase();
  const edits =
    x.edits.length === 0
      ? `<p class="kb-help">No ${escapeHtml(lead)} has changed a team yet.</p>`
      : `<table class="kb-table"><caption class="kb-visually-hidden">Recent changes by ${escapeHtml(lead)}s</caption><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Change</th></tr></thead><tbody>${x.edits
          .map(
            (e) =>
              `<tr><td><span class="kb-mono">${escapeHtml(e.at)}</span></td><td>${escapeHtml(e.who)}</td><td>${escapeHtml(e.text)}</td></tr>`,
          )
          .join("")}</tbody></table>`;
  return `<div class="kb-stack" id="host-leaders-extras">
<h3 class="kb-label">Recent changes by ${escapeHtml(lead)}s</h3>
${edits}
</div>`;
}

/**
 * The "Event settings" fold (#1424): lead time, group leaders and clan tags
 * (children nested), the leader label and what leaders changed. One form that
 * posts to `settings`; it carries only these rows, and a row that is not posted
 * is left alone by `parseSubmission`.
 */
export function renderEventSettings(d: SettingsViewData): string {
  if (d.blocker !== null) {
    return `<div class="notice warn" role="status"><p>${escapeHtml(d.blocker)}</p></div>`;
  }
  const lead = `<div class="kb-settings__group"><p class="kb-overline">Channels</p>
${renderLead(d)}
</div>`;
  return `<form method="POST" action="${escapeHtml(d.actionPath("settings"))}" class="kb-stack" id="host-settings-form">${hidden("_csrf", d.csrfToken)}
<div class="kb-settings">
${lead}
${renderLeadersTagsFields(d.leadersTags ?? null)}
</div>
${renderSeriesTick(d.seriesTick)}
${renderSaveBar("Save settings", "Event settings")}
</form>
${renderLeaderExtras(d)}`;
}

/**
 * The "Change the groups" fold (#1424): names and sizes, switch preset, add and
 * remove groups, and switch groups on or off. Each is a form of its own that
 * posts to `settings`, so none of them shares a save with the rows of "Event
 * settings". Emits the confirm script once for the whole page.
 */
export function renderGroupChanges(d: SettingsViewData): string {
  if (d.blocker !== null) {
    return `<div class="notice warn" role="status"><p>${escapeHtml(d.blocker)}</p></div>${renderGroups(d)}`;
  }
  const names = d.groupEdit
    ? `<form method="POST" action="${escapeHtml(d.actionPath("settings"))}">${hidden("_csrf", d.csrfToken)}
${renderGroupEditor(d.groupEdit)}
${renderSeriesTick(d.seriesTick)}
<button type="submit" class="kb-btn">Save groups</button>
</form>`
    : "";
  return `${names}
${d.groupEdit ? renderPresetForm(d.groupEdit, d.actionPath("settings"), d.csrfToken, d.seriesTick) : renderGroups(d)}
${d.groupEdit ? renderGroupSetForms(d.groupEdit, d.actionPath("settings"), d.csrfToken, d.seriesTick) : ""}
${d.groupsSwitch ? renderGroupsSwitchForms(d.groupsSwitch, d.actionPath("settings"), d.csrfToken, d.seriesTick) : ""}
${scriptTag(CONFIRM_FETCH_SCRIPT)}
${d.groupEdit || (d.groupsSwitch && showsCustomRows(d.groupsSwitch)) ? scriptTag(groupRowsScript()) : ""}`;
}

export interface ConfirmChangeView {
  label: string;
  /** Plain text; escaped here. */
  from: string;
  to: string;
}

export interface ConfirmViewData {
  csrfToken: string;
  actionPath: string;
  panelPath: string;
  token: string;
  changes: ConfirmChangeView[];
  reasons: string[];
}

export interface ResultViewData {
  ok: boolean;
  /** Plain text; escaped here. */
  message: string;
  panelPath: string;
}

/**
 * The full result of a save, for a result too long for the flash line (which
 * is cut at 500 characters, and would hide which channels are unfinished and
 * when to retry). One paragraph per sentence of the result, escaped.
 */
export function renderResultBody(d: ResultViewData): string {
  const parts = d.message
    .split(/(?<=\.) (?=[A-Z])/)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
  return `<section class="card" id="host-settings-result" aria-labelledby="host-settings-result-h">
<h2 id="host-settings-result-h">${d.ok ? "Settings saved" : "Settings saved, with something left to do"}</h2>
<div class="notice ${d.ok ? "ok" : "warn"}" role="status">${parts}</div>
<p><a href="${escapeHtml(d.panelPath)}">Back to the host panel</a></p>
</section>`;
}

/** The confirmation page body: what will change, why it needs a yes, and the signed token. */
export function renderConfirmBody(d: ConfirmViewData): string {
  const changes = d.changes
    .map(
      (c) =>
        `<li><strong>${escapeHtml(c.label)}</strong>: ${escapeHtml(c.from)} to ${escapeHtml(c.to)}</li>`,
    )
    .join("");
  const reasons = d.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  // The markers are what the panel's fetch-and-upgrade reads (`confirm-fetch.ts`, #1344).
  return `<section class="card" id="host-settings-confirm" aria-labelledby="host-settings-confirm-h" data-confirm-page="${CONFIRM_PAGE_MARKER}">
<h2 id="host-settings-confirm-h">Confirm these changes</h2>
<div class="notice warn" role="status"><ul data-confirm-reasons>${reasons}</ul></div>
<p>If you confirm, exactly these changes are made:</p>
<ul data-confirm-changes>${changes}</ul>
<form method="POST" action="${escapeHtml(d.actionPath)}" data-confirm-form>${hidden("_csrf", d.csrfToken)}${hidden("token", d.token)}
<div class="kb-row"><button type="submit" class="kb-btn kb-btn--primary">Confirm and save</button>
<a class="kb-btn kb-btn--ghost" href="${escapeHtml(d.panelPath)}">Cancel</a></div>
</form>
<p class="kb-help">This page is valid for ten minutes. If the event changes before you confirm, nothing is applied and you are asked to review again.</p>
</section>`;
}
