import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { ICONS, icon, toneIcon, type IconName } from "../../src/web/icons.js";

/** The icon names DESIGN.md > Iconography lists: every backticked token in that section. */
function designIconNames(): string[] {
  const design = readFileSync(join(process.cwd(), "DESIGN.md"), "utf8");
  const section =
    design
      .split("## Iconography")[1]
      ?.split(/\n## /)[0]
      ?.split("**As built")[0] ?? "";
  const names = [...section.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)].map(
    (m) => m[1],
  );
  // `kb-icon` and `kb-icon--lg` are CSS classes named in the prose.
  return [...new Set(names)].filter((n) => !n.startsWith("kb-"));
}

describe("shared icon helper", () => {
  it("has every icon DESIGN.md > Iconography lists", () => {
    const listed = designIconNames();
    // Guards the parser: a broken section split would pass vacuously.
    expect(listed.length).toBeGreaterThan(50);
    expect(listed).toEqual(
      expect.arrayContaining(["triangle-alert", "volume-2", "chevron-right"]),
    );
    const missing = listed.filter((n) => !(n in ICONS));
    expect(missing).toEqual([]);
  });

  it("draws each icon as a decorative 24x24 svg by default", () => {
    for (const name of Object.keys(ICONS) as IconName[]) {
      const svg = icon(name);
      expect(svg).toMatch(
        /^<svg class="kb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">.+<\/svg>$/,
      );
      expect(svg).not.toContain("role=");
    }
  });

  it("gives a labelled icon an accessible name and no aria-hidden", () => {
    const svg = icon("hash", { label: 'Text "channel"' });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Text &quot;channel&quot;"');
    expect(svg).not.toContain("aria-hidden");
  });

  it("escapes the label and class names", () => {
    const svg = icon("info", {
      label: "<script>x</script>",
      className: 'a" onload="x',
    });
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain('" onload="');
  });

  it("supports the large size and extra classes", () => {
    expect(icon("info", { large: true, className: "kb-chev" })).toContain(
      'class="kb-icon kb-icon--lg kb-chev"',
    );
  });

  it("maps each tone to its own shape, so colour is never the only cue", () => {
    const shapes = (["", "ok", "warn", "err"] as const).map((t) => toneIcon(t));
    expect(new Set(shapes).size).toBe(4);
    expect(toneIcon("")).toBe(icon("info"));
    expect(toneIcon("ok")).toBe(icon("circle-check"));
    expect(toneIcon("warn")).toBe(icon("triangle-alert"));
    expect(toneIcon("err")).toBe(icon("circle-x"));
  });
});
