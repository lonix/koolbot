/**
 * Panel title wrap (#1698). `.kb-panel__title` is a flex row; a title that holds
 * a badge or a long name must wrap at phone width instead of overflowing or
 * clipping under a Settings savebar. One rule in `docs/design/kb.css` does it
 * for every title, so the pages do not each add `kb-row`.
 */
import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { adminPages, userPages } from "./a11y-pages.js";

const KB_CSS = fileURLToPath(
  new URL("../../docs/design/kb.css", import.meta.url),
);
const css = fs.readFileSync(KB_CSS, "utf8");

/** Declarations of the rule whose selector is exactly `selector`. */
function declarationsOf(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(m).not.toBeNull();
  return (m?.[1] ?? "")
    .split(";")
    .map((d) => d.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

describe(".kb-panel__title wraps (#1698)", () => {
  const title = declarationsOf(".kb-panel__title");

  it("is a flex row that may wrap", () => {
    expect(title).toContain("display: flex");
    expect(title).toContain("flex-wrap: wrap");
  });

  it("keeps its spacing on tokens and does not forbid wrapping", () => {
    expect(title).toContain("gap: var(--space-2)");
    expect(title.join(";")).not.toMatch(/nowrap/);
  });

  it("is not made unwrappable again by another rule", () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(
      ([, sel, body]) =>
        /\.kb-panel__title\b/.test(sel) && /flex-wrap:\s*nowrap/.test(body),
    );
    expect(rules).toHaveLength(0);
  });
});

// The three places the issue names: a title holding a badge sits inside
// `.kb-panel__title`, so the rule above reaches it.
describe("titles holding a badge sit in .kb-panel__title (#1698)", () => {
  const pages = [...adminPages(), ...userPages()];
  const titles = pages.flatMap((p) => {
    const doc = new JSDOM(p.html).window.document;
    return [...doc.querySelectorAll(".kb-panel__title")].map((t) => ({
      page: p.name,
      el: t,
    }));
  });

  it.each([
    ["me-moderation-page.ts: case title (action and status)", /^case-h$/, 2],
    ["adopt-view.ts: bot name and kind badge", /^bot-/, 1],
    ["user-layout.ts: preset name and Default badge", /-title$/, 1],
  ])("%s", (_name, idPattern, badges) => {
    const hits = titles.filter(
      ({ el }) =>
        idPattern.test(el.id) &&
        el.querySelectorAll(".kb-badge").length >= badges,
    );
    expect(hits.length).toBeGreaterThan(0);
    for (const { el } of hits) {
      expect(el.classList.contains("kb-panel__title")).toBe(true);
      // The owner chose the stylesheet rule: no per-title `kb-row`.
      expect(el.classList.contains("kb-row")).toBe(false);
    }
  });
});
