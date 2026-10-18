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
