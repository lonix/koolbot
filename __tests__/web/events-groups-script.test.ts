/* global HTMLInputElement, HTMLOptionElement, HTMLElement */
/**
 * The Groups section's page script, run for real in jsdom (#1188). The markup
 * and script come from `renderAdminNewEventPage`, so what is tested is what ships.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { renderGroupRow } from "../../src/web/admin-views.js";
import { renderAdminNewEvent } from "./new-event-page-helper.js";
import { validateGroupSetup } from "../../src/services/event-groups.js";

/** Where the page shows a flash, as the New event page draws it (#1527). */
const BACK_LINK = '<p><a href="/admin/events">Back to Events</a></p>';

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

function page(maxCount = 15, defaultCount = 2, presets?: unknown): string {
  return renderAdminNewEvent({
    ...COMMON,
    groupLimits: { defaultCount, maxCount },
    ...(presets ? { groupPresets: presets } : {}),
  } as never);
}

/** Load the page and run its groups script. */
function boot(
  maxCount = 15,
  defaultCount = 2,
  restore?: Record<string, unknown>,
  presets?: unknown,
): JSDOM {
  let html = page(maxCount, defaultCount, presets);
  if (restore) {
    // The page as it comes back after a refused submit.
    html = html.replace(
      BACK_LINK,
      `${BACK_LINK}<div class="notice err" data-flash>Groups: nope</div>`,
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
  const rowsScript = scripts.find((code) => code.includes("koolGroupRows="));
  if (!rowsScript) throw new Error("group rows script not found");
  // The same order as the page: the shared rows script, then the form's.
  dom.window.eval(rowsScript);
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

/** Click a preset card: check its radio and fire the change event. */
function choosePreset(dom: JSDOM, id: string): void {
  const radio = dom.window.document.querySelector(
    `input[type=radio][name="groups_preset"][value="${id}"]`,
  ) as HTMLInputElement;
  radio.checked = true;
  radio.dispatchEvent(
    new (dom.window as Win).Event("change", { bubbles: true }),
  );
}

/** The value of the chosen preset card ("" = Custom). */
function chosenPreset(dom: JSDOM): string {
  const radio = dom.window.document.querySelector(
    'input[type=radio][name="groups_preset"]:checked',
  ) as HTMLInputElement | null;
  return radio ? radio.value : "<none>";
}

describe("oversized presets (#1188)", () => {
  it("renders presets bigger than the cap disabled, with the reason", () => {
    const doc = new JSDOM(page(2)).window.document;
    const card = (id: string): HTMLInputElement =>
      doc.querySelector(`input[value="${id}"]`) as HTMLInputElement;
    const text = (id: string): string =>
      card(id).parentElement?.textContent ?? "";
    expect(card("builtin:red-vs-blue").disabled).toBe(false);
    expect(card("builtin:wardogs").disabled).toBe(true);
    expect(text("builtin:wardogs")).toContain("needs 3 groups, limit is 2");
    expect(card("builtin:eve-factions").disabled).toBe(true);
    expect(text("builtin:eve-factions")).toContain(
      "needs 4 groups, limit is 2",
    );
  });

  it("offers every preset when the cap is large enough", () => {
    const doc = new JSDOM(page(15)).window.document;
    expect(doc.querySelectorAll("input[type=radio][disabled]")).toHaveLength(0);
  });

  it("does not replace rows or truncate when an oversized preset is selected anyway", () => {
    const dom = boot(2);
    field(dom, "group_0_name").value = "Mine";
    // A disabled card cannot be clicked; forcing it must still change nothing.
    const wardogs = dom.window.document.querySelector(
      'input[value="builtin:wardogs"]',
    ) as HTMLInputElement;
    wardogs.disabled = false;
    choosePreset(dom, "builtin:wardogs");
    expect(field(dom, "group_0_name").value).toBe("Mine");
    expect(chosenPreset(dom)).toBe("");
  });

  it("fills a preset that fits", () => {
    const dom = boot(2);
    choosePreset(dom, "builtin:red-vs-blue");
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
    // Rows cut down to the cap, still under the wardogs id.
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
      'Preset "3 teams" needs 3 groups but the limit is 2',
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
    // The card is disabled (over the cap), so Custom stays chosen.
    expect(chosenPreset(dom)).toBe("");
  });

  it("puts back a preset that is offered", () => {
    const dom = boot(15, 2, { groups_preset: "builtin:wardogs" });
    expect(chosenPreset(dom)).toBe("builtin:wardogs");
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

describe("the Captains lobby switch of the event form (#1251)", () => {
  const OLD_PRESET = {
    id: "lib:old-command",
    label: "Command and squads",
    description: "saved before the switch",
    groupLabel: "Squad",
    groups: [
      { name: "Alpha", kind: "team", size: 4, tag: "", marker: "" },
      { name: "Command", kind: "leads", size: null, tag: "", marker: "" },
      { name: "Bravo", kind: "team", size: 4, tag: "", marker: "" },
    ],
  };
  const PLAIN_PRESET = {
    id: "lib:plain",
    label: "Two teams",
    description: "",
    groupLabel: "Team",
    groups: [
      { name: "Red", kind: "team", size: null, tag: "", marker: "" },
      { name: "Blue", kind: "team", size: null, tag: "", marker: "" },
    ],
  };
  const choose = (dom: JSDOM, id: string): void => {
    choosePreset(dom, id);
  };
  const captains = (dom: JSDOM, on: boolean): void => {
    const box = field(dom, "groups_captains");
    box.checked = on;
    box.dispatchEvent(
      new (dom.window as Win).Event("change", { bubbles: true }),
    );
  };

  it("is a checkbox, off by default, that says it needs leaders", () => {
    const dom = boot();
    const lobby = field(dom, "groups_captains_lobby");
    expect(lobby.type).toBe("checkbox");
    expect(lobby.checked).toBe(false);
    expect(
      dom.window.document.body.textContent?.includes("Captains lobby"),
    ).toBe(true);
  });

  it("is disabled (so not posted) until group leaders is ticked, and follows it", () => {
    const dom = boot();
    expect(field(dom, "groups_captains_lobby").disabled).toBe(true);
    captains(dom, true);
    expect(field(dom, "groups_captains_lobby").disabled).toBe(false);
    captains(dom, false);
    expect(field(dom, "groups_captains_lobby").disabled).toBe(true);
  });

  it("a preset with a leads row ticks the switch and does not put that row in the list", () => {
    const dom = boot(15, 2, undefined, [OLD_PRESET, PLAIN_PRESET]);
    choose(dom, "lib:old-command");
    expect(field(dom, "groups_captains_lobby").checked).toBe(true);
    expect(field(dom, "group_0_name").value).toBe("Alpha");
    expect(field(dom, "group_1_name").value).toBe("Bravo");
    expect(field(dom, "group_1_kind").value).toBe("team");
    // The kind select offers no leads choice for a new row.
    const kinds = [
      ...dom.window.document.querySelectorAll(
        'select[name="group_0_kind"] option',
      ),
    ].map((o) => (o as HTMLOptionElement).value);
    expect(kinds).toEqual(["team", "open"]);
  });

  it("a preset without a leads row unticks it again", () => {
    const dom = boot(15, 2, undefined, [OLD_PRESET, PLAIN_PRESET]);
    choose(dom, "lib:old-command");
    choose(dom, "lib:plain");
    expect(field(dom, "groups_captains_lobby").checked).toBe(false);
    expect(field(dom, "group_0_name").value).toBe("Red");
  });

  it("a preset that fits only without its lobby row is refused at the cap, like the server does", () => {
    // Three rows including the lobby row: a cap of 2 refuses it.
    const dom = boot(2, 2, undefined, [OLD_PRESET]);
    field(dom, "group_0_name").value = "Mine";
    choose(dom, "lib:old-command");
    expect(field(dom, "group_0_name").value).toBe("Mine");
    expect(field(dom, "groups_captains_lobby").checked).toBe(false);
  });

  it("is put back from a kept draft, with its disabled state following the leaders box", () => {
    const dom = boot(15, 2, {
      groups_enabled: true,
      groups_captains: true,
      groups_captains_lobby: true,
    });
    expect(field(dom, "groups_captains_lobby").checked).toBe(true);
    expect(field(dom, "groups_captains_lobby").disabled).toBe(false);
    const off = boot(15, 2, {
      groups_enabled: true,
      groups_captains: false,
      groups_captains_lobby: true,
    });
    expect(field(off, "groups_captains_lobby").disabled).toBe(true);
  });

  it("a draft from before the switch that holds a leads row ticks the lobby box and does not restore that row as a team", () => {
    const dom = boot(15, 3, {
      groups_enabled: true,
      groups_captains: true,
      group_0_name: "Alpha",
      group_0_kind: "team",
      group_0_size: "4",
      group_1_name: "Command",
      group_1_kind: "leads",
      group_1_tag: "C",
      group_2_name: "Bravo",
      group_2_kind: "open",
    });
    expect(field(dom, "groups_captains_lobby").checked).toBe(true);
    expect(field(dom, "groups_captains_lobby").disabled).toBe(false);
    // The leads row is gone from the list; the other rows are intact.
    expect(field(dom, "group_1_name").value).toBe("");
    expect(field(dom, "group_1_tag").value).toBe("");
    expect(field(dom, "group_0_name").value).toBe("Alpha");
    expect(field(dom, "group_0_size").value).toBe("4");
    expect(field(dom, "group_2_name").value).toBe("Bravo");
    expect(field(dom, "group_2_kind").value).toBe("open");
  });

  it("a row that is already a leads group (an old preset in the preset editor) keeps its own option, so saving never turns it into a team", () => {
    const html = renderGroupRow("0", "1", { name: "Command", kind: "leads" });
    expect(html).toContain('<option value="leads" selected>');
    const fresh = renderGroupRow("0", "1", { name: "Red", kind: "team" });
    expect(fresh).not.toContain('value="leads"');
  });
});

describe("renderGroupRow options (the host panel's live-edit rows, #1406)", () => {
  it("posts the names it is given, and the default names otherwise", () => {
    const html = renderGroupRow(
      "3",
      "4",
      { name: "Red", marker: "R", size: "2", tag: "R" },
      { names: { marker: "m1", name: "n1", size: "z1", tag: "t1" } },
    );
    for (const name of ["m1", "n1", "z1", "t1"]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).not.toContain("group_3_name");
    // The kind keeps its default name (it is not renamed by `names`).
    expect(html).toContain('name="group_3_kind"');
    const plain = renderGroupRow("3", "4", { name: "Red" });
    expect(plain).toContain('name="group_3_marker"');
    expect(plain).toContain('name="group_3_name"');
    expect(plain).toContain('name="group_3_size"');
    expect(plain).toContain('name="group_3_tag"');
  });

  it("fixedKind leaves out the kind select, its panel and the More button", () => {
    const html = renderGroupRow(
      "0",
      "1",
      { kind: "team" },
      { fixedKind: true },
    );
    expect(html).not.toContain("<select");
    expect(html).not.toContain("data-kind-toggle");
    expect(html).not.toContain("data-kind-panel");
    expect(renderGroupRow("0", "1", { kind: "team" })).toContain(
      "data-kind-toggle",
    );
  });

  it("noTag shows a disabled tag box that posts nothing", () => {
    const html = renderGroupRow("0", "1", { tag: "X" }, { noTag: true });
    expect(html).not.toContain('name="group_0_tag"');
    expect(html).toMatch(/<input[^>]*aria-label="Group 1 tag[^>]*disabled>/);
  });

  it("extra goes inside the row's item, after the grid", () => {
    const html = renderGroupRow("0", "1", {}, { extra: "<i>EXTRA</i>" });
    expect(html.indexOf("EXTRA")).toBeGreaterThan(html.indexOf("kb-grouprow"));
    expect(html.indexOf("EXTRA")).toBeLessThan(html.lastIndexOf("</div>"));
  });
});

describe("the Captains lobby counts toward the cap of Add a group (#1263)", () => {
  const change = (dom: JSDOM, name: string, checked: boolean): void => {
    const el = field(dom, name);
    el.checked = checked;
    el.dispatchEvent(
      new (dom.window as Win).Event("change", { bubbles: true }),
    );
  };
  const add = (dom: JSDOM): HTMLElement =>
    dom.window.document.querySelector("[data-add-group]") as HTMLElement;

  it("a posted lobby takes a slot, an unposted one (leaders off, so the box is disabled) does not", () => {
    const dom = boot(3, 2);
    expect(add(dom).hidden).toBe(false);
    change(dom, "groups_captains", true);
    change(dom, "groups_captains_lobby", true);
    // Two rows and the lobby are the three slots.
    expect(add(dom).hidden).toBe(true);
    change(dom, "groups_captains_lobby", false);
    expect(add(dom).hidden).toBe(false);
    change(dom, "groups_captains_lobby", true);
    expect(add(dom).hidden).toBe(true);
    // Leaders off: the box is disabled and not posted, so its slot is free.
    change(dom, "groups_captains", false);
    expect(add(dom).hidden).toBe(false);
  });

  it("the button cannot add past the cap while the lobby is ticked", () => {
    const dom = boot(3, 2);
    change(dom, "groups_captains", true);
    change(dom, "groups_captains_lobby", true);
    add(dom).click();
    expect(
      dom.window.document.querySelectorAll("[data-group-row]"),
    ).toHaveLength(2);
  });

  it("a restored draft keeps all its rows and shows the button state of its restored lobby", () => {
    const dom = boot(3, 2, {
      groups_enabled: true,
      groups_captains: true,
      groups_captains_lobby: true,
      group_0_name: "A",
      group_1_name: "B",
    });
    expect(field(dom, "groups_captains_lobby").checked).toBe(true);
    expect(add(dom).hidden).toBe(true);
  });
});

describe("choosing a preset recomputes the lobby, the cap and the button (#1263)", () => {
  const preset = (id: string, kinds: string[]) => ({
    id,
    label: id,
    description: "",
    groupLabel: "Team",
    groups: kinds.map((kind, i) => ({
      name: `${kind}${i}`,
      kind,
      size: null,
      tag: "",
      marker: "",
    })),
  });
  const presets = [
    preset("lib:plain", ["team", "team"]),
    preset("lib:lobby", ["team", "team", "leads"]),
  ];
  const pick = (dom: JSDOM, id: string): void => {
    choosePreset(dom, id);
  };
  const tickBox = (dom: JSDOM, name: string, checked: boolean): void => {
    const el = field(dom, name);
    el.checked = checked;
    el.dispatchEvent(
      new (dom.window as Win).Event("change", { bubbles: true }),
    );
  };
  const add = (dom: JSDOM): HTMLElement =>
    dom.window.document.querySelector("[data-add-group]") as HTMLElement;

  it("a preset without a lobby unticks the box and frees its slot", () => {
    const dom = boot(3, 2, undefined, presets);
    tickBox(dom, "groups_captains", true);
    tickBox(dom, "groups_captains_lobby", true);
    expect(add(dom).hidden).toBe(true);
    pick(dom, "lib:plain");
    expect(field(dom, "groups_captains_lobby").checked).toBe(false);
    expect(add(dom).hidden).toBe(false);
  });

  it("a preset with a lobby ticks the box and takes its slot", () => {
    const dom = boot(3, 2, undefined, presets);
    tickBox(dom, "groups_captains", true);
    expect(add(dom).hidden).toBe(false);
    pick(dom, "lib:lobby");
    expect(field(dom, "groups_captains_lobby").checked).toBe(true);
    expect(add(dom).hidden).toBe(true);
  });

  it("with leaders off the lobby box stays disabled through a preset choice and takes no slot", () => {
    const dom = boot(3, 2, undefined, presets);
    pick(dom, "lib:lobby");
    expect(field(dom, "groups_captains_lobby").disabled).toBe(true);
    expect(add(dom).hidden).toBe(false);
    tickBox(dom, "groups_captains", true);
    expect(field(dom, "groups_captains_lobby").disabled).toBe(false);
    expect(add(dom).hidden).toBe(true);
  });
});
