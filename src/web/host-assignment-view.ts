/**
 * Body of the host panel's "Assign people" section (#1191).
 *
 * Plain server-rendered forms, no page script: every control is one POST to an
 * action registered with `hostAction` (assign, unassign, randomise, lock), so
 * it works the same with scripts off and each click is one audited change.
 * Everything dynamic goes through `escapeHtml`.
 */

import { escapeHtml } from "./html.js";

export interface AssignmentGroupView {
  key: string;
  name: string;
  marker: string;
  /** Voice user limit and member limit; null = no limit. */
  size: number | null;
  memberCount: number;
  /** Only team groups take members. */
  isTeam: boolean;
}

export interface AssignmentPersonView {
  id: string;
  name: string;
  /** Connected to one of the event's voice channels right now. */
  connected: boolean;
  /** Key of the team group the person is in, or null. */
  groupKey: string | null;
}

export interface AssignmentViewData {
  csrfToken: string;
  actionPath: (name: string) => string;
  groups: AssignmentGroupView[];
  people: AssignmentPersonView[];
  /** False when the voice state could not be read (assigning is then off). */
  presenceOk: boolean;
  locked: boolean;
  /** Label of a group ("Team", "Squad"). */
  groupLabel: string;
}

/** "Heli 2/2", "Assault 5" (no limit). */
export function groupFill(
  g: Pick<AssignmentGroupView, "size" | "memberCount">,
): string {
  return g.size === null ? String(g.memberCount) : `${g.memberCount}/${g.size}`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function postForm(
  d: AssignmentViewData,
  action: string,
  inner: string,
): string {
  return `<form method="POST" action="${escapeHtml(d.actionPath(action))}">${hidden("_csrf", d.csrfToken)}${inner}</form>`;
}

function groupLabelText(g: AssignmentGroupView): string {
  return `${g.marker ? `${g.marker} ` : ""}${g.name}`;
}

function renderLock(d: AssignmentViewData): string {
  const state = d.locked
    ? "Locked: joining a group's voice channel no longer changes who is in which group. Only you can change it."
    : "Unlocked: a person who joins a group's voice channel is put in that group, and moves with them to another group's channel.";
  const button = d.locked
    ? hidden("locked", "0") +
      '<button class="btn-secondary" type="submit">Unlock groups</button>'
    : hidden("locked", "1") +
      '<button class="btn-secondary" type="submit">Lock groups</button>';
  return `<div id="host-assignment-lock"><p>${escapeHtml(state)}</p>${postForm(d, "lock", button)}</div>`;
}

function renderCounts(d: AssignmentViewData): string {
  const teams = d.groups.filter((g) => g.isTeam);
  if (teams.length === 0) {
    return '<p class="muted">This event has no team groups, so there is nobody to assign.</p>';
  }
  const items = teams
    .map(
      (g) =>
        `<li><strong>${escapeHtml(groupLabelText(g))}</strong> <span class="mono">${escapeHtml(groupFill(g))}</span></li>`,
    )
    .join("");
  return `<ul class="host-group-counts" aria-label="People in each ${escapeHtml(d.groupLabel.toLowerCase())}">${items}</ul>`;
}

function renderRow(d: AssignmentViewData, p: AssignmentPersonView): string {
  const teams = d.groups.filter((g) => g.isTeam);
  const options = teams
    .map((g) => {
      const here = p.groupKey === g.key;
      const full = g.size !== null && g.memberCount >= g.size && !here;
      return `<option value="${escapeHtml(g.key)}"${here ? " selected" : ""}${full ? " disabled" : ""}>${escapeHtml(groupLabelText(g))} (${escapeHtml(groupFill(g))}${full ? ", full" : ""})</option>`;
    })
    .join("");
  const blank = `<option value=""${p.groupKey === null ? " selected" : ""} disabled>Choose a ${escapeHtml(d.groupLabel.toLowerCase())}</option>`;
  const canAssign = d.presenceOk && teams.length > 0;
  const assign = canAssign
    ? postForm(
        d,
        "assign",
        hidden("userId", p.id) +
          `<label class="visually-hidden" for="assign-${escapeHtml(p.id)}">${escapeHtml(d.groupLabel)} for ${escapeHtml(p.name)}</label>` +
          `<select id="assign-${escapeHtml(p.id)}" name="group" class="tz-select">${blank}${options}</select> ` +
          `<button class="btn" type="submit">${p.groupKey === null ? "Assign" : "Move"}</button>`,
      )
    : '<span class="muted">Not available</span>';
  const unassign =
    p.groupKey !== null
      ? postForm(
          d,
          "unassign",
          hidden("userId", p.id) +
            `<button class="btn-secondary" type="submit" aria-label="Unassign ${escapeHtml(p.name)}">Unassign</button>`,
        )
      : "";
  const current = teams.find((g) => g.key === p.groupKey);
  return (
    `<tr><td>${escapeHtml(p.name)}</td>` +
    `<td>${p.connected ? "In a voice channel" : '<span class="muted">Not connected</span>'}</td>` +
    `<td>${current ? escapeHtml(groupLabelText(current)) : '<span class="muted">Unassigned</span>'}</td>` +
    `<td>${assign}</td><td>${unassign}</td></tr>`
  );
}

function renderPeople(d: AssignmentViewData): string {
  if (d.people.length === 0) {
    return '<p class="muted">Nobody is connected to this event\'s voice channels yet. People show up here as they join.</p>';
  }
  const rows = d.people.map((p) => renderRow(d, p)).join("");
  return `<table class="prefs-table"><caption class="visually-hidden">People and their ${escapeHtml(d.groupLabel.toLowerCase())}</caption><thead><tr><th scope="col">Person</th><th scope="col">Voice</th><th scope="col">${escapeHtml(d.groupLabel)}</th><th scope="col">Assign</th><th scope="col">Remove</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderRandomise(d: AssignmentViewData): string {
  const hasTeams = d.groups.some((g) => g.isTeam);
  if (!hasTeams || !d.presenceOk) return "";
  const label = escapeHtml(d.groupLabel.toLowerCase());
  const body =
    `<fieldset><legend>Randomise</legend>` +
    `<p class="muted">Deal the people connected right now into the ${label}s at random. A ${label} with a size is filled up to its size, in the order listed; ${label}s without a size share the rest evenly. People who do not fit stay unassigned and are listed.</p>` +
    `<label><input type="radio" name="mode" value="unassigned" checked> Only people who are not in a ${label} yet</label><br>` +
    `<label><input type="radio" name="mode" value="everyone"> Everyone connected (people already placed are dealt again)</label>` +
    `</fieldset>` +
    `<div class="form-actions"><button class="btn" type="submit">Randomise</button></div>`;
  return postForm(d, "randomise", body);
}

/** The whole section body. */
export function renderAssignmentSection(d: AssignmentViewData): string {
  const notice = d.presenceOk
    ? ""
    : '<div class="notice warn" role="note">The bot could not read who is in the voice channels, so assigning and randomising are off. You can still unassign people.</div>';
  return [
    notice,
    renderLock(d),
    renderCounts(d),
    renderPeople(d),
    renderRandomise(d),
  ].join("\n");
}
