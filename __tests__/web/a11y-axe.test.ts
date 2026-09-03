/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * Automated accessibility gate for the WebUI (issue #856).
 *
 * The page renderers in `admin-views.ts` / `user-layout.ts` / `views.ts` are
 * pure functions returning a complete HTML document, so axe can be pointed at
 * their output directly — no browser, no server, no fixtures beyond the props
 * in `a11y-pages.ts`. This is what stops the next settings row from shipping
 * unlabelled the way the ones in #853 / #855 did.
 *
 * Colour contrast is deliberately *not* checked here: jsdom does no layout or
 * cascade, so axe's `color-contrast` rule cannot run. The palette is gated
 * instead by `a11y-contrast.test.ts`, which computes the WCAG ratios from the
 * `THEME` tokens directly.
 */

import { describe, it, expect } from "@jest/globals";
import { axe, toHaveNoViolations } from "jest-axe";
import { allPages } from "./a11y-pages.js";

expect.extend(toHaveNoViolations);

/**
 * Rules that jsdom cannot evaluate meaningfully, switched off so the gate
 * reports real defects rather than environment artefacts.
 *
 * - `color-contrast` needs layout + computed styles (see the note above).
 * - `landmark-*` / `region` rules are kept on: the layouts do emit real
 *   `<nav>` / `<main>` landmarks, and losing one is exactly the kind of
 *   regression this gate exists to catch.
 */
const AXE_OPTIONS = {
  rules: {
    "color-contrast": { enabled: false },
  },
} as const;

// axe walks the whole document and every page here is a few hundred KB of
// markup, so the default 10s Jest timeout is tight on a loaded CI runner.
const AXE_TIMEOUT_MS = 30_000;

describe("WebUI accessibility (axe)", () => {
  for (const page of allPages()) {
    it(
      `${page.name} has no axe violations`,
      async () => {
        document.documentElement.innerHTML = extractDocumentInnerHtml(
          page.html,
        );
        // `lang` lives on <html>, which `innerHTML` can't carry — mirror the
        // attribute the renderer emitted so `html-has-lang` still gates it.
        const lang = page.html.match(/<html[^>]*\slang="([^"]*)"/)?.[1];
        if (lang === undefined) {
          document.documentElement.removeAttribute("lang");
        } else {
          document.documentElement.setAttribute("lang", lang);
        }

        const results = await axe(document.documentElement, AXE_OPTIONS);
        expect(results).toHaveNoViolations();
      },
      AXE_TIMEOUT_MS,
    );
  }
});

/**
 * Strip the doctype / `<html>` wrapper so the document's `<head>` and
 * `<body>` can be installed into jsdom's existing document. Inline `<script>`
 * blocks are dropped: jsdom would execute the layout's countdown / cascade
 * scripts against a document that has no real event loop behind it, and they
 * are not what this gate measures.
 */
function extractDocumentInnerHtml(html: string): string {
  return html
    .replace(/^<!doctype html>/i, "")
    .replace(/^<html[^>]*>/i, "")
    .replace(/<\/html>$/i, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}
