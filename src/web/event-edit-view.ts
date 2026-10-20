/**
 * Body of the "Edit event" page (#1298), rendered inside `renderUserPage` at
 * `/me/events/:id/host/edit`. Reuses the field names, patterns and limits of the
 * create form (`renderEventsPage`), pre-filled. Built only from the shared `kb-`
 * components (PageHeader, Panel, Field, Button, KeyValue; docs/design/components.md),
 * which both layouts load, so it needs no page-local styles.
 *
 * A started event (`limited`) shows its title and start as text and offers
 * only the description and duration; see `services/event-edit.ts`.
 */

import { escapeHtml } from "./html.js";
import { hostPanelPath } from "./host-panel-shared.js";
import {
  EVENT_DESCRIPTION_MAX,
  EVENT_DURATION_MAX,
  EVENT_DURATION_MIN,
  EVENT_TITLE_MAX,
} from "../services/event-edit.js";

export interface EventEditView {
  id: string;
  title: string;
  description: string;
  durationMinutes: number;
  /** IANA zone the date and time are shown in. */
  timezone: string;
  /** Start date in `timezone`, YYYY-MM-DD. */
  date: string;
  /** Start time in `timezone`, HH:MM. */
  time: string;
  /** Pre-formatted start line, for the started view. */
  when: string;
  /** `eventEditVersion` of the row shown; the save is refused if it moved on. */
  version: string;
  mode: "full" | "limited";
}

export function renderEventEditBody(opts: {
  event: EventEditView;
  csrfToken: string;
}): string {
  const e = opts.event;
  const panel = hostPanelPath(e.id);
  const full = e.mode === "full";
  const scheduleFields = full
    ? `<div class="kb-fields">
        <div class="kb-field">
          <label class="kb-label" for="edit-title">Title</label>
          <input class="kb-input" id="edit-title" type="text" name="title" required maxlength="${EVENT_TITLE_MAX}" value="${escapeHtml(e.title)}">
        </div>
      </div>
      <div class="kb-fields">
        <div class="kb-field">
          <label class="kb-label" for="edit-date">Date (YYYY-MM-DD)</label>
          <input class="kb-input" id="edit-date" type="text" name="date" required pattern="\\d{4}-\\d{2}-\\d{2}" value="${escapeHtml(e.date)}">
        </div>
        <div class="kb-field">
          <label class="kb-label" for="edit-time">Time (24h HH:MM)</label>
          <input class="kb-input" id="edit-time" type="text" name="time" required pattern="\\d{2}:\\d{2}" value="${escapeHtml(e.time)}">
        </div>
        <div class="kb-field">
          <label class="kb-label" for="edit-timezone">Timezone (IANA)</label>
          <input class="kb-input" id="edit-timezone" type="text" name="timezone" value="${escapeHtml(e.timezone)}">
        </div>
      </div>`
    : `<p class="kb-help">This event has already started, so its title and start time are fixed. You can still change the description and the duration.</p>
      <dl class="kb-kv">
        <dt>Title</dt><dd>${escapeHtml(e.title)}</dd>
        <dt>Started</dt><dd class="kb-mono">${escapeHtml(e.when)}</dd>
      </dl>`;
  const foot = full
    ? `<footer class="kb-panel__foot">Moving the start moves the Discord event, the announcement, the reminder and the time the voice channel is created. People who marked Interested keep their answer.</footer>`
    : "";
  return `<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <p class="kb-pagehead__crumbs"><a href="${escapeHtml(panel)}">Host panel</a></p>
    <h1 class="kb-pagehead__title">Edit event</h1>
    <p class="kb-pagehead__sub">${escapeHtml(e.title)}</p>
  </div>
</header>
<form method="POST" action="${escapeHtml(panel)}/edit" data-event-edit-form>
  <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">
  <input type="hidden" name="version" value="${escapeHtml(e.version)}">
  <section class="kb-panel" aria-labelledby="edit-event-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="edit-event-h">Event details</h2></header>
    <div class="kb-panel__body kb-stack">
      ${scheduleFields}
      <div class="kb-fields">
        <div class="kb-field">
          <label class="kb-label" for="edit-description">Description</label>
          <textarea class="kb-textarea" id="edit-description" name="description" rows="3" maxlength="${EVENT_DESCRIPTION_MAX}">${escapeHtml(e.description)}</textarea>
        </div>
      </div>
      <div class="kb-fields">
        <div class="kb-field">
          <label class="kb-label" for="edit-duration">Duration (minutes)</label>
          <input class="kb-input" id="edit-duration" type="number" name="duration" required min="${EVENT_DURATION_MIN}" max="${EVENT_DURATION_MAX}" value="${escapeHtml(e.durationMinutes)}">
        </div>
      </div>
      <div class="kb-row"><button type="submit" class="kb-btn kb-btn--primary">Save changes</button> <a class="kb-btn kb-btn--ghost" href="${escapeHtml(panel)}">Cancel</a></div>
    </div>
    ${foot}
  </section>
</form>`;
}
