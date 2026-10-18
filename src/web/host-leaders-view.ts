/**
 * Body of the host panel's "Leaders" section (#1195).
 *
 * Shown only while the event has leaders switched on. Plain server-rendered
 * forms, no page script: pick one member of each team group as its leader,
 * rename what a leader is called, and pull just the leaders into one channel.
 * Every control is one POST to an action registered with `hostAction`, so each
 * click is one audited change. A form never carries a channel id: the pull's
 * destination is posted as `default`, `main`, `here` or a group key and mapped
 * from the event on the server. Everything dynamic goes through `escapeHtml`.
 */

import { escapeHtml } from "./html.js";

export interface LeaderMemberView {
  id: string;
  name: string;
}

export interface LeaderGroupView {
  key: string;
  name: string;
  marker: string;
  /** The group's current leader (a member of it), or null. */
  leaderId: string | null;
  members: LeaderMemberView[];
}

export interface LeaderDestinationView {
  /** `default`, `main`, `here` or a group key. */
  value: string;
  label: string;
}

export interface LeadersViewData {
  csrfToken: string;
  actionPath: (name: string) => string;
  /** What leaders are called ("Leader", "Captain"). */
  leaderLabel: string;
  /** What a group is called ("Team", "Squad"). */
  groupLabel: string;
  /** Team groups only. */
  groups: LeaderGroupView[];
  /** Where the default destination leads right now, in words. */
  defaultWhere: string;
  destinations: LeaderDestinationView[];
  /** Why pulling is switched off (no Move Members, voice state unreadable), or null. */
  blocker: string | null;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function postForm(d: LeadersViewData, action: string, inner: string): string {
  return `<form method="POST" action="${escapeHtml(d.actionPath(action))}">${hidden("_csrf", d.csrfToken)}${inner}</form>`;
}

function groupText(g: LeaderGroupView): string {
  return `${g.marker ? `${g.marker} ` : ""}${g.name}`;
}

function renderPicker(d: LeadersViewData): string {
  const label = d.leaderLabel;
  if (d.groups.length === 0) {
    return `<p class="muted">This event has no team groups, so there is nobody to pick a ${escapeHtml(label.toLowerCase())} from.</p>`;
  }
  const rows = d.groups
    .map((g) => {
      const id = `leader-${g.key}`;
      const options =
        `<option value=""${g.leaderId === null ? " selected" : ""}>No ${escapeHtml(label.toLowerCase())}</option>` +
        g.members
          .map(
            (m) =>
              `<option value="${escapeHtml(m.id)}"${m.id === g.leaderId ? " selected" : ""}>${escapeHtml(m.name)}</option>`,
          )
          .join("");
      const current = g.members.find((m) => m.id === g.leaderId);
      const form =
        g.members.length === 0
          ? `<span class="muted">Nobody is in this ${escapeHtml(d.groupLabel.toLowerCase())} yet. Assign people first.</span>`
          : postForm(
              d,
              "set-leader",
              hidden("group", g.key) +
                `<label class="visually-hidden" for="${escapeHtml(id)}">${escapeHtml(label)} of ${escapeHtml(groupText(g))}</label>` +
                `<select id="${escapeHtml(id)}" name="userId" class="tz-select">${options}</select> ` +
                `<button class="btn" type="submit">Save</button>`,
            );
      return `<tr><td>${escapeHtml(groupText(g))}</td><td>${current ? escapeHtml(current.name) : '<span class="muted">None</span>'}</td><td>${form}</td></tr>`;
    })
    .join("");
  return `<table class="prefs-table"><caption class="visually-hidden">${escapeHtml(label)} of each ${escapeHtml(d.groupLabel.toLowerCase())}</caption><thead><tr><th scope="col">${escapeHtml(d.groupLabel)}</th><th scope="col">${escapeHtml(label)}</th><th scope="col">Change</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderLabel(d: LeadersViewData): string {
  return (
    `<div id="host-leaders-label"><h3>What a leader is called</h3>` +
    postForm(
      d,
      "leader-label",
      `<label for="leader-label-input">Name for this event (for example Captain or Squad Lead)</label> ` +
        `<input id="leader-label-input" type="text" name="label" maxlength="20" value="${escapeHtml(d.leaderLabel)}"> ` +
        `<button class="btn" type="submit">Rename</button>`,
    ) +
    `</div>`
  );
}

function renderPull(d: LeadersViewData): string {
  const label = d.leaderLabel.toLowerCase();
  const off = d.blocker !== null;
  const options = d.destinations
    .map(
      (t) =>
        `<option value="${escapeHtml(t.value)}">${escapeHtml(t.label)}</option>`,
    )
    .join("");
  return (
    `<div id="host-leaders-pull"><h3>Pull ${escapeHtml(label)}s only</h3>` +
    `<p>Moves every connected ${escapeHtml(label)} to one channel for a briefing. Everyone else stays where they are. A ${escapeHtml(label)} who is not connected, is in a channel that is not part of the event, or is you is skipped and listed. This does not change anyone's ${escapeHtml(d.groupLabel.toLowerCase())}.</p>` +
    `<p class="muted">Default: ${escapeHtml(d.defaultWhere)}</p>` +
    postForm(
      d,
      "pull-leaders",
      `<label for="pull-leaders-to">To</label> ` +
        `<select id="pull-leaders-to" name="to" class="tz-select">${options}</select> ` +
        `<button class="btn" type="submit"${off ? ' disabled aria-disabled="true" aria-describedby="leaders-blocker"' : ""}>Pull ${escapeHtml(label)}s</button>`,
    ) +
    `</div>`
  );
}

/** The whole section body. */
export function renderLeadersSection(d: LeadersViewData): string {
  const label = d.leaderLabel.toLowerCase();
  const notice = d.blocker
    ? `<div id="leaders-blocker" class="notice warn" role="note">${escapeHtml(d.blocker)}</div>`
    : "";
  return [
    notice,
    `<p class="muted">One ${escapeHtml(label)} per team ${escapeHtml(d.groupLabel.toLowerCase())}, chosen from the people assigned to it. Taking someone out of their ${escapeHtml(d.groupLabel.toLowerCase())}, or moving them to another, ends their role.</p>`,
    renderPicker(d),
    renderLabel(d),
    renderPull(d),
  ].join("\n");
}
