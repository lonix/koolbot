/**
 * The host panel's team board and toolbar (#1424), which replace the cards
 * "Assign people", "Move people", "Leaders" and "Team names and tags" of #1189.
 *
 * Plain server-rendered forms first: every control is one POST to an action
 * registered with `hostAction` (assign, unassign, randomise, lock,
 * send-to-groups, return-to-main, move-one, set-leader, pull-leaders,
 * reset-team), so it works with scripts off and each click is still one
 * audited change. The page script (`HOST_BOARD_SCRIPT`) only upgrades it:
 * the toolbar's option sets open in a dialog, and a person can be dragged
 * between columns. Dragging fills in and submits the SAME per-person form, so
 * there is no second route and the keyboard path (the Move menu of each
 * person) is the baseline, never a fallback of the drag.
 *
 * A form never carries a channel id: destinations are posted as `main` or a
 * group key and mapped from the event on the server. Everything dynamic goes
 * through `escapeHtml`. Only `kb-` classes are used.
 */

import { escapeHtml } from "./html.js";
import { icon } from "./icons.js";
import { groupCapacity } from "../services/event-group-plan.js";

export interface BoardPersonView {
  id: string;
  name: string;
  /** Connected to one of the event's voice channels right now. */
  connected: boolean;
  /** Where they are connected now ("Main channel", a team's name); null = not connected. */
  where: string | null;
  /** Set (to the leader label) when the person leads the team they are in (#1195). */
  leaderLabel: string | null;
}

export interface BoardTeamView {
  key: string;
  name: string;
  marker: string;
  tag: string;
  /** Voice user limit and member limit; null = no limit. */
  size: number | null;
  hasChannel: boolean;
  /** A leader changed the name or tag; the host can put it back (#1196). */
  customised: boolean;
  people: BoardPersonView[];
}

export interface BoardDestinationView {
  /** `main`, or the group's key. */
  value: string;
  label: string;
  /** People in the channel now (gateway cache). */
  occupants: number;
  /** Voice user limit; 0 = none. */
  limit: number;
}

export interface BoardMovePersonView {
  id: string;
  name: string;
  where: string;
}

export interface BoardLeadersView {
  /** Where the default destination leads right now, in words. */
  defaultWhere: string;
  /** `default`, `main`, `here` or a group key. */
  destinations: Array<{ value: string; label: string }>;
}

