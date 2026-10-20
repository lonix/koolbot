/**
 * Guard (#1324): every Discord embed accent colour comes from
 * `embedColor(kind)` in `src/utils/embed-style.ts`, never a hex literal at the
 * call site. Plain regex scan over the TypeScript sources (comments stripped).
 * The Web UI (`src/web/`) is CSS/HTML and is covered by the design-token
 * tests instead.
 *
 * A file may only be listed in ALLOWED with a reason. Add a colour a community
 * chooses, or a value that is not an embed colour, there; do not add an
 * embed's own accent.
 */
import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../src",
);

const ALLOWED: Record<string, string> = {
  "content/notice-categories.ts":
    "per-category colours of the notice board; the community's own palette",
  "services/role-group-plan.ts": "0xffffff is the Discord role-colour maximum",
};

/** 6-digit hex number (0xRRGGBB) or a "#rrggbb" string literal. */
const COLOUR_LITERAL = /\b0x[0-9a-fA-F]{6}\b|["'`]#[0-9a-fA-F]{6}["'`]/g;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "web" ? [] : walk(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

function findLiterals(
  files: string[],
  root: string,
  allowed: Record<string, string>,
): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel in allowed) continue;
    const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(COLOUR_LITERAL)) {
        hits.push(`${rel}:${i + 1}: ${m[0]}`);
      }
    });
  }
  return hits;
}

describe("embed colour guard", () => {
  it("finds source files to scan", () => {
    expect(walk(SRC).length).toBeGreaterThan(50);
  });

  it("has no colour literal outside the allow-list", () => {
    expect(findLiterals(walk(SRC), SRC, ALLOWED)).toEqual([]);
  });

  it("every allow-list entry still exists and still needs the exemption", () => {
    for (const rel of Object.keys(ALLOWED)) {
      const source = stripComments(
        fs.readFileSync(path.join(SRC, rel), "utf8"),
      );
      expect(source.match(COLOUR_LITERAL)).not.toBeNull();
    }
  });

  it("detects the literal forms it is meant to catch (self-test)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "embed-guard-"));
    try {
      const f = path.join(tmp, "x.ts");
      for (const bad of [
        "e.setColor(0x5865f2);",
        "e.setColor(0xED4245);",
        'log({ color: "#00ff00" });',
        "const c = 0xabcdef;",
      ]) {
        fs.writeFileSync(f, bad);
        expect(findLiterals([f], tmp, {})).toHaveLength(1);
      }
      for (const fine of [
        'e.setColor(embedColor("ok"));',
        "// was 0x5865f2",
        "/* 0x5865f2 */",
        "const seed = 0x6d2b79f5;",
        "const color = event.color;",
      ]) {
        fs.writeFileSync(f, fine);
        expect(findLiterals([f], tmp, {})).toHaveLength(0);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
