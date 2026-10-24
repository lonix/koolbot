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

/** A 20-option multiple select with every option chosen: 12 chips and "+8 more". */
function mountLong(extra = ""): JSDOM {
  const opts = Array.from(
    { length: 20 },
    (_, i) => `<option value="${i}" selected>c${i}</option>`,
  ).join("");
  const dom = new JSDOM(
    `<!doctype html><body><form><label for="f">Channels</label><span class="kb-picker" data-picker data-picker-meta="[]"><select id="f" multiple name="v"${extra}>${opts}</select></span></form></body>`,
    { runScripts: "outside-only" },
  );
  dom.window.eval(CHANNEL_PICKER_SCRIPT);
  return dom;
}

/** jsdom has no layout: stand in for the trigger's rectangle, which moves when the chip rows change. */
function setTrigger(d: JSDOM, r: { left: number; bottom: number }): void {
  q<HTMLElement>(d, ".kb-picker__trigger").getBoundingClientRect = () =>
    ({
      left: r.left,
      right: r.left,
      top: r.bottom - 36,
      bottom: r.bottom,
      width: 0,
      height: 36,
      x: r.left,
      y: r.bottom - 36,
      toJSON() {},
    }) as never;
}
const placed = (d: JSDOM): string =>
  q<HTMLElement>(d, ".kb-picker__pop").style.getPropertyValue("--kb-picker-y");

describe("repainting while the popover is open (review of #1482)", () => {
  // Each path changes the chips, so the Add trigger moves; the open popover
  // must follow it (placement runs again), not keep the coordinates it got on open.
  const paths: Array<{
    name: string;
    mountIt: () => JSDOM;
    act: (d: JSDOM) => void;
  }> = [
    {
      name: "choosing a row",
      mountIt: () => mount("1"),
      act: (d) => all(d, "[data-i]")[2].click(),
    },
    {
      name: "unchoosing a row",
      mountIt: () => mount("1,2"),
      act: (d) => all(d, "[data-i]")[0].click(),
    },
    {
      name: "removing a chip",
      mountIt: () => mount("1,2"),
      act: (d) => all(d, ".kb-picker__chip-remove")[0].click(),
    },
    {
      name: "clicking the check icon of a chosen row",
      mountIt: () => mount("1,2"),
      act: (d) => {
        const mark = q<HTMLElement>(d, "[data-i] svg[data-check] path");
        mark.dispatchEvent(new d.window.MouseEvent("click", { bubbles: true }));
      },
    },
    {
      name: "Backspace in the empty search",
      mountIt: () => mount("1,2"),
      act: (d) =>
        key(d, q<HTMLInputElement>(d, ".kb-picker__search input"), "Backspace"),
    },
    {
      name: "+N more expanding the chip list",
      mountIt: () => mountLong(),
      act: (d) => q<HTMLButtonElement>(d, ".kb-picker__more").click(),
    },
    {
      name: "a change event on the select (Discard's restore, a cascade master)",
      mountIt: () => mount("1"),
      act: (d) => {
        q<HTMLSelectElement>(d, "select").options[1].selected = true;
        q<HTMLSelectElement>(d, "select").dispatchEvent(
          new d.window.Event("change", { bubbles: true }),
        );
      },
    },
  ];

  for (const p of paths) {
    it(`${p.name} places the open popover under the moved trigger`, () => {
      const d = p.mountIt();
      setTrigger(d, { left: 10, bottom: 136 });
      q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
      expect(placed(d)).toBe("140px");
      // The change makes the chips wrap onto another row: the trigger moves down.
      setTrigger(d, { left: 10, bottom: 236 });
      p.act(d);
      // The action is inside the picker, so it is not an outside click: still open.
      expect(q<HTMLElement>(d, ".kb-picker__pop").hidden).toBe(false);
      expect(placed(d)).toBe("240px");
    });

    it(`${p.name} does not place a closed popover`, () => {
      const d = p.mountIt();
      setTrigger(d, { left: 10, bottom: 136 });
      p.act(d);
      expect(placed(d)).toBe("");
    });
  }

  it("keeps the list scrolled to the row that was just toggled, not back to the old active row", () => {
    const d = mount("");
    const revealed: string[] = [];
    for (const r of all(d, "[data-i]"))
      r.scrollIntoView = () => {
        revealed.push(r.id);
      };
    q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
    const rows = all(d, "[data-i]");
    revealed.length = 0;
    rows[2].click();
    expect(revealed[revealed.length - 1]).toBe(rows[2].id);
    expect(
      q<HTMLInputElement>(d, ".kb-picker__search input").getAttribute(
        "aria-activedescendant",
      ),
    ).toBe(rows[2].id);
  });
});

