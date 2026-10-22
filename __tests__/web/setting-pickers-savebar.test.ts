/* global HTMLElement, HTMLInputElement, HTMLFormElement */
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
} from "../../src/web/setting-pickers.js";
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
    q<HTMLFormElement>(dom, "form").dispatchEvent(
      new dom.window.Event("kb-saved"),
    );
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
