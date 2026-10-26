/**
 * The Web UI is dark only (DESIGN.md, Colour): kb.css sets `color-scheme: dark` so the browser
 * draws native control parts (date pickers, file button, selection, scrollbars) dark. A layout's
 * inline style must never reset it (#1507).
 */

import { describe, it, expect } from "@jest/globals";
import { renderGroupsSection } from "../../src/web/admin-views.js";
import { renderNewEventBody } from "../../src/web/event-new-view.js";
import { renderAdminPage } from "../../src/web/admin-layout.js";
import { renderUserPage } from "../../src/web/user-layout.js";
import {
  renderConsent,
  renderErrorPage,
  renderInvalidLink,
  renderSignedOut,
} from "../../src/web/views.js";

const adminPage = (): string =>
  renderAdminPage({
    title: "Test",
    active: "/admin/",
    body: "<p>x</p>",
    csrfToken: "csrf",
    remainingMs: 60_000,
  } as Parameters<typeof renderAdminPage>[0]);

const userPage = (): string =>
  renderUserPage({
    title: "Test",
    active: "/me/",
    body: "<p>x</p>",
    csrfToken: "csrf",
    remainingMs: 60_000,
    isAdmin: false,
  });

const pages: Array<[string, () => string]> = [
  ["admin layout", adminPage],
  ["member layout", userPage],
  [
    "pre-auth error page",
    () => renderErrorPage({ title: "E", heading: "H", bodyHtml: "<p>m</p>" }),
  ],
  [
    "pre-auth consent page",
    () => renderConsent({ token: "t", csrfToken: "c" }),
  ],
  ["pre-auth invalid link", () => renderInvalidLink()],
  ["pre-auth signed out", () => renderSignedOut()],
];

describe("layouts keep kb.css's dark colour scheme (#1507)", () => {
  it.each(pages)(
    "%s sets color-scheme to nothing but dark",
    (_name, render) => {
      const html = render();
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
        (m) => m[1],
      );
      expect(styles.length).toBeGreaterThan(0);
      const values = styles.flatMap((css) =>
        [...css.matchAll(/color-scheme\s*:\s*([^;}]*)/g)].map((m) =>
          m[1].trim(),
        ),
      );
      for (const v of values) expect(v).toBe("dark");
      expect(html).not.toMatch(/color-scheme\s*:\s*(normal|light)/);
    },
  );
});

describe("native-control follow-ups (#1507)", () => {
  it("the admin form.stack rule styles date and time inputs like the other fields", () => {
    const html = adminPage();
    expect(html).toContain("form.stack input[type=date]");
    expect(html).toContain("form.stack input[type=time]");
  });

  it("the Groups legend is drawn on the admin form and visually hidden inside a panel that already says Groups", () => {
    const limits = { defaultCount: 2, maxCount: 8 };
    const admin = renderGroupsSection(limits);
    const member = renderGroupsSection(
      limits,
      undefined,
      null,
      undefined,
      null,
      {},
      true,
    );
    expect(admin).toContain("<legend>Groups</legend>");
    expect(member).toContain(
      '<legend class="kb-visually-hidden">Groups</legend>',
    );
    expect(member).toContain("<fieldset data-groups-section>");
  });

  it("/me/events/new hides the Groups legend its panel head already says", () => {
    const html = renderNewEventBody({
      csrfToken: "c",
      timezone: "UTC",
      defaultDurationMinutes: 120,
      groupLimits: { defaultCount: 2, maxCount: 8 },
      groupPresets: [],
      groupPresetsNotice: null,
    });
    expect(html).toContain(
      '<legend class="kb-visually-hidden">Groups</legend>',
    );
  });
});
