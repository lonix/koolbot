/**
 * Unit tests for the pre-auth WebUI scaffold views (`src/web/views.ts`).
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "@jest/globals";
import {
  renderConsent,
  renderErrorPage,
  renderInvalidLink,
} from "../../src/web/views.js";

const css = readFileSync(
  new URL("../../docs/design/kb.css", import.meta.url),
  "utf8",
);

describe("renderConsent", () => {
  it("posts to the token-bound redemption route with the token URL-encoded", () => {
    const html = renderConsent({ token: "a b/c", csrfToken: "csrf-1" });
    expect(html).toContain('action="/admin/s/a%20b%2Fc"');
    expect(html).toContain(
      '<button type="submit" class="kb-btn kb-btn--primary">Continue</button>',
    );
  });

  it("embeds the double-submit CSRF token so the redemption POST can pass requireCsrf (#771)", () => {
    const html = renderConsent({ token: "tok", csrfToken: "csrf-123" });
    expect(html).toContain(
      '<input type="hidden" name="_csrf" value="csrf-123">',
    );
  });

  it("HTML-escapes the CSRF token value", () => {
    const html = renderConsent({
      token: "tok",
      csrfToken: '"><script>x</script>',
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("renderErrorPage (#855)", () => {
  it("renders a full document with lang, viewport, a main landmark and the dark palette", () => {
    const html = renderErrorPage({
      title: "Sign in required",
      heading: "Sign in required",
      bodyHtml: "<p>Run <code>/config</code> in Discord.</p>",
    });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
    );
    expect(html).toContain("<title>Sign in required — KoolBot Admin</title>");
    expect(html).toContain(
      '<main class="kb-member"><header class="kb-pagehead"><div class="kb-pagehead__text"><h1 class="kb-pagehead__title">Sign in required</h1></div></header>' +
        '<div class="kb-panel"><div class="kb-panel__body"><p>Run <code>/config</code> in Discord.</p></div></div></main>',
    );
    // The page carries no style sheet of its own: kb.css (linked) supplies the
    // dark background, the font and the keyboard focus ring (#1710).
    expect(html).not.toContain("<style");
    expect(html).toContain('href="/admin/_assets/kb.css');
    expect(css).toMatch(/body \{[^}]*background: var\(--bg\)/);
    expect(css).toMatch(
      /a:focus-visible, button:focus-visible[^{]*\{ outline: 2px solid var\(--focus\)/,
    );
  });

  it("escapes the heading and lets the /me surface pick its own title suffix", () => {
    const html = renderErrorPage({
      title: "Forbidden",
      heading: "<Forbidden>",
      bodyHtml: "",
      product: "KoolBot",
    });
    expect(html).toContain(
      '<h1 class="kb-pagehead__title">&lt;Forbidden&gt;</h1>',
    );
    expect(html).toContain("<title>Forbidden — KoolBot</title>");
  });

  it("wraps the existing scaffold pages in the same main landmark", () => {
    expect(renderInvalidLink()).toContain(
      '<main class="kb-member"><header class="kb-pagehead"><div class="kb-pagehead__text"><h1 class="kb-pagehead__title">Link invalid or expired</h1>',
    );
  });
});
