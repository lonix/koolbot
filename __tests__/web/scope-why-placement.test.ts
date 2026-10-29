/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
/**
 * The "why you see this" line on host and moderator pages (#1528): one per
 * page, under the page's own title. Run over the real page fixtures of the
 * accessibility gate (the admin session there holds every scope, so the line
 * is rendered), parsed with jsdom.
 */
/* global Document, DOMParser, Node */
import { describe, it, expect } from "@jest/globals";
import { allPages } from "./a11y-pages.js";
import { placeScopeWhy } from "../../src/web/user-layout.js";

// One entry per page kind of the issue: Your events, New event, Event presets,
// the host panel, Edit event, Mod log, a case and Command audit.
const SCOPE_PAGES = [
  ["Your events", /^\/me\/events Your events/],
  ["New event", /^\/me new event/],
  ["Event presets", /^\/me event presets/],
  ["host panel", /^\/me host panel \(scheduled, groups\)/],
  ["Edit event", /^\/me edit event/],
  ["Mod log", /^\/me\/moderation mod log/],
  ["a case", /^\/me\/moderation case/],
  ["Command audit", /^\/me\/moderation command audit/],
] as const;

const parse = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

describe("the scope line on host and moderator pages (#1528)", () => {
  it.each(SCOPE_PAGES)(
    "%s: exactly one line, after the h1, with no second source",
    (_label, pattern) => {
      const pages = allPages().filter((p) => pattern.test(p.name));
      expect(pages.length).toBeGreaterThan(0);
      for (const { name, html } of pages) {
        const doc = parse(html);
        const why = doc.querySelectorAll("[data-why]");
        expect([name, why.length]).toEqual([name, 1]);
        const h1 = doc.querySelector("main h1");
        expect(h1).not.toBeNull();
        expect(
          h1!.compareDocumentPosition(why[0]) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        // Nothing else says "You see it because": the old page header line.
        expect(doc.body.textContent).not.toContain("You see it because");
        // It is part of the page header, in the header's own meta style.
        expect(why[0].closest("header.kb-pagehead")).not.toBeNull();
        expect(why[0].classList.contains("kb-pagehead__meta")).toBe(true);
      }
    },
  );

  it("keeps the line first for a body with no page header (a confirm step)", () => {
    expect(placeScopeWhy("<section>x</section>", "<div>why</div>")).toBe(
      "<div>why</div><section>x</section>",
    );
    expect(placeScopeWhy("<p>x</p>", "")).toBe("<p>x</p>");
  });

  it("puts the line at the end of the header's text block, before its actions", () => {
    const plain =
      '<header class="kb-pagehead"><div class="kb-pagehead__text"><h1>T</h1></div></header><section><header class="kb-panel__head"></header></section>';
    expect(placeScopeWhy(plain, "<i></i>")).toBe(
      '<header class="kb-pagehead"><div class="kb-pagehead__text"><h1>T</h1><i></i></div></header><section><header class="kb-panel__head"></header></section>',
    );
    const withActions =
      '<header class="kb-pagehead">\n  <div class="kb-pagehead__text"><h1>T</h1></div>\n  <div class="kb-pagehead__actions"><a>x</a></div>\n</header><p>b</p>';
    expect(placeScopeWhy(withActions, "<i></i>")).toBe(
      '<header class="kb-pagehead">\n  <div class="kb-pagehead__text"><h1>T</h1><i></i></div>\n  <div class="kb-pagehead__actions"><a>x</a></div>\n</header><p>b</p>',
    );
  });
});
