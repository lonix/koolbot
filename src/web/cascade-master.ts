/**
 * Shared cascade-master selection for Settings sections (#485, #1068).
 *
 * The master of a section is its own top-level `<category>.enabled` switch and
 * nothing else: the key must equal `<the key's Settings section>.enabled`, so a
 * foreign two-segment toggle that happens to live in the section (e.g.
 * `aka.enabled` inside `namehistory`) is never picked. Sections whose toggles are all independent (e.g. `core.*`,
 * where every toggle is `core.<name>.enabled`) have no master, so no control
 * is greyed out and every submitted key is saved. The client (admin-views)
 * and the server (`/settings/save-section`) both go through this one function
 * so they can never pick different keys.
 */
export function pickCascadeMasterKey(
  candidates: Iterable<{ key: string; isBoolean: boolean; category: string }>,
): string | null {
  for (const { key, isBoolean, category } of candidates) {
    if (isBoolean && key === `${category}.enabled`) return key;
  }
  return null;
}
