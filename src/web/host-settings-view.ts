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

import { escapeHtml } from "./html.js";
import {
  CHANNEL_LEAD_MAX,
  CHANNEL_LEAD_MIN,
} from "../services/event-groups.js";
import { baseField, valueField } from "../services/event-live-edit.js";
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

export interface SettingsViewData {
  csrfToken: string;
  actionPath: (name: string) => string;
  /** Why nothing can be edited right now (events off, event unreadable); null = editable. */
  blocker: string | null;
  /** Stored lead time in minutes; null = the server default. */
  leadMinutes: number | null;
  /** Reason the lead time is read-only, or null while it can be edited. */
  leadReadOnly: string | null;
  /** Lock state, or null when the event has no groups. */
  locked: boolean | null;
  groupLabel: string;
  groups: SettingsGroupView[];
  /** Leaders and tags fields (#1240); null when the event has no groups. */
  leadersTags?: LeadersTagsView | null;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function leadText(minutes: number | null): string {
  return minutes === null
    ? "the server default"
    : `${minutes} minutes before the start`;
}

function renderLead(d: SettingsViewData): string {
  if (d.leadReadOnly !== null) {
    return `<div class="field"><p><strong>Channel creation time:</strong> ${escapeHtml(leadText(d.leadMinutes))}</p><p class="muted">${escapeHtml(d.leadReadOnly)}</p></div>`;
  }
  const base = d.leadMinutes === null ? "" : String(d.leadMinutes);
  return `<div class="field"><label for="host-settings-lead">Channel creation time (minutes before the start)</label>
<input id="host-settings-lead" type="number" inputmode="numeric" min="${CHANNEL_LEAD_MIN}" max="${CHANNEL_LEAD_MAX}" step="1" name="${escapeHtml(valueField("channelLeadMinutes"))}" value="${escapeHtml(base)}" placeholder="server default">
${hidden(baseField("channelLeadMinutes"), base)}
<p class="muted">Leave empty to use the server default. It can only change before the event's channels exist.</p></div>`;
}

function renderLock(d: SettingsViewData): string {
  if (d.locked === null) return "";
  const base = d.locked ? "1" : "0";
  return `<div class="field"><label for="host-settings-lock">Groups</label>
<select id="host-settings-lock" name="${escapeHtml(valueField("groupsLocked"))}">
<option value="0"${d.locked ? "" : " selected"}>Unlocked: joining a group's channel puts people in that group</option>
<option value="1"${d.locked ? " selected" : ""}>Locked: joining a channel changes nobody's group</option>
</select>
${hidden(baseField("groupsLocked"), base)}</div>`;
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

/** The "Live settings" section. */
export function renderSettingsSection(d: SettingsViewData): string {
  if (d.blocker !== null) {
    return `<div class="notice warn" role="status"><p>${escapeHtml(d.blocker)}</p></div>${renderGroups(d)}`;
  }
  return `<p class="muted">Change a setting and save once. Only the fields you change are saved, from the event's current state; saving again with nothing changed does nothing.</p>
<form method="POST" action="${escapeHtml(d.actionPath("settings"))}">${hidden("_csrf", d.csrfToken)}
${renderLead(d)}
${renderLock(d)}
${renderLeadersTagsFields(d.leadersTags ?? null)}
<button type="submit">Save settings</button>
</form>
${renderGroups(d)}`;
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

/** The confirmation page body: what will change, why it needs a yes, and the signed token. */
export function renderConfirmBody(d: ConfirmViewData): string {
  const changes = d.changes
    .map(
      (c) =>
        `<li><strong>${escapeHtml(c.label)}</strong>: ${escapeHtml(c.from)} to ${escapeHtml(c.to)}</li>`,
    )
    .join("");
  const reasons = d.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  return `<section class="card" id="host-settings-confirm" aria-labelledby="host-settings-confirm-h">
<h2 id="host-settings-confirm-h">Confirm these changes</h2>
<div class="notice warn" role="status"><ul>${reasons}</ul></div>
<p>If you confirm, exactly these changes are made:</p>
<ul>${changes}</ul>
<form method="POST" action="${escapeHtml(d.actionPath)}">${hidden("_csrf", d.csrfToken)}${hidden("token", d.token)}
<button type="submit">Confirm and save</button>
<a href="${escapeHtml(d.panelPath)}">Cancel</a>
</form>
<p class="muted">This page is valid for ten minutes. If the event changes before you confirm, nothing is applied and you are asked to review again.</p>
</section>`;
}
