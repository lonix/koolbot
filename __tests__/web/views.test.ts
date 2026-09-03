/**
 * Unit tests for the pre-auth WebUI scaffold views (`src/web/views.ts`).
 */

import { describe, it, expect } from "@jest/globals";
import {
  renderConsent,
  renderErrorPage,
  renderInvalidLink,
} from "../../src/web/views.js";

describe("renderConsent", () => {
  it("posts to the token-bound redemption route with the token URL-encoded", () => {
    const html = renderConsent({ token: "a b/c", csrfToken: "csrf-1" });
    expect(html).toContain('action="/admin/s/a%20b%2Fc"');
    expect(html).toContain('<button type="submit">Continue</button>');
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
    expect(html).toContain("<title>Sign in required — Koolbot Admin</title>");
    expect(html).toContain(
      "<main><h1>Sign in required</h1><p>Run <code>/config</code> in Discord.</p></main>",
    );
    expect(html).toContain("background:#0f1115;color:#e4e6eb");
    // Keyboard focus ring for the links these pages carry.
    expect(html).toContain(
      "a:focus-visible,button:focus-visible{outline:2px solid #93c5fd",
    );
  });

  it("escapes the heading and lets the /me surface pick its own title suffix", () => {
    const html = renderErrorPage({
      title: "Forbidden",
      heading: "<Forbidden>",
      bodyHtml: "",
      product: "Koolbot",
    });
    expect(html).toContain("<h1>&lt;Forbidden&gt;</h1>");
    expect(html).toContain("<title>Forbidden — Koolbot</title>");
  });

  it("wraps the existing scaffold pages in the same main landmark", () => {
    expect(renderInvalidLink()).toContain(
      "<main><h1>Link invalid or expired</h1>",
    );
  });
});
