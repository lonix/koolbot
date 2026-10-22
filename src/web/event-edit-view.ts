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

import { escapeHtml, scriptTag } from "./html.js";
import { COVER_MAX_BYTES } from "../services/event-cover.js";
import { EVENT_COVER_UPLOAD_SCRIPT } from "./event-cover-upload.js";
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
  /**
   * `eventEditVersion` of the row shown, with `mode`; the save is refused if it
   * moved on.
   */
  version: string;
  mode: "full" | "limited";
  /**
   * The linked Discord event is already running (or its state could not be
   * read), so the start cannot move: shown as text, title still editable.
   */
  startLocked?: boolean;
  /**
   * Set for an event of a recurring series: the form then asks how far the
   * change reaches and has no default answer (`cadence` is the label, e.g.
   * "weekly").
   */
  series?: { cadence: string };
}

/**
 * The cover image panel (#1393). `editable`: the host can set, replace or remove
 * it; `series`: the event repeats, and the one cover is shared by every
 * occurrence. `unavailable`: why not (adopted, no longer mirrored, finished).
 */
export type EventEditCover =
  | { kind: "editable"; hasCover: boolean; series: boolean }
  | { kind: "unavailable"; reason: string };

/** The cover panel. A separate form from the details above: its save is not part of "Save changes". */
function renderCoverPanel(
  id: string,
  cover: EventEditCover,
  csrfToken: string,
  adminHref: string | null,
): string {
  const panel = hostPanelPath(id);
  const adminLink = adminHref
    ? `<p class="kb-help">Administrators can also manage it from <a href="${escapeHtml(adminHref)}">Events in the admin area</a>.</p>`
    : "";
  if (cover.kind === "unavailable") {
    return `<section class="kb-panel" aria-labelledby="edit-cover-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="edit-cover-h">Cover image</h2></header>
    <div class="kb-panel__body kb-stack">
      <p class="kb-help">${escapeHtml(cover.reason)}</p>
      ${adminLink}
    </div>
  </section>`;
  }
  const maxMb = COVER_MAX_BYTES / (1024 * 1024);
  const scope = cover.series
    ? `<p class="kb-help">This event repeats. The cover belongs to the whole series: it is shown on every occurrence, whether you edit this occurrence or this and following above.</p>`
    : "";
  const remove = cover.hasCover
    ? `<form method="POST" action="${escapeHtml(panel)}/cover/remove" data-confirm="Remove the cover image${cover.series ? " from the whole series" : ""}?">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <button type="submit" class="kb-btn kb-btn--danger">Remove cover</button>
      </form>`
    : "";
  return `<section class="kb-panel" aria-labelledby="edit-cover-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="edit-cover-h">Cover image</h2></header>
    <div class="kb-panel__body kb-stack">
      <p class="kb-help">${cover.hasCover ? "A cover image is set." : "No cover image yet."} It is shown on the Discord event within a minute of saving.</p>
      ${scope}
      <form method="POST" action="${escapeHtml(panel)}/cover" class="kb-stack" data-cover-upload data-max-bytes="${COVER_MAX_BYTES}">
        <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
        <div class="kb-fields">
          <div class="kb-field">
            <label class="kb-label" for="edit-cover-file">Image (PNG, JPEG or GIF, up to ${maxMb} MB)</label>
            <input class="kb-input" id="edit-cover-file" type="file" accept="image/png,image/jpeg,image/gif">
          </div>
        </div>
        <div class="kb-row"><button type="submit" class="kb-btn">${cover.hasCover ? "Replace cover" : "Upload cover"}</button> <span class="cover-msg kb-help" role="status" aria-live="polite"></span></div>
      </form>
      ${remove}
      ${adminLink}
    </div>
  </section>
  ${scriptTag(EVENT_COVER_UPLOAD_SCRIPT)}`;
}

/** The scope question of a recurring event (#1298): no option is pre-chosen. */
function renderScopeField(cadence: string): string {
  return `<div class="kb-fields">
        <div class="kb-field">
          <p class="kb-label" id="edit-scope-l">Apply this change to</p>
          <div class="kb-segmented" role="radiogroup" aria-labelledby="edit-scope-l" aria-describedby="edit-scope-h">
            <label><input type="radio" name="scope" value="occurrence" required><span>This occurrence</span></label>
            <label><input type="radio" name="scope" value="following" required><span>This and following</span></label>
          </div>
          <p class="kb-help" id="edit-scope-h">This event repeats ${escapeHtml(cadence)}. "This occurrence" leaves the next ones as they were. "This and following" also changes every later occurrence.</p>
        </div>
      </div>`;
}

export function renderEventEditBody(opts: {
  event: EventEditView;
  csrfToken: string;
  /** Left out when the page has no cover panel (events off). */
  cover?: EventEditCover;
  /** Set for an administrator: a link to the admin Events page. */
  adminEventsHref?: string;
}): string {
  const e = opts.event;
  const panel = hostPanelPath(e.id);
  const full = e.mode === "full";
  const titleField = `<div class="kb-fields">
        <div class="kb-field">
          <label class="kb-label" for="edit-title">Title</label>
          <input class="kb-input" id="edit-title" type="text" name="title" required maxlength="${EVENT_TITLE_MAX}" value="${escapeHtml(e.title)}">
        </div>
      </div>`;
  const scheduleFields =
    full && e.startLocked
      ? `${titleField}
      <p class="kb-help">The Discord event is already running (or its state could not be read), so the start time cannot move. You can still change the title, description and duration.</p>
      <dl class="kb-kv">
        <dt>Starts</dt><dd class="kb-mono">${escapeHtml(e.when)}</dd>
      </dl>`
      : full
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
  const foot =
    full && !e.startLocked
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
  <input type="hidden" name="mode" value="${full ? "full" : "limited"}">
  <input type="hidden" name="startEditable" value="${full && !e.startLocked ? "1" : "0"}">
  <section class="kb-panel" aria-labelledby="edit-event-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="edit-event-h">Event details</h2></header>
    <div class="kb-panel__body kb-stack">
      ${e.series ? renderScopeField(e.series.cadence) : ""}
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
</form>
${opts.cover ? renderCoverPanel(e.id, opts.cover, opts.csrfToken, opts.adminEventsHref ?? null) : ""}`;
}
