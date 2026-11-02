/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global DOMParser, Element, Document */
import { describe, it, expect } from "@jest/globals";
import { renderFlash, renderPageFlash } from "../../src/web/admin-views.js";
import { renderAdminPage } from "../../src/web/admin-layout.js";

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

describe("the spacing a flash keeps (#1684)", () => {
  // A Callout has no margin of its own; the old .notice had 1rem below it. The
  // layout gives it back wherever a flash can land, except in a kb-stack,
  // whose gap already spaces it.
  const page = (body: string): Document =>
    new DOMParser().parseFromString(
      renderAdminPage({
        title: "T",
        active: "/admin/",
        body,
        csrfToken: "c",
        remainingMs: 1000,
      }),
      "text/html",
    );
  // jsdom does not resolve var() in getComputedStyle, so read the layout's
  // rules and match the elements against their selectors.
  const spaced = (doc: Document, id: string): boolean => {
    const css = Array.from(doc.querySelectorAll("style"))
      .map((n) => n.textContent ?? "")
      .join("\n");
    const el = doc.getElementById(id)!;
    const sel = (decl: string): string[] =>
      Array.from(
        css.matchAll(new RegExp(`([^{}]+)\\{margin:${decl}\\}`, "g")),
      ).flatMap((m) => m[1].split(/,(?![^(]*\))/).map((x) => x.trim()));
    const on = sel("0 0 var\\(--space-4\\)").some((q) => el.matches(q));
    const off = sel("0").some((q) => el.matches(q));
    return on && !off;
  };

  it("gives every parent the AJAX flash is inserted into the same space as the post-redirect flash", () => {
    const attr = (id: string, cls: string): string =>
      `<div id="${id}" class="kb-callout kb-callout--ok ${cls}" data-flash></div>`;
    const doc = page(
      [
        // The parents flashEl() inserts into: the settings card and a
        // disclosure body (feature pages), before and after #1700 (Panel).
        `<div class="card"><div id="a" class="kb-callout section-flash"></div></div>`,
        `<div class="kb-disclosure__body"><div id="b" class="kb-callout section-flash"></div></div>`,
        `<section class="kb-panel"><div class="kb-panel__body"><div id="c" class="kb-callout section-flash"></div></div></section>`,
        `<section class="kb-panel"><div class="kb-disclosure__body"><div id="d" class="kb-callout section-flash"></div></div></section>`,
        // The post-redirect flash, the reference.
        attr("ref", ""),
      ].join(""),
    );
    expect(spaced(doc, "ref")).toBe(true);
    for (const id of ["a", "b", "c", "d"]) expect(spaced(doc, id)).toBe(true);
  });

  it("adds no margin on top of a kb-stack gap", () => {
    const doc = page(
      `<div class="kb-panel__body kb-stack"><div id="s" class="kb-callout section-flash"></div><div id="f" class="kb-callout kb-callout--ok" data-flash></div></div>`,
    );
    expect(spaced(doc, "s")).toBe(false);
    expect(spaced(doc, "f")).toBe(false);
  });
});
