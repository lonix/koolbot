/**
 * Body of the host panel's "Move people" section (#1192).
 *
 * Three plain server-rendered forms (send to groups, return to main, move one
 * person), no page script: each is one POST to an action registered with
 * `hostAction`, so each click is one audited run. A form never carries a
 * channel id: destinations are posted as `main` or a group key and mapped from
 * the event on the server. Everything dynamic goes through `escapeHtml`.
 */

import { escapeHtml } from "./html.js";

export interface MoveDestinationView {
  /** `main`, or the group's key. */
  value: string;
  label: string;
  /** People in the channel now (gateway cache). */
  occupants: number;
  /** Voice user limit; 0 = none. */
  limit: number;
}

export interface MovePersonView {
  id: string;
  name: string;
  /** Label of the channel they are in now. */
  where: string;
}

export interface MovesViewData {
  csrfToken: string;
  actionPath: (name: string) => string;
  /** Why moving is switched off (no Move Members, voice state unreadable), or null. */
  blocker: string | null;
  /** Team groups that have a channel (the "send to groups" targets). */
  sendableGroups: number;
  /** Assigned people in groups that have no channel yet. */
  waitingForChannel: number;
  /** The main channel exists. */
  hasMain: boolean;
  destinations: MoveDestinationView[];
  people: MovePersonView[];
  groupLabel: string;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function postForm(d: MovesViewData, action: string, inner: string): string {
  return `<form method="POST" action="${escapeHtml(d.actionPath(action))}">${hidden("_csrf", d.csrfToken)}${inner}</form>`;
}

function isFull(dest: MoveDestinationView): boolean {
  return dest.limit > 0 && dest.occupants >= dest.limit;
}

function button(
  label: string,
  disabled: boolean,
  describedBy: string | null,
): string {
  return `<button class="btn" type="submit"${disabled ? ' disabled aria-disabled="true"' : ""}${describedBy && disabled ? ` aria-describedby="${escapeHtml(describedBy)}"` : ""}>${escapeHtml(label)}</button>`;
}

function renderSend(d: MovesViewData): string {
  const label = escapeHtml(d.groupLabel.toLowerCase());
  const off = d.blocker !== null || d.sendableGroups === 0;
  const why = d.blocker
    ? ""
    : d.sendableGroups === 0
      ? `<p id="moves-send-why" class="muted">No ${label} has a voice channel yet, so there is nowhere to send people.</p>`
      : "";
  const waiting =
    d.waitingForChannel > 0
      ? `<p class="muted">${escapeHtml(d.waitingForChannel)} assigned ${d.waitingForChannel === 1 ? "person is" : "people are"} in a ${label} without a channel yet and will not be moved.</p>`
      : "";
  return (
    `<div id="host-moves-send"><h3>Send to ${label}s</h3>` +
    `<p>Moves every person who is assigned to a ${label} and connected to one of the event's voice channels into their own ${label}'s channel. People who are not connected, or are in a channel that is not part of the event, are skipped and listed. Open and leader-only channels are never targets. You are never moved.</p>` +
    waiting +
    why +
    postForm(
      d,
      "send-to-groups",
      button(
        `Send to ${d.groupLabel.toLowerCase()}s`,
        off,
        d.blocker ? "moves-blocker" : "moves-send-why",
      ),
    ) +
    `</div>`
  );
}

function renderReturn(d: MovesViewData): string {
  const off = d.blocker !== null || !d.hasMain;
  const why =
    !d.blocker && !d.hasMain
      ? '<p id="moves-return-why" class="muted">The main channel does not exist, so there is nowhere to bring people back to.</p>'
      : "";
  return (
    `<div id="host-moves-return"><h3>Return to main</h3>` +
    `<p>Moves everyone who is in a ${escapeHtml(d.groupLabel.toLowerCase())} channel back to the main channel. People already in the main channel are not touched. You are never moved.</p>` +
    why +
    postForm(
      d,
      "return-to-main",
      `<label><input type="checkbox" name="skipSpecial" value="1"> Leave people in open and leader-only channels where they are</label>` +
        `<div class="form-actions">${button("Return to main", off, d.blocker ? "moves-blocker" : "moves-return-why")}</div>`,
    ) +
    `</div>`
  );
}

function renderOne(d: MovesViewData): string {
  const off =
    d.blocker !== null || d.people.length === 0 || d.destinations.length === 0;
  const why =
    !d.blocker && d.people.length === 0
      ? '<p id="moves-one-why" class="muted">Nobody is connected to the event\'s voice channels right now.</p>'
      : !d.blocker && d.destinations.length === 0
        ? '<p id="moves-one-why" class="muted">The event has no voice channel to move people to yet.</p>'
        : "";
  const people = d.people
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.where)})</option>`,
    )
    .join("");
  const dests = d.destinations
    .map(
      (t) =>
        `<option value="${escapeHtml(t.value)}"${isFull(t) ? " disabled" : ""}>${escapeHtml(t.label)} (${escapeHtml(t.limit > 0 ? `${t.occupants}/${t.limit}` : t.occupants)}${isFull(t) ? ", full" : ""})</option>`,
    )
    .join("");
  return (
    `<div id="host-moves-one"><h3>Move one person</h3>` +
    `<p>Moves one connected person to the main channel or to a ${escapeHtml(d.groupLabel.toLowerCase())}'s channel. A full channel refuses. This does not change which ${escapeHtml(d.groupLabel.toLowerCase())} the person is assigned to: use Assign people for that.</p>` +
    why +
    postForm(
      d,
      "move-one",
      `<label for="move-one-person">Person</label> ` +
        `<select id="move-one-person" name="userId" class="tz-select" required>${people}</select> ` +
        `<label for="move-one-dest">To</label> ` +
        `<select id="move-one-dest" name="to" class="tz-select" required>${dests}</select> ` +
        button("Move", off, d.blocker ? "moves-blocker" : "moves-one-why"),
    ) +
    `</div>`
  );
}

/** The whole section body. */
export function renderMovesSection(d: MovesViewData): string {
  const notice = d.blocker
    ? `<div id="moves-blocker" class="notice warn" role="note">${escapeHtml(d.blocker)}</div>`
    : "";
  return [
    notice,
    `<p class="muted">Moving people never changes which ${escapeHtml(d.groupLabel.toLowerCase())} they are assigned to. One move run per event at a time; each run is paced and reports who was moved and who was skipped.</p>`,
    renderSend(d),
    renderReturn(d),
    renderOne(d),
  ].join("\n");
}
