/**
 * WCAG contrast gate for the WebUI palette (issue #856).
 *
 * axe's own `color-contrast` rule can't run in the jsdom-based scan
 * (`a11y-axe.test.ts`) because jsdom does no layout or style cascade. The
 * palette is a small set of tokens in `docs/design/tokens.json` though, so the
 * ratios can be computed directly — which is what would have caught the six
 * contrast misses fixed in #855 (`#6b7280` at 3.6:1, `#ef4444` at 3.8:1, …)
 * before they shipped.
 *
 * Every colour token must either appear in a pair below or be named in
 * `DECORATIVE` with a reason; the last suite fails otherwise (#1326), so a new
 * token cannot skip the gate.
 */

import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";

// The palette is whatever `docs/design/tokens.json` says (#1315); read it
// here so a token edit is gated by the same ratios as the stylesheet it feeds.
const RAW_TOKENS = (
  JSON.parse(
    fs.readFileSync(
      new URL("../../docs/design/tokens.json", import.meta.url),
      "utf8",
    ),
  ) as { color: { tokens: Array<{ name: string; value: string }> } }
).color.tokens;

const RAW_VALUES = new Map(RAW_TOKENS.map((t) => [t.name, t.value]));

/** A token's colour, following `{alias}` values (`embed-warn` is `{warn}`). */
function resolve(name: string, seen: string[] = []): string {
  if (seen.includes(name)) {
    throw new Error(
      `Alias cycle in tokens.json: ${[...seen, name].join(" -> ")}`,
    );
  }
  const value = RAW_VALUES.get(name);
  if (!value) throw new Error(`No colour token named ${name}`);
  const alias = /^\{([\w-]+)\}$/.exec(value);
  return alias ? resolve(alias[1], [...seen, name]) : value;
}

/** WCAG 1.4.3 floor for body text. */
const TEXT_MIN = 4.5;
/** WCAG 1.4.11 floor for UI-component boundaries and focus indicators. */
const UI_MIN = 3;