export interface HostBoardData {
  csrfToken: string;
  actionPath: (name: string) => string;
  /** Label of a group ("Team", "Squad"). */
  groupLabel: string;
  /** What leaders are called; only used while `leaders` is given. */
  leaderLabel: string;
  locked: boolean;
  /** False when the voice state could not be read (assigning is then off). */
  presenceOk: boolean;
  /** Team groups only, in event order. */
  teams: BoardTeamView[];
  /** Connected people who are in no team. */
  loose: BoardPersonView[];
  /** Everyone connected to an event channel now. */
  connectedCount: number;
  /** Why moving is switched off (no Move Members, voice state unreadable), or null. */
  moveBlocker: string | null;
  /** Team groups that have a channel (the "send to teams" targets). */
  sendableTeams: number;
  /** Assigned people in teams that have no channel yet. */
  waitingForChannel: number;
  /** The main channel exists. */
  hasMain: boolean;
  destinations: BoardDestinationView[];
  movePeople: BoardMovePersonView[];
  /** Given only while leaders are switched on for the event. */
  leaders?: BoardLeadersView;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function postForm(
  d: HostBoardData,
  action: string,
  inner: string,
  attrs = "",
): string {
  return `<form method="POST" action="${escapeHtml(d.actionPath(action))}"${attrs}>${hidden("_csrf", d.csrfToken)}${inner}</form>`;
}

function teamText(t: Pick<BoardTeamView, "marker" | "name">): string {
  return `${t.marker ? `${t.marker} ` : ""}${t.name}`;
}

function fill(t: BoardTeamView): string {
  return t.size === null
    ? String(t.people.length)
    : `${t.people.length}/${t.size}`;
}

function isFull(t: BoardTeamView): boolean {
  return t.people.length >= groupCapacity(t);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function destFull(dest: BoardDestinationView): boolean {
  return dest.limit > 0 && dest.occupants >= dest.limit;
}

function initial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

function sizedButton(
  label: string,
  opts: { primary?: boolean; disabled?: boolean; describedBy?: string } = {},
): string {
  const cls = `kb-btn${opts.primary ? " kb-btn--primary" : ""}`;
  const off = opts.disabled
    ? ` disabled aria-disabled="true"${opts.describedBy ? ` aria-describedby="${escapeHtml(opts.describedBy)}"` : ""}`
    : "";
  return `<button class="${cls}" type="submit"${off}>${escapeHtml(label)}</button>`;
}

/** The person's own forms: team menu (assign, unassign) and, with leaders on, set-leader. */
function renderMenu(
  d: HostBoardData,
  p: BoardPersonView,
  team: BoardTeamView | null,
): string {
  const label = d.groupLabel.toLowerCase();
  const selectId = `board-move-${p.id}`;
  const options = d.teams
    .map((t) => {
      const here = team?.key === t.key;
      const full = isFull(t) && !here;
      return `<option value="${escapeHtml(t.key)}"${here ? " selected" : ""}${full ? " disabled" : ""}>${escapeHtml(teamText(t))} (${escapeHtml(fill(t))}${full ? ", full" : ""})</option>`;
    })
    .join("");
  const blank = `<option value=""${team === null ? " selected" : ""} disabled>Choose a ${escapeHtml(label)}</option>`;
  const canAssign = d.presenceOk && d.teams.length > 0;
  const hiddenName = `<span class="kb-visually-hidden"> ${escapeHtml(p.name)}</span>`;
  const assign =
    `<form method="POST" action="${escapeHtml(d.actionPath("assign"))}" class="kb-stack" data-board-assign>` +
    hidden("_csrf", d.csrfToken) +
    hidden("userId", p.id) +
    (canAssign
      ? `<div class="kb-field"><label class="kb-label" for="${escapeHtml(selectId)}">${escapeHtml(d.groupLabel)} for ${escapeHtml(p.name)}</label>` +
        `<select class="kb-select" id="${escapeHtml(selectId)}" name="group">${blank}${options}</select></div>`
      : `<p class="kb-help">${d.presenceOk ? `There is no ${escapeHtml(label)} to move this person to yet.` : "Not available: the voice state could not be read."}</p>`) +
    `<div class="kb-row">` +
    (canAssign
      ? `<button class="kb-btn kb-btn--sm kb-btn--primary" type="submit" data-board-do="assign">${team === null ? "Add to " : "Move to "}${escapeHtml(label)}${hiddenName}</button>`
      : "") +
    (team !== null
      ? `<button class="kb-btn kb-btn--sm" type="submit" formaction="${escapeHtml(d.actionPath("unassign"))}" data-board-do="unassign">Not in a ${escapeHtml(label)}${hiddenName}</button>`
      : "") +
    `</div></form>`;
  let leader = "";
  if (d.leaders && team !== null) {
    const lead = d.leaderLabel.toLowerCase();
    leader = postForm(
      d,
      "set-leader",
      hidden("group", team.key) +
        hidden("userId", p.leaderLabel ? "" : p.id) +
        `<button class="kb-btn kb-btn--sm" type="submit">${p.leaderLabel ? `Remove as ${escapeHtml(lead)}` : `Make ${escapeHtml(lead)}`}${hiddenName}</button>`,
    );
  }
  return `<details class="kb-disclosure kb-disclosure--inline kb-board__menu">
<summary>Move<span class="kb-visually-hidden"> ${escapeHtml(p.name)}</span></summary>
<div class="kb-disclosure__body kb-stack">${assign}${leader}</div>
</details>`;
}

function renderPerson(
  d: HostBoardData,
  p: BoardPersonView,
  team: BoardTeamView | null,
): string {
  const crown = p.leaderLabel
    ? `<span class="kb-badge kb-badge--info">${icon("crown", { className: "kb-crown" })}${escapeHtml(p.leaderLabel)}</span>`
    : "";
  const where = p.connected
    ? `In ${escapeHtml(p.where ?? "an event channel")}`
    : '<span class="kb-muted">Not connected</span>';
  return `<li class="kb-board__person" data-user="${escapeHtml(p.id)}" data-group="${escapeHtml(team?.key ?? "")}">
<span class="kb-avatar" aria-hidden="true">${escapeHtml(initial(p.name))}</span>
<span class="kb-board__who">${escapeHtml(p.name)}</span>${crown}
<span class="kb-board__where">${where}</span>
${team === null && !(d.presenceOk && d.teams.length > 0) ? "" : renderMenu(d, p, team)}
</li>`;
}

function renderTeamColumn(d: HostBoardData, t: BoardTeamView): string {
  const id = `board-col-${t.key}`;
  const tag = t.tag
    ? `<span class="kb-team__tag">${escapeHtml(t.tag)}</span>`
    : "";
  const count = `<span class="kb-team__count"><span class="kb-visually-hidden">${escapeHtml(plural(t.people.length, "person", "people"))}${t.size === null ? "" : `, limit ${escapeHtml(t.size)}`}</span><span aria-hidden="true">${escapeHtml(t.people.length)}${t.size === null ? "" : `<small>/${escapeHtml(t.size)}</small>`}</span></span>`;
  const meter =
    t.size === null
      ? ""
      : `<div class="kb-meter" role="img" aria-label="${escapeHtml(`${Math.min(t.people.length, t.size)} of ${t.size} places taken`)}"><span style="width:${Math.min(100, Math.round((t.people.length / t.size) * 100))}%"></span></div>`;
  const people = t.people.length
    ? t.people.map((p) => renderPerson(d, p, t)).join("\n")
    : `<li class="kb-team__empty">Nobody here yet.</li>`;
  const reset = t.customised
    ? postForm(
        d,
        "reset-team",
        hidden("group", t.key) +
          `<button class="kb-btn kb-btn--sm" type="submit">Reset name and tag<span class="kb-visually-hidden"> of ${escapeHtml(teamText(t))}</span></button>`,
      )
    : "";
  const channel = t.hasChannel
    ? `${icon("audio-lines")}Voice channel created`
    : "No voice channel yet";
  return `<section class="kb-board__col" data-group="${escapeHtml(t.key)}" aria-labelledby="${escapeHtml(id)}">
<header class="kb-board__head">${tag}<h3 class="kb-team__name" id="${escapeHtml(id)}">${escapeHtml(teamText(t))}</h3>${count}</header>
${meter}
<ul class="kb-board__list" aria-label="People in ${escapeHtml(teamText(t))}">
${people}
</ul>
<div class="kb-board__foot">${channel}${reset}</div>
</section>`;
}

function renderLooseColumn(d: HostBoardData): string {
  const people = d.loose.length
    ? d.loose.map((p) => renderPerson(d, p, null)).join("\n")
    : `<li class="kb-team__empty">Everyone connected is in a ${escapeHtml(d.groupLabel.toLowerCase())}.</li>`;
  return `<section class="kb-board__col kb-board__col--loose" id="host-board-loose" data-group="" aria-labelledby="board-col-none">
<header class="kb-board__head"><h3 class="kb-team__name" id="board-col-none">Not in a ${escapeHtml(d.groupLabel.toLowerCase())}</h3><span class="kb-team__count"><span class="kb-visually-hidden">${escapeHtml(plural(d.loose.length, "person", "people"))}</span><span aria-hidden="true">${escapeHtml(d.loose.length)}</span></span></header>
<ul class="kb-board__list" aria-label="Connected people who are not in a ${escapeHtml(d.groupLabel.toLowerCase())}">
${people}
</ul>
<div class="kb-board__foot">${escapeHtml(plural(d.connectedCount, "person", "people"))} connected to the event's voice channels</div>
</section>`;
}

/** One option set of the toolbar: a disclosure without script, a dialog with it. */
function renderDialogAction(
  id: string,
  summary: string,
  title: string,
  inner: string,
): string {
  return `<details class="kb-toolbar__action" id="${escapeHtml(id)}" data-board-dialog="${escapeHtml(title)}">
<summary class="kb-btn">${escapeHtml(summary)}</summary>
<div class="kb-toolbar__panel kb-stack">${inner}</div>
</details>`;
}

function renderRandomisePanel(d: HostBoardData): string {
  const label = d.groupLabel.toLowerCase();
  return postForm(
    d,
    "randomise",
    `<p>Deal the people connected right now into the ${escapeHtml(label)}s at random. The split is even (the ${escapeHtml(label)}s differ by at most one person). A size is a hard limit: a full ${escapeHtml(label)} is skipped, and people who do not fit stay out of a ${escapeHtml(label)} and are listed.</p>` +
      `<fieldset class="kb-field"><legend class="kb-label">Who is dealt</legend>` +
      `<div class="kb-segmented" role="presentation">` +
      `<label><input type="radio" name="mode" value="unassigned" checked><span>Only people not in a ${escapeHtml(label)}</span></label>` +
      `<label><input type="radio" name="mode" value="everyone"><span>Everyone connected</span></label>` +
      `</div><p class="kb-help">Everyone connected deals people who are already placed again.</p></fieldset>` +
      `<div class="kb-row">${sizedButton(`Deal people into ${label}s`, { primary: true })}</div>`,
    ' class="kb-stack"',
  );
}

function renderMovePanel(d: HostBoardData): string {
  const label = d.groupLabel.toLowerCase();
  const blocked = d.moveBlocker !== null;
  const returnOff = blocked || !d.hasMain;
  const returnWhy =
    !blocked && !d.hasMain
      ? '<p id="board-return-why" class="kb-help">The main channel does not exist, so there is nowhere to bring people back to.</p>'
      : "";
  const oneOff =
    blocked || d.movePeople.length === 0 || d.destinations.length === 0;
  const oneWhy =
    !blocked && d.movePeople.length === 0
      ? '<p id="board-one-why" class="kb-help">Nobody is connected to the event\'s voice channels right now.</p>'
      : !blocked && d.destinations.length === 0
        ? '<p id="board-one-why" class="kb-help">The event has no voice channel to move people to yet.</p>'
        : "";
  const people = d.movePeople
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.where)})</option>`,
    )
    .join("");
  const dests = d.destinations
    .map(
      (t) =>
        `<option value="${escapeHtml(t.value)}"${destFull(t) ? " disabled" : ""}>${escapeHtml(t.label)} (${escapeHtml(t.limit > 0 ? `${t.occupants}/${t.limit}` : t.occupants)}${destFull(t) ? ", full" : ""})</option>`,
    )
    .join("");
  const back = postForm(
    d,
    "return-to-main",
    `<h4 class="kb-label">Return to main</h4>` +
      `<p>Moves everyone who is in a ${escapeHtml(label)} channel back to the main channel. People already in the main channel are not touched. You are never moved.</p>` +
      returnWhy +
      `<label class="kb-row"><input type="checkbox" name="skipSpecial" value="1"> Leave people in open and leader-only channels where they are</label>` +
      `<div class="kb-row">${sizedButton("Return to main", { disabled: returnOff, describedBy: blocked ? "host-board-notes" : "board-return-why" })}</div>`,
    ' class="kb-stack"',
  );
  const one = postForm(
    d,
    "move-one",
    `<h4 class="kb-label">Move one person</h4>` +
      `<p>Moves one connected person to the main channel or to a ${escapeHtml(label)}'s channel. A full channel refuses. This does not change which ${escapeHtml(label)} the person is in: use their Move menu on the board for that.</p>` +
      oneWhy +
      `<div class="kb-fields"><div class="kb-field"><label class="kb-label" for="board-one-person">Person</label>` +
      `<select class="kb-select" id="board-one-person" name="userId" required>${people}</select></div>` +
      `<div class="kb-field"><label class="kb-label" for="board-one-dest">To</label>` +
      `<select class="kb-select" id="board-one-dest" name="to" required>${dests}</select></div></div>` +
      `<div class="kb-row">${sizedButton("Move", { disabled: oneOff, describedBy: blocked ? "host-board-notes" : "board-one-why" })}</div>`,
    ' class="kb-stack"',
  );
  let pull = "";
  if (d.leaders) {
    const lead = d.leaderLabel.toLowerCase();
    const options = d.leaders.destinations
      .map(
        (t) =>
          `<option value="${escapeHtml(t.value)}">${escapeHtml(t.label)}</option>`,
      )
      .join("");
    pull = postForm(
      d,
      "pull-leaders",
      `<h4 class="kb-label">Pull ${escapeHtml(lead)}s only</h4>` +
        `<p>Moves every connected ${escapeHtml(lead)} to one channel for a briefing. Everyone else stays where they are. A ${escapeHtml(lead)} who is not connected, is in a channel that is not part of the event, or is you is skipped and listed. This does not change anyone's ${escapeHtml(label)}.</p>` +
        `<p class="kb-help">Default: ${escapeHtml(d.leaders.defaultWhere)}</p>` +
        `<div class="kb-field"><label class="kb-label" for="board-pull-to">To</label><select class="kb-select" id="board-pull-to" name="to">${options}</select></div>` +
        `<div class="kb-row">${sizedButton(`Pull ${lead}s`, { disabled: blocked, describedBy: "host-board-notes" })}</div>`,
      ' class="kb-stack"',
    );
  }
  return `<p class="kb-help">Moving people never changes which ${escapeHtml(label)} they are in. One move run per event at a time; each run is paced and reports who was moved and who was skipped.</p>${back}${one}${pull}`;
}

