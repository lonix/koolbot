/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global DOMParser, Document, HTMLSelectElement, HTMLOptionElement, HTMLInputElement */
/**
 * The admin New event page (#1527): the host's New event form inside the admin
 * layout, with what an admin has and a host does not.
 */
import { describe, it, expect } from "@jest/globals";
import {
  ADMIN_NEW_EVENT_FORM,
  refusedNewEventForm,
  renderAdminNewEventPage,
} from "../../src/web/admin-new-event-page.js";
import { renderNewEventBody } from "../../src/web/event-new-view.js";
import { renderEventsPage } from "../../src/web/admin-views.js";
import { EVENT_GROUP_PRESETS } from "../../src/content/event-group-presets.js";

const FORM = {
  csrfToken: "csrf",
  timezone: "Europe/Oslo",
  defaultDurationMinutes: 90,
  groupLimits: { defaultCount: 2, maxCount: 15 },
  groupPresets: EVENT_GROUP_PRESETS,
  groupPresetsNotice: null,
};

const page = (
  form: Partial<Parameters<typeof renderAdminNewEventPage>[0]["form"]> = {},
  over: Partial<Parameters<typeof renderAdminNewEventPage>[0]> = {},
): Document =>
  new DOMParser().parseFromString(
    renderAdminNewEventPage({
      csrfToken: "csrf",
      remainingMs: 60_000,
      enabled: true,
      form: { ...FORM, ...form },
      ...over,
    }),
    "text/html",
  );

describe("the admin New event page", () => {
  it("is the host's form: When, Details and Groups panels, one h1, one primary button", () => {
    const doc = page();
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("h1")?.textContent).toBe("New event");
    expect(
      [...doc.querySelectorAll(".kb-panel__title")].map((h) => h.textContent),
    ).toEqual(["When", "Details", "Groups"]);
    const segmented = doc.querySelectorAll('input[type="radio"][name="when"]');
    expect([...segmented].map((r) => (r as HTMLInputElement).value)).toEqual([
      "now",
      "15",
      "30",
      "60",
      "pick",
    ]);
    // The duration is chosen from preset lengths, the server default selected.
    expect(
      doc.querySelector<HTMLOptionElement>(
        'select[name="duration"] option:checked',
      )?.value,
    ).toBe("90");
    expect(doc.querySelectorAll("button.kb-btn--primary")).toHaveLength(1);
    expect(doc.querySelector("button.kb-btn--primary")?.textContent).toBe(
      "Create event",
    );
  });

  it("posts to the admin create route and links the admin's preset library", () => {
    const doc = page();
    const form = doc.querySelector("form[data-event-form]");
    expect(form?.getAttribute("action")).toBe("/admin/events/create");
    expect(form?.getAttribute("method")).toBe("POST");
    expect(
      doc.querySelector('input[name="_csrf"]')?.getAttribute("value"),
    ).toBe("csrf");
    expect(doc.querySelector('a[href="/admin/events/presets"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/me/events/presets"]')).toBeNull();
  });

  it("offers Repeat, with its four choices, inside the date and time fields that Now hides", () => {
    const doc = page();
    const repeat = doc.querySelector<HTMLSelectElement>(
      'select[name="recurrence"]',
    );
    expect([...repeat!.options].map((o) => o.value)).toEqual([
      "none",
      "weekly",
      "biweekly",
      "monthly",
    ]);
    expect(repeat?.value).toBe("none");
    expect(repeat?.closest("[data-when-pick]")).not.toBeNull();
    expect(
      doc.querySelector('label[for="new-event-recurrence"]'),
    ).not.toBeNull();
  });

  it("keeps the optional timezone: the first option is the server zone and posts nothing", () => {
    const zone = page().querySelector<HTMLSelectElement>(
      'select[name="timezone"]',
    );
    expect(zone?.options[0].value).toBe("");
    expect(zone?.options[0].textContent).toBe("Default (Europe/Oslo)");
    expect(zone?.value).toBe("");
  });

  it("puts the page in the Events part of the admin menu and links back to Events", () => {
    const doc = page();
    expect(
      doc.querySelector('nav [aria-current="page"]')?.getAttribute("href"),
    ).toBe("/admin/events");
    expect(doc.querySelector('main a[href="/admin/events"]')).not.toBeNull();
  });

  it("tells an admin where to finish the setup, and links Bot permissions next to the Groups fields", () => {
    const doc = page({
      setupNotice:
        "No announcement channel is set, so events will not be announced.",
    });
    const notice = doc.querySelector(".kb-callout--warn");
    expect(notice?.textContent).toContain("No announcement channel");
    expect(notice?.querySelector('a[href="/admin/events"]')).not.toBeNull();
    expect(notice?.textContent).not.toContain("Ask an admin");
  });

  it("selects Now for the Start now link", () => {
    const now = page({ initialWhen: "now" }).querySelector<HTMLInputElement>(
      'input[name="when"]:checked',
    );
    expect(now?.value).toBe("now");
  });

  it("says Events is off, and where to switch it on, without a second primary button", () => {
    const doc = page({}, { enabled: false });
    expect(doc.body.textContent).toContain("The Events feature is off.");
    expect(doc.querySelectorAll("button.kb-btn--primary")).toHaveLength(1);
    expect(page().body.textContent).not.toContain("feature is off");
  });
});

