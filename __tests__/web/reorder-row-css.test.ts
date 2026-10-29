import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const kbCss = readFileSync(path.join(here, "../../docs/design/kb.css"), "utf8");

/** Every `selector { declarations }` pair, comments removed (plain CSS, no nesting). */
function rules(css: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  const clean = css.split("/*").flatMap((part, i) => {
    if (i === 0) return [part];
    const end = part.indexOf("*/");
    return [end === -1 ? "" : part.slice(end + 2)];
  });
  for (const chunk of clean.join("").split("}")) {
    const open = chunk.indexOf("{");
    if (open === -1) continue;
    out.push({
      selectors: chunk
        .slice(0, open)
        .split(",")
        .map((s) => s.trim()),
      body: chunk.slice(open + 1),
    });
  }
  return out;
}

describe("reorder row drag feedback (#1515)", () => {
  it("colours the whole row: every drag rule that names td also names th[scope=row]", () => {
    const drag = rules(kbCss).filter((r) =>
      r.selectors.some(
        (s) => s.includes("[data-reorder-row]") && /td\b/.test(s),
      ),
    );
    expect(drag.length).toBeGreaterThan(0);
    for (const r of drag) {
      for (const s of r.selectors.filter((x) => /td\b/.test(x))) {
        expect(r.selectors).toContain(s.replace(/\btd\b/, 'th[scope="row"]'));
      }
    }
  });
});
