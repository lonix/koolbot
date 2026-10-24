/* global HTMLSelectElement, Element, HTMLElement, HTMLInputElement, HTMLButtonElement, KeyboardEventInit */
/**
 * The multi-select channel and role picker (#1473): the server markup for
 * `channel_list` / `role_list` and `CHANNEL_PICKER_SCRIPT` on a
 * `select[multiple]`, run in jsdom together with the save bar.
 */
import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import { JSDOM } from "jsdom";
import { CHANNEL_PICKER_SCRIPT } from "../../src/web/setting-pickers.js";
import { renderSaveBar, SAVEBAR_SCRIPT } from "../../src/web/savebar.js";
import {
  renderSettingsPage,
  type ChannelOption,
} from "../../src/web/admin-views.js";

const TEXT: ChannelOption[] = [
  { id: "1", name: "general", type: ChannelType.GuildText, parentName: "Chat" },
  { id: "2", name: "rules", type: ChannelType.GuildText, parentName: null },
  { id: "3", name: "help", type: ChannelType.GuildText, parentName: null },
];

function pageHtml(current: string, type = "channel_list"): string {
  const html = renderSettingsPage({
    csrfToken: "t",
    guildName: "G",
    flash: null,
    groups: [
      {
        category: "events",
        rows: [
          {
            key: "events.channels",
            label: "Channels",
            current,
            defaultValue: "",
            type,
            description: "Where.",
            category: "events",
          },
        ],
      },
    ],
    textChannels: TEXT,
    voiceChannels: [],
    categoryChannels: [],
    roles: [{ id: "9", name: "Mods", color: 0, position: 1 }],
  } as unknown as Parameters<typeof renderSettingsPage>[0]);
  const m = html.match(
    /<span class="kb-picker" data-picker [^>]*>[\s\S]*?<\/select><\/span>/,
  );
  if (!m) throw new Error("no picker in page");
  return m[0];
}

