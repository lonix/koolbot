/**
 * The one rule for an event the native Discord event sync leaves alone, kept
 * free of imports so the host panel's permission notice can read the same rule
 * `NativeEventSync.syncEvent` applies, instead of a copy of it (#1467).
 */

/**
 * A detached event (its Discord event was deleted there) that is still open is
 * neither re-created nor edited. Granting Create Events will not bring its card
 * back, so nothing about that permission concerns it.
 */
export function nativeSyncPaused(event: {
  state?: string | null;
  nativeDetached?: boolean | null;
}): boolean {
  const terminal = event.state === "ended" || event.state === "cancelled";
  return !terminal && event.nativeDetached === true;
}