/** Expand `#abc` / `#aabbcc` into its three 0–255 channels. */
function channels(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour: ${hex}`);
  }
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** Relative luminance per WCAG 2.x. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two colours, 1 (identical) … 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

interface Pair {
  what: string;
  /** Token names, so the coverage suite can see which tokens are gated. */
  fg: string;
  bg: string;
  min: number;
}

const pair = (what: string, fg: string, bg: string, min: number): Pair => ({
  what,
  fg,
  bg,
  min,
});

/** Grounds a text token can sit on (DESIGN.md, `docs/design/components.md`). */
const GROUNDS: Array<[string, string]> = [
  ["page background", "bg"],
  ["a card", "surface"],
  ["a table header", "surface-alt"],
  ["the top bar", "chrome"],
  ["the current nav item", "selected"],
];

/** Grounds a control edge, focus ring or warning can sit on (not `selected`). */
const SURFACES = GROUNDS.filter(([, bg]) => bg !== "selected");

/** Foreground tokens that carry text on those grounds, and owe 4.5:1 on each. */
const TEXT_TOKENS: Array<[string, string]> = [
  ["body text", "text"],
  ["secondary text", "text-secondary"],
  ["muted text", "muted"],
  ["link text", "link"],
];

const PAIRS: Pair[] = [
  ...TEXT_TOKENS.flatMap(([name, fg]) =>
    GROUNDS.map(([groundName, bg]) =>
      pair(`${name} on ${groundName}`, fg, bg, TEXT_MIN),
    ),
  ),
  // Warning text is for the page and the cards, not the selected nav item.
  ...SURFACES.map(([groundName, bg]) =>
    pair(`warning text on ${groundName}`, "warn", bg, TEXT_MIN),
  ),
  // Button fills carry their own label colour, so they're judged against it
  // rather than against the page.
  pair("primary button label", "on-primary", "primary", TEXT_MIN),
  pair("primary button label (hover)", "on-primary", "primary-hover", TEXT_MIN),
  pair("destructive button label", "on-primary", "danger", TEXT_MIN),
  pair(
    "destructive button label (hover)",
    "on-primary",
    "danger-hover",
    TEXT_MIN,
  ),
  pair("neutral button label", "on-primary", "fill", TEXT_MIN),
  pair("neutral button label (hover)", "on-primary", "fill-hover", TEXT_MIN),
  pair("current nav item label", "on-primary", "selected", TEXT_MIN),
  pair("pill text on a neutral pill", "pill-text", "fill", TEXT_MIN),
  // Notices and badges share one palette on the admin and member pages
  // (#1315): judge every pair the stylesheets use.
  ...(["ok", "err", "info", "warn"] as const).map((kind) =>
    pair(
      `${kind} notice text on its fill`,
      `${kind}-text`,
      `${kind}-bg`,
      TEXT_MIN,
    ),
  ),
  pair("info text on the current nav item", "info-text", "selected", TEXT_MIN),
  // Status dots reuse the notice text colours on any surface.
  ...(["ok", "err", "warn"] as const).flatMap((kind) =>
    SURFACES.map(([groundName, bg]) =>
      pair(`${kind} status dot on ${groundName}`, `${kind}-text`, bg, TEXT_MIN),
    ),
  ),
  // Activity data: Rewind's hero, and the peak hour in a heatmap or bar list.
  pair("Rewind text on the hero", "lore-text", "lore-deep", TEXT_MIN),
  pair("Rewind text on the year chip", "lore-text", "lore", TEXT_MIN),
  pair("heatmap peak on a card", "lore-peak", "surface", TEXT_MIN),
  // Non-text: a control's edge, the focus ring and meter fills only owe 3:1
  // (WCAG 1.4.11 / 2.4.11), but they owe it against every surface they can be
  // drawn on.
  ...SURFACES.flatMap(([groundName, bg]) => [
    pair(`form-control border on ${groundName}`, "control", bg, UI_MIN),
    pair(`focus ring on ${groundName}`, "focus", bg, UI_MIN),
  ]),
  pair("focus ring on the current nav item", "focus", "selected", UI_MIN),
  pair("meter fill and switch track on a card", "primary", "surface", UI_MIN),
];

/**
 * Colour tokens that carry no information on their own, so they owe no ratio.
 * Adding a token to `tokens.json` means adding a pair above or an entry here
 * (with the reason); the last suite fails until you do.
 */
const DECORATIVE: Record<string, string> = {
  border:
    "hairlines only (1.6:1 on purpose); a control's edge is `control`, which is paired",
  "heat-empty":
    "empty heatmap cell; every value is also in the cell's label and the bar list",
  "lore-fill":
    "heatmap cells and activity bars; the values are named in text beside them",
  scrim: "the dialog backdrop, bg at 70% (8-digit hex, not a text ground)",
  "embed-brand": "Discord embed accent bar; the title carries the meaning",
  "embed-ok": "Discord embed accent bar; the title carries the meaning",
  "embed-warn": "Discord embed accent bar (an alias of warn)",
  "embed-danger": "Discord embed accent bar; the title carries the meaning",
  "embed-neutral": "Discord embed accent bar (an alias of control)",
  "embed-lore": "Discord embed accent bar; the title carries the meaning",
};

describe("palette contrast (#856)", () => {
  for (const p of PAIRS) {
    it(`${p.what} clears ${p.min}:1`, () => {
      // Rounded to 2dp so a failure names the ratio you have to tune a
      // replacement colour against, not just "below the floor".
      const ratio = Number(
        contrastRatio(resolve(p.fg), resolve(p.bg)).toFixed(2),
      );
      expect(ratio).toBeGreaterThanOrEqual(p.min);
    });
  }

  it("keeps the greys that failed WCAG out of the palette (#855)", () => {
    // #6b7280 was 3.6:1 as muted text, #64748b failed as *text* (it survives
    // only as the control border, which owes 3:1), #b45309 was 3.4:1 as the
    // warning colour. Re-introducing one as a text colour is the regression
    // this guards.
    const textColours = ["text", "text-secondary", "muted", "link", "warn"].map(
      (name) => resolve(name),
    );
    for (const failed of ["#6b7280", "#b45309", "#ef4444"]) {
      expect(textColours).not.toContain(failed);
    }
  });

  it("treats the decorative hairline as decorative", () => {
    // `border` is deliberately below 3:1 — it draws card/table hairlines,
    // which convey nothing on their own. Form-control edges use `control`
    // instead precisely because they do.
    expect(contrastRatio(resolve("border"), resolve("bg"))).toBeLessThan(
      UI_MIN,
    );
    expect(
      contrastRatio(resolve("control"), resolve("bg")),
    ).toBeGreaterThanOrEqual(UI_MIN);
  });
});

describe("every colour token is gated or marked decorative (#1326)", () => {
  const paired = new Set(PAIRS.flatMap((p) => [p.fg, p.bg]));

  for (const { name } of RAW_TOKENS) {
    it(`${name} has a contrast pair or a decorative entry, not both`, () => {
      expect(paired.has(name) !== name in DECORATIVE).toBe(true);
    });
  }

  it("names no token that is gone", () => {
    const known = new Set(RAW_TOKENS.map((t) => t.name));
    for (const name of [...paired, ...Object.keys(DECORATIVE)]) {
      expect(known.has(name)).toBe(true);
    }
  });
});
