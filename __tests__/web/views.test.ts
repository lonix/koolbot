/**
 * Unit tests for the pre-auth WebUI scaffold views (`src/web/views.ts`).
 */

import { describe, it, expect } from "@jest/globals";
import { renderConsent } from "../../src/web/views.js";

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
