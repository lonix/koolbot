/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global document, HTMLInputElement, HTMLElement, HTMLFormElement, HTMLSelectElement, HTMLButtonElement, Event, DOMParser */
/**
 * The save bar of a settings form (#1330): rendered visible without
 * JavaScript, hidden until the first change, counts changed settings per row
 * against the loaded values, Discard restores them, and the per-row reset
 * buttons never count. Markup is checked through a DOM, never with regular
 * expressions over HTML.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  renderFeatureSettingsCard,
  renderSettingsPage,
  type SettingRow,
} from "../../src/web/admin-views.js";
import { renderSaveBar, SAVEBAR_SCRIPT } from "../../src/web/savebar.js";

function row(
  over: Partial<SettingRow> & Pick<SettingRow, "key" | "type">,
): SettingRow {
  return {
    label: over.key,
    current: "",
    defaultValue: "",
    description: "",
    category: over.key.split(".")[0],
    ...over,
  };
}

const ROWS: SettingRow[] = [
  row({ key: "x.enabled", type: "boolean", current: true, defaultValue: true }),
  row({
    key: "x.name",
    type: "string",
    current: "Lobby",
    defaultValue: "Lobby",
  }),
  row({ key: "x.size", type: "number", current: 4, defaultValue: 10 }),
  row({
    key: "x.period",
    type: "string",
    current: "week",
    defaultValue: "week",
    options: [
      { value: "week", label: "This week" },
      { value: "month", label: "This month" },
      { value: "alltime", label: "All time" },
    ],
  }),
];

function cardHtml(rows: SettingRow[] = ROWS): string {
  return renderFeatureSettingsCard({
    category: "x",
    settingRows: rows,
    returnTo: "/admin/x",
    csrfToken: "tok",
  });
}

function pageHtml(groups: Array<{ category: string; rows: SettingRow[] }>) {
  return renderSettingsPage({
    csrfToken: "tok",
    remainingMs: 60_000,
    textChannels: [],
    voiceChannels: [],
    categoryChannels: [],
    roles: [],
    guildId: "g",
    guildName: "G",
    groups,
  });
}

function mount(html: string): void {
  document.body.innerHTML = html;
}

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

const bar = (): HTMLElement => el("[data-savebar]");
const text = (): string => el("[data-savebar-text]").textContent ?? "";
const discard = (): HTMLButtonElement => el("[data-savebar-discard]");
const saveForm = (): HTMLFormElement =>
  el<HTMLFormElement>("form[action$='save-section']");
const name = (): HTMLInputElement => el('input[name="value_x.name"]');
const size = (): HTMLInputElement => el('input[name="value_x.size"]');
const enabled = (): HTMLInputElement => el('input[name="value_x.enabled"]');

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function toggle(input: HTMLInputElement): void {
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function run(script: string = SAVEBAR_SCRIPT): void {
  new Function(script)();
}

describe("the save bar markup (no JavaScript)", () => {
  it("is one region per form, visible, inside the form it saves", () => {
    mount(cardHtml());
    expect(
      document.querySelectorAll("form[action$='save-section']"),
    ).toHaveLength(1);
    expect(document.querySelectorAll("[data-savebar]")).toHaveLength(1);
    expect(saveForm().contains(bar())).toBe(true);
    expect(bar().getAttribute("role")).toBe("region");
    expect(bar().getAttribute("aria-label")).toBe("Unsaved changes: Settings");
    expect(bar().hasAttribute("hidden")).toBe(false);
    expect(text()).toBe("Save your changes");
  });

  it("sits in a card that opts out of scrolling, so sticky reaches the viewport", () => {
    mount(cardHtml());
    expect(bar().closest(".card")?.classList.contains("card--savebar")).toBe(
      true,
    );
    const doc = new DOMParser().parseFromString(
      pageHtml([{ category: "x", rows: ROWS }]),
      "text/html",
    );
    for (const b of doc.querySelectorAll("[data-savebar]")) {
      expect(b.closest(".card")?.classList.contains("card--savebar")).toBe(
        true,
      );
      // The scrolling rows container is the bar's sibling, never its ancestor.
      expect(b.closest(".kb-settings")).toBeNull();
      expect(
        b.parentElement?.querySelector(":scope > .kb-settings"),
      ).not.toBeNull();
    }
  });

  it("marks the Settings page's <main> as has-savebar", () => {
    const doc = new DOMParser().parseFromString(
      pageHtml([{ category: "x", rows: ROWS }]),
      "text/html",
    );
    expect(doc.querySelector("main")?.classList.contains("has-savebar")).toBe(
      true,
    );
  });

  it("keeps Save a plain submit button the AJAX save script still finds", () => {
    mount(cardHtml());
    const save = saveForm().querySelector(
      "button[type=submit]:not([formaction]):not([form])",
    );
    expect(save?.textContent).toBe("Save settings");
    expect(bar().contains(save)).toBe(true);
  });

  it("hides Discard until the script can make it work", () => {
    mount(cardHtml());
    expect(discard().hasAttribute("hidden")).toBe(true);
    expect(discard().type).toBe("button");
  });

  it("escapes the submit label", () => {
    const host = document.createElement("div");
    host.innerHTML = renderSaveBar('<img src=x onerror="1">');
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("button[type=submit]")?.textContent).toBe(
      '<img src=x onerror="1">',
    );
  });

  it("renders on the Settings page too, one per category form", () => {
    const doc = new DOMParser().parseFromString(
      pageHtml([
        { category: "x", rows: ROWS },
        { category: "y", rows: [row({ key: "y.a", type: "string" })] },
      ]),
      "text/html",
    );
    const labels = Array.from(doc.querySelectorAll("[data-savebar]")).map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    for (const form of doc.querySelectorAll("form[action$='save-section']")) {
      expect(form.querySelectorAll("[data-savebar]")).toHaveLength(1);
    }
  });
});

describe("the save bar script", () => {
  beforeEach(() => {
    mount(cardHtml());
    run();
  });

  it("hides the bar and shows Discard once enhanced", () => {
    expect(bar().hidden).toBe(true);
    expect(discard().hidden).toBe(false);
  });

  it("appears on the first change and counts it", () => {
    type(name(), "Squad");
    expect(bar().hidden).toBe(false);
    expect(text()).toBe("1 unsaved change");
  });

  it("counts changes in different rows and pluralises", () => {
    type(name(), "Squad");
    toggle(enabled());
    expect(text()).toBe("2 unsaved changes");
  });

  it("counts a changed number field and a changed segmented control", () => {
    type(size(), "7");
    expect(text()).toBe("1 unsaved change");
    const radios = document.querySelectorAll<HTMLInputElement>(
      'input[name="value_x.period"]',
    );
    expect(radios.length).toBeGreaterThan(1);
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change", { bubbles: true }));
    expect(text()).toBe("2 unsaved changes");
  });

  it("counts a row once however many of its controls changed", () => {
    const radios = document.querySelectorAll<HTMLInputElement>(
      'input[name="value_x.period"]',
    );
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change", { bubbles: true }));
    radios[2].checked = true;
    radios[2].dispatchEvent(new Event("change", { bubbles: true }));
    expect(text()).toBe("1 unsaved change");
  });

  it("drops a change that is changed back, and hides at zero", () => {
    type(name(), "Squad");
    type(name(), "Lobby");
    expect(bar().hidden).toBe(true);
    toggle(enabled());
    toggle(enabled());
    expect(bar().hidden).toBe(true);
  });

  it("Discard restores every loaded value and fires input and change", () => {
    const seen: string[] = [];
    saveForm().addEventListener("input", () => seen.push("input"));
    saveForm().addEventListener("change", () => seen.push("change"));
    type(name(), "Squad");
    toggle(enabled());
    seen.length = 0;
    discard().click();
    expect(name().value).toBe("Lobby");
    expect(enabled().checked).toBe(true);
    expect(bar().hidden).toBe(true);
    expect(seen).toContain("input");
    expect(seen).toContain("change");
  });

  it("Discard moves focus to a control it restored", () => {
    type(name(), "Squad");
    discard().click();
    expect(document.activeElement).toBe(name());
  });

  it("never counts a reset button, which belongs to a sibling form", () => {
    const resets = document.querySelectorAll<HTMLButtonElement>(
      "button[form$='-reset']",
    );
    expect(resets.length).toBeGreaterThan(0);
    for (const reset of resets) {
      expect(Array.from(saveForm().elements)).not.toContain(reset);
      reset.dispatchEvent(new Event("click", { bubbles: true }));
    }
    expect(bar().hidden).toBe(true);
  });

  it("a field of the reset form never counts either", () => {
    const resetForm = el<HTMLFormElement>("form[id$='-reset']");
    for (const field of resetForm.elements) {
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    expect(bar().hidden).toBe(true);
  });

  it("ignores a disabled control", () => {
    const input = name();
    input.value = "Squad";
    input.disabled = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bar().hidden).toBe(true);
  });

  it("makes saved values the new baseline on kb-saved", () => {
    type(name(), "Squad");
    saveForm().dispatchEvent(new Event("kb-saved"));
    expect(bar().hidden).toBe(true);
    type(name(), "Lobby");
    expect(text()).toBe("1 unsaved change");
    discard().click();
    expect(name().value).toBe("Squad");
  });
});

describe("selects and cron pickers", () => {
  const selectForm = (options: string): string =>
    `<form><div class="kb-setting"><select name="a">${options}</select></div>${renderSaveBar("Save")}</form>`;

  it("compares a select with its default option, not its first option", () => {
    mount(
      selectForm(
        '<option value="1">1</option><option value="2" selected>2</option>',
      ),
    );
    run();
    expect(bar().hidden).toBe(true);
    const select = el<HTMLSelectElement>("select");
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(text()).toBe("1 unsaved change");
    discard().click();
    expect(select.value).toBe("2");
  });

  it("does not count a select without a selected option as changed", () => {
    mount(
      selectForm('<option value="1">1</option><option value="2">2</option>'),
    );
    run();
    expect(bar().hidden).toBe(true);
  });

  it("counts a cron picker through its visible controls, once", () => {
    mount(
      `<form><div class="kb-setting"><div class="cron-picker"><input type="hidden" class="cron-hidden" name="c" value="0 9 * * 1"><input type="time" class="cron-time" value="09:00"><input type="number" class="cron-dom" value="1"></div></div>${renderSaveBar("Save")}</form>`,
    );
    run();
    expect(bar().hidden).toBe(true);
    // The picker script rewrites its hidden copy on load; that is no change.
    el<HTMLInputElement>(".cron-hidden").value = "0 9 * * 2";
    el<HTMLFormElement>("form").dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    expect(bar().hidden).toBe(true);
    type(el<HTMLInputElement>(".cron-time"), "10:30");
    type(el<HTMLInputElement>(".cron-dom"), "2");
    expect(text()).toBe("1 unsaved change");
  });

  it("does not count other hidden fields (csrf, keys)", () => {
    mount(
      `<form><input type="hidden" name="_csrf" value="a">${renderSaveBar("Save")}</form>`,
    );
    run();
    el<HTMLInputElement>("input[name=_csrf]").value = "b";
    el<HTMLFormElement>("form").dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    expect(bar().hidden).toBe(true);
  });
});

describe("mutation check of the counting logic", () => {
  /** What a scenario shows with a (possibly mutated) script. */
  function scenario(script: string) {
    mount(cardHtml());
    run(script);
    type(name(), "Squad");
    const afterOne = text();
    toggle(enabled());
    const afterTwo = text();
    const radios = document.querySelectorAll<HTMLInputElement>(
      'input[name="value_x.period"]',
    );
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change", { bubbles: true }));
    radios[2].checked = true;
    radios[2].dispatchEvent(new Event("change", { bubbles: true }));
    const afterRow = text();
    radios[0].checked = true;
    radios[0].dispatchEvent(new Event("change", { bubbles: true }));
    type(name(), "Lobby");
    toggle(enabled());
    const afterRevert = bar().hidden;
    type(size(), "9");
    discard().click();
    return {
      afterOne,
      afterTwo,
      afterRow,
      afterRevert,
      afterDiscard: size().value,
    };
  }

  it("the scenario passes on the real script", () => {
    expect(scenario(SAVEBAR_SCRIPT)).toEqual({
      afterOne: "1 unsaved change",
      afterTwo: "2 unsaved changes",
      afterRow: "3 unsaved changes",
      afterRevert: true,
      afterDiscard: "4",
    });
  });

  const mutations: Array<[string, string, string]> = [
    [
      "never counts a checkbox",
      "if(t==='checkbox'||t==='radio')return el.checked!==el.defaultChecked;",
      "if(t==='checkbox'||t==='radio')return false;",
    ],
    [
      "counts every checkbox as changed",
      "return el.checked!==el.defaultChecked;",
      "return true;",
    ],
    [
      "never counts a text field",
      "return el.value!==el.defaultValue}",
      "return false}",
    ],
    [
      "counts per control instead of per row",
      "function rowOf(el){return el.closest('.kb-setting')||el}",
      "function rowOf(el){return el}",
    ],
    [
      "never restores a text field on Discard",
      "else el.value=el.defaultValue}",
      "else{}}",
    ],
    ["never hides the bar at zero", "bar.hidden=n===0;", "bar.hidden=false;"],
  ];

  it.each(mutations)("is caught when the script %s", (_what, from, to) => {
    expect(SAVEBAR_SCRIPT).toContain(from);
    const mutated = SAVEBAR_SCRIPT.replace(from, to);
    expect(mutated).not.toBe(SAVEBAR_SCRIPT);
    expect(scenario(mutated)).not.toEqual(scenario(SAVEBAR_SCRIPT));
  });
});

