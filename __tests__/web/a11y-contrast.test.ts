/**
 * WCAG contrast gate for the WebUI palette (issue #856).
 *
 * axe's own `color-contrast` rule can't run in the jsdom-based scan
 * (`a11y-axe.test.ts`) because jsdom does no layout or style cascade. The
 * palette is a small set of tokens in `src/web/theme.ts` though, so the
 * ratios can be computed directly — which is what would have caught the six
 * contrast misses fixed in #855 (`#6b7280` at 3.6:1, `#ef4444` at 3.8:1, …)
 * before they shipped.
 *
 * Add a pair here whenever you add a token: an untested token is an
 * ungated one.
 */

import { describe, it, expect } from "@jest/globals";
import { THEME } from "../../src/web/theme.js";

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
  fg: string;
  bg: string;
  min: number;
}

/** Backgrounds any foreground token can end up sitting on. */
const SURFACES: Array<[string, string]> = [
  ["page background", THEME.bg],
  ["a card", THEME.surface],
  ["a table header", THEME.surfaceAlt],
];

/** Foreground tokens that carry text, and therefore owe 4.5:1 everywhere. */
const TEXT_TOKENS: Array<[string, string]> = [
  ["body text", THEME.text],
  ["muted text", THEME.muted],
  ["link text", THEME.link],
  ["warning text", THEME.warn],
];

const PAIRS: Pair[] = [
  ...TEXT_TOKENS.flatMap(([name, fg]) =>
    SURFACES.map(([surfaceName, bg]) => ({
      what: `${name} on ${surfaceName}`,
      fg,
      bg,
      min: TEXT_MIN,
    })),
  ),
  // Button fills carry their own label colour, so they're judged against it
  // rather than against the page.
  {
    what: "primary button label",
    fg: THEME.onPrimary,
    bg: THEME.primary,
    min: TEXT_MIN,
  },
  {
    what: "primary button label (hover)",
    fg: THEME.onPrimary,
    bg: THEME.primaryHover,
    min: TEXT_MIN,
  },
  {
    what: "destructive button label",
    fg: THEME.onPrimary,
    bg: THEME.danger,
    min: TEXT_MIN,
  },
  {
    what: "destructive button label (hover)",
    fg: THEME.onPrimary,
    bg: THEME.dangerHover,
    min: TEXT_MIN,
  },
  // Non-text: a control's edge and the focus ring only owe 3:1 (WCAG 1.4.11 /
  // 2.4.11), but they owe it against every surface they can be drawn on.
  ...SURFACES.flatMap(([surfaceName, bg]) => [
    {
      what: `form-control border on ${surfaceName}`,
      fg: THEME.control,
      bg,
      min: UI_MIN,
    },
    { what: `focus ring on ${surfaceName}`, fg: THEME.focus, bg, min: UI_MIN },
  ]),
];

describe("THEME palette contrast (#856)", () => {
  for (const pair of PAIRS) {
    it(`${pair.what} clears ${pair.min}:1`, () => {
      // Rounded to 2dp so a failure names the ratio you have to tune a
      // replacement colour against, not just "below the floor".
      const ratio = Number(contrastRatio(pair.fg, pair.bg).toFixed(2));
      expect(ratio).toBeGreaterThanOrEqual(pair.min);
    });
  }

  it("keeps the greys that failed WCAG out of the palette (#855)", () => {
    // #6b7280 was 3.6:1 as muted text, #64748b failed as *text* (it survives
    // only as the control border, which owes 3:1), #b45309 was 3.4:1 as the
    // warning colour. Re-introducing one as a text colour is the regression
    // this guards.
    const textColours = [THEME.text, THEME.muted, THEME.link, THEME.warn];
    for (const failed of ["#6b7280", "#b45309", "#ef4444"]) {
      expect(textColours).not.toContain(failed);
    }
  });

  it("treats the decorative hairline as decorative", () => {
    // `THEME.border` is deliberately below 3:1 — it draws card/table
    // hairlines, which convey nothing on their own. Form-control edges use
    // `THEME.control` instead precisely because they do.
    expect(contrastRatio(THEME.border, THEME.bg)).toBeLessThan(UI_MIN);
    expect(contrastRatio(THEME.control, THEME.bg)).toBeGreaterThanOrEqual(
      UI_MIN,
    );
  });
});