describe("focus after the chips are repainted (review of #1482)", () => {
  it("+N more moves focus to the first newly revealed remove button", () => {
    const d = mountLong();
    const more = q<HTMLButtonElement>(d, ".kb-picker__more");
    more.focus();
    expect(d.window.document.activeElement).toBe(more);
    more.click();
    expect(all(d, ".kb-picker__chip-remove").length).toBe(20);
    const first = all(d, ".kb-picker__chip-remove")[12];
    expect(d.window.document.activeElement).toBe(first);
    expect(first.getAttribute("data-rm")).toBe("12");
    expect(first.getAttribute("aria-label")).toBe("Remove c12");
  });

  it("+N more with the popover open still lands on the first revealed remove button", () => {
    const d = mountLong();
    q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
    q<HTMLButtonElement>(d, ".kb-picker__more").click();
    expect(q<HTMLElement>(d, ".kb-picker__pop").hidden).toBe(false);
    expect(d.window.document.activeElement).toBe(
      all(d, ".kb-picker__chip-remove")[12],
    );
  });

  it("with a disabled select there is no remove button to reach, so focus goes to the chip group", () => {
    const d = mountLong(" disabled");
    const more = q<HTMLButtonElement>(d, ".kb-picker__more");
    more.focus();
    more.click();
    const group = q<HTMLElement>(d, ".kb-picker__chips");
    expect(all(d, ".kb-picker__chip-remove").every((b) => b.disabled)).toBe(
      true,
    );
    expect(group.getAttribute("tabindex")).toBe("-1");
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Selected Channels");
    expect(d.window.document.activeElement).toBe(group);
  });

  it("does not invent a name for the chip group when the select has no label", () => {
    const dom = new JSDOM(
      `<!doctype html><body><form><span class="kb-picker" data-picker data-picker-meta="[]"><select multiple name="v"><option value="1" selected>a</option></select></span></form></body>`,
      { runScripts: "outside-only" },
    );
    dom.window.eval(CHANNEL_PICKER_SCRIPT);
    expect(
      q<HTMLElement>(dom, ".kb-picker__chips").hasAttribute("aria-label"),
    ).toBe(false);
  });

  // Every other path that repaints, and where focus is afterwards.
  const stays: Array<{
    name: string;
    focusOn: (d: JSDOM) => HTMLElement;
    act: (d: JSDOM) => void;
    expectOn: (d: JSDOM) => HTMLElement;
  }> = [
    {
      name: "choosing a row with Enter keeps focus in the search box",
      focusOn: (d) => q<HTMLElement>(d, ".kb-picker__search input"),
      act: (d) => key(d, q(d, ".kb-picker__search input"), "Enter"),
      expectOn: (d) => q<HTMLElement>(d, ".kb-picker__search input"),
    },
    {
      name: "clicking a row keeps focus in the search box",
      focusOn: (d) => q<HTMLElement>(d, ".kb-picker__search input"),
      act: (d) => all(d, "[data-i]")[2].click(),
      expectOn: (d) => q<HTMLElement>(d, ".kb-picker__search input"),
    },
    {
      name: "Backspace keeps focus in the search box",
      focusOn: (d) => q<HTMLElement>(d, ".kb-picker__search input"),
      act: (d) => key(d, q(d, ".kb-picker__search input"), "Backspace"),
      expectOn: (d) => q<HTMLElement>(d, ".kb-picker__search input"),
    },
    {
      name: "removing a chip puts focus on the Add trigger",
      focusOn: (d) => all(d, ".kb-picker__chip-remove")[0],
      act: (d) => all(d, ".kb-picker__chip-remove")[0].click(),
      expectOn: (d) => q<HTMLElement>(d, ".kb-picker__trigger"),
    },
    {
      name: "Discard's restore hands focus to the picker trigger, as the save bar does for a restored select",
      focusOn: (d) => q<HTMLElement>(d, "[data-savebar-discard]"),
      act: (d) => q<HTMLButtonElement>(d, "[data-savebar-discard]").click(),
      expectOn: (d) => q<HTMLElement>(d, ".kb-picker__trigger"),
    },
  ];
  for (const c of stays) {
    it(c.name, () => {
      const d = mount("1,2");
      if (!c.name.startsWith("Discard")) {
        q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
      } else {
        all(d, ".kb-picker__chip-remove")[0].click();
      }
      c.focusOn(d).focus();
      c.act(d);
      expect(d.window.document.activeElement).toBe(c.expectOn(d));
    });
  }
});