function renderLock(d: HostBoardData): string {
  const badge = d.locked
    ? `<span class="kb-badge kb-badge--warn">${icon("lock")}Locked</span>`
    : `<span class="kb-badge kb-badge--on">${icon("lock-open")}Unlocked</span>`;
  const button = d.locked
    ? hidden("locked", "0") +
      '<button class="kb-btn" type="submit">Unlock groups</button>'
    : hidden("locked", "1") +
      '<button class="kb-btn" type="submit">Lock groups</button>';
  return postForm(d, "lock", `${badge}${button}`, ' class="kb-row"');
}

/** The notes the disabled buttons point at (`aria-describedby`), shown to everyone. */
function renderNotes(d: HostBoardData): string {
  const label = d.groupLabel.toLowerCase();
  const notes: string[] = [];
  if (d.teams.length === 0) {
    notes.push(
      `Randomise and Send to ${label}s need a ${label}: there is none yet.`,
    );
  }
  if (d.moveBlocker) notes.push(d.moveBlocker);
  else if (d.sendableTeams === 0 && d.teams.length > 0) {
    notes.push(
      `No ${label} has a voice channel yet, so there is nowhere to send people.`,
    );
  }
  if (d.waitingForChannel > 0) {
    notes.push(
      `${plural(d.waitingForChannel, "assigned person is", "assigned people are")} in a ${label} without a channel yet and will not be moved.`,
    );
  }
  notes.push(
    d.locked
      ? "Locked: joining a team's voice channel no longer changes who is in which team. Only you can change it."
      : "Unlocked: a person who joins a team's voice channel is put in that team, and moves with them to another team's channel.",
  );
  return `<p class="kb-help" id="host-board-notes">${notes.map(escapeHtml).join(" ")}</p>`;
}

