/**
 * "Your events" (#1319): `/me/events`, the home of the Event host scope for
 * people who host but are not admins. The body only; the route wraps it in
 * `renderUserPage`, whose scope line says why the person can host.
 *
 * Only the person's own events are passed in (the query filters on the
 * session's user), and there is no server-wide event setting and no link to
 * `/admin` anywhere on it. Start now and New event are links to the shared
 * form (`/me/events/new`); Cancel is the one write here, and it posts to the
 * host panel's own gated action.
 */

import { confirmListAttr, escapeHtml } from "./html.js";
import { icon } from "./icons.js";
import { CHEVRON_ICON } from "./feature-page.js";
import { eventCancelItems } from "./admin-views.js";
import { hostPanelPath, renderEventStateBadge } from "./host-panel-shared.js";

export const HOST_EVENTS_BASE = "/me/events";
export const HOST_NEW_EVENT_PATH = `${HOST_EVENTS_BASE}/new`;
/** Start now is the shared form with its "Now" choice already selected. */
export const HOST_START_NOW_PATH = `${HOST_NEW_EVENT_PATH}?when=now`;

export interface HostEventListRow {
  id: string;
  title: string;
  /** Pre-formatted start line with its zone (`formatEventWhen`). */
  when: string;
  state: string;
  durationMinutes: number;
  /** Running (`isEventRunning`): offered the host panel, not Cancel. */
  running: boolean;
  /** An Edit link is offered. */
  editable: boolean;
  /** Part of a repeating series: Cancel reaches this occurrence only. */
  recurring: boolean;
}

export interface HostEventsPageProps {
  csrfToken: string;
  /** Events is switched on; when off, the create buttons are not offered. */
  eventsEnabled: boolean;
  /** Null when the list could not be read. */
  events: {
    live: HostEventListRow[];
    upcoming: HostEventListRow[];
    past: HostEventListRow[];
  } | null;
}

function minutes(n: number): string {
  return n > 0 ? `${n} min` : "";
}

function rowHtml(
  e: HostEventListRow,
  csrfToken: string,
  opts: { cancel: boolean },
): string {
  const panel = hostPanelPath(e.id);
  const label = escapeHtml(e.title);
  const edit =
    e.editable && opts.cancel
      ? `<a class="kb-btn kb-btn--sm" href="${escapeHtml(panel)}/edit" aria-label="Edit ${label}">Edit</a> `
      : "";
  const open = e.running
    ? `<a class="kb-btn kb-btn--sm kb-btn--primary" href="${escapeHtml(panel)}" aria-label="Open the host panel for ${label}">Host panel</a>`
    : "";
  const cancel = opts.cancel
    ? `<form method="POST" action="${escapeHtml(panel)}/cancel" class="kb-row" data-confirm="Cancel the event '${label}'?"${confirmListAttr(eventCancelItems(false, e.recurring))}>` +
      `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">` +
      `<button type="submit" class="kb-btn kb-btn--sm kb-btn--danger" aria-label="Cancel ${label}">Cancel</button></form>`
    : "";
  return `<tr>
<th scope="row"><a href="${escapeHtml(panel)}">${label}</a></th>
<td>${escapeHtml(e.when)}${e.durationMinutes > 0 ? ` <span class="kb-muted">· ${escapeHtml(minutes(e.durationMinutes))}</span>` : ""}</td>
<td>${renderEventStateBadge(e.state, e.running)}</td>
<td class="kb-actions"><span class="kb-row">${open}${edit}${cancel}</span></td>
</tr>`;
}

function table(
  caption: string,
  rows: HostEventListRow[],
  csrfToken: string,
  opts: { cancel: boolean },
): string {
  return `<table class="kb-table"><caption class="kb-visually-hidden">${escapeHtml(caption)}</caption>
<thead><tr><th scope="col">Event</th><th scope="col">When</th><th scope="col">State</th><th scope="col"><span class="kb-visually-hidden">Actions</span></th></tr></thead>
<tbody>${rows.map((r) => rowHtml(r, csrfToken, opts)).join("\n")}</tbody></table>`;
}

function panel(
  id: string,
  title: string,
  count: number,
  inner: string,
): string {
  return `<section class="kb-panel" id="${id}" aria-labelledby="${id}-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}-h">${escapeHtml(title)}</h2><span class="kb-panel__meta">${count}</span></header>
  ${inner}
</section>`;
}

export function renderHostEventsPage(props: HostEventsPageProps): string {
  const actions = props.eventsEnabled
    ? `<div class="kb-pagehead__actions">
    <a class="kb-btn" href="${HOST_START_NOW_PATH}">${icon("zap")}Start now</a>
    <a class="kb-btn kb-btn--primary" href="${HOST_NEW_EVENT_PATH}">${icon("calendar-plus")}New event</a>
  </div>`
    : "";
  const header = `<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">Your events</h1>
    <p class="kb-pagehead__sub">The events you created. <strong>Start now</strong> opens a new event that begins at once; <strong>New event</strong> plans one for later.</p>
  </div>
  ${actions}
</header>`;
  const off = props.eventsEnabled
    ? ""
    : `<div class="kb-callout kb-callout--warn" role="status"><div class="kb-callout__body"><p class="kb-callout__title">Events are switched off on this server.</p><p class="kb-callout__text">You can look at your earlier events, but new ones cannot be created until an admin switches Events on.</p></div></div>`;
  const e = props.events;
  if (e === null) {
    return `${header}
${off}
<div class="kb-callout kb-callout--warn" role="status"><div class="kb-callout__body"><p class="kb-callout__title">Your events could not be read.</p><p class="kb-callout__text">Reload the page in a moment.</p></div></div>`;
  }
  const liveHtml = panel(
    "live-events",
    "Live now",
    e.live.length,
    e.live.length > 0
      ? `<div class="kb-panel__body--flush">${table("Live events", e.live, props.csrfToken, { cancel: false })}</div>`
      : `<div class="kb-panel__body"><p class="kb-muted">Nothing is running. ${props.eventsEnabled ? "Choose <strong>Start now</strong> to open an event at once, and its voice channel is ready straight away." : ""}</p></div>`,
  );
  const upcomingHtml = panel(
    "upcoming-events",
    "Upcoming",
    e.upcoming.length,
    e.upcoming.length > 0
      ? `<div class="kb-panel__body--flush">${table("Upcoming events", e.upcoming, props.csrfToken, { cancel: true })}</div>`
      : `<div class="kb-empty"><p class="kb-empty__title">No upcoming events.</p><p class="kb-empty__text">Events you plan show up here, with Edit and Cancel.</p>${props.eventsEnabled ? `<a class="kb-btn kb-btn--primary" href="${HOST_NEW_EVENT_PATH}">New event</a>` : ""}</div>`,
  );
  const pastHtml =
    e.past.length > 0
      ? `<details class="kb-disclosure" id="past-events">
  <summary>${CHEVRON_ICON}Past events <span class="kb-badge kb-badge--count">${e.past.length}</span></summary>
  <div class="kb-disclosure__body kb-panel__body--flush">${table("Past events", e.past, props.csrfToken, { cancel: false })}</div>
</details>`
      : "";
  return `${header}
${off}
<div class="kb-stack">
${liveHtml}
${upcomingHtml}
${pastHtml}
</div>`;
}
