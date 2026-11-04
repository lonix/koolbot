/**
 * Every scroll container is also a containing block (#1735).
 *
 * `.kb-visually-hidden` and `.visually-hidden` are `position: absolute`. An absolutely positioned box is
 * clipped by a scroll container (`overflow-x: auto | scroll | clip`) only when that container is its
 * containing block, that is when the container is itself positioned. With no positioned ancestor inside
 * the container, the label's containing block is outside it, the container does not clip it, and a label
 * that sits past the container's right edge widens the whole document (a Role groups table made the page
 * scroll sideways by 261px at 1280px, against the "scroll inside their panel, never the page" rule, #855).
 *
 * jsdom has no layout, so this reads the stylesheets as text: every selector that sets `overflow-x` (or
 * the `overflow` shorthand) to `auto`, `scroll` or `clip` must also be given `position: relative`. The
 * measured proof is `node scripts/measure-ui-widths.mjs --strict` on the rendered fixtures.
 */
import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAdminPage } from "../../src/web/admin-layout.js";
import { renderUserPage } from "../../src/web/user-layout.js";

const KB_CSS = path.join(
  fileURLToPath(new URL("../../", import.meta.url)),
  "docs/design/kb.css",
);

interface Rule {
  selector: string;
  body: string;
}

/** Flat rules of a stylesheet (no at-rule nesting is needed here: scroll containers are top-level). */
function parseRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const selector of m[1].split(",")) {
      const s = selector.trim();
      if (s) rules.push({ selector: s, body: m[2] });
    }
  }
  return rules;
}

function styleOf(html: string): string {
  const m = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html);
  if (!m) throw new Error("page has no <style> block");
  return m[1];
}

const SCROLLS = /(?:^|;)\s*overflow(?:-x)?\s*:\s*(?:auto|scroll|clip)\b/;
const POSITIONED = /(?:^|;)\s*position\s*:\s*relative\b/;

/** Tag, id and classes of one compound selector; null for a selector with a combinator or pseudo. */
function compound(selector: string): { tag: string; rest: string[] } | null {
  if (/[\s>+~:[]/.test(selector)) return null;
  const parts = selector.match(/^([a-z0-9]*)((?:[.#][\w-]+)*)$/i);
  if (!parts) return null;
  return {
    tag: parts[1],
    rest: parts[2].match(/[.#][\w-]+/g) ?? [],
  };
}

/** A positioned rule `p` applies to everything `s` matches when `p` is `s` or a looser compound of it. */
function covers(p: string, s: string): boolean {
  if (p === s) return true;
  const a = compound(p);
  const b = compound(s);
  if (!a || !b) return false;
  return (
    (a.tag === "" || a.tag === b.tag) && a.rest.every((x) => b.rest.includes(x))
  );
}

function scrollContainersWithoutContainingBlock(css: string): string[] {
  const rules = parseRules(css);
  const positioned = rules
    .filter((r) => POSITIONED.test(r.body))
    .map((r) => r.selector);
  return rules
    .filter((r) => SCROLLS.test(r.body))
    .map((r) => r.selector)
    .filter((s) => !positioned.some((p) => covers(p, s)));
}

const adminCss = styleOf(
  renderAdminPage({
    title: "T",
    active: "/admin/",
    body: "<p>x</p>",
    csrfToken: "c",
    remainingMs: 1000,
  }),
);
const userCss = styleOf(
  renderUserPage({
    title: "T",
    active: "/me/",
    body: "<p>x</p>",
    csrfToken: "c",
    remainingMs: 1000,
    isAdmin: false,
  }),
);
const kbCss = fs.readFileSync(KB_CSS, "utf8");

describe("scroll containers are containing blocks (#1735)", () => {
  it("finds the scroll containers it is meant to guard", () => {
    const scrolling = (css: string) =>
      parseRules(css)
        .filter((r) => SCROLLS.test(r.body))
        .map((r) => r.selector);
    expect(scrolling(kbCss)).toContain(".kb-panel__body--flush");
    expect(scrolling(adminCss)).toEqual(
      expect.arrayContaining(["main", ".card", "main.has-savebar"]),
    );
    expect(scrolling(userCss)).toEqual(
      expect.arrayContaining(["#main", "#main.has-savebar"]),
    );
  });

  it("kb.css: every scrolling selector sets position: relative", () => {
    expect(scrollContainersWithoutContainingBlock(kbCss)).toEqual([]);
  });

  it("the admin layout STYLE block: every scrolling selector sets position: relative", () => {
    expect(scrollContainersWithoutContainingBlock(adminCss)).toEqual([]);
  });

  it("the member layout STYLE block: every scrolling selector sets position: relative", () => {
    expect(scrollContainersWithoutContainingBlock(userCss)).toEqual([]);
  });
});