function mount(current = "1,77"): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><body><form><label for="f">Channels</label>${pageHtml(current).replace("<select ", '<select id="f" ')}${renderSaveBar("Save")}</form></body>`,
    { runScripts: "outside-only" },
  );
  dom.window.eval(CHANNEL_PICKER_SCRIPT);
  dom.window.eval(SAVEBAR_SCRIPT);
  return dom;
}

const q = <T extends Element>(d: JSDOM, s: string): T =>
  d.window.document.querySelector(s) as unknown as T;
const all = (d: JSDOM, s: string): HTMLElement[] =>
  Array.from(d.window.document.querySelectorAll(s)) as HTMLElement[];
const chosen = (d: JSDOM): string[] =>
  Array.from(q<HTMLSelectElement>(d, "select").selectedOptions).map(
    (o) => o.value,
  );
function key(d: JSDOM, el: Element, k: string, init: KeyboardEventInit = {}) {
  el.dispatchEvent(
    new d.window.KeyboardEvent("keydown", { key: k, bubbles: true, ...init }),
  );
}

describe("server markup (no JavaScript)", () => {
  it("wraps the multiple select in span.kb-picker with meta", () => {
    const h = pageHtml("1");
    expect(h).toContain('data-picker-meta="');
    expect(h).toContain("multiple");
    expect(h).toContain('name="value_events.channels"');
  });
});

describe("script on select[multiple]", () => {
  it("shows one chip per selected option, a missing id included", () => {
    const d = mount("1,77");
    expect(all(d, ".kb-picker__chips .kb-mention").length).toBe(2);
    expect(q<HTMLElement>(d, "select").classList).toContain(
      "kb-visually-hidden",
    );
  });

  it("shows an empty note when nothing is selected", () => {
    const d = mount("");
    expect(all(d, ".kb-picker__chips .kb-mention").length).toBe(0);
    expect(q<HTMLElement>(d, ".kb-picker__chips").textContent).toContain(
      "None selected",
    );
  });

  it("a click toggles a row, keeps the popover open and fires input and change", () => {
    const d = mount("1");
    const sel = q<HTMLSelectElement>(d, "select");
    const events: string[] = [];
    sel.addEventListener("input", () => events.push("input"));
    sel.addEventListener("change", () => events.push("change"));
    q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
    const rows = all(d, "[data-i]");
    rows[2].click();
    expect(chosen(d)).toEqual(["1", "3"]);
    expect(events).toEqual(["input", "change"]);
    expect(q<HTMLElement>(d, ".kb-picker__pop").hidden).toBe(false);
    expect(rows[2].getAttribute("aria-selected")).toBe("true");
    rows[0].click();
    expect(chosen(d)).toEqual(["3"]);
    expect(all(d, ".kb-picker__chips .kb-mention").length).toBe(1);
  });

  it("Enter toggles the active row and the list is multiselectable", () => {
    const d = mount("");
    q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
    expect(
      q<HTMLElement>(d, "[role=listbox]").getAttribute("aria-multiselectable"),
    ).toBe("true");
    const inp = q<HTMLInputElement>(d, ".kb-picker__search input");
    key(d, inp, "ArrowDown");
    key(d, inp, "Enter");
    expect(chosen(d).length).toBe(1);
    key(d, inp, "Escape");
    expect(q<HTMLElement>(d, ".kb-picker__pop").hidden).toBe(true);
  });

  it("the remove button of a chip unselects it and has a name", () => {
    const d = mount("1,2");
    const rm = all(d, ".kb-picker__chip-remove");
    expect(rm[0].getAttribute("aria-label")).toBe("Remove #general");
    rm[0].click();
    expect(chosen(d)).toEqual(["2"]);
    expect(all(d, ".kb-picker__chips .kb-mention").length).toBe(1);
  });

  it("Backspace in an empty search removes the last chip, and not while text is typed", () => {
    const d = mount("1,2");
    q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
    const inp = q<HTMLInputElement>(d, ".kb-picker__search input");
    inp.value = "x";
    key(d, inp, "Backspace");
    expect(chosen(d)).toEqual(["1", "2"]);
    inp.value = "";
    key(d, inp, "Backspace");
    expect(chosen(d)).toEqual(["1"]);
  });

  it("the save bar counts a change and Discard restores the chips", () => {
    const d = mount("1");
    q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
    all(d, "[data-i]")[1].click();
    expect(q<HTMLElement>(d, ".kb-savebar").textContent).toMatch(/1/);
    q<HTMLButtonElement>(d, "[data-savebar-discard]").click();
    expect(chosen(d)).toEqual(["1"]);
    expect(all(d, ".kb-picker__chips .kb-mention").length).toBe(1);
  });

  it("shows only the first chips and a +N more button that expands", () => {
    const opts = Array.from(
      { length: 20 },
      (_, i) => `<option value="${i}" selected>c${i}</option>`,
    ).join("");
    const dom = new JSDOM(
      `<!doctype html><body><form><span class="kb-picker" data-picker data-picker-meta="[]"><select multiple name="v">${opts}</select></span></form></body>`,
      { runScripts: "outside-only" },
    );
    dom.window.eval(CHANNEL_PICKER_SCRIPT);
    expect(all(dom, ".kb-picker__chips .kb-mention").length).toBe(12);
    const more = q<HTMLButtonElement>(dom, ".kb-picker__more");
    expect(more.textContent).toContain("+8 more");
    more.click();
    expect(all(dom, ".kb-picker__chips .kb-mention").length).toBe(20);
  });

  it("a disabled select disables the trigger and the remove buttons", () => {
    const dom = new JSDOM(
      `<!doctype html><body><form><span class="kb-picker" data-picker data-picker-meta="[]"><select multiple name="v" disabled><option value="1" selected>a</option></select></span></form></body>`,
      { runScripts: "outside-only" },
    );
    dom.window.eval(CHANNEL_PICKER_SCRIPT);
    expect(q<HTMLButtonElement>(dom, ".kb-picker__trigger").disabled).toBe(
      true,
    );
    expect(q<HTMLButtonElement>(dom, ".kb-picker__chip-remove").disabled).toBe(
      true,
    );
  });
});
