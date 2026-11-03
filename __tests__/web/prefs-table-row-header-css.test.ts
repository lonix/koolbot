/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
import { describe, it, expect } from "@jest/globals";

/* global DOMParser */
import { allPages } from "./a11y-pages.js";

/** The member layout's stylesheet, read from a rendered page with jsdom. */
function memberCss(): string {
  const page = allPages().find((p) => p.name === "/me privacy");
  if (!page) throw new Error("no /me privacy fixture");
  const doc = new DOMParser().parseFromString(page.html, "text/html");
  return Array.from(doc.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
}

/** Declarations of the rule whose selector list contains `selector` exactly. */
function declarationsOf(css: string, selector: string): string | undefined {
  for (const chunk of css.split("}")) {
    const open = chunk.indexOf("{");
    if (open === -1) continue;
    const selectors = chunk
      .slice(0, open)
      .split(",")
      .map((s) => s.trim());
    if (selectors.includes(selector)) return chunk.slice(open + 1);
  }
  return undefined;
}

describe("member table row headers: the .prefs-table rules are gone (#1515, #1711)", () => {
  const css = memberCss();

  it("no mono row-header rule is left in the member sheet", () => {
    expect(
      declarationsOf(css, ".prefs-table tbody th[scope=row].mono"),
    ).toBeUndefined();
  });

  it("no muted row-header rule is left in the member sheet", () => {
    expect(
      declarationsOf(css, ".prefs-table tbody th[scope=row].muted"),
    ).toBeUndefined();
  });

  it("no .prefs-table rule is left at all", () => {
    expect(css).not.toContain(".prefs-table");
  });
});
