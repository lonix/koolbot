/**
 * Body of the host panel's "Team names and tags" section (#1196).
 *
 * Shows whether leaders may customise their own team, each team's current name
 * and tag next to what the host set (when a leader changed it), a reset button
 * per changed team, and the last edits leaders made from Discord (who, what).
 * Reset works whatever the leaders' switches say: the host can always tidy up.
 * Plain server-rendered forms, one POST to `reset-team` each (CSRF, host gate
 * and audit come from `hostAction`). Everything dynamic goes through
 * `escapeHtml`.
 */

import { escapeHtml } from "./html.js";

export interface CustomiseTeamView {
  key: string;
  name: string;
  marker: string;
  tag: string;
  /** What the host set before a leader changed it; null when nobody did. */
  originalName: string | null;
  originalTag: string;
  /** A stored name whose channel rename is still to be confirmed. */
  renamePending: boolean;
}

export interface CustomiseEditView {
  /** ISO time of the edit. */
  at: string;
  who: string;
  text: string;
}

export interface CustomiseViewData {
  csrfToken: string;
  actionPath: (name: string) => string;
  /** Leaders and customisation both on. */
  on: boolean;
  /** What a group is called ("Team", "Squad"). */
  groupLabel: string;
  leaderLabel: string;
  teams: CustomiseTeamView[];
  edits: CustomiseEditView[];
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function shown(name: string, tag: string): string {
  return `${escapeHtml(name)}${tag ? ` <span class="muted">[${escapeHtml(tag)}]</span>` : ""}`;
}

export function renderCustomiseSection(d: CustomiseViewData): string {
  const label = d.groupLabel;
  const leader = d.leaderLabel.toLowerCase();
  const status = d.on
    ? `<p>Each ${escapeHtml(leader)} can rename their own ${escapeHtml(label.toLowerCase())} and set its tag with the <strong>Customise team</strong> button in the ${escapeHtml(label.toLowerCase())}'s channel chat. You can put any ${escapeHtml(label.toLowerCase())} back at any time below.</p>`
    : `<p class="muted">${escapeHtml(d.leaderLabel)}s cannot customise their ${escapeHtml(label.toLowerCase())} on this event. Names and tags a ${escapeHtml(leader)} already chose are kept until you reset them.</p>`;
  const rows = d.teams
    .map((t) => {
      const customised = t.originalName !== null;
      const form = customised
        ? `<form method="POST" action="${escapeHtml(d.actionPath("reset-team"))}">${hidden("_csrf", d.csrfToken)}${hidden("group", t.key)}<button class="btn" type="submit">Reset</button></form>`
        : '<span class="muted">Not changed</span>';
      const pending = t.renamePending
        ? ' <span class="tag tag-info">channel rename pending</span>'
        : "";
      return `<tr><td>${t.marker ? `${escapeHtml(t.marker)} ` : ""}${shown(t.name, t.tag)}${pending}</td><td>${customised ? shown(t.originalName as string, t.originalTag) : '<span class="muted">Same</span>'}</td><td>${form}</td></tr>`;
    })
    .join("");
  const table =
    d.teams.length === 0
      ? `<p class="muted">This event has no teams.</p>`
      : `<table class="prefs-table"><caption class="visually-hidden">Name and tag of each ${escapeHtml(label.toLowerCase())}</caption><thead><tr><th scope="col">${escapeHtml(label)} now</th><th scope="col">Set by you</th><th scope="col">Reset</th></tr></thead><tbody>${rows}</tbody></table>`;
  const edits =
    d.edits.length === 0
      ? `<p class="muted">No ${escapeHtml(leader)} has changed a ${escapeHtml(label.toLowerCase())} yet.</p>`
      : `<table class="prefs-table"><caption class="visually-hidden">Recent changes by ${escapeHtml(leader)}s</caption><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Change</th></tr></thead><tbody>${d.edits
          .map(
            (e) =>
              `<tr><td><span class="mono">${escapeHtml(e.at)}</span></td><td>${escapeHtml(e.who)}</td><td>${escapeHtml(e.text)}</td></tr>`,
          )
          .join("")}</tbody></table>`;
  return [
    status,
    table,
    `<h3>Recent changes by ${escapeHtml(leader)}s</h3>`,
    edits,
  ].join("\n");
}
