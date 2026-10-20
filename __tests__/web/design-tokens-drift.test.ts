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

/** Every CSS hex length: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. */
const HEX_LITERAL =
  /(?<![&\w/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

/** Property or attribute names whose value is a colour (or a var() fallback). */
const COLOUR_CONTEXT =
  /(?:colou?r|background|border[\w-]*|outline[\w-]*|fill|stroke|shadow|gradient|--[\w-]+)\s*[:=(,]/i;

/** Attributes whose quoted value is an anchor or an identifier, not a colour. */
const ANCHOR_ATTRIBUTE =
  /(?:href|action|for|id|src|name|value|data-[\w-]+|aria-[\w-]+)\s*=\s*["'`]$/i;

/**
 * Hex colour literals in `source`. A `#abc` is a colour only in a colour
 * context (after a colour property, `fill=`, a `var()` fallback, or alone in
 * quotes); `#1315` in prose, `href="#add"` and `&#39;` are not. Digit-only
 * colours such as `#000` therefore count.
 */
function hexLiterals(source: string): string[] {
  return source.split("\n").flatMap((line) => {
    // The embed-colour form shows a person what a hex colour looks like
    // (`#5865F2`) and its pattern validates one: user input, not styling.
    if (line.includes("embedColor") || line.includes("Colour (hex")) {
      return [];
    }
    if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return [];
    const found: string[] = [];
    for (const m of line.matchAll(HEX_LITERAL)) {
      const at = m.index ?? 0;
      const before = line.slice(0, at);
      const after = line[at + m[0].length] ?? "";
      const segment = before.slice(
        Math.max(before.lastIndexOf(";"), before.lastIndexOf("{")) + 1,
      );
      const quoted = /["'`]$/.test(before) && after === before.slice(-1);
      if (ANCHOR_ATTRIBUTE.test(before)) continue;
      if (COLOUR_CONTEXT.test(segment) || quoted) found.push(m[0]);
    }
    return found;
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

  it.each([
    ["color:#fff;background:#0f1115", ["#fff", "#0f1115"]],
    ["color:#000", ["#000"]],
    ["background:#808080;", ["#808080"]],
    ["color:#abcd", ["#abcd"]],
    ["border:1px solid #12345678", ["#12345678"]],
    ["box-shadow:0 0 1px #000", ["#000"]],
    ['<rect fill="#fff">', ["#fff"]],
    ['const c = "#0f1115";', ["#0f1115"]],
    ["color:var(--x,#fff)", ["#fff"]],
    [
      "background:linear-gradient(135deg,#1e1b4b 0%,#312e81 100%)",
      ["#1e1b4b", "#312e81"],
    ],
    ["see #855 and #1315 and (#855)", []],
    ["Note: see #1315 and #abcd", []],
    ['<a href="#add">x</a>', []],
    ['<a href="#123">x</a>', []],
    ["&#39; and &#x27;", []],
    ["https://example.test/#fff", []],
    ["color:var(--text)", []],
  ])("matches %s", (source, expected) => {
    expect(hexLiterals(source)).toEqual(expected);
  });

  it("recognises an unknown token name", () => {
    expect(KNOWN.has("--not-a-token")).toBe(false);
  });
});
