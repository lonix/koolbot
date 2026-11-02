/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global DOMParser, Element */
import { describe, it, expect } from "@jest/globals";
import { renderFlash, renderPageFlash } from "../../src/web/admin-views.js";

function root(html: string): Element {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")
    .body;
}

describe("renderFlash on the kb- Callout (#1684)", () => {
  it.each([
    ["ok", "kb-callout kb-callout--ok", "status"],
    ["warn", "kb-callout kb-callout--warn", "status"],
    ["err", "kb-callout kb-callout--err", "alert"],
  ] as const)("draws a %s flash as a Callout", (type, cls, role) => {
    const el = root(
      renderFlash({ type, text: "Saved. 3 settings changed." }),
    ).firstElementChild!;
    expect(el.getAttribute("class")).toBe(cls);
    expect(el.getAttribute("role")).toBe(role);
    expect(el.getAttribute("tabindex")).toBe("-1");
    expect(el.hasAttribute("data-flash")).toBe(true);
    expect(el.querySelector("svg.kb-icon")).not.toBeNull();
    expect(el.querySelector(".kb-callout__title")!.textContent).toBe(
      "Saved. 3 settings changed.",
    );
  });

  it("keeps the text plain and the id hook", () => {
    const html = renderFlash(
      { type: "err", text: "<b>x</b>" },
      "settings-flash",
    );
    expect(html).toContain('id="settings-flash"');
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toMatch(/class="[^"]*\bnotice\b/);
  });

  it("renders nothing without a flash, and the page flash defers to the settings", () => {
    expect(renderFlash(null)).toBe("");
    expect(renderPageFlash(undefined)).toBe("");
    expect(
      renderPageFlash({ type: "ok", text: "Saved.", openSettings: true }),
    ).toBe("");
    expect(renderPageFlash({ type: "ok", text: "Saved." })).toContain(
      "kb-callout--ok",
    );
  });
});
