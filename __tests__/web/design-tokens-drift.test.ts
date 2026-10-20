/**
 * Design-token drift gate (#1315). `docs/design/tokens.json` is the one source
 * for the Web UI palette, spacing, radii, layout sizes and type scale; the
 * stylesheets and the TypeScript renderers may only refer to it by
 * `var(--name)`. This reads SOURCE FILES as plain text (never rendered HTML):
 *  - every `var(--name)` in `kb.css` and `src/web/**` is a generated token or
 *    is defined in `kb.css` itself,
 *  - no hex colour literal is left in `src/web` or `kb.css`,
 *  - no `font-size` literal is left in `kb.css`.
 */
import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTokensCss,
  type DesignTokens,
} from "../../src/web/design-assets.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WEB_DIR = path.join(REPO_ROOT, "src/web");
const KB_CSS = path.join(REPO_ROOT, "docs/design/kb.css");
const TOKENS_JSON = path.join(REPO_ROOT, "docs/design/tokens.json");

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return listTs(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

const tokens = JSON.parse(fs.readFileSync(TOKENS_JSON, "utf8")) as DesignTokens;
const generated = buildTokensCss(tokens);
const kbCss = fs.readFileSync(KB_CSS, "utf8");

function declaredVars(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

function usedVars(source: string): string[] {
  return [...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
}

const KNOWN = new Set([...declaredVars(generated), ...declaredVars(kbCss)]);

/** `#rgb`, `#rrggbb` and `#rrggbbaa`; issue numbers such as `#855` have no a-f letter and are skipped. */
const HEX_LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

function hexLiterals(source: string): string[] {
  return source.split("\n").flatMap((line) => {
    // The embed-colour form shows a person what a hex colour looks like
    // (`#5865F2`) and its pattern validates one: user input, not styling.
    if (line.includes("embedColor") || line.includes("Colour (hex")) {
      return [];
    }
    return (line.match(HEX_LITERAL) ?? []).filter((h) => /[a-fA-F]/.test(h));
  });
}

describe("design token drift (#1315)", () => {
  it("generates a property for every colour, spacing, radius, layout and type token", () => {
    for (const name of [
      "bg",
      "warn-bg",
      "space-4",
      "radius-lg",
      "content-max",
      "shadow-pop",
      "font-sans",
      "font-mono",
      "type-body-size",
      "type-body-line-height",
      "type-body-weight",
      "type-overline-letter-spacing",
    ]) {
      expect(KNOWN.has(`--${name}`)).toBe(true);
    }
    // `{warn}` style references become var() links, never literal braces.
    expect(generated).toContain("--embed-warn: var(--warn);");
    expect(generated).not.toContain("{warn}");
  });

  it("only uses var(--name) that exist in tokens.json or kb.css", () => {
    const missing: string[] = [];
    for (const file of [KB_CSS, ...listTs(WEB_DIR)]) {
      for (const name of usedVars(fs.readFileSync(file, "utf8"))) {
        if (!KNOWN.has(name)) {
          missing.push(`${path.relative(REPO_ROOT, file)}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("leaves no hex colour literal in src/web or kb.css", () => {
    const found: string[] = [];
    for (const file of [KB_CSS, ...listTs(WEB_DIR)]) {
      for (const hex of hexLiterals(fs.readFileSync(file, "utf8"))) {
        found.push(`${path.relative(REPO_ROOT, file)}: ${hex}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("leaves no font-size literal in kb.css", () => {
    const found = kbCss
      .split("\n")
      .filter((line) => /font-size:\s*[0-9.]/.test(line));
    expect(found).toEqual([]);
  });

  it("recognises the regressions it exists for", () => {
    expect(hexLiterals("color:#fff;background:#0f1115")).toHaveLength(2);
    expect(hexLiterals("see #855 and #1315")).toEqual([]);
    expect(KNOWN.has("--not-a-token")).toBe(false);
  });
});
