/* global HTMLInputElement, HTMLElement, HTMLButtonElement, HTMLDetailsElement, HTMLFormElement */
/**
 * The group setup form's collapse, preset cards, quick builder, derived values
 * and emoji picker (#1299), run for real in jsdom. The markup and scripts come
 * from `renderEventsPage`, so what is tested is what ships.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { renderEventsPage } from "../../src/web/admin-views.js";
import {
  MARKER_CHOICES,
  MARKER_COLOURS,
  groupRowsScript,
  markerFits,
  markerLength,
  pickableMarkers,
} from "../../src/web/event-group-form.js";
import {
  GROUP_MARKER_MAX_CHARS,
  parseGroupForm,
  validateGroupSetup,
} from "../../src/services/event-groups.js";
import { EVENT_GROUP_PRESETS } from "../../src/content/event-group-presets.js";

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

type Win = JSDOM["window"];

function boot(maxCount = 15, defaultCount = 2): JSDOM {
  const html = renderEventsPage({
    ...COMMON,
    groupLimits: { defaultCount, maxCount },
  } as never);
  const dom = new JSDOM(html, {
    url: "http://localhost/admin/events",
    runScripts: "outside-only",
  });
  const scripts = [
    ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  dom.window.eval(scripts.find((c) => c.includes("koolGroupRows="))!);
  dom.window.eval(scripts.find((c) => c.includes("koolbot-event-form-draft"))!);
  return dom;
}

const q = <T extends HTMLElement = HTMLElement>(dom: JSDOM, sel: string): T => {
  const el = dom.window.document.querySelector(sel);
  if (!el) throw new Error(`nothing matches ${sel}`);
  return el as T;
};
const field = (dom: JSDOM, name: string): HTMLInputElement =>
  q<HTMLInputElement>(dom, `[name="${name}"]`);

/** A click: for a checkbox or radio this toggles it and fires change, like a browser. */
function click(dom: JSDOM, el: HTMLElement): void {
  el.dispatchEvent(
    new (dom.window as Win).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    }),
  );
}

const typeInto = (dom: JSDOM, name: string, value: string): void => {
  const el = field(dom, name);
  el.value = value;
  el.dispatchEvent(new (dom.window as Win).Event("input", { bubbles: true }));
  el.dispatchEvent(new (dom.window as Win).Event("change", { bubbles: true }));
};

const chooseCard = (dom: JSDOM, id: string): void =>
  click(dom, q(dom, `input[type=radio][name="groups_preset"][value="${id}"]`));

const switchOn = (dom: JSDOM): void =>
  click(dom, q(dom, '[name="groups_enabled"]'));

const quickSize = (dom: JSDOM, value: string): void =>
  click(dom, q(dom, `[data-size-quick] input[value="${value}"]`));

/** What the browser would post for the form, as the server parses it. */
function posted(dom: JSDOM): Record<string, string> {
  const form = q<HTMLFormElement>(dom, "form[data-event-form]");
  const data = new (dom.window as Win).FormData(form);
  const body: Record<string, string> = {};
  data.forEach((v, k) => {
    body[k] = String(v);
  });
  return body;
}

const validate = (dom: JSDOM, maxCount = 15) =>
  validateGroupSetup(parseGroupForm(posted(dom)), { maxCount });

