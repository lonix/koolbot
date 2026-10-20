/**
 * Body of the "Edit event" page (#1298), rendered inside `renderUserPage` at
 * `/me/events/:id/host/edit`. Reuses the field names, patterns and limits of the
 * create form (`renderEventsPage`), pre-filled.
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
    ? `<label>Title
      <input type="text" name="title" required maxlength="${EVENT_TITLE_MAX}" value="${escapeHtml(e.title)}">
    </label>
    <label>Date (YYYY-MM-DD)
      <input type="text" name="date" required pattern="\\d{4}-\\d{2}-\\d{2}" value="${escapeHtml(e.date)}">
    </label>
    <label>Time (24h HH:MM)
      <input type="text" name="time" required pattern="\\d{2}:\\d{2}" value="${escapeHtml(e.time)}">
    </label>
    <label>Timezone (IANA)
      <input type="text" name="timezone" value="${escapeHtml(e.timezone)}">
    </label>`
    : `<p class="muted">This event has already started, so its title and start time are fixed. You can still change the description and the duration.</p>
    <table class="prefs-table"><tbody>
      <tr><th scope="row">Title</th><td>${escapeHtml(e.title)}</td></tr>
      <tr><th scope="row">Started</th><td class="mono">${escapeHtml(e.when)}</td></tr>
    </tbody></table>`;
  const notes = full
    ? `<p class="muted">Moving the start moves the Discord event, the announcement, the reminder and the time the voice channel is created. People who marked Interested keep their answer.</p>`
    : "";
  return `<h1>Edit event</h1>
<p class="subtitle"><strong>${escapeHtml(e.title)}</strong> · <a href="${escapeHtml(panel)}">Back to host panel</a></p>
<section class="card" aria-labelledby="edit-event-h">
  <h2 id="edit-event-h">Event details</h2>
  <form method="POST" action="${escapeHtml(panel)}/edit" class="stack" data-event-edit-form>
    <input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">
    <input type="hidden" name="version" value="${escapeHtml(e.version)}">
    ${scheduleFields}
    <label>Description
      <textarea name="description" rows="3" maxlength="${EVENT_DESCRIPTION_MAX}">${escapeHtml(e.description)}</textarea>
    </label>
    <label>Duration (minutes)
      <input type="number" name="duration" required min="${EVENT_DURATION_MIN}" max="${EVENT_DURATION_MAX}" value="${escapeHtml(e.durationMinutes)}">
    </label>
    ${notes}
    <button type="submit" class="btn btn-primary">Save changes</button>
  </form>
</section>`;
}
