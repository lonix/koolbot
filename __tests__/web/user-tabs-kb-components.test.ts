/**
 * The Birthday, Timezone, Voice and Privacy tabs are built from the kb-
 * components (#1543): a PageHeader, kb-panels, kb-fields and kb-btns, with no
 * `style` attribute and none of the member layout's legacy classes.
 */

import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderUserBirthdayBody,
  renderUserTimezoneBody,
  renderUserVoiceBody,
  renderUserPrivacyBody,
  VOICE_NAME_PATTERN_FORM_ID,
} from "../../src/web/user-layout.js";

const csrfToken = "tok";
const presets = [
  {
    index: 0,
    name: "Chill",
    channelName: null,
    userLimit: null,
    bitrate: null,
    isDefault: true,
  },
  {
    index: 1,
    name: "Ranked",
    channelName: "Ranked room",
    userLimit: 5,
    bitrate: 64,
    isDefault: false,
  },
];
const rows = [
  { collection: "voicesessions", note: "Your voice history." },
  { collection: "quotes", note: "Quotes <you> added." },
];
const privacy = {
  featureEnabled: true,
  included: rows,
  excluded: rows,
  maxItems: 100,
  reset: { enabled: true, cooldownHours: 24, csrfToken },
};

const BODIES: Array<{ name: string; html: string }> = [
  {
    name: "birthday",
    html: renderUserBirthdayBody({
      csrfToken,
      selected: { month: 4, day: 12, year: 1990 },
    }),
  },
  {
    name: "birthday (rejected)",
    html: renderUserBirthdayBody({
      csrfToken,
      selected: null,
      refusedForm: {
        formId: "birthday",
        errors: { date: ["That date does not exist."] },
        values: { month: "2", day: "30", year: "" },
      },
    }),
  },
  {
    name: "timezone",
    html: renderUserTimezoneBody({
      csrfToken,
      selected: "Europe/Oslo",
      serverTimezone: "UTC",
    }),
  },
  {
    name: "voice",
    html: renderUserVoiceBody({
      csrfToken,
      namePattern: "{username}'s Room",
      displayName: "Alice",
      presets,
      maxPerUser: 5,
    }),
  },
  {
    name: "voice (no presets)",
    html: renderUserVoiceBody({
      csrfToken,
      namePattern: null,
      displayName: "Alice",
      presets: [],
      maxPerUser: 5,
    }),
  },
  {
    name: "voice (rejected)",
    html: renderUserVoiceBody({
      csrfToken,
      namePattern: null,
      displayName: "Alice",
      presets,
      maxPerUser: 5,
      refusedForm: {
        formId: VOICE_NAME_PATTERN_FORM_ID,
        errors: { namePattern: ["Too long."] },
        values: { namePattern: "<b>&amp; typed" },
      },
    }),
  },
  { name: "privacy", html: renderUserPrivacyBody(privacy) },
  {
    name: "privacy (tracking opt-out offered)",
    html: renderUserPrivacyBody({
      ...privacy,
      trackingOptOut: { offered: true, optedOutAt: null, csrfToken },
    }),
  },
  {
    name: "privacy (opted out)",
    html: renderUserPrivacyBody({
      ...privacy,
      trackingOptOut: {
        offered: true,
        optedOutAt: new Date("2030-01-02T00:00:00Z"),
        csrfToken,
      },
    }),
  },
];

const LEGACY =
  ".card, .btn, .btn-secondary, .btn-danger, .pill, .subtitle, .muted, .mono, .tz-select, .tz-preview, .preset-grid, .preset-actions, .form-actions, .prefs-table, .empty";

const dom = (html: string) => new JSDOM(`<body>${html}</body>`).window.document;