describe("the marker list (#1299)", () => {
  it("only offers Unicode emoji that pass the marker limit and the validator", () => {
    expect(MARKER_CHOICES.length).toBeGreaterThan(20);
    for (const { emoji } of MARKER_CHOICES) {
      expect(markerLength(emoji)).toBeLessThanOrEqual(GROUP_MARKER_MAX_CHARS);
      expect(emoji).not.toMatch(/[<>:]/); // never a custom server emoji
      const result = validateGroupSetup(
        parseGroupForm({
          groups_enabled: "1",
          group_0_name: "Red",
          group_0_marker: emoji,
        }),
        { maxCount: 5 },
      );
      expect(result.ok).toBe(true);
    }
  });

  it("has no duplicates, offers all of them, and starts with the colour circles in the generate order", () => {
    const all = MARKER_CHOICES.map((c) => c.emoji);
    expect(new Set(all).size).toBe(all.length);
    expect(pickableMarkers()).toHaveLength(MARKER_CHOICES.length);
    expect(all.slice(0, MARKER_COLOURS.length)).toEqual(
      MARKER_COLOURS.map((c) => c.emoji),
    );
    expect(MARKER_COLOURS.slice(0, 4).map((c) => c.colour)).toEqual([
      "Red",
      "Blue",
      "Green",
      "Yellow",
    ]);
  });

  it("the length check refuses what the validator refuses (a family emoji is over the limit)", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(markerFits(family)).toBe(false);
    expect(markerFits("🇳🇴🇳🇴🇳🇴")).toBe(false);
    expect(
      validateGroupSetup(
        parseGroupForm({
          groups_enabled: "1",
          group_0_name: "Red",
          group_0_marker: family,
        }),
        { maxCount: 5 },
      ).ok,
    ).toBe(false);
  });

  it("the picker's script carries exactly the list", () => {
    const script = groupRowsScript();
    for (const { emoji } of MARKER_CHOICES) expect(script).toContain(emoji);
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("collapsing the groups section (#1299)", () => {
  it("folds to the one switch while groups are off, and opens when it is ticked", () => {
    const dom = boot();
    const body = q(dom, "[data-groups-body]");
    expect(body.hidden).toBe(true);
    switchOn(dom);
    expect(field(dom, "groups_enabled").checked).toBe(true);
    expect(body.hidden).toBe(false);
    click(dom, field(dom, "groups_enabled"));
    expect(body.hidden).toBe(true);
  });

  it("starts with Advanced closed and the script-only parts shown", () => {
    const dom = boot();
    expect(q<HTMLDetailsElement>(dom, "[data-groups-advanced]").open).toBe(
      false,
    );
    expect(q(dom, "[data-group-builder]").hidden).toBe(false);
    expect(q(dom, "[data-size-quick]").hidden).toBe(false);
  });

  it("hides, and does not post, an option whose parent is off", () => {
    const dom = boot();
    switchOn(dom);
    const nestedLeaders = q(dom, '[data-nested-for="groups_captains"]');
    const nestedTags = q(dom, '[data-nested-for="groups_tags"]');
    expect(nestedLeaders.hidden).toBe(true);
    expect(nestedTags.hidden).toBe(true);
    expect(field(dom, "groups_captains_lobby").disabled).toBe(true);
    expect(field(dom, "groups_tags_suffix").disabled).toBe(true);
    click(dom, field(dom, "groups_captains"));
    expect(nestedLeaders.hidden).toBe(false);
    expect(field(dom, "groups_captains_lobby").disabled).toBe(false);
    expect(nestedTags.hidden).toBe(true);
    click(dom, field(dom, "groups_tags"));
    expect(nestedTags.hidden).toBe(false);
    expect(field(dom, "groups_tags_suffix").disabled).toBe(false);
    // Ticked children are posted only while their parent is on.
    click(dom, field(dom, "groups_captains_lobby"));
    expect(posted(dom)["groups_captains_lobby"]).toBe("1");
    click(dom, field(dom, "groups_captains"));
    expect(posted(dom)["groups_captains_lobby"]).toBeUndefined();
  });
});

describe("preset cards (#1299)", () => {
  it("choosing a card fills the rows, folds them behind a one-line summary and Customise opens them", () => {
    const dom = boot();
    switchOn(dom);
    chooseCard(dom, "builtin:red-vs-blue");
    expect(field(dom, "group_0_name").value).toBe("Red");
    expect(field(dom, "group_1_name").value).toBe("Blue");
    const editor = q(dom, "[data-group-editor]");
    const summary = q(dom, "[data-preset-summary]");
    const customise = q<HTMLButtonElement>(dom, "[data-customise]");
    expect(editor.hidden).toBe(true);
    expect(summary.hidden).toBe(false);
    expect(summary.textContent).toBe(
      "2 groups · Red 🔴, Blue 🔵 · no size limit",
    );
    expect(customise.hidden).toBe(false);
    click(dom, customise);
    expect(editor.hidden).toBe(false);
    expect(customise.getAttribute("aria-expanded")).toBe("true");
    click(dom, customise);
    expect(editor.hidden).toBe(true);
  });

  it("the summary follows clan tags, the size and leaders", () => {
    const dom = boot();
    switchOn(dom);
    chooseCard(dom, "builtin:red-vs-blue");
    click(dom, field(dom, "groups_tags"));
    click(dom, field(dom, "groups_captains"));
    quickSize(dom, "5");
    expect(q(dom, "[data-preset-summary]").textContent).toBe(
      "2 groups · Red [RED] 🔴, Blue [BLUE] 🔵 · 5 each · clan tags on · leaders on",
    );
  });

  it("Red vs Blue with 5 each takes three clicks from a blank form, no typing, and the server accepts it", () => {
    const dom = boot();
    click(dom, field(dom, "groups_enabled")); // 1
    chooseCard(dom, "builtin:red-vs-blue"); // 2
    quickSize(dom, "5"); // 3
    const result = validate(dom);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.setup.groups.map((g) => [g.name, g.size, g.marker, g.kind]),
    ).toEqual([
      ["Red", 5, "🔴", "team"],
      ["Blue", 5, "🔵", "team"],
    ]);
    expect(result.setup.presetId).toBe("builtin:red-vs-blue");
  });

  it("choosing Custom shows the rows again", () => {
    const dom = boot();
    switchOn(dom);
    chooseCard(dom, "builtin:red-vs-blue");
    chooseCard(dom, "");
    expect(q(dom, "[data-group-editor]").hidden).toBe(false);
    expect(q(dom, "[data-preset-summary]").hidden).toBe(true);
    expect(q(dom, "[data-customise]").hidden).toBe(true);
  });

  it("an error on submit opens the rows so the mistake is next to its field", () => {
    const dom = boot();
    switchOn(dom);
    chooseCard(dom, "builtin:red-vs-blue");
    typeInto(dom, "group_1_name", "red");
    expect(q(dom, "[data-group-editor]").hidden).toBe(true);
    const event = new (dom.window as Win).Event("submit", {
      cancelable: true,
      bubbles: true,
    });
    q(dom, "form[data-event-form]").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(q(dom, "[data-group-editor]").hidden).toBe(false);
    expect(q(dom, "[data-group-errors]").textContent).toContain(
      "already used by group 1",
    );
  });
});

describe("the quick builder (#1299)", () => {
  const build = (dom: JSDOM, count: string, size: string, names?: string) => {
    q<HTMLInputElement>(dom, "[data-build-count]").value = count;
    q<HTMLInputElement>(dom, "[data-build-size]").value = size;
    if (names) {
      click(dom, q(dom, `input[name="groups_build_names"][value="${names}"]`));
    }
    click(dom, q(dom, "[data-build]"));
  };

  it("4 groups of 5 makes Red, Blue, Green, Yellow with the colour markers in order", () => {
    const dom = boot();
    build(dom, "4", "5");
    expect(field(dom, "groups_enabled").checked).toBe(true);
    const rows = [0, 1, 2, 3].map((i) => [
      field(dom, `group_${i}_name`).value,
      field(dom, `group_${i}_size`).value,
      field(dom, `group_${i}_marker`).value,
    ]);
    expect(rows).toEqual([
      ["Red", "5", "🔴"],
      ["Blue", "5", "🔵"],
      ["Green", "5", "🟢"],
      ["Yellow", "5", "🟡"],
    ]);
    expect(validate(dom).ok).toBe(true);
    expect(q(dom, "[data-preset-summary]").textContent).toBe(
      "4 groups · Red 🔴, Blue 🔵, Green 🟢, Yellow 🟡 · 5 each",
    );
  });

  it("numbered names use the group wording and keep the markers", () => {
    const dom = boot();
    build(dom, "3", "", "numbers");
    expect([0, 1, 2].map((i) => field(dom, `group_${i}_name`).value)).toEqual([
      "Team 1",
      "Team 2",
      "Team 3",
    ]);
    expect(field(dom, "group_2_marker").value).toBe("🟢");
    expect(field(dom, "group_0_size").value).toBe("");
  });

  it("never builds past the cap, counting the captains lobby", () => {
    const dom = boot(4);
    switchOn(dom);
    click(dom, field(dom, "groups_captains"));
    click(dom, field(dom, "groups_captains_lobby"));
    build(dom, "9", "5");
    expect(field(dom, "group_2_name").value).toBe("Green");
    expect(
      dom.window.document.querySelector('[name="group_3_name"]'),
    ).toBeNull();
    expect(validate(dom, 4).ok).toBe(true);
  });

  it("rebuilding with fewer groups blanks the rest", () => {
    const dom = boot();
    build(dom, "4", "5");
    build(dom, "2", "5");
    expect(field(dom, "group_2_name").value).toBe("");
    expect(field(dom, "group_2_marker").value).toBe("");
    expect(validate(dom).ok).toBe(true);
  });

  it("past nine groups the colours run out, so the names are numbered", () => {
    const dom = boot();
    build(dom, "10", "");
    expect(field(dom, "group_9_name").value).toBe("Team 10");
    expect(validate(dom).ok).toBe(true);
  });
});

describe("derived values (#1299)", () => {
  it("the tag follows the name while clan tags are on, until it is edited", () => {
    const dom = boot();
    switchOn(dom);
    click(dom, field(dom, "groups_tags"));
    typeInto(dom, "group_0_name", "Red");
    expect(field(dom, "group_0_tag").value).toBe("RED");
    typeInto(dom, "group_0_name", "Crimson Wolves");
    expect(field(dom, "group_0_tag").value).toBe("CW");
    typeInto(dom, "group_0_tag", "CRM");
    typeInto(dom, "group_0_name", "Reds");
    expect(field(dom, "group_0_tag").value).toBe("CRM");
  });

  it("no tag is derived while clan tags are off, and ticking them fills the empty ones", () => {
    const dom = boot();
    switchOn(dom);
    typeInto(dom, "group_0_name", "Blue");
    expect(field(dom, "group_0_tag").value).toBe("");
    click(dom, field(dom, "groups_tags"));
    expect(field(dom, "group_0_tag").value).toBe("BLUE");
  });

  it("a tag the preset set is kept", () => {
    const dom = boot();
    switchOn(dom);
    typeInto(dom, "group_0_tag", "ZZ");
    click(dom, field(dom, "groups_tags"));
    typeInto(dom, "group_0_name", "Red");
    expect(field(dom, "group_0_tag").value).toBe("ZZ");
  });

  it("size copies down from the first row to named rows until they are edited", () => {
    const dom = boot();
    switchOn(dom);
    typeInto(dom, "group_0_name", "A");
    typeInto(dom, "group_1_name", "B");
    expect(field(dom, "group_1_size").value).toBe("");
    typeInto(dom, "group_0_size", "6");
    expect(field(dom, "group_1_size").value).toBe("6");
    typeInto(dom, "group_1_size", "4");
    typeInto(dom, "group_0_size", "7");
    expect(field(dom, "group_1_size").value).toBe("4");
  });

  it("an empty row never gets a size, so it stays ignored", () => {
    const dom = boot(15, 3);
    switchOn(dom);
    typeInto(dom, "group_0_name", "A");
    typeInto(dom, "group_0_size", "6");
    expect(field(dom, "group_1_size").value).toBe("");
    expect(field(dom, "group_2_size").value).toBe("");
    expect(validate(dom).ok).toBe(true);
  });

  it("a name that is cleared gives back what was filled in for it", () => {
    const dom = boot();
    switchOn(dom);
    click(dom, field(dom, "groups_tags"));
    typeInto(dom, "group_0_name", "A");
    typeInto(dom, "group_0_size", "5");
    typeInto(dom, "group_1_name", "B");
    expect(field(dom, "group_1_size").value).toBe("5");
    expect(field(dom, "group_1_tag").value).toBe("B");
    typeInto(dom, "group_1_name", "");
    expect(field(dom, "group_1_size").value).toBe("");
    expect(field(dom, "group_1_tag").value).toBe("");
    expect(validate(dom).ok).toBe(true);
  });

  it("the next colour goes to a new named row once the others have markers", () => {
    const dom = boot(15, 3);
    switchOn(dom);
    typeInto(dom, "group_0_name", "A");
    typeInto(dom, "group_1_name", "B");
    // No marker anywhere yet: a plain list stays plain.
    expect(field(dom, "group_1_marker").value).toBe("");
    field(dom, "group_0_marker").value = "🔴";
    typeInto(dom, "group_2_name", "C");
    expect(field(dom, "group_2_marker").value).toBe("🔵");
  });
});

describe("the emoji picker (#1299)", () => {
  const marker = (i: number): HTMLInputElement =>
    q<HTMLInputElement>(dom0, `[name="group_${i}_marker"]`);
  let dom0: JSDOM;
  const rowBtn = (i: number): HTMLButtonElement =>
    dom0.window.document.querySelectorAll<HTMLButtonElement>(
      "[data-marker-btn]",
    )[i];

  it("replaces the text box with a button that shows the current emoji", () => {
    dom0 = boot();
    expect(marker(0).hidden).toBe(true);
    expect(rowBtn(0).hidden).toBe(false);
    expect(rowBtn(0).textContent).toBe("+");
    expect(rowBtn(0).getAttribute("aria-label")).toBe(
      "Group 1 marker: none. Choose one",
    );
    marker(0).value = "🔵";
    marker(0).dispatchEvent(
      new (dom0.window as Win).Event("input", { bubbles: true }),
    );
    expect(rowBtn(0).textContent).toBe("🔵");
    expect(rowBtn(0).getAttribute("aria-label")).toBe(
      "Group 1 marker: 🔵. Change it",
    );
  });

  it("opens a grid of the curated emoji, marks the current one, and picking sets the value", () => {
    dom0 = boot();
    switchOn(dom0);
    marker(1).value = "🟢";
    rowBtn(1).dispatchEvent(
      new (dom0.window as Win).Event("click", { bubbles: true }),
    );
    const pop = q(dom0, ".kb-emoji-pop");
    expect(pop.hidden).toBe(false);
    expect(rowBtn(1).getAttribute("aria-expanded")).toBe("true");
    const cells = [
      ...pop.querySelectorAll<HTMLButtonElement>(".kb-emoji-grid button"),
    ];
    expect(cells.map((c) => c.getAttribute("data-emoji"))).toEqual(
      MARKER_CHOICES.map((c) => c.emoji),
    );
    expect(
      cells
        .filter((c) => c.getAttribute("aria-pressed") === "true")
        .map((c) => c.textContent),
    ).toEqual(["🟢"]);
    const red = cells.find((c) => c.getAttribute("data-emoji") === "🔴")!;
    click(dom0, red);
    expect(marker(1).value).toBe("🔴");
    expect(rowBtn(1).textContent).toBe("🔴");
    expect(pop.hidden).toBe(true);
    expect(rowBtn(1).getAttribute("aria-expanded")).toBe("false");
    // The pick counts as a change of the form: it ticks groups on and posts.
    expect(posted(dom0)["group_1_marker"]).toBe("🔴");
  });

  it("No marker is an explicit choice", () => {
    dom0 = boot();
    marker(0).value = "🟣";
    rowBtn(0).dispatchEvent(
      new (dom0.window as Win).Event("click", { bubbles: true }),
    );
    click(dom0, q(dom0, ".kb-emoji-pop button[data-emoji='']"));
    expect(marker(0).value).toBe("");
    expect(rowBtn(0).textContent).toBe("+");
  });

  it("search narrows the grid and says when nothing matches", () => {
    dom0 = boot();
    rowBtn(0).dispatchEvent(
      new (dom0.window as Win).Event("click", { bubbles: true }),
    );
    const search = q<HTMLInputElement>(dom0, "[data-emoji-search]");
    search.value = "square";
    search.dispatchEvent(
      new (dom0.window as Win).Event("input", { bubbles: true }),
    );
    const shown = [
      ...dom0.window.document.querySelectorAll<HTMLButtonElement>(
        ".kb-emoji-grid button",
      ),
    ].filter((b) => !b.hidden);
    expect(shown.length).toBe(7);
    expect(q(dom0, "[data-emoji-empty]").hidden).toBe(true);
    search.value = "zzz";
    search.dispatchEvent(
      new (dom0.window as Win).Event("input", { bubbles: true }),
    );
    expect(q(dom0, "[data-emoji-empty]").hidden).toBe(false);
  });

  it("Escape closes it and a click elsewhere closes it", () => {
    dom0 = boot();
    rowBtn(0).dispatchEvent(
      new (dom0.window as Win).Event("click", { bubbles: true }),
    );
    const pop = q(dom0, ".kb-emoji-pop");
    pop.dispatchEvent(
      new (dom0.window as Win).KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    expect(pop.hidden).toBe(true);
    rowBtn(0).dispatchEvent(
      new (dom0.window as Win).Event("click", { bubbles: true }),
    );
    expect(pop.hidden).toBe(false);
    dom0.window.document.body.dispatchEvent(
      new (dom0.window as Win).MouseEvent("click", { bubbles: true }),
    );
    expect(pop.hidden).toBe(true);
  });

  it("a row added later gets the button and the More toggle too", () => {
    dom0 = boot(15, 1);
    switchOn(dom0);
    click(dom0, q(dom0, "[data-add-group]"));
    const rows = dom0.window.document.querySelectorAll("[data-group-row]");
    expect(rows).toHaveLength(2);
    expect(
      rows[1].querySelector<HTMLElement>("[data-marker-btn]")?.hidden,
    ).toBe(false);
    expect(
      rows[1].querySelector<HTMLElement>("[data-kind-toggle]")?.hidden,
    ).toBe(false);
  });

  it("the kind select is folded behind More, and a row that is not a team stays open", () => {
    dom0 = boot();
    const panel = (i: number): HTMLElement =>
      dom0.window.document.querySelectorAll<HTMLElement>("[data-kind-panel]")[
        i
      ];
    const toggle = (i: number): HTMLElement =>
      dom0.window.document.querySelectorAll<HTMLElement>("[data-kind-toggle]")[
        i
      ];
    expect(panel(0).hidden).toBe(true);
    click(dom0, toggle(0));
    expect(panel(0).hidden).toBe(false);
    expect(toggle(0).getAttribute("aria-expanded")).toBe("true");
    click(dom0, toggle(0));
    expect(panel(0).hidden).toBe(true);
    // A preset that sets a non-team kind opens its panel.
    field(dom0, "group_1_kind").value = "open";
    window0Sync(dom0);
    expect(panel(1).hidden).toBe(false);
  });
});

function window0Sync(dom: JSDOM): void {
  (
    dom.window as unknown as { koolGroupRows: { syncAll(): void } }
  ).koolGroupRows.syncAll();
}

describe("a refused submit puts the form back (#1299)", () => {
  it("restores the chosen card, the rows and the markers, with the rows open", () => {
    const html = renderEventsPage({
      ...COMMON,
      groupLimits: { defaultCount: 2, maxCount: 15 },
    } as never).replace(
      "<h1>Events</h1>",
      '<h1>Events</h1><div class="notice err" data-flash>Groups: nope</div>',
    );
    const dom = new JSDOM(html, {
      url: "http://localhost/admin/events",
      runScripts: "outside-only",
    });
    dom.window.sessionStorage.setItem(
      "koolbot-event-form-draft",
      JSON.stringify({
        groups_enabled: true,
        groups_preset: EVENT_GROUP_PRESETS[0].id,
        group_0_name: "Red",
        group_0_marker: "🔴",
        group_1_name: "Blue",
        group_1_marker: "🔵",
        groups_tags: true,
      }),
    );
    const scripts = [
      ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    dom.window.eval(scripts.find((c) => c.includes("koolGroupRows="))!);
    dom.window.eval(
      scripts.find((c) => c.includes("koolbot-event-form-draft"))!,
    );
    expect(field(dom, "groups_enabled").checked).toBe(true);
    expect(q(dom, "[data-groups-body]").hidden).toBe(false);
    expect(
      q<HTMLInputElement>(dom, 'input[name="groups_preset"]:checked').value,
    ).toBe(EVENT_GROUP_PRESETS[0].id);
    expect(q(dom, "[data-group-editor]").hidden).toBe(false);
    expect(q(dom, "[data-nested-for='groups_tags']").hidden).toBe(false);
    const buttons = dom.window.document.querySelectorAll("[data-marker-btn]");
    expect(buttons[0].textContent).toBe("🔴");
    expect(buttons[1].textContent).toBe("🔵");
    expect(markerLength("🔴")).toBe(1);
  });

  it("saves only the chosen card, not the last one in the list", () => {
    const dom = boot();
    switchOn(dom);
    chooseCard(dom, "builtin:wardogs");
    const event = new (dom.window as Win).Event("submit", {
      cancelable: true,
      bubbles: true,
    });
    q(dom, "form[data-event-form]").dispatchEvent(event);
    const saved = JSON.parse(
      dom.window.sessionStorage.getItem("koolbot-event-form-draft") ?? "{}",
    );
    expect(saved.groups_preset).toBe("builtin:wardogs");
  });
});
