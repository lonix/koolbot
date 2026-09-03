import { describe, it, expect } from "@jest/globals";
import { escapeHtml, escapeJsInAttr } from "../../src/web/html.js";
import { escapeHtml as escapeHtmlFromLayout } from "../../src/web/admin-layout.js";

// `admin-layout.ts` and `views.ts` each defined their own `escapeHtml` (#851);
// both now render through this module. These tests pin the shared behaviour —
// `views.ts` used to pass `string`, so the null/undefined handling that the
// admin copy had must survive for the merged version to be safe for both.
describe("escapeHtml", () => {
  it("escapes every character that can break out of markup", () => {
    expect(escapeHtml(`<script>"x'&y"</script>`)).toBe(
      "&lt;script&gt;&quot;x&#39;&amp;y&quot;&lt;/script&gt;",
    );
  });

  it("escapes the ampersand first so entities are not double-decoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("renders null and undefined as an empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("stringifies non-string values", () => {
    expect(escapeHtml(42)).toBe("42");
    expect(escapeHtml(true)).toBe("true");
  });

  it("is the same function the layout re-exports", () => {
    expect(escapeHtmlFromLayout).toBe(escapeHtml);
  });
});

describe("escapeJsInAttr", () => {
  it("escapes quotes and backslashes so the JS string cannot be terminated", () => {
    expect(escapeJsInAttr("O'Brien")).toBe("O\\&#39;Brien");
    expect(escapeJsInAttr("a\\b")).toBe("a\\\\b");
  });

  it("neutralises line terminators, including U+2028/U+2029", () => {
    expect(escapeJsInAttr("a\nb\rc\u2028d\u2029e")).toBe(
      "a\\nb\\rc\\u2028d\\u2029e",
    );
  });

  it("breaks a closing script tag so it cannot escape its context", () => {
    expect(escapeJsInAttr("</script>")).toContain("&lt;\\/script&gt;");
  });

  it("renders null and undefined as an empty string", () => {
    expect(escapeJsInAttr(null)).toBe("");
    expect(escapeJsInAttr(undefined)).toBe("");
  });
});
