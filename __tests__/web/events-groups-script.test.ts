/* global HTMLInputElement, HTMLOptionElement, HTMLSelectElement, HTMLElement */
/**
 * The Groups section's page script, run for real in jsdom (#1188). The markup
 * and script come from `renderEventsPage`, so what is tested is what ships.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { renderEventsPage } from "../../src/web/admin-views.js";
import { validateGroupSetup } from "../../src/services/event-groups.js";

const COMMON = {
  csrfToken: "csrf-tok",
  remainingMs: 60_000,
  categoryConfigured: true,
  announcementConfigured: true,
  timezone: "UTC",
  settingRows: [],
  enabled: true,
  rows: [],
};

function page(maxCount = 15, defaultCount = 2): string {
  return renderEventsPage({
    ...COMMON,
    groupLimits: { defaultCount, maxCount },
  } as never);
}

/** Load the page and run its groups script. */
function boot(
  maxCount = 15,
  defaultCount = 2,
  restore?: Record<string, unknown>,
): JSDOM {
  let html = page(maxCount, defaultCount);
  if (restore) {
    // The page as it comes back after a refused submit.
    html = html.replace(
      "<h1>Events</h1>",
      '<h1>Events</h1><div class="notice err" data-flash>Groups: nope</div>',
    );
  }
  const dom = new JSDOM(html, {
    url: "http://localhost/admin/events",
    runScripts: "outside-only",
  });
  if (restore) {
    dom.window.sessionStorage.setItem(
      "koolbot-event-form-draft",
      JSON.stringify(restore),
    );
  }
  const scripts = [
    ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  const groups = scripts.find((code) =>
    code.includes("koolbot-event-form-draft"),
  );
  if (!groups) throw new Error("groups script not found");
  dom.window.eval(groups);
  return dom;
}

type Win = JSDOM["window"];

function field(dom: JSDOM, name: string): HTMLInputElement {
  const el = dom.window.document.querySelector(`[name="${name}"]`);
  if (!el) throw new Error(`no field ${name}`);
  return el as HTMLInputElement;
}

function submit(dom: JSDOM): boolean {
  const form = dom.window.document.querySelector("form[data-event-form]");
  const event = new (dom.window as Win).Event("submit", {
    cancelable: true,
    bubbles: true,
  });
  form?.dispatchEvent(event);
  return event.defaultPrevented;
}

function tick(dom: JSDOM): void {
  const box = field(dom, "groups_enabled");
  box.checked = true;
  box.dispatchEvent(new (dom.window as Win).Event("change", { bubbles: true }));
}

describe("oversized presets (#1188)", () => {
  it("renders presets bigger than the cap disabled, with the reason", () => {
    const doc = new JSDOM(page(2)).window.document;
    const option = (id: string): HTMLOptionElement =>
      doc.querySelector(`option[value="${id}"]`) as HTMLOptionElement;
    expect(option("builtin:red-vs-blue").disabled).toBe(false);
    expect(option("builtin:wardogs").disabled).toBe(true);
    expect(option("builtin:wardogs").textContent).toContain(
      "needs 3 groups, limit is 2",
    );
    expect(option("builtin:eve-factions").disabled).toBe(true);
    expect(option("builtin:eve-factions").textContent).toContain(
      "needs 4 groups, limit is 2",
    );
  });

  it("offers every preset when the cap is large enough", () => {
    const doc = new JSDOM(page(15)).window.document;
    expect(doc.querySelectorAll("option[disabled]")).toHaveLength(0);
  });

  it("does not replace rows or truncate when an oversized preset is selected anyway", () => {
    const dom = boot(2);
    field(dom, "group_0_name").value = "Mine";
    const select = field(dom, "groups_preset") as unknown as HTMLSelectElement;
    select.value = "builtin:wardogs";
    select.dispatchEvent(
      new (dom.window as Win).Event("change", { bubbles: true }),
    );
    expect(field(dom, "group_0_name").value).toBe("Mine");
    expect(select.value).toBe("");
  });

  it("fills a preset that fits", () => {
    const dom = boot(2);
    const select = field(dom, "groups_preset") as unknown as HTMLSelectElement;
    select.value = "builtin:red-vs-blue";
    select.dispatchEvent(
      new (dom.window as Win).Event("change", { bubbles: true }),
    );
    expect(field(dom, "group_0_name").value).toBe("Red");
    expect(field(dom, "group_1_name").value).toBe("Blue");
    expect(field(dom, "groups_enabled").checked).toBe(true);
  });

  const rows = (names: string[]) =>
    names.map((name, i) => ({
      position: i + 1,
      name,
      kind: "team",
      size: "",
      tag: "",
      marker: "",
    }));

  it("the server refuses an oversized preset instead of saving a truncated copy", () => {
    // Rows cut down to the cap, still under the Wardogs id.
    const truncated = validateGroupSetup(
      {
        enabled: true,
        presetId: "builtin:wardogs",
        groupLabel: "",
        leaderLabel: "",
        channelLeadMinutes: "",
        rows: rows(["Manticore", "Valkyra"]),
      },
      { maxCount: 2 },
    );
    expect(truncated.ok).toBe(false);
    expect(!truncated.ok && truncated.errors[0]).toContain(
      'Preset "Wardogs" needs 3 groups but the limit is 2',
    );
    // No rows: also refused, not expanded.
    const empty = validateGroupSetup(
      {
        enabled: true,
        presetId: "builtin:eve-factions",
        groupLabel: "",
        leaderLabel: "",
        channelLeadMinutes: "",
        rows: [],
      },
      { maxCount: 3 },
    );
    expect(empty.ok).toBe(false);
  });

  it("the server still accepts a Custom setup of any size within the cap", () => {
    const custom = validateGroupSetup(
      {
        enabled: true,
        presetId: "",
        groupLabel: "",
        leaderLabel: "",
        channelLeadMinutes: "",
        rows: rows(["a", "b"]),
      },
      { maxCount: 2 },
    );
    expect(custom.ok).toBe(true);
  });
});

describe("native validation while groups are off (#1188)", () => {
  it("does not block the form on group number fields until groups are on", () => {
    const dom = boot();
    const size = field(dom, "group_0_size");
    const lead = field(dom, "groups_lead_minutes");
    size.value = "100";
    lead.value = "1441";
    expect(field(dom, "groups_enabled").checked).toBe(false);
    expect(size.checkValidity()).toBe(true);
    expect(lead.checkValidity()).toBe(true);
    // A fraction would fail the default step too.
    size.value = "1.5";
    expect(size.checkValidity()).toBe(true);
  });

  it("applies the limits again once groups are ticked", () => {
    const dom = boot();
    const size = field(dom, "group_0_size");
    const lead = field(dom, "groups_lead_minutes");
    size.value = "100";
    lead.value = "1441";
    tick(dom);
    expect(size.checkValidity()).toBe(false);
    expect(lead.checkValidity()).toBe(false);
    size.value = "8";
    lead.value = "30";
    expect(size.checkValidity()).toBe(true);
    expect(lead.checkValidity()).toBe(true);
    size.value = "1.5";
    expect(size.checkValidity()).toBe(false);
  });

  it("covers rows added by the script", () => {
    const dom = boot(15, 1);
    tick(dom);
    (
      dom.window.document.querySelector("[data-add-group]") as HTMLElement
    ).click();
    const size = field(dom, "group_1_size");
    size.value = "100";
    expect(size.checkValidity()).toBe(false);
    // Unticking releases the new row's field too.
    const box = field(dom, "groups_enabled");
    box.checked = false;
    box.dispatchEvent(new (dom.window as Win).Event("change"));
    expect(size.checkValidity()).toBe(true);
  });

  it("typing in a row ticks the box and restores the limits", () => {
    const dom = boot();
    const size = field(dom, "group_0_size");
    size.value = "100";
    expect(size.checkValidity()).toBe(true);
    field(dom, "group_0_name").dispatchEvent(
      new (dom.window as Win).Event("input", { bubbles: true }),
    );
    expect(field(dom, "groups_enabled").checked).toBe(true);
    expect(size.checkValidity()).toBe(false);
  });
});

describe("duplicate name check in the page script (#1188)", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "accepts a first group named %s",
    (name) => {
      const dom = boot();
      tick(dom);
      field(dom, "group_0_name").value = name;
      expect(submit(dom)).toBe(false);
      const errors = dom.window.document.querySelector(
        "[data-group-errors]",
      ) as HTMLElement;
      expect(errors.hidden).toBe(true);
    },
  );

  it("still reports a real duplicate, ignoring case", () => {
    const dom = boot();
    tick(dom);
    field(dom, "group_0_name").value = "constructor";
    field(dom, "group_1_name").value = "Constructor";
    expect(submit(dom)).toBe(true);
    const errors = dom.window.document.querySelector(
      "[data-group-errors]",
    ) as HTMLElement;
    expect(errors.hidden).toBe(false);
    expect(errors.textContent).toContain("already used by group 1");
  });

  it("matches the server, which accepts those names", () => {
    const result = validateGroupSetup(
      {
        enabled: true,
        presetId: "",
        groupLabel: "",
        leaderLabel: "",
        channelLeadMinutes: "",
        rows: ["constructor", "__proto__"].map((name, i) => ({
          position: i + 1,
          name,
          kind: "team",
          size: "",
          tag: "",
          marker: "",
        })),
      },
      { maxCount: 15 },
    );
    expect(result.ok).toBe(true);
  });
});

