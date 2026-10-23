/* global Document, HTMLElement, HTMLInputElement, HTMLButtonElement, HTMLFormElement */
/**
 * The stepper and preset durations of #1427: the markup, the field the server
 * reads, and the page scripts run for real in jsdom together with the save bar,
 * the section cascade and the number input script. The controls keep no state
 * of their own (radios, a box, buttons that only move the box), so a seeded
 * random walk at the end checks that over every order of events what the form
 * posts is what the screen shows.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
  defaultConfig,
  settingsMetadata,
} from "../../src/services/config-schema.js";
import {
  DURATION_PRESETS_SCRIPT,
  STEPPER_SCRIPT,
  pickPreset,
  renderDurationPresets,
  renderStepper,
} from "../../src/web/setting-pickers.js";
import { CASCADE_DISABLE_SCRIPT } from "../../src/web/admin-layout.js";
import { NUMBER_INPUT_SCRIPT } from "../../src/web/number-input.js";
import { renderSaveBar, SAVEBAR_SCRIPT } from "../../src/web/savebar.js";
import { readSettingField } from "../../src/web/admin-views.js";
import { coerceConfigValue } from "../../src/web/routes/write/helpers.js";

const REMINDER = "events.reminder_minutes";
const PRESETS = [0, 5, 10, 15, 30, 60];
const BOUNDS = { min: 0, max: 10080 };
const STEP_KEY = "events.groups.default_count";
const STEP_BOUNDS = { min: 1, max: 25 };

function doc(html: string): Document {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}

function durationHtml(current: string | number, disabled = false): string {
  return renderDurationPresets(
    `preset_${REMINDER}`,
    `value_${REMINDER}`,
    current,
    PRESETS,
    BOUNDS,
    {
      id: "set-r",
      labelledBy: "name-r",
      label: "Reminder lead time",
      unit: "minutes",
      zeroLabel: "Off",
      disabled,
    },
  );
}

describe("renderDurationPresets", () => {
  it("ticks the preset that is stored and still puts the number in the box", () => {
    const d = doc(durationHtml(30));
    const checked = d.querySelector("input[type=radio]:checked");
    expect((checked as HTMLInputElement).value).toBe("30");
    expect(
      (d.querySelector("[data-duration-input]") as HTMLInputElement).value,
    ).toBe("30");
  });

  it("labels the options, with 0 as Off and Custom… last", () => {
    const labels = [...doc(durationHtml(30)).querySelectorAll("label")].map(
      (l) => l.textContent,
    );
    expect(labels).toEqual(["Off", "5", "10", "15", "30", "60", "Custom…"]);
  });

  it("ticks Custom… for a stored number that is not a preset, and shows it", () => {
    const d = doc(durationHtml(45));
    expect(
      (d.querySelector("input[type=radio]:checked") as HTMLInputElement).value,
    ).toBe("custom");
    expect(
      (d.querySelector("[data-duration-input]") as HTMLInputElement).value,
    ).toBe("45");
  });

  it("does not treat a stored value with whitespace as a preset: Custom… is ticked and the box is visible", () => {
    const d = doc(durationHtml("30 "));
    expect(
      (d.querySelector("input[type=radio]:checked") as HTMLInputElement).value,
    ).toBe("custom");
    const box = d.querySelector("[data-duration-input]") as HTMLInputElement;
    expect(box.value).toBe("30 ");
    // The markup never carries `required` (see the no-JavaScript test below);
    // the script adds it while Custom… is ticked.
    expect(box.required).toBe(false);
    // No hidden invalid box: with the script run, the wrapper is still shown.
    const dom = new JSDOM(
      `<!doctype html><body><form>${durationHtml("30 ")}</form></body>`,
      {
        runScripts: "outside-only",
      },
    );
    dom.window.eval(DURATION_PRESETS_SCRIPT);
    expect(
      (
        dom.window.document.querySelector(
          "[data-duration-custom]",
        ) as HTMLElement
      ).hidden,
    ).toBe(false);
    expect(
      (
        dom.window.document.querySelector(
          "[data-duration-input]",
        ) as HTMLInputElement
      ).required,
    ).toBe(true);
  });

  it("shows a stored number outside the range as it is, under Custom…", () => {
    const d = doc(durationHtml(99999));
    expect(
      (d.querySelector("input[type=radio]:checked") as HTMLInputElement).value,
    ).toBe("custom");
    expect(
      (d.querySelector("[data-duration-input]") as HTMLInputElement).value,
    ).toBe("99999");
  });

  it("names the group and the box, and keeps the box bounded", () => {
    const d = doc(durationHtml(30));
    const group = d.querySelector("[role=radiogroup]") as HTMLElement;
    expect(group.id).toBe("set-r");
    expect(group.getAttribute("aria-labelledby")).toBe("name-r");
    const box = d.querySelector("[data-duration-input]") as HTMLInputElement;
    expect(box.name).toBe(`value_${REMINDER}`);
    expect(box.getAttribute("aria-label")).toBe(
      "Custom Reminder lead time in minutes",
    );
    expect(box.getAttribute("data-min")).toBe("0");
    expect(box.getAttribute("data-max")).toBe("10080");
    expect(box.required).toBe(false); // a preset is ticked, so it needs no number
    expect(
      [...d.querySelectorAll("input[type=radio]")].every(
        (r) => (r as HTMLInputElement).name === `preset_${REMINDER}`,
      ),
    ).toBe(true);
  });

  it("locks the radios and the box together, never marking an option disabled otherwise", () => {
    const d = doc(durationHtml(30, true));
    const locked = [...d.querySelectorAll("input")];
    expect(
      locked.every((i) => i.disabled && i.hasAttribute("data-dep-locked")),
    ).toBe(true);
    const free = doc(durationHtml(30));
    expect([...free.querySelectorAll("input")].some((i) => i.disabled)).toBe(
      false,
    );
  });
});

describe("renderStepper", () => {
  const html = (v: string | number, disabled = false): string =>
    renderStepper(`value_${STEP_KEY}`, v, STEP_BOUNDS, "Groups offered", {
      id: "set-s",
      disabled,
    });

  it("is the bounded box with two buttons that stay hidden until the script runs", () => {
    const d = doc(html(2));
    const input = d.querySelector("input") as HTMLInputElement;
    expect(input.name).toBe(`value_${STEP_KEY}`);
    expect(input.required).toBe(true);
    expect(input.getAttribute("data-min")).toBe("1");
    expect(input.getAttribute("data-max")).toBe("25");
    const buttons = [...d.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Decrease Groups offered",
      "Increase Groups offered",
    ]);
    expect(buttons.every((b) => b.hidden && b.type === "button")).toBe(true);
  });

  it("locks the buttons with the box", () => {
    const d = doc(html(2, true));
    expect(
      [...d.querySelectorAll("input,button")].every(
        (e) =>
          (e as HTMLInputElement).disabled && e.hasAttribute("data-dep-locked"),
      ),
    ).toBe(true);
  });

  it("shows a stored value outside the range unchanged", () => {
    expect(
      (doc(html(40)).querySelector("input") as HTMLInputElement).value,
    ).toBe("40");
  });
});

describe("without JavaScript", () => {
  it("never renders the box required, whatever is stored, so a ticked preset is never blocked by it", () => {
    for (const stored of [30, 45, "30 ", 99999, ""]) {
      const d = doc(durationHtml(stored));
      expect(
        (d.querySelector("[data-duration-input]") as HTMLInputElement).required,
      ).toBe(false);
    }
  });

  it("has no pattern on the custom box, so a stray 1e3 cannot block a ticked preset; Custom… with it is refused", () => {
    const dom = new JSDOM(
      `<!doctype html><body><form>${durationHtml(45)}</form></body>`,
    );
    const form = dom.window.document.querySelector("form") as HTMLFormElement;
    const box = form.querySelector("[data-duration-input]") as HTMLInputElement;
    expect(box.hasAttribute("pattern")).toBe(false);
    box.value = "1e3";
    (
      form.querySelector('input[type=radio][value="15"]') as HTMLInputElement
    ).checked = true;
    expect(form.checkValidity()).toBe(true);
    const read = (): unknown =>
      readSettingField(
        Object.fromEntries(
          [...new dom.window.FormData(form).entries()].map(([k, v]) => [
            k,
            String(v),
          ]),
        ),
        REMINDER,
      );
    expect(read()).toBe("15");
    (
      form.querySelector(
        'input[type=radio][value="custom"]',
      ) as HTMLInputElement
    ).checked = true;
    expect(read()).toBe("1e3");
    expect(coerceConfigValue(REMINDER, read(), 45).ok).toBe(false);
  });

  it("stored 45, box cleared, preset 15 ticked: the form is valid and the server reads 15; Custom… with an empty box is refused", () => {
    const dom = new JSDOM(
      `<!doctype html><body><form>${durationHtml(45)}</form></body>`,
    );
    const form = dom.window.document.querySelector("form") as HTMLFormElement;
    const box = form.querySelector("[data-duration-input]") as HTMLInputElement;
    box.value = "";
    (
      form.querySelector('input[type=radio][value="15"]') as HTMLInputElement
    ).checked = true;
    expect(form.checkValidity()).toBe(true);
    const body = Object.fromEntries(
      [...new dom.window.FormData(form).entries()].map(([k, v]) => [
        k,
        String(v),
      ]),
    );
    expect(readSettingField(body, REMINDER)).toBe("15");
    expect(
      coerceConfigValue(REMINDER, readSettingField(body, REMINDER), 45),
    ).toEqual({
      ok: true,
      value: 15,
    });
    (
      form.querySelector(
        'input[type=radio][value="custom"]',
      ) as HTMLInputElement
    ).checked = true;
    const custom = Object.fromEntries(
      [...new dom.window.FormData(form).entries()].map(([k, v]) => [
        k,
        String(v),
      ]),
    );
    const raw = readSettingField(custom, REMINDER);
    expect(raw).toBe("");
    expect(coerceConfigValue(REMINDER, raw, 45).ok).toBe(false);
  });
});

describe("what the server reads", () => {
  const body = (o: Record<string, string>): Record<string, string> => o;

  it("pickPreset only names a preset", () => {
    expect(pickPreset("30", PRESETS)).toBe("30");
    expect(pickPreset("45", PRESETS)).toBeNull();
    expect(pickPreset("custom", PRESETS)).toBeNull();
    expect(pickPreset(undefined, PRESETS)).toBeNull();
    expect(pickPreset(["30"], PRESETS)).toBeNull();
    expect(pickPreset("30 ", PRESETS)).toBeNull();
  });

  it("a ticked preset wins over the box, Custom… and no radio mean the box", () => {
    const box = `value_${REMINDER}`;
    const radio = `preset_${REMINDER}`;
    expect(
      readSettingField(body({ [radio]: "15", [box]: "99" }), REMINDER),
    ).toBe("15");
    expect(
      readSettingField(body({ [radio]: "custom", [box]: "45" }), REMINDER),
    ).toBe("45");
    expect(readSettingField(body({ [box]: "45" }), REMINDER)).toBe("45");
    // A value that is not a preset cannot choose a number: the box decides.
    expect(
      readSettingField(body({ [radio]: "7", [box]: "45" }), REMINDER),
    ).toBe("45");
  });

  it("keys without presets read the box only", () => {
    expect(
      readSettingField(
        body({ [`preset_${STEP_KEY}`]: "3", [`value_${STEP_KEY}`]: "4" }),
        STEP_KEY,
      ),
    ).toBe("4");
  });

  it("presets are a shortcut, not a whitelist: a number in range that is not a preset saves", () => {
    expect(coerceConfigValue(REMINDER, "45", 30)).toEqual({
      ok: true,
      value: 45,
    });
    expect(coerceConfigValue(REMINDER, "10081", 30).ok).toBe(false);
    expect(coerceConfigValue(REMINDER, "", 30).ok).toBe(false);
    expect(coerceConfigValue(STEP_KEY, "26", 2).ok).toBe(false);
    expect(coerceConfigValue(STEP_KEY, "0", 2).ok).toBe(false);
  });
});

describe("which keys get which control", () => {
  const withPresets = Object.entries(settingsMetadata).filter(
    ([, m]) => "presets" in m && m.presets,
  );
  const withStepper = Object.entries(settingsMetadata).filter(
    ([, m]) => "stepper" in m && m.stepper,
  );

  it("is the five durations and three small ranges of #1427", () => {
    expect(withPresets.map(([k]) => k).sort()).toEqual([
      "events.channel_grace_minutes",
      "events.create_lead_minutes",
      "events.default_duration_minutes",
      "events.reminder_minutes",
      "lfg.expiry_minutes",
    ]);
    expect(withStepper.map(([k]) => k).sort()).toEqual([
      "events.groups.default_count",
      "events.groups.max_count",
      "lfg.default_size",
    ]);
  });

  it.each(withPresets)(
    "%s: presets lie in range and include the default",
    (key, meta) => {
      const m = meta as { min: number; max: number; presets: number[] };
      for (const p of m.presets) {
        expect(p).toBeGreaterThanOrEqual(m.min);
        expect(p).toBeLessThanOrEqual(m.max);
      }
      expect(new Set(m.presets).size).toBe(m.presets.length);
      expect(m.presets).toContain(
        defaultConfig[key as keyof typeof defaultConfig],
      );
    },
  );

  it.each(withStepper)(
    "%s: a small range, never both controls",
    (_key, meta) => {
      const m = meta as { min: number; max: number; presets?: number[] };
      expect(m.max - m.min + 1).toBeLessThan(30);
      expect(m.presets).toBeUndefined();
    },
  );
});

// ---------- jsdom: scripts, save bar, cascade ----------

function mount(current: number, masterOn = true): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><body><form><div data-cascade-scope>` +
      `<input type="checkbox" name="master" data-cascade-master${masterOn ? " checked" : ""}>` +
      `<div class="kb-setting" id="row-d">${durationHtml(current)}</div>` +
      `<div class="kb-setting" id="row-s">${renderStepper(
        `value_${STEP_KEY}`,
        2,
        STEP_BOUNDS,
        "Groups offered",
        { id: "set-s" },
      )}</div></div>` +
      `<input type="text" name="sibling" value="a">${renderSaveBar("Save")}</form></body>`,
    { runScripts: "outside-only" },
  );
  // The order the admin layout loads them in.
  dom.window.eval(CASCADE_DISABLE_SCRIPT);
  dom.window.eval(NUMBER_INPUT_SCRIPT);
  dom.window.eval(STEPPER_SCRIPT);
  dom.window.eval(DURATION_PRESETS_SCRIPT);
  dom.window.eval(SAVEBAR_SCRIPT);
  return dom;
}

function q<T extends HTMLElement>(dom: JSDOM, sel: string): T {
  return dom.window.document.querySelector(sel) as T;
}

function posted(dom: JSDOM): Record<string, string> {
  return Object.fromEntries(
    [...new dom.window.FormData(q<HTMLFormElement>(dom, "form")).entries()].map(
      ([k, v]) => [k, String(v)],
    ),
  );
}

/** The duration the server would read from the form. */
function duration(dom: JSDOM): unknown {
  return readSettingField(posted(dom), REMINDER);
}
function stepperValue(dom: JSDOM): string {
  return posted(dom)[`value_${STEP_KEY}`];
}

