/**
 * Body of the "New event" page (#1305), rendered inside `renderUserPage` at
 * `/me/events/new`: an event host creates an event of their own. Same fields and
 * names as the admin form (`renderEventsPage`), so one pipeline
 * (`event-create.ts`) reads both. Built from the shared `kb-` components
 * (docs/design/pages.md, NewEventPage); the Groups block is the shared one
 * (`renderGroupsSection`), which #1299 reworks in one place for every form.
 *
 * Nothing here decides who may create: the route's host scope does. The page
 * has no Repeat field, because a host's events do not repeat.
 */

import { escapeHtml, scriptTag } from "./html.js";
import { renderSegmented } from "./setting-controls.js";
import { EVENT_GROUPS_SCRIPT, renderGroupsSection } from "./admin-views.js";
import {
  EVENT_WHEN_CHOICES,
  EVENT_WHEN_LABELS,
  EVENT_WHEN_SCRIPT,
} from "./event-when.js";
import {
  EVENT_DESCRIPTION_MAX,
  EVENT_TITLE_MAX,
} from "../services/event-edit.js";
import type { EventGroupPreset } from "../content/event-group-presets.js";

export interface NewEventViewProps {
  csrfToken: string;
  /** Resolved server zone, offered first in the timezone select. */
  timezone: string;
  /** `events.default_duration_minutes`, selected by default. */
  defaultDurationMinutes: number;
  groupLimits: { defaultCount: number; maxCount: number };
  groupPresets: readonly EventGroupPreset[];
  groupPresetsNotice: string | null;
  /** The channel category or the announcement channel is not set. */
  setupNotice?: string | null;
}

/** Preset lengths, in minutes (docs/design NumberField: durations are chosen). */
const DURATION_PRESETS = [30, 45, 60, 90, 120, 180, 240] as const;

function durationOptions(selected: number): string {
  const values = [...new Set<number>([...DURATION_PRESETS, selected])].sort(
    (a, b) => a - b,
  );
  return values
    .map(
      (m) =>
        `<option value="${m}"${m === selected ? " selected" : ""}>${m} minutes</option>`,
    )
    .join("");
}

/** The server's zone first, then every zone the runtime knows. */
function timezoneOptions(serverZone: string): string {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  const rest = zones.filter((z) => z !== serverZone);
  return [
    `<option value="${escapeHtml(serverZone)}" selected>${escapeHtml(serverZone)} (server)</option>`,
    ...rest.map(
      (z) => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`,
    ),
  ].join("");
}

// The shared Groups block still uses plain label/field markup, which the member
// layout does not style (as the preset editor, `me-event-presets-page.ts`).
// Scoped to that block so the kb- controls around it are untouched.
const GROUPS_STYLE =
  "<style>[data-groups-section] label{display:block;margin:0 0 .75rem}[data-groups-section] label.checkbox{display:flex;gap:.5rem;align-items:flex-start}[data-groups-section] input[type=text],[data-groups-section] input[type=number],[data-groups-section] select{display:block;max-width:100%}[data-groups-section] fieldset{margin:0 0 .75rem}</style>";

export function renderNewEventBody(props: NewEventViewProps): string {
  const when = renderSegmented(
    "when",
    EVENT_WHEN_CHOICES.map((value) => ({
      value,
      label: EVENT_WHEN_LABELS[value],
    })),
    "pick",
    { id: "new-event-when", labelledBy: "new-event-when-label" },
  );
  const notice = props.setupNotice
    ? `<div class="kb-callout kb-callout--warn" role="status"><div class="kb-callout__body"><p class="kb-callout__title">${escapeHtml(props.setupNotice)}</p><p class="kb-callout__text">Ask an admin to finish setting up Events.</p></div></div>`
    : "";
  return `<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">New event</h1>
    <p class="kb-pagehead__sub">You will be the host. Plan it for later, or start it right now and the voice channels are ready at once.</p>
  </div>
</header>
${notice}
${GROUPS_STYLE}
<form method="POST" action="/me/events/new" class="kb-stack" data-event-form>
  <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
  <section class="kb-panel" aria-labelledby="new-event-when-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="new-event-when-h">When</h2></header>
    <div class="kb-panel__body kb-stack">
      <div class="kb-field">
        <span class="kb-label" id="new-event-when-label">Start</span>
        ${when}
        <p class="kb-help">Now starts the event at once: the channels are created straight away, the announcement says it is happening now and no reminder is sent.</p>
      </div>
      <div class="kb-fields" data-when-pick>
        <div class="kb-field">
          <label class="kb-label" for="new-event-date">Date</label>
          <input class="kb-input" id="new-event-date" type="date" name="date">
        </div>
        <div class="kb-field">
          <label class="kb-label" for="new-event-time">Time (24 hours)</label>
          <input class="kb-input" id="new-event-time" type="time" name="time">
        </div>
        <div class="kb-field">
          <label class="kb-label" for="new-event-timezone">Timezone</label>
          <select class="kb-select" id="new-event-timezone" name="timezone">${timezoneOptions(props.timezone)}</select>
        </div>
      </div>
    </div>
  </section>
  <section class="kb-panel" aria-labelledby="new-event-details-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="new-event-details-h">Details</h2></header>
    <div class="kb-panel__body kb-stack">
      <div class="kb-field">
        <label class="kb-label" for="new-event-title">Title</label>
        <input class="kb-input" id="new-event-title" type="text" name="title" required maxlength="${EVENT_TITLE_MAX}" placeholder="Game night">
      </div>
      <div class="kb-field">
        <label class="kb-label" for="new-event-description">Description (optional)</label>
        <textarea class="kb-textarea" id="new-event-description" name="description" rows="3" maxlength="${EVENT_DESCRIPTION_MAX}" placeholder="What is happening?"></textarea>
      </div>
      <div class="kb-field">
        <label class="kb-label" for="new-event-duration">Duration</label>
        <select class="kb-select" id="new-event-duration" name="duration">${durationOptions(props.defaultDurationMinutes)}</select>
      </div>
    </div>
  </section>
  <section class="kb-panel" aria-labelledby="new-event-groups-h">
    <header class="kb-panel__head"><h2 class="kb-panel__title" id="new-event-groups-h">Groups</h2></header>
    <div class="kb-panel__body">
      ${renderGroupsSection(props.groupLimits, props.groupPresets, props.groupPresetsNotice, "/me/events/presets")}
    </div>
  </section>
  <div class="kb-row"><button type="submit" class="kb-btn kb-btn--primary">Create event</button></div>
</form>
${scriptTag(EVENT_GROUPS_SCRIPT)}
${EVENT_WHEN_SCRIPT}`;
}
