/**
 * The `create:<Name>` values of a Command permissions save (#1760), taken out
 * of what the form posted. Kept apart from `permissions-role-create.ts` so the
 * route reads them without loading the Discord write code, which it only needs
 * when a role has to be created.
 */

import { parsePickerCreateValue } from "./setting-pickers.js";

/** The same name typed twice, in any case or spacing, is one role. The role plan cleans the name for Discord. */
const nameKey = (name: string): string =>
  name.replace(/\s+/g, " ").trim().toLowerCase();

export interface SplitCreateValues {
  /** The submitted values that are not `create:` values, in order. */
  rest: string[];
  /** The typed names, de-duplicated ignoring case and spacing, in typed order. */
  names: string[];
  /** Names that did not pass the Picker's own rule (blank, too long). */
  errors: string[];
}

/**
 * Takes the `create:` values out of what the form posted, before anything
 * reads the rest as role ids or group references: a `create:` value is never
 * stored, whatever happens to it.
 */
export function splitCreateValues(
  submitted: readonly string[],
): SplitCreateValues {
  const rest: string[] = [];
  const names: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const item of submitted) {
    const parsed = parsePickerCreateValue(item);
    if (!parsed) {
      rest.push(item);
    } else if (!parsed.ok) {
      if (!errors.includes(parsed.error)) errors.push(parsed.error);
    } else if (!seen.has(nameKey(parsed.name))) {
      seen.add(nameKey(parsed.name));
      names.push(parsed.name);
    }
  }
  return { rest, names, errors };
}