describe.each(BODIES)("the $name body (#1543)", ({ html }) => {
  const doc = dom(html);

  it("has no style attribute", () => {
    expect(doc.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("uses none of the legacy member classes", () => {
    expect(doc.querySelectorAll(LEGACY)).toHaveLength(0);
  });

  it("is one kb-stack that opens with a PageHeader and one h1", () => {
    const root = doc.body.firstElementChild!;
    expect(root.className).toBe("kb-stack");
    expect(root.firstElementChild!.className).toBe("kb-pagehead");
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("h1")!.className).toBe("kb-pagehead__title");
  });

  it("puts every section in a kb-panel with a titled head", () => {
    const sections = doc.querySelectorAll("section");
    expect(sections.length).toBeGreaterThan(0);
    sections.forEach((s) => {
      expect(s.classList.contains("kb-panel")).toBe(true);
      expect(
        s.querySelector(".kb-panel__head .kb-panel__title"),
      ).not.toBeNull();
      expect(s.getAttribute("aria-labelledby")).toBe(
        s.querySelector(".kb-panel__title")!.id,
      );
    });
  });

  it("has at most one primary button", () => {
    expect(doc.querySelectorAll(".kb-btn--primary").length).toBeLessThanOrEqual(
      1,
    );
  });
});

describe("Birthday (#1543)", () => {
  it("lays month, day and year out as kb-fields in one kb-fields row", () => {
    const doc = dom(BODIES[0]!.html);
    const fields = doc.querySelector(".kb-fields")!;
    expect(fields.querySelectorAll(":scope > .kb-field")).toHaveLength(3);
    expect(doc.querySelector("#bd-month")!.className).toBe("kb-select");
    expect(doc.querySelector("#bd-year")!.className).toBe("kb-input");
  });
});

describe("Timezone (#1543)", () => {
  const doc = dom(BODIES[2]!.html);

  it("puts the select in a kb-field with a label", () => {
    const field = doc.querySelector("#tz-select")!.closest(".kb-field")!;
    expect(field.querySelector("label.kb-label")!.getAttribute("for")).toBe(
      "tz-select",
    );
  });

  it("keeps the current-time target and shows it as help text under the select", () => {
    const now = doc.getElementById("tz-now")!;
    expect(now.getAttribute("data-server-tz")).toBe("UTC");
    expect(now.closest("p")!.className).toBe("kb-help");
  });
});

describe("Voice (#1543)", () => {
  const doc = dom(BODIES[3]!.html);

  it("makes each preset a panel whose head names it and carries the Default badge", () => {
    const panels = doc.querySelectorAll(".kb-panel .kb-panel");
    expect(panels).toHaveLength(2);
    const first = doc.querySelector("#voice-preset-0-title")!;
    expect(first.textContent).toContain("Chill");
    expect(first.querySelector(".kb-badge")!.textContent).toContain("Default");
    expect(
      doc.querySelector("#voice-preset-1-title")!.querySelector(".kb-badge"),
    ).toBeNull();
  });

  it("lays a preset's four fields out as kb-fields", () => {
    const form = doc.querySelector('form[action="/me/voice/preset/edit"]')!;
    expect(form.querySelectorAll(".kb-fields > .kb-field")).toHaveLength(4);
  });

  it("gives the name pattern its help and preview as kb-help lines", () => {
    const field = doc
      .querySelector(`#${VOICE_NAME_PATTERN_FORM_ID}-namePattern`)!
      .closest(".kb-field")!;
    expect(field.querySelectorAll("p.kb-help")).toHaveLength(2);
    expect(field.textContent).toContain("Preview: Alice's Room");
  });

  it("echoes a refused name pattern exactly as typed, escaped once", () => {
    const html = BODIES[5]!.html;
    expect(html).toContain('value="&lt;b&gt;&amp;amp; typed"');
    const input = dom(html).querySelector(
      `#${VOICE_NAME_PATTERN_FORM_ID}-namePattern`,
    ) as unknown as { value: string };
    expect(input.value).toBe("<b>&amp; typed");
  });

  it("shows an empty state inside the presets panel when there are none", () => {
    const empty = dom(BODIES[4]!.html);
    expect(empty.querySelector("#presets-title")).not.toBeNull();
    expect(empty.querySelector(".kb-empty .kb-empty__title")!.textContent).toBe(
      "No saved presets yet",
    );
  });
});

describe("Privacy (#1543)", () => {
  const doc = dom(BODIES[6]!.html);

  it("renders both collection lists as kb-tables in flush panel bodies", () => {
    const tables = doc.querySelectorAll(
      ".kb-panel__body--flush > table.kb-table",
    );
    expect(tables).toHaveLength(2);
    tables.forEach((t) => {
      expect(t.querySelector("caption")!.className).toBe("kb-visually-hidden");
      expect(t.querySelectorAll("tbody th[scope=row].kb-mono")).toHaveLength(2);
    });
  });

  it("escapes a registry note once", () => {
    expect(BODIES[6]!.html).toContain("Quotes &lt;you&gt; added.");
    expect(BODIES[6]!.html).not.toContain("&amp;lt;");
  });

  it("offers the download as a primary link button and keeps the reset as the danger panel", () => {
    const link = doc.querySelector('a[href="/me/privacy/export"]')!;
    expect(link.className).toBe("kb-btn kb-btn--primary");
    expect(doc.querySelector("#reset")!.className).toBe(
      "kb-panel kb-panel--danger",
    );
  });

  it("keeps the tracking card as a panel at #tracking", () => {
    const tracking = dom(BODIES[7]!.html).querySelector("#tracking")!;
    expect(tracking.className).toBe("kb-panel");
    expect(
      tracking.querySelector('input[name="action"]')!.getAttribute("value"),
    ).toBe("opt-out");
    expect(
      dom(BODIES[8]!.html)
        .querySelector('#tracking input[name="action"]')!
        .getAttribute("value"),
    ).toBe("opt-in");
  });
});