/** The toolbar and the board, as one section body. */
export function renderHostBoard(d: HostBoardData): string {
  const label = d.groupLabel.toLowerCase();
  const hasTeams = d.teams.length > 0;
  // No team group (only open groups, or none): the toolbar and the people stay,
  // because Move people (the main and open channels are destinations) and taking
  // people out of a team do not need a team. Only what needs a team is off.
  const noTeams = hasTeams
    ? ""
    : `<div class="kb-callout" role="note"><div class="kb-callout__body"><p class="kb-callout__title">There is no ${escapeHtml(label)} to put people in yet.</p><p class="kb-callout__text">Add one under Change the groups, further down this page. Until then you can still move people between the event's voice channels.</p></div></div>`;
  const presenceNotice = d.presenceOk
    ? ""
    : `<div class="kb-callout kb-callout--warn" role="note"><div class="kb-callout__body"><p class="kb-callout__text">The bot could not read who is in the voice channels, so adding people to a ${escapeHtml(label)} and randomising are off. You can still take people out of a ${escapeHtml(label)}.</p></div></div>`;
  const randomiseOff = !d.presenceOk || !hasTeams;
  const randomise = randomiseOff
    ? `<button class="kb-btn" type="button" disabled aria-disabled="true" aria-describedby="host-board-notes">Randomise…</button>`
    : renderDialogAction(
        "host-randomise",
        "Randomise…",
        `Randomise people into ${label}s`,
        renderRandomisePanel(d),
      );
  const move =
    d.moveBlocker !== null
      ? `<button class="kb-btn" type="button" disabled aria-disabled="true" aria-describedby="host-board-notes">Move people…</button>`
      : renderDialogAction(
          "host-move-people",
          "Move people…",
          "Move people",
          renderMovePanel(d),
        );
  const sendOff = d.moveBlocker !== null || d.sendableTeams === 0;
  const send = postForm(
    d,
    "send-to-groups",
    sizedButton(`Send to ${label}s`, {
      primary: true,
      disabled: sendOff,
      describedBy: "host-board-notes",
    }),
    ' class="kb-toolbar__end"',
  );
  const toolbar = `<div class="kb-toolbar" role="group" aria-label="${escapeHtml(d.groupLabel)} actions">
${renderLock(d)}
<span class="kb-toolbar__sep" aria-hidden="true"></span>
${randomise}
${move}
${send}
</div>`;
  const columns = [
    ...d.teams.map((t) => renderTeamColumn(d, t)),
    renderLooseColumn(d),
  ].join("\n");
  return `<section class="kb-stack" id="host-board" aria-labelledby="host-board-h">
<h2 class="kb-visually-hidden" id="host-board-h">${escapeHtml(d.groupLabel)}s</h2>
${presenceNotice}
${noTeams}
${toolbar}
${renderNotes(d)}
${hasTeams ? `<p class="kb-help">Put a person in a ${escapeHtml(label)} with the Move menu next to their name. With a mouse you can also drag them to another column.</p>` : ""}
<p class="kb-visually-hidden" id="host-board-status" role="status" aria-live="polite"></p>
<div class="kb-board" id="host-board-columns">
${columns}
</div>
</section>`;
}