describe("restoring a draft after a refused submit (#1188)", () => {
  it("reapplies the number limits, so a bad lead time is flagged straight away", () => {
    const dom = boot(15, 2, {
      groups_enabled: true,
      groups_lead_minutes: "1441",
      group_0_name: "Alpha",
      group_0_size: "100",
    });
    expect(field(dom, "groups_enabled").checked).toBe(true);
    expect(field(dom, "groups_lead_minutes").value).toBe("1441");
    expect(field(dom, "groups_lead_minutes").checkValidity()).toBe(false);
    expect(field(dom, "group_0_size").checkValidity()).toBe(false);
    field(dom, "groups_lead_minutes").value = "1.5";
    expect(field(dom, "groups_lead_minutes").checkValidity()).toBe(false);
    field(dom, "groups_lead_minutes").value = "30";
    expect(field(dom, "groups_lead_minutes").checkValidity()).toBe(true);
  });

  it("keeps the fields released when the draft had groups off", () => {
    const dom = boot(15, 2, {
      groups_enabled: false,
      groups_lead_minutes: "1441",
    });
    expect(field(dom, "groups_lead_minutes").value).toBe("1441");
    expect(field(dom, "groups_lead_minutes").checkValidity()).toBe(true);
  });

  it("restores rows beyond the default count and their limits", () => {
    const dom = boot(15, 1, {
      groups_enabled: true,
      group_2_name: "Third",
      group_2_size: "100",
    });
    expect(field(dom, "group_2_name").value).toBe("Third");
    expect(field(dom, "group_2_size").checkValidity()).toBe(false);
  });

  it("does not put back a preset that is no longer offered", () => {
    const dom = boot(2, 2, {
      groups_enabled: true,
      groups_preset: "builtin:wardogs",
    });
    expect(
      (field(dom, "groups_preset") as unknown as HTMLSelectElement).value,
    ).toBe("");
  });

  it("puts back a preset that is offered", () => {
    const dom = boot(15, 2, { groups_preset: "builtin:wardogs" });
    expect(
      (field(dom, "groups_preset") as unknown as HTMLSelectElement).value,
    ).toBe("builtin:wardogs");
  });

  it("restores nothing without an error flash", () => {
    const html = page();
    const dom = new JSDOM(html, {
      url: "http://localhost/admin/events",
      runScripts: "outside-only",
    });
    dom.window.sessionStorage.setItem(
      "koolbot-event-form-draft",
      JSON.stringify({ group_0_name: "Ghost" }),
    );
    const code = [
      ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
    ]
      .map((m) => m[1])
      .find((c) => c.includes("koolbot-event-form-draft"));
    dom.window.eval(code as string);
    expect(field(dom, "group_0_name").value).toBe("");
  });
});
