/* global HTMLElement, HTMLButtonElement, HTMLInputElement, HTMLFormElement */
/**
 * The colour input and the save bar, both scripts loaded together in jsdom
 * (#1426): Discard must put the swatch, the Use default box and the stored
 * non-colour back as one, and the bar must see the final state of a change.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  COLOUR_INPUT_SCRIPT,
  renderColourInput,
  renderEmojiField,
} from "../../src/web/setting-pickers.js";
import { CASCADE_DISABLE_SCRIPT } from "../../src/web/admin-layout.js";
import { groupRowsScript } from "../../src/web/event-group-form.js";
import { renderSaveBar, SAVEBAR_SCRIPT } from "../../src/web/savebar.js";

const NAME = "value_reactionroles.group_role_colour";
const DEFAULT = "use_default_reactionroles.group_role_colour";

function mount(current: string): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><body><form><div class="kb-setting">${renderColourInput(NAME, DEFAULT, current)}</div>` +
      `<input type="text" name="sibling" value="a">${renderSaveBar("Save")}</form></body>`,
    { runScripts: "outside-only" },
  );
  // The order the admin layout loads them in.
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

function pick(dom: JSDOM, value: string): void {
  const swatch = q<HTMLInputElement>(dom, "[data-colour-input]");
  swatch.value = value;
  swatch.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  swatch.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function tick(dom: JSDOM, on: boolean): void {
  const box = q<HTMLInputElement>(dom, "[data-colour-default]");
  box.checked = on;
  box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function discard(dom: JSDOM): void {
  q(dom, "[data-savebar-discard]").click();
}

const bar = (dom: JSDOM): HTMLElement => q(dom, "[data-savebar]");
const barText = (dom: JSDOM): string =>
  q(dom, "[data-savebar-text]").textContent ?? "";

describe("Discard with a stored value that is not a colour", () => {
  it("restores the stored text, so a later save of a sibling does not replace it", () => {
    const dom = mount("red");
    const mirror = q<HTMLInputElement>(dom, "[data-colour-mirror]");
    const swatch = q<HTMLInputElement>(dom, "[data-colour-input]");
    pick(dom, "#123456");
    expect(mirror.value).toBe("#123456");
    expect(bar(dom).hidden).toBe(false);
    discard(dom);
    expect(mirror.value).toBe("red");
    expect(posted(dom)[NAME]).toBe("red");
    expect(swatch.hasAttribute("name")).toBe(false);
    expect(swatch.disabled).toBe(false);
    expect(bar(dom).hidden).toBe(true);
    // A sibling edit afterwards still posts the stored text.
    const sibling = q<HTMLInputElement>(dom, "[name=sibling]");
    sibling.value = "b";
    sibling.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(posted(dom)[NAME]).toBe("red");
    expect(posted(dom)[DEFAULT]).toBeUndefined();
  });

  it("returning the swatch to its first colour brings the stored text back", () => {
    const dom = mount("red");
    const mirror = q<HTMLInputElement>(dom, "[data-colour-mirror]");
    const first = q<HTMLInputElement>(dom, "[data-colour-input]").defaultValue;
    pick(dom, "#123456");
    pick(dom, first);
    expect(mirror.value).toBe("red");
    expect(bar(dom).hidden).toBe(true);
  });

  it("a saved pick becomes the value Discard returns to", () => {
    const dom = mount("red");
    const mirror = q<HTMLInputElement>(dom, "[data-colour-mirror]");
    pick(dom, "#123456");
    submitAndSave(dom);
    expect(mirror.getAttribute("data-stored")).toBe("#123456");
    pick(dom, "#654321");
    discard(dom);
    expect(mirror.value).toBe("#123456");
  });
});

describe("Discard with Use default on", () => {
  it("ticks the box again and greys the swatch, posting the default", () => {
    const dom = mount("");
    const box = q<HTMLInputElement>(dom, "[data-colour-default]");
    const swatch = q<HTMLInputElement>(dom, "[data-colour-input]");
    expect(box.checked).toBe(true);
    pick(dom, "#123456");
    expect(box.checked).toBe(false);
    expect(swatch.disabled).toBe(false);
    expect(bar(dom).hidden).toBe(false);
    discard(dom);
    expect(box.checked).toBe(true);
    expect(swatch.disabled).toBe(true);
    expect(posted(dom)[DEFAULT]).toBe("true");
    expect(bar(dom).hidden).toBe(true);
  });
});

describe("the save bar sees the final state of a colour change", () => {
  it("pick, tick Use default, untick it: one unsaved change stays shown", () => {
    const dom = mount("#a95f55");
    pick(dom, "#123456");
    expect(barText(dom)).toBe("1 unsaved change");
    tick(dom, true);
    tick(dom, false);
    expect(bar(dom).hidden).toBe(false);
    expect(barText(dom)).toBe("1 unsaved change");
    expect(posted(dom)[NAME]).toBe("#123456");
  });

  it("ticking Use default on a stored colour counts one change and unticking clears it", () => {
    const dom = mount("#a95f55");
    tick(dom, true);
    expect(barText(dom)).toBe("1 unsaved change");
    tick(dom, false);
    expect(bar(dom).hidden).toBe(true);
  });
});

function submitAndSave(dom: JSDOM, during?: () => void): void {
  const form = q<HTMLFormElement>(dom, "form");
  form.dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
  during?.();
  form.dispatchEvent(new dom.window.Event("kb-saved"));
}

describe("a save of a colour that held a stored non-colour", () => {
  it("keeps an edit made while the request was out as one unsaved change", () => {
    const dom = mount("red");
    const mirror = q<HTMLInputElement>(dom, "[data-colour-mirror]");
    pick(dom, "#123456");
    submitAndSave(dom, () => pick(dom, "#654321"));
    // The bar committed what was sent; the later pick is still unsaved.
    expect(mirror.getAttribute("data-stored")).toBe("#123456");
    expect(mirror.value).toBe("#654321");
    expect(bar(dom).hidden).toBe(false);
    expect(barText(dom)).toBe("1 unsaved change");
    // Discard returns to what was saved, in the swatch and in the field.
    discard(dom);
    expect(q<HTMLInputElement>(dom, "[data-colour-input]").value).toBe(
      "#123456",
    );
    expect(mirror.value).toBe("#123456");
    expect(posted(dom)[NAME]).toBe("#123456");
    expect(bar(dom).hidden).toBe(true);
  });

  it("a plain save makes the sent colour the one Discard returns to", () => {
    const dom = mount("red");
    const mirror = q<HTMLInputElement>(dom, "[data-colour-mirror]");
    pick(dom, "#123456");
    submitAndSave(dom);
    expect(mirror.getAttribute("data-stored")).toBe("#123456");
    expect(bar(dom).hidden).toBe(true);
  });

  it("saving Use default turns the stored text into the default, so unticking posts no invalid value", () => {
    const dom = mount("red");
    const mirror = q<HTMLInputElement>(dom, "[data-colour-mirror]");
    tick(dom, true);
    expect(posted(dom)[DEFAULT]).toBe("true");
    submitAndSave(dom);
    expect(mirror.getAttribute("data-stored")).toBe("");
    expect(mirror.value).toBe("");
    tick(dom, false);
    expect(posted(dom)[NAME]).toBe("");
    expect(posted(dom)[NAME]).not.toBe("red");
  });
});

describe("the section cascade", () => {
  function cascade(current: string, masterOn: boolean): JSDOM {
    const dom = new JSDOM(
      `<!doctype html><body><form><div data-cascade-scope>` +
        `<input type="checkbox" name="master" data-cascade-master${masterOn ? " checked" : ""}>` +
        `<div class="kb-setting">${renderColourInput(NAME, DEFAULT, current)}</div>` +
        `<div class="kb-setting">${renderEmojiField("value_p", "🎮", { label: "Prefix" })}</div>` +
        `</div>${renderSaveBar("Save")}</form></body>`,
      { runScripts: "outside-only" },
    );
    // The order the admin layout loads them in.
    dom.window.eval(CASCADE_DISABLE_SCRIPT);
    dom.window.eval(COLOUR_INPUT_SCRIPT);
    dom.window.eval(groupRowsScript());
    dom.window.eval(SAVEBAR_SCRIPT);
    return dom;
  }
  const flip = (dom: JSDOM, on: boolean): void => {
    const m = q<HTMLInputElement>(dom, "[data-cascade-master]");
    m.checked = on;
    m.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };

  it("keeps the swatch off while the feature is off, whatever Use default says", () => {
    const dom = cascade("#a95f55", false);
    const swatch = q<HTMLInputElement>(dom, "[data-colour-input]");
    const box = q<HTMLInputElement>(dom, "[data-colour-default]");
    expect(box.disabled).toBe(true);
    expect(swatch.disabled).toBe(true);
    box.checked = true;
    box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    box.checked = false;
    box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(swatch.disabled).toBe(true);
    expect(bar(dom).hidden).toBe(true);
  });

  it("follows the master: on enables the swatch, off disables it, Use default still greys it", () => {
    const dom = cascade("#a95f55", false);
    const swatch = q<HTMLInputElement>(dom, "[data-colour-input]");
    flip(dom, true);
    expect(swatch.disabled).toBe(false);
    tick(dom, true);
    expect(swatch.disabled).toBe(true);
    flip(dom, false);
    expect(swatch.disabled).toBe(true);
    flip(dom, true);
    // Use default is still ticked, so the swatch stays off.
    expect(swatch.disabled).toBe(true);
    tick(dom, false);
    expect(swatch.disabled).toBe(false);
  });

  it("master on from the start behaves as before", () => {
    const dom = cascade("", true);
    const swatch = q<HTMLInputElement>(dom, "[data-colour-input]");
    expect(swatch.disabled).toBe(true);
    pick(dom, "#112233");
    expect(swatch.disabled).toBe(false);
    expect(q<HTMLInputElement>(dom, "[data-colour-default]").checked).toBe(
      false,
    );
  });

  it("the emoji button does nothing while its box is off", () => {
    const dom = cascade("#a95f55", false);
    const input = q<HTMLInputElement>(dom, "[data-marker-input]");
    expect(input.disabled).toBe(true);
    q(dom, "[data-marker-btn]").click();
    expect(dom.window.document.querySelector(".kb-emoji-pop")).toBeNull();
    flip(dom, true);
    q(dom, "[data-marker-btn]").click();
    expect(
      (dom.window.document.querySelector(".kb-emoji-pop") as HTMLElement)
        .hidden,
    ).toBe(false);
  });
});

describe("a save made while the section is off", () => {
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

  it("does not commit a pick the server will skip: Discard still returns to the stored text", () => {
    const scoped = new JSDOM(
      `<!doctype html><body><form><div data-cascade-scope>` +
        `<input type="checkbox" name="master" data-cascade-master checked>` +
        `<div class="kb-setting">${renderColourInput(NAME, DEFAULT, "red")}</div>` +
        `</div><input type="text" name="sibling" value="a">${renderSaveBar("Save")}</form></body>`,
      { runScripts: "outside-only" },
    );
    scoped.window.eval(CASCADE_DISABLE_SCRIPT);
    scoped.window.eval(COLOUR_INPUT_SCRIPT);
    scoped.window.eval(SAVEBAR_SCRIPT);
    const mirror = q<HTMLInputElement>(scoped, "[data-colour-mirror]");
    const master = q<HTMLInputElement>(scoped, "[data-cascade-master]");
    const flip = (on: boolean): void => {
      master.checked = on;
      master.dispatchEvent(
        new scoped.window.Event("change", { bubbles: true }),
      );
    };
    pick(scoped, "#123456");
    // The sibling changes, so the bar stays up and the form can be saved.
    const sibling = q<HTMLInputElement>(scoped, "[name=sibling]");
    sibling.value = "b";
    sibling.dispatchEvent(new scoped.window.Event("input", { bubbles: true }));
    flip(false);
    submitAndSave(scoped);
    // Nothing was sent for the colour, so nothing was committed for it.
    expect(mirror.getAttribute("data-stored")).toBe("red");
    flip(true);
    expect(q<HTMLInputElement>(scoped, "[data-colour-input]").disabled).toBe(
      false,
    );
    discard(scoped);
    expect(mirror.value).toBe("red");
    expect(posted(scoped)[NAME]).toBe("red");
  });

  it("an earlier submission's snapshot is dropped when the next one skips the colour", () => {
    const scoped = new JSDOM(
      `<!doctype html><body><form><div data-cascade-scope>` +
        `<input type="checkbox" name="master" data-cascade-master checked>` +
        `<div class="kb-setting">${renderColourInput(NAME, DEFAULT, "red")}</div>` +
        `</div>${renderSaveBar("Save")}</form></body>`,
      { runScripts: "outside-only" },
    );
    scoped.window.eval(CASCADE_DISABLE_SCRIPT);
    scoped.window.eval(COLOUR_INPUT_SCRIPT);
    scoped.window.eval(SAVEBAR_SCRIPT);
    const mirror = q<HTMLInputElement>(scoped, "[data-colour-mirror]");
    const master = q<HTMLInputElement>(scoped, "[data-cascade-master]");
    pick(scoped, "#123456");
    const form = q<HTMLFormElement>(scoped, "form");
    // A save that failed leaves its snapshot behind.
    form.dispatchEvent(
      new scoped.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    master.checked = false;
    master.dispatchEvent(new scoped.window.Event("change", { bubbles: true }));
    submitAndSave(scoped);
    expect(mirror.getAttribute("data-stored")).toBe("red");
  });

  it("the shared emoji grid is usable in a section that is on after another section went off", () => {
    const dom = twoScopes();
    const d = dom.window.document;
    const clickBtn = (id: string): void =>
      (
        d
          .querySelector(`#${id}`)
          ?.closest("[data-emoji-field]")
          ?.querySelector("[data-marker-btn]") as HTMLButtonElement
      ).click();
    clickBtn("a");
    const search = d.querySelector("[data-emoji-search]") as HTMLInputElement;
    expect(search.disabled).toBe(false);
    const m1 = q<HTMLInputElement>(dom, "#m1");
    m1.checked = false;
    m1.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(search.disabled).toBe(true);
    clickBtn("b");
    expect(search.closest("#s2")).not.toBeNull();
    expect(search.disabled).toBe(false);
    expect((d.querySelector(".kb-emoji-pop") as HTMLElement).hidden).toBe(
      false,
    );
  });
});