describe("keyboard after a repaint while open (review of #1482, third round)", () => {
  const press = (d: JSDOM, el: Element, k: string, init = {}): boolean =>
    el.dispatchEvent(
      new d.window.KeyboardEvent("keydown", {
        key: k,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );

  it("after removing a chip, ArrowDown on Add goes back to the search box and Escape then closes", () => {
    const d = mount("1,2");
    q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
    all(d, ".kb-picker__chip-remove")[0].click();
    const trig = q<HTMLButtonElement>(d, ".kb-picker__trigger");
    expect(d.window.document.activeElement).toBe(trig);
    expect(q<HTMLElement>(d, ".kb-picker__pop").hidden).toBe(false);
    press(d, trig, "ArrowDown");
    const inp = q<HTMLInputElement>(d, ".kb-picker__search input");
    expect(d.window.document.activeElement).toBe(inp);
    // The search box still names a row that exists.
    const ad = inp.getAttribute("aria-activedescendant");
    expect(ad && d.window.document.getElementById(ad)).toBeTruthy();
    press(d, inp, "Escape");
    expect(q<HTMLElement>(d, ".kb-picker__pop").hidden).toBe(true);
    expect(d.window.document.activeElement).toBe(trig);
  });

  it("after +N more, Escape on the revealed remove button closes the popover", () => {
    const d = mountLong();
    q<HTMLButtonElement>(d, ".kb-picker__trigger").click();
    q<HTMLButtonElement>(d, ".kb-picker__more").click();
    const rm = all(d, ".kb-picker__chip-remove")[12];
    expect(d.window.document.activeElement).toBe(rm);
    expect(press(d, rm, "Escape")).toBe(false);
    expect(q<HTMLElement>(d, ".kb-picker__pop").hidden).toBe(true);
    expect(d.window.document.activeElement).toBe(
      q<HTMLElement>(d, ".kb-picker__trigger"),
    );
  });

  it("keeps the IME guard: Escape while composing leaves the popover open, on the trigger too", () => {
    const d = mount("1");
    const trig = q<HTMLButtonElement>(d, ".kb-picker__trigger");
    trig.click();
    const inp = q<HTMLInputElement>(d, ".kb-picker__search input");
    expect(press(d, inp, "Escape", { isComposing: true })).toBe(true);
    expect(press(d, trig, "Escape", { isComposing: true })).toBe(true);
    expect(press(d, trig, "Escape", { keyCode: 229 })).toBe(true);
    expect(q<HTMLElement>(d, ".kb-picker__pop").hidden).toBe(false);
  });
});
