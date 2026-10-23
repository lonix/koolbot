/* global HTMLSelectElement, HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLFormElement */
/**
 * The colour input, the save bar and the section cascade, all their scripts
 * loaded together in jsdom (#1426). The colour field keeps no state of its own:
 * Use default and Keep are real checkboxes and the swatch is a real input, so
 * the save bar's baseline, commit and Discard apply to them as to any control.
 * A seeded random walk at the end checks that over every order of events.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  COLOUR_INPUT_SCRIPT,
  renderColourInput,
  renderEmojiField,
  renderTimezoneSelect,
  TIMEZONE_SELECT_SCRIPT,
} from "../../src/web/setting-pickers.js";
import { DEFAULT_COLOUR_SWATCH } from "../../src/utils/setting-formats.js";
import { CASCADE_DISABLE_SCRIPT } from "../../src/web/admin-layout.js";
import { groupRowsScript } from "../../src/web/event-group-form.js";
import { renderSaveBar, SAVEBAR_SCRIPT } from "../../src/web/savebar.js";
import { readSettingField } from "../../src/web/admin-views.js";
import { coerceConfigValue } from "../../src/web/routes/write/helpers.js";

const KEY = "reactionroles.group_role_colour";
const NAME = `value_${KEY}`;
const DEFAULT = `use_default_${KEY}`;
const PLACEHOLDER = DEFAULT_COLOUR_SWATCH;

/** A form as the Settings page builds it: a cascade scope with its master, the colour row, a sibling, the bar. */
function mount(current: string, masterOn = true): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><body><form><div data-cascade-scope>` +
      `<input type="checkbox" name="master" data-cascade-master${masterOn ? " checked" : ""}>` +
      `<div class="kb-setting">${renderColourInput(NAME, DEFAULT, current)}</div>` +
      `</div><input type="text" name="sibling" value="a">${renderSaveBar("Save")}</form></body>`,
    { runScripts: "outside-only" },
  );
  // The order the admin layout loads them in.
  dom.window.eval(CASCADE_DISABLE_SCRIPT);
  dom.window.eval(COLOUR_INPUT_SCRIPT);
  dom.window.eval(SAVEBAR_SCRIPT);
  return dom;
}

function q<T extends HTMLElement>(dom: JSDOM, sel: string): T {
  return dom.window.document.querySelector(sel) as T;
}

function posted(dom: JSDOM): Record<string, string> {
  const form = q<HTMLFormElement>(dom, "form");
  return Object.fromEntries(
    [...new dom.window.FormData(form).entries()].map(([k, v]) => [
      k,
      String(v),
    ]),
  );
}

/** What the server would take from the form, given the stored value. */
function effective(dom: JSDOM, stored: string): unknown {
  return readSettingField(posted(dom), KEY, stored);
}

function swatch(dom: JSDOM): HTMLInputElement {
  return q<HTMLInputElement>(dom, "[data-colour-input]");
}
function box(dom: JSDOM, which: "default" | "keep"): HTMLInputElement | null {
  return dom.window.document.querySelector(
    `[data-colour-${which}]`,
  ) as HTMLInputElement | null;
}

function pick(dom: JSDOM, value: string): void {
  const s = swatch(dom);
  if (s.disabled || s.value === value) return; // a browser fires nothing then
  s.value = value;
  s.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function tick(dom: JSDOM, which: "default" | "keep", on: boolean): void {
  const b = box(dom, which);
  if (!b || b.disabled || b.checked === on) return;
  b.checked = on;
  b.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function flip(dom: JSDOM, on: boolean): void {
  const m = q<HTMLInputElement>(dom, "[data-cascade-master]");
  if (m.checked === on) return;
  m.checked = on;
  m.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function discard(dom: JSDOM): void {
  q(dom, "[data-savebar-discard]").click();
}

function submit(dom: JSDOM): void {
  q<HTMLFormElement>(dom, "form").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
}
function saved(dom: JSDOM): void {
  q<HTMLFormElement>(dom, "form").dispatchEvent(
    new dom.window.Event("kb-saved"),
  );
}

const bar = (dom: JSDOM): HTMLElement => q(dom, "[data-savebar]");
const barText = (dom: JSDOM): string =>
  q(dom, "[data-savebar-text]").textContent ?? "";

describe("a stored value that is not a colour", () => {
  it("is kept: Keep is ticked, and the server reads the stored text, not the swatch", () => {
    const dom = mount("red");
    expect(box(dom, "keep")?.checked).toBe(true);
    expect(posted(dom)[NAME]).toBe(PLACEHOLDER);
    expect(effective(dom, "red")).toBe("red");
    expect(bar(dom).hidden).toBe(true);
  });

  it("a pick replaces it, and Discard brings back Keep and the text together", () => {
    const dom = mount("red");
    pick(dom, "#123456");
    expect(box(dom, "keep")?.checked).toBe(false);
    expect(effective(dom, "red")).toBe("#123456");
    expect(barText(dom)).toBe("1 unsaved change");
    discard(dom);
    expect(box(dom, "keep")?.checked).toBe(true);
    expect(effective(dom, "red")).toBe("red");
    expect(bar(dom).hidden).toBe(true);
  });

  it("a sibling edit after Discard still posts Keep, so the stored text survives the save", () => {
    const dom = mount("red");
    pick(dom, "#123456");
    discard(dom);
    const sibling = q<HTMLInputElement>(dom, "[name=sibling]");
    sibling.value = "b";
    sibling.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(effective(dom, "red")).toBe("red");
  });

  it("in flight: pick, submit, return to the first colour before the response", () => {
    const dom = mount("red");
    pick(dom, "#123456");
    submit(dom);
    pick(dom, PLACEHOLDER);
    // The server stored the submitted colour.
    saved(dom);
    expect(effective(dom, "#123456")).toBe(PLACEHOLDER);
    expect(coerceConfigValue(KEY, PLACEHOLDER, "#123456").ok).toBe(true);
    // What is shown differs from what was saved, so it is one unsaved change.
    expect(bar(dom).hidden).toBe(false);
    expect(barText(dom)).toBe("1 unsaved change");
    discard(dom);
    expect(swatch(dom).value).toBe("#123456");
    expect(effective(dom, "#123456")).toBe("#123456");
    expect(bar(dom).hidden).toBe(true);
  });

  it("an edit made while the request was out stays one unsaved change", () => {
    const dom = mount("red");
    pick(dom, "#123456");
    submit(dom);
    pick(dom, "#654321");
    saved(dom);
    expect(barText(dom)).toBe("1 unsaved change");
    discard(dom);
    expect(effective(dom, "#123456")).toBe("#123456");
  });

  it("saving Use default, then unticking it, posts a colour that validates", () => {
    const dom = mount("red");
    tick(dom, "default", true);
    expect(box(dom, "keep")?.checked).toBe(false);
    expect(effective(dom, "red")).toBe("");
    submit(dom);
    saved(dom);
    tick(dom, "default", false);
    const value = effective(dom, "");
    expect(value).not.toBe("red");
    expect(coerceConfigValue(KEY, value, "").ok).toBe(true);
  });
});

describe("Use default on a stored default", () => {
  it("pick then Discard ticks the box again", () => {
    const dom = mount("");
    expect(box(dom, "default")?.checked).toBe(true);
    expect(box(dom, "keep")).toBeNull();
    pick(dom, "#123456");
    expect(box(dom, "default")?.checked).toBe(false);
    expect(swatch(dom).disabled).toBe(false);
    expect(effective(dom, "")).toBe("#123456");
    discard(dom);
    expect(box(dom, "default")?.checked).toBe(true);
    expect(posted(dom)[DEFAULT]).toBe("true");
    expect(effective(dom, "")).toBe("");
  });
});

describe("the save bar sees the final state of a colour change", () => {
  it("pick, tick Use default, untick it: one unsaved change stays shown", () => {
    const dom = mount("#a95f55");
    pick(dom, "#123456");
    expect(barText(dom)).toBe("1 unsaved change");
    tick(dom, "default", true);
    tick(dom, "default", false);
    expect(bar(dom).hidden).toBe(false);
    expect(barText(dom)).toBe("1 unsaved change");
    expect(effective(dom, "#a95f55")).toBe("#123456");
  });

  it("ticking Use default counts one change and unticking clears it", () => {
    const dom = mount("#a95f55");
    tick(dom, "default", true);
    expect(barText(dom)).toBe("1 unsaved change");
    tick(dom, "default", false);
    expect(bar(dom).hidden).toBe(true);
  });
});

describe("the section cascade", () => {
  it("keeps the swatch off while the feature is off, whatever the boxes say", () => {
    const dom = mount("#a95f55", false);
    expect(box(dom, "default")?.disabled).toBe(true);
    expect(swatch(dom).disabled).toBe(true);
    const b = box(dom, "default") as HTMLInputElement;
    b.checked = true;
    b.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    b.checked = false;
    b.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(swatch(dom).disabled).toBe(true);
    expect(bar(dom).hidden).toBe(true);
  });

  it("follows the master: on enables the swatch and the boxes, off disables them", () => {
    const dom = mount("#a95f55", false);
    flip(dom, true);
    expect(swatch(dom).disabled).toBe(false);
    expect(box(dom, "default")?.disabled).toBe(false);
    tick(dom, "default", true);
    expect(swatch(dom).disabled).toBe(false);
    flip(dom, false);
    expect(swatch(dom).disabled).toBe(true);
    flip(dom, true);
    expect(swatch(dom).disabled).toBe(false);
  });

  it("a save made with the section off commits nothing for the colour", () => {
    const dom = mount("red");
    pick(dom, "#123456");
    const sibling = q<HTMLInputElement>(dom, "[name=sibling]");
    sibling.value = "b";
    sibling.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    flip(dom, false);
    submit(dom);
    saved(dom);
    flip(dom, true);
    discard(dom);
    // The save committed the master as off, so Discard restores that too.
    flip(dom, true);
    expect(box(dom, "keep")?.checked).toBe(true);
    expect(effective(dom, "red")).toBe("red");
  });
});

describe("the emoji field in a section that is off", () => {
  function twoScopes(): JSDOM {
    const scope = (n: number, field: string): string =>
      `<div data-cascade-scope id="s${n}">` +
      `<input type="checkbox" name="m${n}" data-cascade-master id="m${n}" checked>` +
      `<div class="kb-setting">${field}</div></div>`;
    const dom = new JSDOM(
      `<!doctype html><body><form>` +
        scope(
          1,
          renderEmojiField("value_a", "🎮", { label: "Voice prefix", id: "a" }),
        ) +
        scope(
          2,
          renderEmojiField("value_b", "📅", { label: "Event prefix", id: "b" }),
        ) +
        `${renderSaveBar("Save")}</form></body>`,
      { runScripts: "outside-only" },
    );
    dom.window.eval(CASCADE_DISABLE_SCRIPT);
    dom.window.eval(groupRowsScript());
    dom.window.eval(SAVEBAR_SCRIPT);
    return dom;
  }

  it("the button does nothing while its box is off", () => {
    const dom = twoScopes();
    const m = q<HTMLInputElement>(dom, "#m1");
    m.checked = false;
    m.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    q<HTMLButtonElement>(dom, "#s1 [data-marker-btn]").click();
    expect(dom.window.document.querySelector(".kb-emoji-pop")).toBeNull();
    m.checked = true;
    m.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    q<HTMLButtonElement>(dom, "#s1 [data-marker-btn]").click();
    expect(
      (dom.window.document.querySelector(".kb-emoji-pop") as HTMLElement)
        .hidden,
    ).toBe(false);
  });

  it("the shared grid is usable in a section that is on after another went off", () => {
    const dom = twoScopes();
    const d = dom.window.document;
    q<HTMLButtonElement>(dom, "#s1 [data-marker-btn]").click();
    const search = d.querySelector("[data-emoji-search]") as HTMLInputElement;
    expect(search.disabled).toBe(false);
    const m1 = q<HTMLInputElement>(dom, "#m1");
    m1.checked = false;
    m1.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(search.disabled).toBe(true);
    q<HTMLButtonElement>(dom, "#s2 [data-marker-btn]").click();
    expect(search.closest("#s2")).not.toBeNull();
    expect(search.disabled).toBe(false);
    expect((d.querySelector(".kb-emoji-pop") as HTMLElement).hidden).toBe(
      false,
    );
  });
});

/** Small seeded generator, so a failing walk can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("every order of events (random walk)", () => {
  const COLOURS = ["#123456", "#654321", PLACEHOLDER, "#a95f55"];
  const ACTIONS = [
    "pick",
    "pick",
    "tickDefault",
    "untickDefault",
    "tickKeep",
    "untickKeep",
    "submit",
    "saved",
    "failed",
    "discard",
    "cascadeOff",
    "cascadeOn",
  ] as const;

  function walk(seed: number, stored0: string): void {
    const rand = mulberry32(seed);
    const dom = mount(stored0);
    let server = stored0;
    let pending: { sent: unknown } | null = null;
    const log: string[] = [];
    const fail = (why: string): never => {
      throw new Error(
        `seed ${seed}, stored ${JSON.stringify(stored0)}: ${why}\n  ${log.join("\n  ")}`,
      );
    };
    const cascadeOn = (): boolean =>
      q<HTMLInputElement>(dom, "[data-cascade-master]").checked;

    for (let step = 0; step < 40; step++) {
      const action = ACTIONS[Math.floor(rand() * ACTIONS.length)];
      log.push(action);
      switch (action) {
        case "pick": {
          const colour = COLOURS[Math.floor(rand() * COLOURS.length)];
          const before = swatch(dom).value;
          pick(dom, colour);
          // What the user just picked is what a save sends.
          if (
            cascadeOn() &&
            colour !== before &&
            effective(dom, server) !== colour
          ) {
            fail(
              `picked ${colour}, the form posts ${JSON.stringify(effective(dom, server))}`,
            );
          }
          break;
        }
        case "tickDefault": {
          const was = box(dom, "default")?.checked;
          tick(dom, "default", true);
          if (cascadeOn() && !was && effective(dom, server) !== "") {
            fail("Use default ticked, the form does not post the default");
          }
          break;
        }
        case "untickDefault":
          tick(dom, "default", false);
          break;
        case "tickKeep": {
          const was = box(dom, "keep")?.checked;
          tick(dom, "keep", true);
          if (
            cascadeOn() &&
            was === false &&
            effective(dom, server) !== server
          ) {
            fail("Keep ticked, the form does not post the stored value");
          }
          break;
        }
        case "untickKeep":
          tick(dom, "keep", false);
          break;
        case "cascadeOff":
          flip(dom, false);
          break;
        case "cascadeOn":
          flip(dom, true);
          break;
        case "submit":
          if (pending) break;
          pending = { sent: cascadeOn() ? effective(dom, server) : null };
          submit(dom);
          break;
        case "failed":
          pending = null;
          break;
        case "saved":
          if (!pending) break;
          if (pending.sent !== null) {
            const r = coerceConfigValue(KEY, pending.sent, server);
            if (!r.ok)
              fail(`the server would refuse what was sent: ${r.reason}`);
            else server = String(r.value);
          }
          pending = null;
          saved(dom);
          break;
        case "discard":
          if (pending || bar(dom).hidden) break;
          discard(dom);
          if (cascadeOn()) {
            if (String(effective(dom, server)) !== server) {
              fail(
                `Discard left ${JSON.stringify(effective(dom, server))}, saved is ${JSON.stringify(server)}`,
              );
            }
            if (!bar(dom).hidden) fail("the bar stayed after Discard");
          }
          break;
      }
      if (!cascadeOn()) continue;
      // The two boxes are exclusive.
      if (box(dom, "default")?.checked && box(dom, "keep")?.checked) {
        fail("Use default and Keep are both ticked");
      }
      // Whatever is shown, a save of it must be accepted, never rejecting the section.
      const sent = effective(dom, server);
      const r = coerceConfigValue(KEY, sent, server);
      if (!r.ok)
        fail(`the displayed state posts ${JSON.stringify(sent)}: ${r.reason}`);
      // A clean bar means nothing differs from what was saved.
      if (!pending && bar(dom).hidden && String(sent) !== server) {
        fail(
          `the bar is hidden but the form posts ${JSON.stringify(sent)}, saved is ${JSON.stringify(server)}`,
        );
      }
    }
  }

  for (const stored of ["red", "#a95f55", ""]) {
    it(`never posts a refused value or hides an unsaved change (stored ${JSON.stringify(stored)})`, () => {
      for (let seed = 1; seed <= 60; seed++) walk(seed, stored);
    });
  }
});

describe("the timezone search and the save bar", () => {
  function tzMount(stored: string): JSDOM {
    const dom = new JSDOM(
      `<!doctype html><body><form>${renderTimezoneSelect("tz", stored, { defaultZone: "Europe/Oslo", blank: true })}` +
        `<input name="sibling" value="a">${renderSaveBar("Save")}</form></body>`,
      { runScripts: "outside-only" },
    );
    dom.window.eval(TIMEZONE_SELECT_SCRIPT);
    dom.window.eval(SAVEBAR_SCRIPT);
    return dom;
  }
  const sel = (dom: JSDOM): HTMLSelectElement =>
    q<HTMLSelectElement>(dom, "select");
  const pickZone = (dom: JSDOM, v: string): void => {
    sel(dom).value = v;
    sel(dom).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const search = (dom: JSDOM, text: string): void => {
    const s = q<HTMLInputElement>(dom, "[data-tz-search]");
    s.value = text;
    s.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  /**
   * What a browser posts for the select: the selected option, unless it is
   * disabled. jsdom's FormData does not apply that rule, so it is applied here.
   */
  const postedZone = (dom: JSDOM): string | null => {
    const o = sel(dom).selectedOptions[0];
    return o && !o.disabled ? o.value : null;
  };

  it("never disables an option, so a selected zone is always posted", () => {
    const dom = tzMount("Asia/Tokyo");
    search(dom, "new york");
    expect([...sel(dom).options].filter((o) => o.disabled)).toEqual([]);
    // Options are only hidden, and the selected one stays visible.
    expect(sel(dom).selectedOptions[0].hidden).toBe(false);
    expect(postedZone(dom)).toBe("Asia/Tokyo");
  });

  it("a stored zone that the search filters out is still shown and posted", () => {
    const dom = tzMount("Europe/Berlin");
    search(dom, "tokyo");
    expect(sel(dom).value).toBe("Europe/Berlin");
    expect(sel(dom).selectedOptions[0].hidden).toBe(false);
    expect(postedZone(dom)).toBe("Europe/Berlin");
  });

  it("pick, then change the search: the posted value is the one shown", () => {
    const dom = tzMount("Asia/Tokyo");
    search(dom, "oslo");
    pickZone(dom, "Europe/Oslo");
    search(dom, "new york");
    expect(sel(dom).value).toBe("Europe/Oslo");
    expect(postedZone(dom)).toBe("Europe/Oslo");
    search(dom, "");
    expect([...sel(dom).options].filter((o) => o.hidden || o.disabled)).toEqual(
      [],
    );
    expect(postedZone(dom)).toBe("Europe/Oslo");
  });

  it("save in flight, pick another zone, search, saved, Discard: the restored zone is posted", () => {
    const dom = tzMount("Asia/Tokyo");
    pickZone(dom, "Europe/Berlin");
    submit(dom);
    pickZone(dom, "Asia/Tokyo");
    search(dom, "new york");
    saved(dom);
    expect(bar(dom).hidden).toBe(false);
    discard(dom);
    expect(sel(dom).value).toBe("Europe/Berlin");
    expect([...sel(dom).options].filter((o) => o.disabled)).toEqual([]);
    expect(postedZone(dom)).toBe("Europe/Berlin");
    // The restored zone is visible in the list, not only posted.
    expect(sel(dom).selectedOptions[0].hidden).toBe(false);
    expect(bar(dom).hidden).toBe(true);
  });
});
