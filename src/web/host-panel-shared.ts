/**
 * Pure helpers of the event host panel (#1189) that need no database model,
 * so the page layouts, the view and the access module can all import them
 * without pulling in the event model or each other.
 */

import { escapeHtml } from "./html.js";

/** Base path of the host panel for one event. Later controls hang off it. */
export function hostPanelPath(eventId: string): string {
  return `/me/events/${encodeURIComponent(eventId)}/host`;
}

/**
 * Whether host controls are offered: only `scheduled` and `active` events.
 * Ended and cancelled events show a read-only summary, and `hostAction`
 * refuses writes against them.
 *
 * Extension point: an event whose native Discord event was adopted
 * (`nativeAdopted`, #1177) is never written to Discord by KoolBot. Controls
 * that would write to the native event must check that flag themselves.
 */
export function hostControlsAvailable(
  event: { state?: string | null } | null | undefined,
): boolean {
  return event?.state === "scheduled" || event?.state === "active";
}

/**
 * The one definition of a RUNNING event for the host's "Your events" page, its
 * Cancel guard and the atomic cancel claim (#1319): the event is `active` AND
 * its start has arrived. `active` alone is not enough, because the event's
 * channel is prepared (and the state set) a lead time BEFORE the start (15
 * minutes by default); until the start such an event is still upcoming and can
 * still be edited and cancelled. Start now on an impromptu event stores the
 * start 30 seconds ahead, so it counts as running within half a minute.
 * Limit: the model does not record that a host started a planned event early,
 * so one started before its start time stays upcoming until the start arrives.
 */
export function isEventRunning(
  event: { state?: string | null; startTime?: Date | null },
  now: Date,
): boolean {
  return (
    event.state === "active" &&
    event.startTime instanceof Date &&
    event.startTime.getTime() <= now.getTime()
  );
}

/**
 * The one set of state words for an event (#1518): *Your events* and the host
 * panel say the same thing for the same event. `running` is `isEventRunning`'s
 * answer; an `active` event that has not started yet is still *Planned*.
 * An unknown state is shown as it is stored.
 */
export function eventStateWord(
  state: string,
  running: boolean,
): { label: string; tone: "on" | "off" | "info" } {
  if (running) return { label: "Live", tone: "on" };
  if (state === "scheduled" || state === "active") {
    return { label: "Planned", tone: "info" };
  }
  if (state === "ended") return { label: "Ended", tone: "info" };
  if (state === "cancelled") return { label: "Cancelled", tone: "off" };
  return { label: state, tone: "info" };
}

/** The state as a `kb-badge`, with the word from `eventStateWord`. */
export function renderEventStateBadge(state: string, running: boolean): string {
  const { label, tone } = eventStateWord(state, running);
  return `<span class="kb-badge kb-badge--${tone}">${escapeHtml(label)}</span>`;
}
