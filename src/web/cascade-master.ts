/**
 * Shared cascade-master selection for Settings sections (#485, #1068).
 *
 * The master of a section is its top-level `<category>.enabled` switch and
 * nothing else. Sections whose toggles are all independent (e.g. `core.*`,
 * where every toggle is `core.<name>.enabled`) have no master, so no control
 * is greyed out and every submitted key is saved. The client (admin-views)
 * and the server (`/settings/save-section`) both go through this one function
 * so they can never pick different keys.
 */
export function pickCascadeMasterKey(
  candidates: Iterable<{ key: string; isBoolean: boolean }>,
): string | null {
  for (const { key, isBoolean } of candidates) {
    if (isBoolean && /^[^.]+\.enabled$/.test(key)) return key;
  }
  return null;
}
