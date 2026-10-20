/**
 * Exhaustiveness gate for the accessibility fixtures (#1326).
 *
 * `a11y-pages.ts` is the list of pages the axe scan (and the UI preview) walks.
 * A page missing from it is not gated, which is how the violations in #853 /
 * #855 went unnoticed. A comment asking people to keep the list complete does
 * not hold, so this suite does: every `render*Page` export under `src/web`
 * must be called in `a11y-pages.ts`, or be named in `NOT_A_PAGE` with a reason.
 *
 * It reads source text only (no rendering, no DOM), so it runs in the default
 * `node` environment.
 */

import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = fileURLToPath(new URL("../../src/web/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./a11y-pages.ts", import.meta.url));

/**
 * `render*Page` exports that are not pages of their own. Keep the reason: an
 * entry here is a decision that something is not worth a fixture.
 */
const NOT_A_PAGE: Record<string, string> = {
  renderAdminPage:
    "the admin layout wrapper every admin page is built with, not a page; it is scanned through each of them",
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Names of the `render*Page` functions a source file exports. */
function exportedPageRenderers(source: string): string[] {
  const names: string[] = [];
  // `export function renderXPage`, `export async function …`, `export const …`
  const declared =
    /^export\s+(?:async\s+)?(?:function\s*\*?|const|let)\s+(render\w*Page)\b/gm;
  for (const match of source.matchAll(declared)) names.push(match[1]);
  // `export { renderXPage, renderYPage as renderZPage }`, with or without `from`
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(",")) {
      const exported =
        part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? "";
      if (/^render\w*Page$/.test(exported)) names.push(exported);
    }
  }
  return names;
}

function renderersInWeb(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(WEB_DIR)) {
    for (const name of exportedPageRenderers(fs.readFileSync(file, "utf8"))) {
      found.set(name, path.relative(WEB_DIR, file));
    }
  }
  return found;
}

/** The fixtures file without comment lines, so a mention is not a call. */
function fixtureCode(): string {
  return fs
    .readFileSync(FIXTURES, "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

function isCalled(code: string, name: string): boolean {
  return code.includes(`${name}(`);
}

describe("every Web UI page has an axe fixture (#1326)", () => {
  const renderers = renderersInWeb();
  const code = fixtureCode();

  it("finds the page renderers it is meant to guard", () => {
    // Guards the scan itself: if the pattern or the path stops matching, an
    // empty list would pass every check below.
    expect(renderers.size).toBeGreaterThan(20);
    expect(renderers.has("renderDashboardPage")).toBe(true);
  });

  for (const [name, file] of [...renderers].sort()) {
    if (name in NOT_A_PAGE) continue;
    it(`${name} (${file}) is called in a11y-pages.ts`, () => {
      expect(isCalled(code, name)).toBe(true);
    });
  }

  it("keeps NOT_A_PAGE honest", () => {
    for (const name of Object.keys(NOT_A_PAGE)) {
      // Still exported, and still without a fixture of its own; otherwise the
      // entry is stale and hides nothing but a decision.
      expect(renderers.has(name)).toBe(true);
      expect(isCalled(code, name)).toBe(false);
    }
  });
});
