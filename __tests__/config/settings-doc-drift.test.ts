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

/**
 * Dotted names in the `SETTINGS.md` prose that are deliberately not config
 * keys. Every entry must be justified: an unjustified exemption is how a
 * genuinely misspelled key would slip past the phantom-key assertion. Extend
 * this only for things that are not settings at all — never to silence a key
 * that merely looks wrong.
 */
const NON_CONFIG_DOTTED_NAMES = new Set<string>([
  // Per-user notification opt-ins stored on the user document, not in config.
  "prefs.digest",
  "prefs.rewind",
  // WebUI audit-log action name written by the /me/privacy export (#719),
  // not a setting.
  "user.privacy.export",
]);

/**
 * File extensions that mark a backticked dotted token as a filename rather
 * than a config key. Applied as a category rule instead of listing each file
 * individually; `no config key looks like a filename` below pins the
 * assumption that no real key could be swallowed by it.
 */
const FILENAME_SUFFIXES = /\.(ts|js|cjs|mjs|json|md|ya?ml|env|lock)$/;

/**
 * Every `` `foo.bar` `` token in the doc that is claimed to be a config key.
 *
 * Deliberately *not* filtered by top-level namespace: a typo in the first
 * segment (`voicechannel.enabled` for `voicechannels.enabled`) is exactly the
 * drift this guard exists to catch, so an unrecognised namespace must fail
 * rather than be skipped.
 */
function documentedKeys(): string[] {
  const found = new Set<string>();
  for (const match of SETTINGS_MD.matchAll(/`([a-z_]+(?:\.[a-z_0-9]+)+)`/g)) {
    const name = match[1];
    if (NON_CONFIG_DOTTED_NAMES.has(name)) continue;
    if (FILENAME_SUFFIXES.test(name)) continue;
    found.add(name);
  }
  return [...found].sort();
}

describe("SETTINGS.md / config-schema drift", () => {
  it("documents no key that is absent from the schema", () => {
    const phantom = documentedKeys().filter((key) => !(key in defaultConfig));
    expect(phantom).toEqual([]);
  });

  it("mentions every key declared in the schema", () => {
    const documented = new Set(documentedKeys());
    const undocumented = schemaKeys.filter((key) => !documented.has(key));
    expect(undocumented).toEqual([]);
  });

  it("has no config key that looks like a filename", () => {
    // Keeps FILENAME_SUFFIXES from ever excusing a real key.
    expect(schemaKeys.filter((key) => FILENAME_SUFFIXES.test(key))).toEqual([]);
  });

  it("exempts no dotted name that is actually a config key", () => {
    // Keeps NON_CONFIG_DOTTED_NAMES from ever masking a documented real key.
    const bogus = [...NON_CONFIG_DOTTED_NAMES].filter(
      (name) => name in defaultConfig,
    );
    expect(bogus).toEqual([]);
  });
});
