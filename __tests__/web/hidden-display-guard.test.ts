/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
/**
 * An element that ships `hidden` must really be hidden without JavaScript.
 * The browser hides `[hidden]` with a user-agent rule, which any author rule
 * that sets `display` on the same element beats (`.kb-field { display: flex }`
 * showed the editors' Generate builder, with a button that does nothing, to a
 * visitor without scripts). jsdom has no cascade, so this works the cascade out
 * for `display` from the real stylesheets: every `[hidden]` element of every
 * rendered page must lose no `display` contest to a rule other than `none`.
 * The fix is an unstyled wrapper carrying `hidden`, or a `[hidden]` guard rule.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { allPages } from "./a11y-pages.js";

interface Rule {
  selector: string;
  display: string;
  important: boolean;
  spec: number;
  order: number;
}

function specificity(sel: string): number {
  const s = sel.replace(/"[^"]*"|'[^']*'/g, "");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const cls = (
    s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)(?!not\b|is\b|where\b)[\w-]+/g) ?? []
  ).length;
  const tags = (
    s.replace(/\[[^\]]*\]/g, "").match(/(^|[\s>+~(])[a-z][\w-]*/gi) ?? []
  ).length;
  return ids * 10000 + cls * 100 + tags;
}

function rulesOf(css: string, order: { n: number }): Rule[] {
  const out: Rule[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim();
    if (head.startsWith("@")) continue;
    const d =
      /(?:^|;)\s*display\s*:\s*([^;]+?)\s*(!important)?\s*(?:;|$)/i.exec(m[2]);
    if (!d) continue;
    for (const sel of head.split(",")) {
      const s = sel.trim();
      if (s)
        out.push({
          selector: s,
          display: d[1].trim().toLowerCase(),
          important: !!d[2],
          spec: specificity(s),
          order: order.n++,
        });
    }
  }
  return out;
}

const KB = readFileSync(resolve("docs/design/kb.css"), "utf8");

describe("hidden elements stay hidden without JavaScript", () => {
  it("no [hidden] element in a rendered page loses its display to a rule other than none", () => {
    const offenders = new Set<string>();
    let checked = 0;
    for (const page of allPages()) {
      const dom = new JSDOM(page.html);
      const doc = dom.window.document;
      const order = { n: 0 };
      const rules = rulesOf(KB, order);
      doc
        .querySelectorAll("style")
        .forEach((st) => rules.push(...rulesOf(st.textContent ?? "", order)));
      for (const el of Array.from(doc.querySelectorAll("[hidden]"))) {
        checked++;
        const hit = rules.filter((r) => {
          try {
            return el.matches(r.selector);
          } catch {
            return false;
          }
        });
        if (!hit.length) continue;
        hit.sort(
          (a, b) =>
            Number(a.important) - Number(b.important) ||
            a.spec - b.spec ||
            a.order - b.order,
        );
        const win = hit[hit.length - 1];
        if (win.display !== "none") {
          offenders.add(
            `<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}"> beaten by "${win.selector}" (display: ${win.display})`,
          );
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect([...offenders].sort()).toEqual([]);
  });
});
