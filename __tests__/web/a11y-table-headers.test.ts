/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * Row and column headers in data tables (#1515).
 *
 * The design keeps the #854 / #855 rule "row headers in tables": every body
 * row of a data table starts with `th scope="row"`, the cell that names the
 * row, so a screen reader moving across a row hears "Weekly poll, Enabled, …"
 * and not a bare list of values. No axe rule requires it, so this guard walks
 * every page in `a11y-pages.ts` and parses it with jsdom.
 *
 * A table with one column is a list, and a row with one cell is an empty
 * state or a spanning note; neither needs a row header.
 */

import { describe, it, expect } from "@jest/globals";
import { allPages } from "./a11y-pages.js";

/**
 * Tables that are genuinely not data tables, keyed by `<page name>` and the
 * table's caption or first column header. Empty on purpose: every table the
 * fixtures render is a data table. Adding an entry is an owner decision.
 */
const NOT_DATA_TABLES: ReadonlyArray<{
  page: string;
  table: string;
  reason: string;
}> = [];

function tableLabel(table: Element): string {
  const caption = table.querySelector("caption")?.textContent?.trim();
  if (caption) return caption;
  return (table.querySelector("thead")?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The problems in one parsed document, one string per offending table. */
function tableHeaderProblems(doc: Document): string[] {
  const problems: string[] = [];
  doc.querySelectorAll("table").forEach((table) => {
    const rows = Array.from(table.querySelectorAll("tr"));
    const columns = Math.max(0, ...rows.map((r) => r.children.length));
    if (columns < 2) return;
    const label = tableLabel(table);
    const badColumns = Array.from(table.querySelectorAll("thead th")).filter(
      (th) => th.getAttribute("scope") !== "col",
    );
    const badRows = Array.from(table.querySelectorAll("tbody tr")).filter(
      (tr) =>
        tr.children.length > 1 && !tr.querySelector(":scope > th[scope=row]"),
    );
    if (badColumns.length > 0) {
      problems.push(
        `"${label}": ${badColumns.length} header cell(s) in thead without scope="col"`,
      );
    }
    if (badRows.length > 0) {
      problems.push(
        `"${label}": ${badRows.length} body row(s) without th scope="row"`,
      );
    }
  });
  return problems;
}

describe("WebUI data table headers (#1515)", () => {
  it("flags a body row without a row header and a column header without scope", () => {
    const doc = new DOMParser().parseFromString(
      `<table><thead><tr><th>A</th><th scope="col">B</th></tr></thead>
       <tbody><tr><td>x</td><td>y</td></tr><tr><td colspan="2">Nothing yet</td></tr></tbody></table>`,
      "text/html",
    );
    expect(tableHeaderProblems(doc)).toEqual([
      '"AB": 1 header cell(s) in thead without scope="col"',
      '"AB": 1 body row(s) without th scope="row"',
    ]);
  });

  it("accepts row headers, empty-state rows and one-column lists", () => {
    const doc = new DOMParser().parseFromString(
      `<table><thead><tr><th scope="col">A</th><th scope="col">B</th></tr></thead>
       <tbody><tr><th scope="row">x</th><td>y</td></tr><tr><td colspan="2">Nothing yet</td></tr></tbody></table>
       <table><tbody><tr><td>only</td></tr></tbody></table>`,
      "text/html",
    );
    expect(tableHeaderProblems(doc)).toEqual([]);
  });

  for (const page of allPages()) {
    it(`${page.name} names every data table row and column`, () => {
      const doc = new DOMParser().parseFromString(page.html, "text/html");
      const allowed = NOT_DATA_TABLES.filter((e) => e.page === page.name).map(
        (e) => e.table,
      );
      const problems = tableHeaderProblems(doc).filter(
        (p) => !allowed.some((t) => p.startsWith(`"${t}"`)),
      );
      expect(problems).toEqual([]);
    });
  }
});