describe("cooperating with the AJAX settings save", () => {
  function pageScripts(): { save: string; bar: string; cascade: string } {
    const doc = new DOMParser().parseFromString(
      pageHtml([{ category: "x", rows: ROWS }]),
      "text/html",
    );
    mount(doc.body.innerHTML);
    const scripts = Array.from(doc.querySelectorAll("script")).map(
      (s) => s.textContent ?? "",
    );
    const save = scripts.find((s) => s.includes("save-section"));
    const barScript = scripts.find((s) => s.includes("data-savebar"));
    const cascade = scripts.find((s) => s.includes("data-cascade-master"));
    if (!save || !barScript || !cascade) {
      throw new Error("scripts missing from the page");
    }
    return { save, bar: barScript, cascade };
  }

  const tick = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  /** A fetch whose response the test releases. */
  function delayedFetch(status: number, json: unknown): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      await gate;
      return { status, text: async () => JSON.stringify(json) };
    });
    return release;
  }

  /** Mounts the page and runs its save, cascade and (given) save bar script. */
  function start(barScript?: string): void {
    const scripts = pageScripts();
    new Function(scripts.save)();
    new Function(scripts.cascade)();
    run(barScript ?? scripts.bar);
  }

  const save = (): void =>
    el<HTMLButtonElement>("[data-savebar] button[type=submit]").click();

  async function saveWith(status: number, json: unknown): Promise<void> {
    const release = delayedFetch(status, json);
    start();
    type(name(), "Squad");
    expect(text()).toBe("1 unsaved change");
    save();
    release();
    await tick();
  }

  /** Submit "Squad", type "Team" before the response returns. */
  async function editDuringSave(barScript?: string): Promise<void> {
    const release = delayedFetch(200, { type: "ok", text: "Saved." });
    start(barScript);
    type(name(), "Squad");
    save();
    type(name(), "Team");
    release();
    await tick();
  }

  it("is on the page as a nonce-tagged script", () => {
    const doc = new DOMParser().parseFromString(
      pageHtml([{ category: "x", rows: ROWS }]),
      "text/html",
    );
    const tagged = Array.from(doc.querySelectorAll("script")).filter((s) =>
      (s.textContent ?? "").includes("data-savebar"),
    );
    expect(tagged).toHaveLength(1);
    expect(tagged[0].getAttribute("nonce")).toBeTruthy();
  });

  it("clears the count after an accepted AJAX save", async () => {
    await saveWith(200, { type: "ok", text: "Saved." });
    expect(bar().hidden).toBe(true);
  });

  it("keeps the count when the server rejects a value", async () => {
    await saveWith(400, {
      type: "err",
      text: "Rejected.",
      invalidKeys: ["x.name"],
    });
    expect(bar().hidden).toBe(false);
    expect(text()).toBe("1 unsaved change");
  });

  it("keeps an edit made while the save was in flight unsaved", async () => {
    await editDuringSave();
    expect(bar().hidden).toBe(false);
    expect(text()).toBe("1 unsaved change");
    // Discard goes back to what the server received, not to the typed value.
    discard().click();
    expect(name().value).toBe("Squad");
    expect(bar().hidden).toBe(true);
  });

  it("treats Discard during the save as a change from what was saved", async () => {
    const release = delayedFetch(200, { type: "ok", text: "Saved." });
    start();
    type(name(), "Squad");
    save();
    discard().click();
    expect(name().value).toBe("Lobby");
    release();
    await tick();
    // The server holds "Squad"; the form shows "Lobby".
    expect(name().value).toBe("Lobby");
    expect(bar().hidden).toBe(false);
    expect(text()).toBe("1 unsaved change");
  });

  it("is caught when the baseline is read from the live controls", async () => {
    const from = "commit(pending||snap(form))";
    expect(SAVEBAR_SCRIPT).toContain(from);
    await editDuringSave(SAVEBAR_SCRIPT.replace(from, "commit(snap(form))"));
    // The mutant calls the edit saved and hides the bar.
    expect(bar().hidden).toBe(true);
  });

  it("Discard restores a control the cascade disabled (real cascade script)", () => {
    start();
    type(name(), "Squad");
    toggle(enabled());
    expect(name().disabled).toBe(true);
    discard().click();
    expect(name().value).toBe("Lobby");
    expect(enabled().checked).toBe(true);
    expect(name().disabled).toBe(false);
    expect(bar().hidden).toBe(true);
  });

  it("keeps a disabled control out of the count", () => {
    start();
    type(name(), "Squad");
    toggle(enabled());
    expect(text()).toBe("1 unsaved change");
  });

  it("is caught when Discard skips a disabled control", () => {
    const from = "changedControls(form,true)";
    expect(SAVEBAR_SCRIPT).toContain(from);
    start(SAVEBAR_SCRIPT.replace(from, "changedControls(form)"));
    type(name(), "Squad");
    toggle(enabled());
    discard().click();
    expect(name().value).toBe("Squad");
    expect(text()).toBe("1 unsaved change");
  });
});