function tickRadio(dom: JSDOM, value: string): void {
  const r = q<HTMLInputElement>(
    dom,
    `#row-d input[type=radio][value="${value}"]`,
  );
  if (r.disabled || r.checked) return;
  r.checked = true;
  r.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function typeBox(dom: JSDOM, value: string): void {
  const box = q<HTMLInputElement>(dom, "[data-duration-input]");
  if (box.disabled || box.closest("[hidden]")) return;
  box.value = value;
  box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

function press(dom: JSDOM, step: "-1" | "1"): void {
  const b = q<HTMLButtonElement>(dom, `[data-step="${step}"]`);
  if (b.disabled) return;
  b.click();
}

function typeStepper(dom: JSDOM, value: string): void {
  const i = q<HTMLInputElement>(dom, "#row-s input");
  if (i.disabled) return;
  i.value = value;
  i.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  i.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
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
const customWrap = (dom: JSDOM): HTMLElement =>
  q(dom, "[data-duration-custom]");

describe("the script still validates the digit shape of the box without a pattern", () => {
  it("flags non-digits and out-of-range numbers on input, and clears the flag when a preset is ticked", () => {
    const dom = mount(45);
    const box = q<HTMLInputElement>(dom, "[data-duration-input]");
    box.value = "1e3";
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(box.validity.valid).toBe(false);
    box.value = "10081";
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(box.validity.valid).toBe(false);
    tickRadio(dom, "15");
    expect(q<HTMLFormElement>(dom, "form").checkValidity()).toBe(true);
  });
});

describe("the stepper keeps its pattern", () => {
  it("is always visible, required and meant to hold a number, so the pattern is its own validation", () => {
    const d = doc(renderStepper(`value_${STEP_KEY}`, 2, STEP_BOUNDS, "Groups"));
    expect(
      (d.querySelector("input") as HTMLInputElement).getAttribute("pattern"),
    ).toBe("[0-9]*");
  });
});

describe("the stepper's focus ring", () => {
  const css = readFileSync(
    new URL("../../docs/design/kb.css", import.meta.url),
    "utf8",
  );

  it("sits on the clipping wrapper, not on the input or a button inside it", () => {
    expect(css).toMatch(/\.kb-stepper \{[^}]*overflow: hidden/);
    expect(css).toMatch(
      /\.kb-stepper:focus-within \{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/,
    );
    expect(css).toMatch(
      /\.kb-stepper input:focus-visible, \.kb-stepper button:focus-visible \{ outline: none; \}/,
    );
  });
});

describe("preset durations in the page", () => {
  it("hides the box while a preset is ticked and shows it for Custom…", () => {
    const dom = mount(30);
    expect(customWrap(dom).hidden).toBe(true);
    tickRadio(dom, "custom");
    expect(customWrap(dom).hidden).toBe(false);
    expect(
      mount(45)
        .window.document.querySelector("[data-duration-custom]")
        ?.hasAttribute("hidden"),
    ).toBe(false);
  });

  it("picking a preset puts it in the box and counts one change; picking the stored one back clears it", () => {
    const dom = mount(30);
    tickRadio(dom, "15");
    expect(duration(dom)).toBe("15");
    expect(q<HTMLInputElement>(dom, "[data-duration-input]").value).toBe("15");
    expect(barText(dom)).toBe("1 unsaved change");
    tickRadio(dom, "30");
    expect(bar(dom).hidden).toBe(true);
  });

  it("Custom… keeps the number, typing changes it, Discard brings back the preset and hides the box", () => {
    const dom = mount(30);
    tickRadio(dom, "custom");
    expect(duration(dom)).toBe("30");
    typeBox(dom, "45");
    expect(duration(dom)).toBe("45");
    expect(barText(dom)).toBe("1 unsaved change");
    discard(dom);
    expect(duration(dom)).toBe("30");
    expect(customWrap(dom).hidden).toBe(true);
    expect(bar(dom).hidden).toBe(true);
  });

  it("Custom… requires a number and a preset does not, through ticking, Discard and the cascade", () => {
    const dom = mount(30);
    const box = q<HTMLInputElement>(dom, "[data-duration-input]");
    expect(box.required).toBe(false);
    tickRadio(dom, "custom");
    expect(box.required).toBe(true);
    typeBox(dom, "");
    expect(box.validity.valid).toBe(false);
    expect(q<HTMLFormElement>(dom, "form").checkValidity()).toBe(false);
    tickRadio(dom, "15");
    expect(box.required).toBe(false);
    expect(q<HTMLFormElement>(dom, "form").checkValidity()).toBe(true);
    tickRadio(dom, "custom");
    discard(dom);
    expect(box.required).toBe(false);
    expect(box.value).toBe("30");
    flip(dom, false);
    flip(dom, true);
    expect(box.required).toBe(false);
    expect(q<HTMLFormElement>(dom, "form").checkValidity()).toBe(true);
  });

  it("an invalid custom number cannot block the form once a preset is chosen again", () => {
    const dom = mount(30);
    tickRadio(dom, "custom");
    typeBox(dom, "99999");
    const box = q<HTMLInputElement>(dom, "[data-duration-input]");
    expect(box.validity.valid).toBe(false);
    tickRadio(dom, "15");
    expect(box.validity.valid).toBe(true);
    expect(q<HTMLFormElement>(dom, "form").checkValidity()).toBe(true);
  });

  it("a stored custom value posts unchanged, and a stored out-of-range one is flagged for the browser", () => {
    const dom = mount(45);
    expect(duration(dom)).toBe("45");
    expect(coerceConfigValue(REMINDER, duration(dom), 45).ok).toBe(true);
    expect(bar(dom).hidden).toBe(true);
    const over = mount(99999);
    expect(duration(over)).toBe("99999");
    expect(
      q<HTMLInputElement>(over, "[data-duration-input]").validity.valid,
    ).toBe(false);
  });

  it("in flight: pick, submit, pick back before the response; Discard returns to what was saved", () => {
    const dom = mount(30);
    tickRadio(dom, "15");
    submit(dom);
    tickRadio(dom, "30");
    saved(dom);
    // The server stored 15; the screen shows 30, which is now the change.
    expect(barText(dom)).toBe("1 unsaved change");
    discard(dom);
    expect(duration(dom)).toBe("15");
    expect(bar(dom).hidden).toBe(true);
  });

  it("the cascade off locks the whole control and on brings it back, the box staying hidden", () => {
    const dom = mount(30, false);
    const all = (): HTMLInputElement[] => [
      ...dom.window.document.querySelectorAll<HTMLInputElement>("#row-d input"),
    ];
    expect(all().every((i) => i.disabled)).toBe(true);
    flip(dom, true);
    expect(all().every((i) => !i.disabled)).toBe(true);
    expect(customWrap(dom).hidden).toBe(true);
  });
});

describe("the stepper in the page", () => {
  it("shows its buttons only once the script has run", () => {
    const dom = new JSDOM(
      `<!doctype html><body><form><div class="kb-setting">${renderStepper(
        `value_${STEP_KEY}`,
        2,
        STEP_BOUNDS,
        "Groups",
      )}</div></form></body>`,
      { runScripts: "outside-only" },
    );
    expect(dom.window.document.querySelector("button")?.hidden).toBe(true);
    dom.window.eval(STEPPER_SCRIPT);
    expect(dom.window.document.querySelector("button")?.hidden).toBe(false);
  });

  it("an emptied or whitespace box is flagged by the browser, and never hidden", () => {
    const dom = mount(30);
    const input = q<HTMLInputElement>(dom, "#row-s input");
    typeStepper(dom, "");
    expect(input.validity.valid).toBe(false);
    typeStepper(dom, "2 ");
    expect(input.validity.valid).toBe(false);
    expect(input.closest("[hidden]")).toBeNull();
    typeStepper(dom, "3");
    expect(input.validity.valid).toBe(true);
  });

  it("moves by one, counts a change, and each button is off at its bound", () => {
    const dom = mount(30);
    press(dom, "1");
    expect(stepperValue(dom)).toBe("3");
    expect(barText(dom)).toBe("1 unsaved change");
    press(dom, "-1");
    expect(bar(dom).hidden).toBe(true);
    press(dom, "-1");
    expect(stepperValue(dom)).toBe("1");
    expect(q<HTMLButtonElement>(dom, '[data-step="-1"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>(dom, '[data-step="1"]').disabled).toBe(false);
    typeStepper(dom, "25");
    expect(q<HTMLButtonElement>(dom, '[data-step="1"]').disabled).toBe(true);
    press(dom, "1");
    expect(stepperValue(dom)).toBe("25");
  });

  it("a stored value outside the range is shown as it is and a click brings it inside", () => {
    const dom = mount(30);
    typeStepper(dom, "40");
    expect(stepperValue(dom)).toBe("40");
    press(dom, "-1");
    expect(stepperValue(dom)).toBe("25");
  });

  it("Discard restores the value and the buttons' state", () => {
    const dom = mount(30);
    typeStepper(dom, "25");
    expect(q<HTMLButtonElement>(dom, '[data-step="1"]').disabled).toBe(true);
    discard(dom);
    expect(stepperValue(dom)).toBe("2");
    expect(q<HTMLButtonElement>(dom, '[data-step="1"]').disabled).toBe(false);
    expect(bar(dom).hidden).toBe(true);
  });

  it("the cascade does not bring back a button that should stay off at its bound", () => {
    const dom = mount(30);
    typeStepper(dom, "25");
    flip(dom, false);
    expect(q<HTMLButtonElement>(dom, '[data-step="1"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>(dom, '[data-step="-1"]').disabled).toBe(true);
    flip(dom, true);
    expect(q<HTMLButtonElement>(dom, '[data-step="1"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>(dom, '[data-step="-1"]').disabled).toBe(false);
  });
});

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
  const ACTIONS = [
    "preset",
    "preset",
    "custom",
    "type",
    "plus",
    "minus",
    "typeStep",
    "clear",
    "submit",
    "saved",
    "discard",
    "cascadeOff",
    "cascadeOn",
  ] as const;
  const NUMBERS = ["1", "7", "45", "60", "10080", "25", "3"];

  function walk(seed: number, stored: number): void {
    const rand = mulberry32(seed);
    const dom = mount(stored);
    const log: string[] = [];
    const fail = (why: string): never => {
      throw new Error(
        `seed ${seed}, stored ${stored}: ${why}\n  ${log.join("\n  ")}`,
      );
    };
    const on = (): boolean =>
      q<HTMLInputElement>(dom, "[data-cascade-master]").checked;
    const pick = <T>(list: readonly T[]): T =>
      list[Math.floor(rand() * list.length)];

    for (let step = 0; step < 40; step++) {
      const action = pick(ACTIONS);
      log.push(action);
      switch (action) {
        case "preset": {
          const v = String(pick(PRESETS));
          tickRadio(dom, v);
          if (on() && duration(dom) !== v)
            fail(`preset ${v} posts ${duration(dom)}`);
          break;
        }
        case "custom":
          tickRadio(dom, "custom");
          break;
        case "type": {
          const v = pick(NUMBERS);
          const visible = !customWrap(dom).hidden;
          typeBox(dom, v);
          if (on() && visible && duration(dom) !== v) {
            fail(`typed ${v}, form posts ${duration(dom)}`);
          }
          break;
        }
        case "plus":
          press(dom, "1");
          break;
        case "minus":
          press(dom, "-1");
          break;
        case "clear":
          typeBox(dom, "");
          break;
        case "typeStep":
          typeStepper(dom, pick(NUMBERS));
          break;
        case "submit":
          submit(dom);
          break;
        case "saved":
          saved(dom);
          break;
        case "discard":
          discard(dom);
          break;
        case "cascadeOff":
          flip(dom, false);
          break;
        case "cascadeOn":
          flip(dom, true);
          break;
      }

      // Invariants after every step.
      const radios = [
        ...dom.window.document.querySelectorAll<HTMLInputElement>(
          "#row-d input[type=radio]",
        ),
      ];
      const ticked = radios.filter((r) => r.checked);
      if (ticked.length !== 1) fail(`${ticked.length} radios ticked`);
      const isCustom = ticked[0].value === "custom";
      if (customWrap(dom).hidden !== !isCustom) {
        fail(
          `box hidden=${customWrap(dom).hidden} with ${ticked[0].value} ticked`,
        );
      }
      if (on()) {
        const box = q<HTMLInputElement>(dom, "[data-duration-input]");
        const effective = duration(dom);
        const expected = isCustom ? box.value : ticked[0].value;
        if (effective !== expected) {
          fail(`form posts ${String(effective)}, the screen shows ${expected}`);
        }
        const durBox = q<HTMLInputElement>(dom, "[data-duration-input]");
        if (durBox.required !== isCustom) {
          fail(
            `box required=${durBox.required} with ${ticked[0].value} ticked`,
          );
        }
        // A ticked preset never depends on the hidden box: it is always valid.
        if (!isCustom && !durBox.validity.valid) {
          fail("a hidden box blocks the form");
        }
        // Custom… with an empty box is flagged by the browser, not the server.
        if (isCustom && durBox.value === "" && durBox.validity.valid) {
          fail("an empty custom box passes native validation");
        }
        const minus = q<HTMLButtonElement>(dom, '[data-step="-1"]');
        const plus = q<HTMLButtonElement>(dom, '[data-step="1"]');
        const raw = q<HTMLInputElement>(dom, "#row-s input").value;
        if (/^[0-9]+$/.test(raw)) {
          const n = Number(raw);
          if (minus.disabled !== n <= STEP_BOUNDS.min) {
            fail(`minus disabled=${minus.disabled} at ${n}`);
          }
          if (plus.disabled !== n >= STEP_BOUNDS.max) {
            fail(`plus disabled=${plus.disabled} at ${n}`);
          }
        }
      } else {
        const locked = [
          ...dom.window.document.querySelectorAll<HTMLInputElement>(
            "#row-d input, #row-s input",
          ),
        ];
        if (locked.some((i) => !i.disabled))
          fail("cascade off left a control on");
      }
    }
    // Discard returns to the last committed baseline whatever came before.
    flip(dom, true);
    discard(dom);
    if (!bar(dom).hidden) fail("Discard left changes behind");
  }

  it("keeps the form, the screen and the buttons in step for 300 seeds", () => {
    for (let seed = 1; seed <= 300; seed++) {
      walk(seed, [30, 45, 0, 99999][seed % 4]);
    }
  });
});
