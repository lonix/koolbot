/* global HTMLInputElement, HTMLOptionElement, HTMLSelectElement, HTMLFormElement, HTMLElement, Document */
/**
 * The picker and the admin page of the preset library (#1200). The markup and
 * the page script come from `renderEventsPage` / `renderEventPresetsPage`, and
 * the scripts are run for real in jsdom, so what is tested is what ships.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { renderEventsPage } from "../../src/web/admin-views.js";
import {
  renderEventPresetsPage,
  renderPresetEditorForm,
} from "../../src/web/event-presets-page.js";
import { renderMyEventPresetsBody } from "../../src/web/me-event-presets-page.js";
import {
  presetToFormValues,
  validatePresetForm,
} from "../../src/services/event-group-preset-service.js";
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

  it("marks the admin's own personal preset as theirs (#1216), since its name may match a library one", () => {
    const mine = {
      ...libraryPreset,
      id: "my:0123456789abcdef01234599",
    } as EventGroupPreset;
    const doc = new JSDOM(page([libraryPreset, mine])).window.document;
    const text = (id: string): string =>
      doc.querySelector(`option[value="${id}"]`)?.textContent ?? "";
    expect(text(mine.id)).toContain("(yours)");
    expect(text(LIB_ID)).not.toContain("(yours)");
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
    // The preset's leads group ("Command") is the Captains lobby now (#1251):
    // it ticks the switch instead of becoming a row.
    expect(
      dom.window.document.querySelector('[name="group_2_name"]'),
    ).toBeNull();
    expect(field(dom, "groups_captains_lobby").checked).toBe(true);
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

  describe("the hosts' presets card (#1216)", () => {
    const MY_A = "my:0123456789abcdef01234567";
    const MY_B = "my:0123456789abcdef01234568";
    const hostRow = (
      id: string,
      label: string,
      publishedAs: string | null,
      ownerName = "",
    ) => ({
      ownerId: "111111111111111111",
      ownerName,
      publishedAs,
      entry: {
        ...EVENT_GROUP_PRESETS[0],
        id,
        label,
        source: "personal" as const,
        enabled: true,
      },
    });

    it("lists each host preset with Publish, or Unpublish when a copy exists, posting the personal id and a token", () => {
      const doc = new JSDOM(
        adminPage({
          hostPresets: {
            page: 0,
            hasMore: false,
            rows: [
              hostRow(MY_A, "Night raid", null, "Ada"),
              hostRow(MY_B, "Clan match", `lib:${"a".repeat(24)}`),
            ],
          },
        }),
      ).window.document;
      const publish = doc.querySelectorAll<HTMLFormElement>(
        'form[action="/admin/events/presets/publish"]',
      );
      const unpublish = doc.querySelectorAll<HTMLFormElement>(
        'form[action="/admin/events/presets/unpublish"]',
      );
      expect(publish).toHaveLength(1);
      expect(unpublish).toHaveLength(1);
      expect(
        (publish[0].querySelector('[name="id"]') as HTMLInputElement).value,
      ).toBe(MY_A);
      expect(
        (unpublish[0].querySelector('[name="id"]') as HTMLInputElement).value,
      ).toBe(MY_B);
      expect(unpublish[0].getAttribute("data-confirm")).toContain(
        "Events that already used it keep their groups",
      );
      for (const f of [publish[0], unpublish[0]]) {
        expect(f.querySelector('[name="_csrf"]')).not.toBeNull();
      }
      expect(doc.body.textContent).toContain("Ada");
      expect(doc.body.textContent).toContain("111111111111111111");
    });

    it("links to the previous and next page when there are more rows", () => {
      const rows = [hostRow(MY_A, "Night raid", null)];
      const doc = new JSDOM(
        adminPage({ hostPresets: { page: 1, hasMore: true, rows } }),
      ).window.document;
      const hrefs = Array.from(
        doc.querySelectorAll("a[href*='hostPage=']"),
      ).map((a) => a.getAttribute("href"));
      expect(hrefs).toEqual([
        "/admin/events/presets?hostPage=0#host-presets",
        "/admin/events/presets?hostPage=2#host-presets",
      ]);
      const single = new JSDOM(
        adminPage({ hostPresets: { page: 0, hasMore: false, rows } }),
      ).window.document;
      expect(single.querySelector("a[href*='hostPage=']")).toBeNull();
    });

    it("tells hosts on their own page that admins can see unpublished presets, and only other hosts cannot", () => {
      const doc = new JSDOM(
        renderMyEventPresetsBody({
          csrfToken: "t",
          presets: [],
          editing: null,
          editUnavailable: false,
          values: {},
          prefillNote: null,
          maxCount: 15,
          defaultCount: 2,
        }),
      ).window.document;
      const text = doc.querySelector(".subtitle")?.textContent ?? "";
      expect(text).toContain("other hosts cannot see or use them");
      expect(text).toContain("Server admins can see them");
      expect(text).not.toContain("nobody else");
    });

    it("escapes host-supplied names and shows empty and unreadable states", () => {
      const html = adminPage({
        hostPresets: {
          page: 0,
          hasMore: false,
          rows: [hostRow(MY_A, "<script>x</script>", null, "<b>Eve</b>")],
        },
      });
      expect(html).not.toContain("<script>x</script>");
      expect(html).not.toContain("<b>Eve</b>");
      expect(html).toContain("&lt;b&gt;Eve&lt;/b&gt;");
      expect(
        adminPage({ hostPresets: { page: 0, hasMore: false, rows: [] } }),
      ).toContain("No host has saved a preset yet");
      expect(adminPage({ hostPresets: null })).toContain(
        "hosts' presets could not be read",
      );
      expect(adminPage()).not.toContain("Hosts' presets");
    });
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

  it("a leads row that arrives as an ordinary row value keeps its own kind option, so saving never turns it into a team; no other row can pick it (#1251, #1263)", () => {
    const html = adminPage({
      values: {
        preset_name: "Old command preset",
        group_0_name: "Alpha",
        group_0_kind: "team",
        group_1_name: "Command",
        group_1_kind: "leads",
      },
    });
    const doc = new JSDOM(html).window.document;
    const kinds = (name: string): string[] =>
      Array.from(
        doc.querySelectorAll<HTMLOptionElement>(`[name="${name}"] option`),
      ).map((o) => o.value);
    const selected = (name: string): string =>
      (doc.querySelector(`[name="${name}"]`) as HTMLSelectElement).value;
    expect(kinds("group_1_kind")).toEqual(["team", "open", "leads"]);
    expect(selected("group_1_kind")).toBe("leads");
    expect(kinds("group_0_kind")).toEqual(["team", "open"]);
    const template = doc.querySelector("template[data-group-row-template]");
    expect(template?.innerHTML.includes('value="leads"')).toBe(false);
  });

  it("a refused copy of a preset with a leads row comes back with that row still a leads row, so the retry never turns it into a team (#1251)", () => {
    // After a refused save the page is the blank editor: no kind select has a
    // leads option. The draft the script restores holds the leads value.
    const html = adminPage().replace(
      "<h1>Group presets</h1>",
      '<h1>Group presets</h1><div class="notice err" data-flash>nope</div>',
    );
    const dom = new JSDOM(html, {
      url: "http://localhost/admin/events/presets",
      runScripts: "outside-only",
    });
    dom.window.sessionStorage.setItem(
      "koolbot-event-preset-draft",
      JSON.stringify({
        preset_name: "Copy",
        group_0_name: "Alpha",
        group_0_kind: "team",
        group_1_name: "Command",
        group_1_kind: "leads",
      }),
    );
    const code = [
      ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
    ]
      .map((m) => m[1])
      .find((c) => c.includes("koolbot-event-preset-draft"));
    dom.window.eval(code as string);
    const kind = (n: number): HTMLSelectElement =>
      dom.window.document.querySelector(
        `[name="group_${n}_kind"]`,
      ) as HTMLSelectElement;
    expect(kind(1).value).toBe("leads");
    expect(kind(0).value).toBe("team");
    // An older draft has no tick of its own: restoring its leads row ticks the
    // box, because the tick decides whether the lobby is kept (#1263).
    expect(
      (
        dom.window.document.querySelector(
          '[name="groups_captains_lobby"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    // Only the row that was a leads row gets the option.
    expect(Array.from(kind(0).options).map((o) => o.value)).toEqual([
      "team",
      "open",
    ]);
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

  it("after a refused save, restoring the draft rebuilds every submitted row, even beyond the cap", () => {
    // Duplicate or Save-from-event of 4 groups at a cap of 2: the refused
    // create comes back to a page with the default 2 rows and the draft.
    const html = adminPage({ maxCount: 2 }).replace(
      "<h1>Group presets</h1>",
      '<h1>Group presets</h1><div class="notice err" data-flash>Preset not saved.</div>',
    );
    const dom = new JSDOM(html, {
      url: "http://localhost/admin/events/presets",
      runScripts: "outside-only",
    });
    const draft: Record<string, string> = { preset_name: "Copy" };
    for (let i = 0; i < 4; i++) {
      draft[`group_${i}_name`] = `G${i}`;
      draft[`group_${i}_kind`] = "team";
      draft[`group_${i}_size`] = String(i + 1);
    }
    dom.window.sessionStorage.setItem(
      "koolbot-event-preset-draft",
      JSON.stringify(draft),
    );
    const code = [
      ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
    ]
      .map((m) => m[1])
      .find((c) => c.includes("koolbot-event-preset-draft"));
    dom.window.eval(code as string);
    const doc = dom.window.document;
    expect(doc.querySelectorAll("[data-group-row]")).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(
        (doc.querySelector(`[name="group_${i}_name"]`) as HTMLInputElement)
          .value,
      ).toBe(`G${i}`);
      expect(
        (doc.querySelector(`[name="group_${i}_size"]`) as HTMLInputElement)
          .value,
      ).toBe(String(i + 1));
    }
    // A user's own additions stay capped.
    expect((doc.querySelector("[data-add-group]") as HTMLElement).hidden).toBe(
      true,
    );
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

// ---------- Clan tags default (#1194) ----------

describe("a preset's clan tags default (#1194)", () => {
  const tagged: EventGroupPreset = {
    ...libraryPreset,
    id: "lib:bbbbbbbbbbbbbbbbbbbbbbbb",
    label: "Quiz night",
    tagsEnabled: true,
  };

  it("choosing a preset that defaults tags on ticks the box; one without the default unticks it; the host can still change it", () => {
    const dom = boot(page([libraryPreset, tagged]));
    const box = field(dom, "groups_tags");
    expect(box.checked).toBe(false);
    choose(dom, tagged.id);
    expect(box.checked).toBe(true);
    // The host's own choice after the preset stands.
    box.checked = false;
    expect(box.checked).toBe(false);
    choose(dom, tagged.id);
    expect(box.checked).toBe(true);
    // A preset with no default (absent = off) puts the box back to off.
    choose(dom, LIB_ID);
    expect(box.checked).toBe(false);
  });

  it("a built-in preset has no default, so it leaves the box off", () => {
    const dom = boot(page(undefined));
    field(dom, "groups_tags").checked = true;
    choose(dom, "builtin:red-vs-blue");
    expect(field(dom, "groups_tags").checked).toBe(false);
  });

  it("the form offers the tags box and the suffix box, unticked", () => {
    const doc = new JSDOM(page(undefined)).window.document;
    for (const name of ["groups_tags", "groups_tags_suffix"]) {
      const el = doc.querySelector(`[name="${name}"]`) as HTMLInputElement;
      expect(el.type).toBe("checkbox");
      expect(el.checked).toBe(false);
    }
  });

  it("a restored draft keeps the host's tags choice", () => {
    const dom = boot(page([libraryPreset]), {
      groups_enabled: true,
      groups_tags: true,
      groups_tags_suffix: true,
    });
    expect(field(dom, "groups_tags").checked).toBe(true);
    expect(field(dom, "groups_tags_suffix").checked).toBe(true);
  });

  it("the preset editor shows the box ticked only when the preset has the default, and lists it in the table", () => {
    const on = new JSDOM(adminPage({ values: { groups_tags: "1" } })).window
      .document;
    expect(
      (on.querySelector('[name="groups_tags"]') as HTMLInputElement).checked,
    ).toBe(true);
    const off = new JSDOM(adminPage({ values: {} })).window.document;
    expect(
      (off.querySelector('[name="groups_tags"]') as HTMLInputElement).checked,
    ).toBe(false);
    const listed = adminPage({
      entries: [
        entry({ source: "library", enabled: true, tagsEnabled: true }),
        entry({
          id: "lib:cccccccccccccccccccccccc",
          source: "library",
          enabled: true,
        }),
      ],
    });
    expect((listed.match(/clan tags on/g) ?? []).length).toBe(1);
  });

  it("after a refused save, the editor draft keeps the ticked box", () => {
    const html = adminPage().replace(
      "<h1>Group presets</h1>",
      '<h1>Group presets</h1><div class="notice err" data-flash>Preset not saved.</div>',
    );
    const dom = new JSDOM(html, {
      url: "http://localhost/admin/events/presets",
      runScripts: "outside-only",
    });
    dom.window.sessionStorage.setItem(
      "koolbot-event-preset-draft",
      JSON.stringify({ preset_name: "Copy", groups_tags: true }),
    );
    const code = [
      ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
    ]
      .map((m) => m[1])
      .find((c) => c.includes("koolbot-event-preset-draft"));
    dom.window.eval(code as string);
    expect(
      (
        dom.window.document.querySelector(
          '[name="groups_tags"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
});

describe("the Captains lobby tick in the preset editor (#1263)", () => {
  const stored = [
    { name: "Alpha", kind: "team", size: 4, tag: "AL", marker: "G" },
    { name: 'War <room> "1"', kind: "leads", size: 5, tag: "WR", marker: "R" },
    { name: "Specs", kind: "open", size: null, tag: "", marker: "" },
  ];
  const editor = (values: Record<string, string>, maxCount = 15): string =>
    renderPresetEditorForm({
      csrfInput: '<input type="hidden" name="_csrf" value="t">',
      action: "/x",
      editing: { id: LIB_ID, label: "Old" },
      values,
      maxCount,
      defaultCount: 2,
      cancelHref: "/x",
    });
  const docOf = (html: string): Document => new JSDOM(html).window.document;
  const tick = (doc: Document): HTMLInputElement =>
    doc.querySelector('[name="groups_captains_lobby"]') as HTMLInputElement;
  /** What a browser would post: named controls, a checkbox only when checked. */
  const posted = (doc: Document): Record<string, string> => {
    const body: Record<string, string> = {};
    const form = doc.querySelector("form[data-preset-form]") as HTMLFormElement;
    for (const el of Array.from(form.elements) as HTMLInputElement[]) {
      if (!el.name || el.type === "submit" || el.type === "button") continue;
      if (el.type === "checkbox" && !el.checked) continue;
      body[el.name] = el.value;
    }
    return body;
  };

  it("an old preset's leads row is the ticked box: no row for it, no leads option anywhere", () => {
    const doc = docOf(
      editor(
        presetToFormValues({
          label: "Old",
          groupLabel: "Squad",
          groups: stored,
        }),
      ),
    );
    expect(tick(doc).checked).toBe(true);
    expect(doc.querySelectorAll("[data-group-row]")).toHaveLength(2);
    const optionValues = Array.from(
      doc.querySelectorAll<HTMLOptionElement>("select option"),
    ).map((o) => o.value);
    expect(optionValues).not.toContain("leads");
    const template = doc.querySelector("template[data-group-row-template]");
    expect(template?.innerHTML.includes("leads")).toBe(false);
    // The row's own values are carried aside, escaped.
    const lobbyName = doc.querySelector(
      '[name="lobby_name"]',
    ) as HTMLInputElement;
    expect(lobbyName.type).toBe("hidden");
    expect(lobbyName.value).toBe('War <room> "1"');
  });

  it("a preset without a lobby shows the box unticked, with nothing carried", () => {
    const doc = docOf(
      editor(presetToFormValues({ groupLabel: "Squad", groups: [stored[0]] })),
    );
    expect(tick(doc).checked).toBe(false);
    expect(
      (doc.querySelector('[name="lobby_name"]') as HTMLInputElement).value,
    ).toBe("");
    const blank = docOf(editor({}));
    expect(tick(blank).checked).toBe(false);
  });

  it("states that the tick stands alone and only takes effect while leaders are ticked on the event", () => {
    const html = editor({});
    expect(html).toContain("Captains lobby");
    expect(html).toContain(
      "only takes effect on an event while group leaders is ticked",
    );
    expect(html).not.toContain("use the Captains lobby switch instead");
  });

  it("round trip through the rendered form: opening and saving an old preset changes nothing", () => {
    const values = presetToFormValues({
      label: "Old",
      description: "d",
      groupLabel: "Squad",
      leaderLabel: "Captain",
      channelLeadMinutes: 15,
      tagsEnabled: true,
      groups: stored,
    });
    const body = posted(docOf(editor(values)));
    const result = validatePresetForm(body, { maxCount: 15 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.groups).toEqual(stored);
    expect(result.data).toMatchObject({
      name: "Old",
      groupLabel: "Squad",
      leaderLabel: "Captain",
      channelLeadMinutes: 15,
      tagsEnabled: true,
    });
  });

  it("unticking the box in the rendered form removes the lobby on save; ticking a preset without one adds it", () => {
    const withLobby = docOf(
      editor(presetToFormValues({ groupLabel: "Squad", groups: stored })),
    );
    tick(withLobby).checked = false;
    const off = validatePresetForm(
      { ...posted(withLobby), preset_name: "Old" },
      { maxCount: 15 },
    );
    expect(off.ok && off.data.groups.map((g) => g.kind)).toEqual([
      "team",
      "open",
    ]);

    const without = docOf(
      editor(presetToFormValues({ groupLabel: "Squad", groups: [stored[0]] })),
    );
    tick(without).checked = true;
    const on = validatePresetForm(
      { ...posted(without), preset_name: "New" },
      { maxCount: 15 },
    );
    expect(on.ok && on.data.groups.map((g) => [g.name, g.kind])).toEqual([
      ["Alpha", "team"],
      ["Leader lobby", "leads"],
    ]);
  });

  it("the same editor is on the hosts' own page", () => {
    const html = renderMyEventPresetsBody({
      csrfToken: "t",
      presets: [],
      editing: null,
      editUnavailable: false,
      values: presetToFormValues({ groupLabel: "Squad", groups: stored }),
      prefillNote: null,
      maxCount: 15,
      defaultCount: 2,
    });
    const doc = docOf(html);
    expect(tick(doc).checked).toBe(true);
    expect(doc.querySelectorAll("[data-group-row]")).toHaveLength(2);
  });

  it("the oversize warning counts the lobby", () => {
    const html = editor(
      presetToFormValues({ groupLabel: "Squad", groups: stored }),
      2,
    );
    expect(html).toContain(
      "has 3 groups (counting the Captains lobby) but the limit is 2",
    );
  });

  it("the list shows the lobby as a tag, not as a group", () => {
    const html = adminPage();
    const row = html.slice(html.indexOf("Mine &quot;"));
    expect(row).toContain("captains lobby");
    expect(row).toContain('<span class="muted">2:</span>');
    expect(row).not.toContain("Command");
  });

  it("the page script counts a ticked lobby toward the cap of the Add a group button", () => {
    const html = editor({}, 4);
    const dom = new JSDOM(`<body>${html}</body>`, {
      url: "http://localhost/admin/events/presets",
      runScripts: "outside-only",
    });
    const code = renderEventPresetsPage({
      csrfToken: "t",
      remainingMs: 1,
      entries: [],
      state: "ok",
      maxCount: 4,
      defaultCount: 2,
      editing: null,
      values: {},
      prefillNote: null,
    })
      .match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)
      ?.map((m) => m.replace(/<\/?script[^>]*>/g, ""))
      .find((c) => c.includes("koolbot-event-preset-draft"));
    dom.window.eval(code as string);
    const add = dom.window.document.querySelector(
      "[data-add-group]",
    ) as HTMLElement;
    expect(add.hidden).toBe(false);
    const box = dom.window.document.querySelector(
      '[name="groups_captains_lobby"]',
    ) as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new dom.window.Event("change"));
    add.click();
    expect(
      dom.window.document.querySelectorAll("[data-group-row]"),
    ).toHaveLength(3);
    expect(add.hidden).toBe(true);
    box.checked = false;
    box.dispatchEvent(new dom.window.Event("change"));
    expect(add.hidden).toBe(false);
  });
});
