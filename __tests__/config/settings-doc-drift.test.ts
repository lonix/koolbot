import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/services/config-schema.js";

/**
 * Guards `SETTINGS.md` against drifting away from `config-schema.ts` (#846).
 *
 * The reference tables used to advertise three keys that no longer existed —
 * one of them (`voicetracking.announcements.channel`) a single suffix away
 * from the real key, so an admin copying it got an unexplained "unknown key"
 * rejection from the Settings page. Four real keys were meanwhile
 * undocumented. Both directions are checked here so neither can recur
 * silently.
 */

const SETTINGS_MD = readFileSync(
  fileURLToPath(new URL("../../SETTINGS.md", import.meta.url)),
  "utf8",
);

const schemaKeys = Object.keys(defaultConfig).sort();

/** Top-level namespaces that a documented key is expected to belong to. */
const schemaNamespaces = new Set(schemaKeys.map((key) => key.split(".")[0]));

/**
 * Dotted names that live in the `SETTINGS.md` prose but are deliberately not
 * config keys. Extend this only for things that genuinely aren't settings.
 */
const NON_CONFIG_DOTTED_NAMES = new Set<string>([
  // Per-user notification opt-ins stored on the user document, not in config.
  "prefs.digest",
  "prefs.rewind",
]);

/** Every `` `foo.bar` `` token in the doc that looks like a config key. */
function documentedKeys(): string[] {
  const found = new Set<string>();
  for (const match of SETTINGS_MD.matchAll(/`([a-z_]+(?:\.[a-z_0-9]+)+)`/g)) {
    const name = match[1];
    if (NON_CONFIG_DOTTED_NAMES.has(name)) continue;
    if (!schemaNamespaces.has(name.split(".")[0])) continue;
    found.add(name);
  }
  return [...found].sort();
}

describe("SETTINGS.md / config-schema drift", () => {
  it("documents no key that is absent from the schema", () => {
    const phantom = documentedKeys().filter(
      (key) => !(key in defaultConfig),
    );
    expect(phantom).toEqual([]);
  });

  it("mentions every key declared in the schema", () => {
    const documented = new Set(documentedKeys());
    const undocumented = schemaKeys.filter((key) => !documented.has(key));
    expect(undocumented).toEqual([]);
  });
});
