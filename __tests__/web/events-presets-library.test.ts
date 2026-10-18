/* global HTMLInputElement, HTMLOptionElement, HTMLSelectElement, HTMLFormElement, HTMLElement */
/**
 * The picker and the admin page of the preset library (#1200). The markup and
 * the page script come from `renderEventsPage` / `renderEventPresetsPage`, and
 * the scripts are run for real in jsdom, so what is tested is what ships.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { renderEventsPage } from "../../src/web/admin-views.js";
import { renderEventPresetsPage } from "../../src/web/event-presets-page.js";
import {
  EVENT_GROUP_PRESETS,
  type EventGroupPreset,
} from "../../src/content/event-group-presets.js";

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

const LIB_ID = "lib:0123456789abcdef01234567";
const libraryPreset: EventGroupPreset = {
  id: LIB_ID,
  label: "Clan <match>",
  description: 'Five "roles"',
  groupLabel: "Squad",
  leaderLabel: "Lead",
  channelLeadMinutes: 30,
  groups: [
    { name: "Assault", kind: "team", size: 8, tag: "AS", marker: "🟢" },
    { name: "Logi", kind: "team", size: 4, tag: "", marker: "" },
    { name: "Command", kind: "leads", size: null, tag: "", marker: "" },
  ],
};

function page(
  presets: readonly EventGroupPreset[] | undefined,
  maxCount = 15,
  notice: string | null = null,
): string {
  return renderEventsPage({
    ...COMMON,
    groupLimits: { defaultCount: 2, maxCount },
    ...(presets ? { groupPresets: presets } : {}),
    groupPresetsNotice: notice,
  } as never);
}

function boot(html: string, restore?: Record<string, unknown>): JSDOM {
  let doc = html;
  if (restore) {
    doc = doc.replace(
      "<h1>Events</h1>",
      '<h1>Events</h1><div class="notice err" data-flash>Groups: nope</div>',
    );
  }
  const dom = new JSDOM(doc, {
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
    ...doc.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
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

function choose(dom: JSDOM, id: string): HTMLSelectElement {
  const select = field(dom, "groups_preset") as unknown as HTMLSelectElement;
  select.value = id;
  select.dispatchEvent(
    new (dom.window as Win).Event("change", { bubbles: true }),
  );
  return select;
}

function optionValues(html: string): string[] {
  const doc = new JSDOM(html).window.document;
  return Array.from(
    doc.querySelectorAll<HTMLOptionElement>(
      'select[name="groups_preset"] option',
    ),
  ).map((o) => o.value);
}

describe("the event form's preset picker (#1200)", () => {
  it("offers every built-in when no list is passed, as before the library", () => {
    expect(optionValues(page(undefined))).toEqual([
      "",
      ...EVENT_GROUP_PRESETS.map((p) => p.id),
    ]);
  });

  it("offers exactly the enabled presets plus Custom, so a disabled built-in is absent", () => {
    const enabled = [
      EVENT_GROUP_PRESETS[0],
      libraryPreset,
    ] as EventGroupPreset[];
    expect(optionValues(page(enabled))).toEqual([
      "",
      "builtin:red-vs-blue",
      LIB_ID,
    ]);
  });

  it("offers only Custom when nothing is enabled", () => {
    expect(optionValues(page([]))).toEqual([""]);
  });

  it("shows the unreadable-library notice and escapes the preset text", () => {
    const html = page(
      [libraryPreset],
      15,
      "The preset library could not be read <b>x</b>",
    );
    expect(html).toContain("could not be read &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("Clan &lt;match&gt;");
    expect(html).not.toContain("Clan <match>");
  });

  it("a library preset fills the rows, group label, leader label and lead time", () => {
    const dom = boot(page([libraryPreset]));
    choose(dom, LIB_ID);
    expect(field(dom, "group_0_name").value).toBe("Assault");
    expect(field(dom, "group_0_size").value).toBe("8");
    expect(field(dom, "group_0_tag").value).toBe("AS");
    expect(field(dom, "group_0_marker").value).toBe("🟢");
    expect(field(dom, "group_2_name").value).toBe("Command");
    expect(field(dom, "group_2_kind").value).toBe("leads");
    expect(field(dom, "groups_label").value).toBe("Squad");
    expect(field(dom, "groups_leader_label").value).toBe("Lead");
    expect(field(dom, "groups_lead_minutes").value).toBe("30");
    expect(field(dom, "groups_enabled").checked).toBe(true);
  });

  it("a library preset that uses the server default clears a lead time an earlier preset filled", () => {
    const serverDefault: EventGroupPreset = {
      ...libraryPreset,
      id: "lib:aaaaaaaaaaaaaaaaaaaaaaaa",
      label: "Default lead",
      channelLeadMinutes: null,
    };
    const dom = boot(page([libraryPreset, serverDefault]));
    choose(dom, LIB_ID);
    expect(field(dom, "groups_lead_minutes").value).toBe("30");
    choose(dom, serverDefault.id);
    expect(field(dom, "groups_lead_minutes").value).toBe("");
  });

  it("a built-in leaves the leader label and lead time alone", () => {
    const dom = boot(page(undefined));
    field(dom, "groups_leader_label").value = "Captain";
    field(dom, "groups_lead_minutes").value = "10";
    choose(dom, "builtin:red-vs-blue");
    expect(field(dom, "groups_leader_label").value).toBe("Captain");
    expect(field(dom, "groups_lead_minutes").value).toBe("10");
    expect(field(dom, "group_0_name").value).toBe("Red");
  });

  it("a library preset bigger than the cap is disabled and never applied", () => {
    const dom = boot(page([libraryPreset], 2));
    const option = dom.window.document.querySelector(
      `option[value="${LIB_ID}"]`,
    ) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect(option.textContent).toContain("needs 3 groups, limit is 2");
    field(dom, "group_0_name").value = "Mine";
    const select = choose(dom, LIB_ID);
    expect(field(dom, "group_0_name").value).toBe("Mine");
    expect(select.value).toBe("");
  });

  it("a draft that names a preset no longer offered is not put back", () => {
    const dom = boot(page([EVENT_GROUP_PRESETS[0]]), {
      groups_enabled: true,
      groups_preset: "builtin:wardogs",
      group_0_name: "Kept",
    });
    expect(
      (field(dom, "groups_preset") as unknown as HTMLSelectElement).value,
    ).toBe("");
    expect(field(dom, "group_0_name").value).toBe("Kept");
  });

  it("a draft that names an offered library preset is put back", () => {
    const dom = boot(page([libraryPreset]), {
      groups_enabled: true,
      groups_preset: LIB_ID,
    });
    expect(
      (field(dom, "groups_preset") as unknown as HTMLSelectElement).value,
    ).toBe(LIB_ID);
  });
});

// ---------- The admin page ----------

const entry = (
  over: Partial<EventGroupPreset> & {
    source: "builtin" | "library";
    enabled: boolean;
  },
) => ({ ...EVENT_GROUP_PRESETS[0], ...over });

function adminPage(
  over: Partial<Parameters<typeof renderEventPresetsPage>[0]> = {},
): string {
  return renderEventPresetsPage({
    csrfToken: "csrf-tok",
    remainingMs: 60_000,
    entries: [
      entry({ source: "builtin", enabled: true }),
      entry({
        id: LIB_ID,
        label: 'Mine "<x>"',
        source: "library",
        enabled: false,
        groups: libraryPreset.groups,
      }),
    ],
    state: "ok",
    maxCount: 15,
    defaultCount: 2,
    editing: null,
    values: {},
    prefillNote: null,
    ...over,
  });
}

describe("the presets admin page (#1200)", () => {
  it("lists built-in and own presets, each with a switch that posts the wanted state", () => {
    const doc = new JSDOM(adminPage()).window.document;
    const forms = Array.from(
      doc.querySelectorAll<HTMLFormElement>(
        'form[action="/admin/events/presets/toggle"]',
      ),
    );
    expect(forms).toHaveLength(2);
    const wanted = forms.map(
      (f) => (f.querySelector('[name="enabled"]') as HTMLInputElement).value,
    );
    // The built-in is on (so the form turns it off); the own preset is off.
    expect(wanted).toEqual(["0", "1"]);
    expect(forms.every((f) => f.querySelector('[name="_csrf"]'))).toBe(true);
  });

  it("offers edit and delete for own presets only, and duplicate for all", () => {
    const doc = new JSDOM(adminPage()).window.document;
    expect(
      doc.querySelectorAll('form[action="/admin/events/presets/delete"]'),
    ).toHaveLength(1);
    expect(doc.querySelectorAll('a[href*="?edit="]')).toHaveLength(1);
    expect(doc.querySelectorAll('a[href*="?from="]')).toHaveLength(2);
  });

  it("escapes preset names everywhere", () => {
    const html = adminPage();
    expect(html).not.toContain('Mine "<x>"');
    expect(html).toContain("Mine &quot;&lt;x&gt;&quot;");
  });

  it("prefills the editor from a copy and keeps the group rows", () => {
    const html = adminPage({
      values: {
        preset_name: "Red vs Blue (copy)",
        groups_label: "Team",
        group_0_name: "Red",
        group_0_kind: "leads",
        group_0_size: "5",
        group_1_name: "Blue",
        group_1_kind: "team",
        group_1_size: "",
        group_2_name: "Third",
      },
      prefillNote: "Prefilled from x",
    });
    const doc = new JSDOM(html).window.document;
    const val = (n: string): string =>
      (doc.querySelector(`[name="${n}"]`) as HTMLInputElement).value;
    expect(val("preset_name")).toBe("Red vs Blue (copy)");
    expect(val("group_0_name")).toBe("Red");
    expect(val("group_0_kind")).toBe("leads");
    expect(val("group_0_size")).toBe("5");
    expect(val("group_2_name")).toBe("Third");
    expect(doc.querySelector('[name="preset_id"]')).toBeNull();
    expect(html).toContain("Prefilled from x");
  });

  it("an edit carries the preset's id and the unreadable notice shows", () => {
    const html = adminPage({
      editing: { id: LIB_ID, label: "Mine" },
      state: "library-unreadable",
    });
    const doc = new JSDOM(html).window.document;
    expect(
      (doc.querySelector('[name="preset_id"]') as HTMLInputElement).value,
    ).toBe(LIB_ID);
    expect(html).toContain("could not be read");
  });

  it("shows every stored row even when the cap was lowered below it, with a warning", () => {
    const values: Record<string, string> = { preset_name: "Big" };
    for (let i = 0; i < 4; i++) values[`group_${i}_name`] = `G${i}`;
    const html = adminPage({
      maxCount: 2,
      values,
      editing: { id: LIB_ID, label: "Big" },
    });
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelectorAll("[data-group-row]")).toHaveLength(4);
    expect(
      (doc.querySelector('[name="group_3_name"]') as HTMLInputElement).value,
    ).toBe("G3");
    expect(html).toContain("has 4 groups but the limit is 2");
  });

  it("with the library unreadable, an edit shows no editor, so nothing can be created as a duplicate", () => {
    const html = adminPage({
      editUnavailable: true,
      state: "library-unreadable",
    });
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector("form[data-preset-form]")).toBeNull();
    expect(doc.querySelector('[name="preset_name"]')).toBeNull();
    expect(html).toContain("cannot be loaded right now");
  });

  it("Add a group clones a row, up to the cap", () => {
    const html = adminPage({ maxCount: 3 });
    const dom = new JSDOM(html, {
      url: "http://localhost/admin/events/presets",
      runScripts: "outside-only",
    });
    const code = [
      ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
    ]
      .map((m) => m[1])
      .find((c) => c.includes("koolbot-event-preset-draft"));
    dom.window.eval(code as string);
    const doc = dom.window.document;
    const button = doc.querySelector("[data-add-group]") as HTMLElement;
    expect(button.hidden).toBe(false);
    button.click();
    expect(doc.querySelectorAll("[data-group-row]")).toHaveLength(3);
    expect(doc.querySelector('[name="group_2_name"]')).not.toBeNull();
    expect(button.hidden).toBe(true);
  });
});