describe("a cron picker's inactive controls (real cron script)", () => {
  const CRON_ROWS: SettingRow[] = [
    row({
      key: "x.schedule",
      type: "cron",
      current: "0 9 * * *",
      defaultValue: "0 9 * * *",
    }),
    row({
      key: "x.name",
      type: "string",
      current: "Lobby",
      defaultValue: "Lobby",
    }),
  ];

  function start(barScript?: string): void {
    const doc = new DOMParser().parseFromString(
      pageHtml([{ category: "x", rows: CRON_ROWS }]),
      "text/html",
    );
    mount(doc.body.innerHTML);
    const scripts = Array.from(doc.querySelectorAll("script")).map(
      (s) => s.textContent ?? "",
    );
    const cron = scripts.find((s) => s.includes("cron-picker"));
    const bars = scripts.find((s) => s.includes("data-savebar"));
    if (!cron || !bars) throw new Error("scripts missing from the page");
    new Function(cron)();
    run(barScript ?? bars);
  }

  const mode = (): HTMLSelectElement => el<HTMLSelectElement>(".cron-mode");
  const dow = (): HTMLSelectElement => el<HTMLSelectElement>(".cron-dow");
  const dom = (): HTMLInputElement => el<HTMLInputElement>(".cron-dom");
  const custom = (): HTMLInputElement => el<HTMLInputElement>(".cron-custom");

  function choose(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("counts the active controls, not the ones the mode hides", () => {
    start();
    expect(bar().hidden).toBe(true);
    choose(mode(), "weekly");
    expect(text()).toBe("1 unsaved change");
    choose(dow(), "3");
    expect(text()).toBe("1 unsaved change");
  });

  it("is clean again after Daily, Weekly, another weekday, Daily", () => {
    start();
    choose(mode(), "weekly");
    choose(dow(), "3");
    choose(mode(), "daily");
    expect(el<HTMLInputElement>(".cron-hidden").value).toBe("0 9 * * *");
    expect(dow().closest("[hidden]")).not.toBeNull();
    expect(bar().hidden).toBe(true);
  });

  it("is clean again after the monthly day is edited and Daily returns", () => {
    start();
    choose(mode(), "monthly");
    type(dom(), "15");
    choose(mode(), "daily");
    expect(bar().hidden).toBe(true);
  });

  it("is clean again after the custom expression is edited and Daily returns", () => {
    start();
    choose(mode(), "custom");
    type(custom(), "5 4 * * 1");
    choose(mode(), "daily");
    expect(bar().hidden).toBe(true);
  });

  it("still restores a hidden control on Discard", () => {
    start();
    choose(mode(), "weekly");
    choose(dow(), "3");
    choose(mode(), "daily");
    type(name(), "Squad");
    discard().click();
    expect(dow().value).toBe("0");
    expect(name().value).toBe("Lobby");
  });

  it("puts focus on a visible restored control, not a hidden weekday select", () => {
    start();
    choose(mode(), "weekly");
    choose(dow(), "3");
    choose(mode(), "daily");
    type(name(), "Squad");
    discard().click();
    expect(bar().hidden).toBe(true);
    expect(document.activeElement).toBe(name());
  });

  it("is caught when hidden cron controls count", () => {
    const from =
      "function inactive(el){return el.disabled||!!el.closest('[hidden]')}";
    expect(SAVEBAR_SCRIPT).toContain(from);
    start(
      SAVEBAR_SCRIPT.replace(from, "function inactive(el){return el.disabled}"),
    );
    choose(mode(), "weekly");
    choose(dow(), "3");
    choose(mode(), "daily");
    expect(bar().hidden).toBe(false);
  });

  it("is caught when Discard focuses the first restored control, hidden or not", () => {
    const from = "var f=els.filter(focusable)[0]||";
    expect(SAVEBAR_SCRIPT).toContain(from);
    start(
      SAVEBAR_SCRIPT.replace(
        from,
        "var f=els.filter(function(el){return el.type!=='hidden'})[0]||",
      ),
    );
    choose(mode(), "weekly");
    choose(dow(), "3");
    choose(mode(), "daily");
    type(name(), "Squad");
    discard().click();
    expect(document.activeElement).not.toBe(name());
  });
});

describe("edits and focus while a save is in flight", () => {
  const LETTERS = ["a", "b", "c", "d", "e", "f"].map((v) => ({
    value: v,
    label: `Option ${v}`,
  }));
  const FLIGHT_ROWS: SettingRow[] = [
    row({
      key: "x.name",
      type: "string",
      current: "Lobby",
      defaultValue: "Lobby",
    }),
    row({
      key: "x.picker",
      type: "string",
      current: "a",
      defaultValue: "a",
      options: LETTERS,
    }),
    row({
      key: "x.period",
      type: "string",
      current: "week",
      defaultValue: "week",
      options: [
        { value: "week", label: "This week" },
        { value: "month", label: "This month" },
        { value: "alltime", label: "All time" },
      ],
    }),
  ];

  const tick = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  /** Mounts the page, runs its save and bar scripts, holds the response. */
  function start(barScript?: string): () => void {
    const doc = new DOMParser().parseFromString(
      pageHtml([{ category: "x", rows: FLIGHT_ROWS }]),
      "text/html",
    );
    mount(doc.body.innerHTML);
    const scripts = Array.from(doc.querySelectorAll("script")).map(
      (s) => s.textContent ?? "",
    );
    const saveScript = scripts.find((s) => s.includes("save-section"));
    const bars = scripts.find((s) => s.includes("data-savebar"));
    if (!saveScript || !bars) throw new Error("scripts missing from the page");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      await gate;
      return {
        status: 200,
        text: async () => JSON.stringify({ type: "ok", text: "Saved." }),
      };
    });
    new Function(saveScript)();
    run(barScript ?? bars);
    return release;
  }

  const save = (): void =>
    el<HTMLButtonElement>("[data-savebar] button[type=submit]").click();
  const picker = (): HTMLSelectElement =>
    el<HTMLSelectElement>('select[name="value_x.picker"]');
  const radios = (): HTMLInputElement[] =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[name="value_x.period"]',
      ),
    );

  it("keeps a select changed after the submit, and keeps it unsaved", async () => {
    const release = start();
    type(name(), "Squad");
    save();
    picker().value = "c";
    picker().dispatchEvent(new Event("change", { bubbles: true }));
    release();
    await tick();
    expect(picker().value).toBe("c");
    expect(bar().hidden).toBe(false);
    expect(text()).toBe("1 unsaved change");
  });

  it("keeps a segmented control changed after the submit, and keeps it unsaved", async () => {
    const release = start();
    type(name(), "Squad");
    save();
    radios()[1].checked = true;
    radios()[1].dispatchEvent(new Event("change", { bubbles: true }));
    release();
    await tick();
    expect(radios()[1].checked).toBe(true);
    expect(radios()[0].checked).toBe(false);
    expect(bar().hidden).toBe(false);
    expect(text()).toBe("1 unsaved change");
  });

  it("is caught when the live selection is not put back after the defaults", async () => {
    const from = "live.forEach(function(l){";
    expect(SAVEBAR_SCRIPT).toContain(from);
    const mutated = SAVEBAR_SCRIPT.replace(from, "[].forEach(function(l){");
    expect(mutated).not.toBe(SAVEBAR_SCRIPT);
    const release = start(mutated);
    type(name(), "Squad");
    save();
    picker().value = "c";
    picker().dispatchEvent(new Event("change", { bubbles: true }));
    radios()[1].checked = true;
    radios()[1].dispatchEvent(new Event("change", { bubbles: true }));
    release();
    await tick();
    const lost = picker().value !== "c" || !radios()[1].checked;
    expect(lost).toBe(true);
  });

  it("moves focus off the bar when an accepted save hides it", async () => {
    const release = start();
    type(name(), "Squad");
    discard().focus();
    expect(document.activeElement).toBe(discard());
    save();
    release();
    await tick();
    expect(bar().hidden).toBe(true);
    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBe(document.body);
    expect(bar().contains(active)).toBe(false);
    expect(active?.closest("[hidden]")).toBeNull();
  });

  it("leaves focus alone when the user moved elsewhere", async () => {
    const release = start();
    type(name(), "Squad");
    save();
    size2().focus();
    release();
    await tick();
    expect(bar().hidden).toBe(true);
    expect(document.activeElement).toBe(size2());
  });

  it("is caught when the save path never moves focus", async () => {
    const from = "if(had&&bar.hidden)moveFocus([],true)";
    expect(SAVEBAR_SCRIPT).toContain(from);
    const release = start(SAVEBAR_SCRIPT.replace(from, ""));
    type(name(), "Squad");
    discard().focus();
    save();
    release();
    await tick();
    const active = document.activeElement as HTMLElement | null;
    expect(active === document.body || bar().contains(active)).toBe(true);
  });

  /** A visible control the user could have moved to. */
  function size2(): HTMLElement {
    return picker();
  }
});
