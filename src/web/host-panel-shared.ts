/**
 * Pure helpers of the event host panel (#1189) that need no database model,
 * so the page layouts, the view and the access module can all import them
 * without pulling in the event model or each other.
 */

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
 * The registry entries (`bot-permission-registry.ts`) that are checked in the
 * events category, so one event can name the category it really uses (#1467).
 */
const EVENT_CATEGORY_ENTRIES = [
  "event-channels",
  "event-host-access",
  "event-leads-channel",
  "event-moves",
] as const;

/**
 * Where one event's channels really live, for the permission check, following
 * the event services' own placement: the group channels sit in the main
 * channel's category (`event-group-channels.ts`), and before the main channel
 * exists `EventService.resolveEventCategory` takes the event's category, then
 * the `events.category_id` setting. Returns the category id per registry entry,
 * or `{}` to leave the configured category in place.
 */
export function eventPermissionTargets(
  event: { channelId?: string | null; categoryId?: string | null },
  parentOf: (channelId: string) => string | null | undefined,
): Record<string, string> {
  const category =
    (event.channelId ? parentOf(event.channelId) : null) ||
    event.categoryId ||
    "";
  if (!category) return {};
  return Object.fromEntries(EVENT_CATEGORY_ENTRIES.map((id) => [id, category]));
}
