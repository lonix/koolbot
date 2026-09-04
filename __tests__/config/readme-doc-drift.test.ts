import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMAND_CONFIGS } from "../../src/services/command-registry.js";
import {
  categoryMetadata,
  settingsMetadata,
} from "../../src/services/config-schema.js";

/**
 * Guards the two README tables that duplicate registry state against drift
 * (#923). `/remind` shipped in #902 and the Reminders/Privacy categories in
 * #902/#910, but none of them reached the README — and the README is the
 * landing page, so a feature missing from it is invisible to anyone who does
 * not open `COMMANDS.md` / `SETTINGS.md`.
 *
 * Both checks run in the "every registry entry is documented" direction, plus
 * the reverse for categories so a retired one cannot linger in the table.
 */

const README = readFileSync(
  fileURLToPath(new URL("../../README.md", import.meta.url)),
  "utf8",
);

/** The body of a `### <heading>` section, up to the next heading or rule. */
function section(heading: string): string {
  const start = README.indexOf(`### ${heading}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = README.slice(start + heading.length + 4);
  const end = rest.search(/\n(?:#{2,3} |---)/);
  return end === -1 ? rest : rest.slice(0, end);
}

const COMMANDS_SECTION = section("Available Commands");
const CATEGORIES_SECTION = section("Configuration categories");

/** Category slugs that no `settingsMetadata` entry uses, so they have no
 * settings to document. `other` is the schema's fallback bucket for rows
 * without metadata; both are deliberately absent from the README table. */
const CATEGORIES_WITHOUT_SETTINGS = new Set<string>(["other"]);

/** `**Title**` from each row of the categories table. */
function documentedCategoryTitles(): string[] {
  return [...CATEGORIES_SECTION.matchAll(/^\| \*\*(.+?)\*\* \|/gm)].map(
    (match) => match[1],
  );
}

describe("README / registry drift", () => {
  it("lists every command in COMMAND_CONFIGS", () => {
    const undocumented = COMMAND_CONFIGS.filter(
      ({ name }) =>
        // Matches `/name` and `/name subcommand` alike, but not a longer
        // command name that merely starts with the same word.
        !new RegExp(`\`/${name}(?![a-z-])`).test(COMMANDS_SECTION),
    ).map(({ name }) => name);
    expect(undocumented).toEqual([]);
  });

  it("has a categories-table row for every category that owns settings", () => {
    const documented = new Set(documentedCategoryTitles());
    const undocumented = [
      ...new Set(Object.values(settingsMetadata).map((m) => m.category)),
    ]
      .filter((slug) => !documented.has(categoryMetadata[slug]?.title ?? slug))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it("documents no category row that no setting uses", () => {
    const live = new Map(
      Object.entries(categoryMetadata)
        .filter(
          ([slug]) =>
            !CATEGORIES_WITHOUT_SETTINGS.has(slug) &&
            Object.values(settingsMetadata).some((m) => m.category === slug),
        )
        .map(([, meta]) => [meta.title, true]),
    );
    const stale = documentedCategoryTitles().filter(
      (title) => !live.has(title),
    );
    expect(stale).toEqual([]);
  });
});