/**
 * The page script: progressive enhancement only. Without it every control above
 * still posts its form. It does two things:
 *  - an option set of the toolbar (`details[data-board-dialog]`) opens in a
 *    `dialog.kb-dialog` (focus starts on Go back, Escape closes, focus returns
 *    to the button), and the form moves back into the page when it closes;
 *  - a person can be dragged to another column. Dropping fills in the person's
 *    own team form and submits it with `requestSubmit`, so the route, its gate
 *    and its audit row are the same as the Move menu's.
 */
export const HOST_BOARD_SCRIPT = [
  "(function(){",
  "function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x)n.textContent=x;return n}",
  "function say(m){var s=document.getElementById('host-board-status');if(s)s.textContent=m}",
  "var canDialog=typeof document.createElement('dialog').showModal==='function';",
  "if(canDialog){Array.prototype.forEach.call(document.querySelectorAll('details[data-board-dialog]'),function(det){",
  "var sum=det.querySelector('summary'),panel=det.querySelector('.kb-toolbar__panel');if(!sum||!panel)return;",
  "sum.addEventListener('click',function(e){e.preventDefault();",
  "var d=el('dialog','kb-dialog'),title=el('h2','kb-dialog__title',det.getAttribute('data-board-dialog'));",
  "title.id=det.id+'-title';d.setAttribute('aria-labelledby',title.id);",
  "var head=el('div','kb-dialog__head'),body=el('div','kb-dialog__body'),foot=el('div','kb-dialog__foot');",
  "var back=el('button','kb-btn kb-btn--ghost','Go back');back.type='button';",
  "back.addEventListener('click',function(){d.close()});",
  "head.appendChild(title);body.appendChild(panel);foot.appendChild(back);",
  "d.appendChild(head);d.appendChild(body);d.appendChild(foot);",
  "d.addEventListener('close',function(){det.appendChild(panel);if(d.parentNode)d.parentNode.removeChild(d);sum.focus()});",
  "document.body.appendChild(d);d.showModal();back.focus()})})}",
  "var dragged=null;",
  "Array.prototype.forEach.call(document.querySelectorAll('.kb-board__person'),function(li){",
  "li.setAttribute('draggable','true');",
  "li.addEventListener('dragstart',function(e){dragged=li;li.classList.add('is-dragging');",
  "if(e.dataTransfer){e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',li.getAttribute('data-user')||'')}catch(x){}}});",
  "li.addEventListener('dragend',function(){li.classList.remove('is-dragging');dragged=null;",
  "Array.prototype.forEach.call(document.querySelectorAll('.kb-board__col.is-over'),function(c){c.classList.remove('is-over')})})});",
  "Array.prototype.forEach.call(document.querySelectorAll('.kb-board__col'),function(col){",
  "col.addEventListener('dragover',function(e){if(!dragged)return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='move';col.classList.add('is-over')});",
  "col.addEventListener('dragleave',function(e){if(!col.contains(e.relatedTarget))col.classList.remove('is-over')});",
  "col.addEventListener('drop',function(e){if(!dragged)return;e.preventDefault();col.classList.remove('is-over');",
  "var li=dragged,to=col.getAttribute('data-group')||'',from=li.getAttribute('data-group')||'';dragged=null;",
  "if(to===from)return;",
  "var form=li.querySelector('form[data-board-assign]');if(!form)return;",
  "var who=(li.querySelector('.kb-board__who')||{}).textContent||'This person';",
  "if(to===''){var un=form.querySelector('[data-board-do=unassign]');if(un&&form.requestSubmit)form.requestSubmit(un);return}",
  "var sel=form.querySelector('select[name=group]'),go=form.querySelector('[data-board-do=assign]');",
  "if(!sel||!go||!form.requestSubmit){say('Assigning is not available right now.');return}",
  "var opt=null;Array.prototype.forEach.call(sel.options,function(o){if(o.value===to)opt=o});",
  "if(!opt||opt.disabled){say(who+' cannot be moved there: it is full.');return}",
  "sel.value=to;say('Moving '+who+'.');form.requestSubmit(go)})});",
  "})();",
].join("");