describe("the host's New event form is unchanged by the admin's", () => {
  const html = renderNewEventBody(FORM);

  it("has no Repeat, and posts to the host's route", () => {
    expect(html).not.toContain('name="recurrence"');
    expect(html).not.toContain("new-event-recurrence");
    expect(html).toContain('action="/me/events/new"');
    expect(html).toContain('href="/me/events/presets"');
  });

  it("tells a host to ask an admin about a missing setup", () => {
    const withNotice = renderNewEventBody({
      ...FORM,
      setupNotice: "No channel category is set.",
    });
    expect(withNotice).toContain("Ask an admin to finish setting up Events.");
  });

  it("keeps the server zone selected, with no blank first option", () => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const zone = doc.querySelector<HTMLSelectElement>(
      'select[name="timezone"]',
    );
    expect(zone?.value).toBe("Europe/Oslo");
    expect(zone?.options[0].value).toBe("Europe/Oslo");
  });
});

describe("a refused New event post, read back", () => {
  const refused = (
    errors: Record<string, string>,
    values: Record<string, string> = {},
  ): ReturnType<typeof refusedNewEventForm> =>
    refusedNewEventForm(
      { formId: ADMIN_NEW_EVENT_FORM, errors, values },
      "Europe/Oslo",
      90,
    );

  it("names the field when the key is a form field", () => {
    expect(refused({ groups: "Groups: x" }).refusal).toEqual({
      message: "Groups: x",
      field: "groups",
    });
    expect(refused({ recurrence: "r" }).refusal.field).toBe("recurrence");
  });

  it("leaves a message with no field when the key is not one", () => {
    expect(refused({ form: "Over the limit." }).refusal).toEqual({
      message: "Over the limit.",
    });
  });

  it("puts back the text, the When choice and the Groups rows as posted", () => {
    const view = refused(
      { title: "Enter a title." },
      {
        when: "30",
        date: "2999-01-01",
        description: " hi ",
        recurrence: "weekly",
        groups_enabled: "1",
        group_0_name: "Red",
        group_1_name: "",
        group_2_name: "Blue",
      },
    );
    expect(view.initialWhen).toBe("30");
    expect(view.values).toMatchObject({
      date: "2999-01-01",
      description: "hi",
      recurrence: "weekly",
      timezone: "Europe/Oslo",
      durationMinutes: 90,
    });
    expect(view.groups.enabled).toBe(true);
    expect(view.groups.prefill.rows.map((r) => r.name)).toEqual([
      "Red",
      "",
      "Blue",
    ]);
  });

  it("draws the refused field, the callout and the typed Repeat choice", () => {
    const view = refused(
      { recurrence: "An event that starts now cannot repeat." },
      { when: "now", recurrence: "weekly" },
    );
    const doc = page({
      refusal: view.refusal,
      values: view.values,
      initialWhen: view.initialWhen,
    });
    const repeat = doc.querySelector<HTMLSelectElement>(
      'select[name="recurrence"]',
    );
    expect(repeat?.getAttribute("aria-invalid")).toBe("true");
    expect(repeat?.value).toBe("weekly");
    expect(doc.getElementById("new-event-recurrence-error")?.textContent).toBe(
      "An event that starts now cannot repeat.",
    );
    expect(doc.querySelector("[data-refusal-callout]")).not.toBeNull();
  });
});

describe("the Events page no longer holds the form", () => {
  it("has no schedule form, no Groups script and no When script", () => {
    const html = renderEventsPage({
      csrfToken: "csrf",
      remainingMs: 60_000,
      enabled: true,
      categoryConfigured: true,
      announcementConfigured: true,
      timezone: "UTC",
      rows: [],
      settingRows: [],
    });
    expect(html).not.toContain("data-event-form");
    expect(html).not.toContain("data-when-pick");
    expect(html).toContain('href="/admin/events/new"');
  });
});
