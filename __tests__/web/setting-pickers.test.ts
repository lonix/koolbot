/* global Document, HTMLFormElement, HTMLInputElement, HTMLSelectElement, HTMLElement, HTMLButtonElement */
/**
 * The timezone select, colour input and emoji field of #1426: the server rules,
 * the markup (read through a DOM, never regular expressions over HTML) and the
 * page scripts run for real in jsdom.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  DEFAULT_COLOUR_SWATCH,
  validateSettingFormat,
  CHANNEL_AFFIX_MAX_CHARS,
} from "../../src/utils/setting-formats.js";
import {
  settingsMetadata,
  defaultConfig,
} from "../../src/services/config-schema.js";
import { coerceConfigValue } from "../../src/web/routes/write/helpers.js";
import {
  COLOUR_INPUT_SCRIPT,
  TIMEZONE_SELECT_SCRIPT,
  renderColourInput,
  renderEmojiField,
  renderTimezoneSelect,
  timezoneChoices,
} from "../../src/web/setting-pickers.js";
import {
  groupRowsScript,
  pickableMarkers,
} from "../../src/web/event-group-form.js";
import {
  readSettingField,
  renderSettingsPage,
  type SettingRow,
} from "../../src/web/admin-views.js";
import { renderNewEventBody } from "../../src/web/event-new-view.js";
import { renderEventEditBody } from "../../src/web/event-edit-view.js";
import { listSupportedTimezones } from "../../src/utils/timezone.js";
import { allPages } from "./a11y-pages.js";

function doc(html: string): Document {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document;
}

function boot(html: string, scripts: string[]): JSDOM {
  const dom = new JSDOM(`<!doctype html><body><form>${html}</form></body>`, {
    runScripts: "outside-only",
  });
  for (const code of scripts) dom.window.eval(code);
  return dom;
}

describe("validateSettingFormat", () => {
  it("timezone: blank, UTC and listed zones pass; others are refused with a reason", () => {
    expect(validateSettingFormat("timezone", "")).toEqual({
      ok: true,
      value: "",
    });
    expect(validateSettingFormat("timezone", " UTC ")).toEqual({
      ok: true,
      value: "UTC",
    });
    expect(validateSettingFormat("timezone", "Europe/Oslo").ok).toBe(true);
    const bad = validateSettingFormat("timezone", "Mars/Olympus");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("unknown timezone");
  });

  it("timezone: every zone the picker lists is accepted", () => {
    for (const zone of timezoneChoices()) {
      expect(validateSettingFormat("timezone", zone).ok).toBe(true);
    }
  });

  it("colour: blank or #RRGGBB, stored lower case with the hash", () => {
    expect(validateSettingFormat("colour", "")).toEqual({
      ok: true,
      value: "",
    });
    expect(validateSettingFormat("colour", "#A95F55")).toEqual({
      ok: true,
      value: "#a95f55",
    });
    expect(validateSettingFormat("colour", "A95F55")).toEqual({
      ok: true,
      value: "#a95f55",
    });
    for (const bad of ["red", "#fff", "#12345g", "#1234567", "0x112233"]) {
      expect(validateSettingFormat("colour", bad).ok).toBe(false);
    }
  });

  it("affix: free text up to 32 code points, no control characters, no custom emoji markup (#1435)", () => {
    expect(CHANNEL_AFFIX_MAX_CHARS).toBe(32);
    for (const good of [
      "",
      "🎮",
      "🎮 | ",
      "🇳🇴",
      "⚔️",
      "[VC]",
      "Looking for group: ",
      "This is ",
      "'s last resort",
      "👨‍👩‍👧‍👦",
      "x".repeat(32),
    ]) {
      expect(validateSettingFormat("affix", good).ok).toBe(true);
    }
    for (const bad of [
      "x".repeat(33),
      "🎮".repeat(33),
      "a\nb",
      "\u0007",
      "<:wave:123456789012345678>",
      "<a:x:1>",
    ]) {
      expect(validateSettingFormat("affix", bad).ok).toBe(false);
    }
  });

  it("the longest prefix, name and suffix still fit a Discord channel name", () => {
    // `<prefix> <display name><suffix>`, display name at most 32.
    const longest = CHANNEL_AFFIX_MAX_CHARS * 2 + 1 + 32;
    expect(longest).toBeLessThanOrEqual(100);
  });

  it("every emoji the picker offers passes the server rule", () => {
    for (const { emoji } of pickableMarkers()) {
      expect(validateSettingFormat("affix", emoji).ok).toBe(true);
    }
  });

  it("the defaults of the picker keys pass their own rule", () => {
    for (const [key, meta] of Object.entries(settingsMetadata)) {
      if (!meta.format) continue;
      const value = defaultConfig[key as keyof typeof defaultConfig];
      expect(validateSettingFormat(meta.format, String(value)).ok).toBe(true);
    }
  });
});

describe("the picker keys", () => {
  it("are declared as string keys with a format", () => {
    expect(
      Object.entries(settingsMetadata)
        .filter(([, m]) => m.format)
        .map(([k, m]) => [k, m.format, m.type]),
    ).toEqual([
      ["voicechannels.channel.prefix", "affix", "string"],
      ["voicechannels.channel.suffix", "affix", "string"],
      ["welcome.roles_message_id", "reaction_role_message", "string"],
      ["events.timezone", "timezone", "string"],
      ["events.channel_prefix", "affix", "string"],
      ["reactionroles.group_role_colour", "colour", "string"],
    ]);
  });

  it("refuse a value the picker could not produce in coerceConfigValue", () => {
    expect(coerceConfigValue("events.timezone", "Nowhere/Land").ok).toBe(false);
    expect(coerceConfigValue("reactionroles.group_role_colour", "red").ok).toBe(
      false,
    );
    expect(
      coerceConfigValue("voicechannels.channel.suffix", "x".repeat(33)).ok,
    ).toBe(false);
    // Shortcode resolution turns the `:wave:` of custom emoji markup into an
    // emoji, so the markup is refused as submitted.
    expect(
      coerceConfigValue(
        "voicechannels.channel.prefix",
        "<:wave:123456789012345678>",
      ).ok,
    ).toBe(false);
    expect(
      coerceConfigValue("events.channel_prefix", "<a:wave:123456789012345678>")
        .ok,
    ).toBe(false);
  });

  it("accept long free text, as the owner decided (#1435)", () => {
    expect(
      coerceConfigValue("voicechannels.channel.prefix", "Looking for group: "),
    ).toEqual({ ok: true, value: "Looking for group: " });
  });

  it("accept the stored value unchanged, and nothing else invalid", () => {
    expect(
      coerceConfigValue("events.timezone", "Nowhere/Land", "Nowhere/Land"),
    ).toEqual({ ok: true, value: "Nowhere/Land" });
    expect(
      coerceConfigValue("voicechannels.channel.prefix", "[Voice] ", "[Voice] "),
    ).toEqual({ ok: true, value: "[Voice] " });
    expect(
      coerceConfigValue("events.timezone", "Nowhere/Else", "Nowhere/Land").ok,
    ).toBe(false);
  });

  it("keeps a stored prefix over the cap unchanged, and refuses a different over-cap one (#1435)", () => {
    const legacy = "x".repeat(40);
    expect(
      coerceConfigValue("voicechannels.channel.prefix", legacy, legacy),
    ).toEqual({ ok: true, value: legacy });
    expect(
      coerceConfigValue("voicechannels.channel.prefix", "y".repeat(40), legacy)
        .ok,
    ).toBe(false);
  });

  it("keeps an affix posted exactly as stored, shortcode and all (#1438)", () => {
    const stored = "[VC] :sparkles:";
    expect(
      coerceConfigValue("voicechannels.channel.prefix", stored, stored),
    ).toEqual({ ok: true, value: stored });
    // A changed value is resolved and checked after resolution.
    expect(
      coerceConfigValue("voicechannels.channel.prefix", stored, "other"),
    ).toEqual({ ok: true, value: "[VC] ✨" });
  });

  it("measures a value after its shortcodes are resolved", () => {
    expect(
      coerceConfigValue(
        "voicechannels.channel.prefix",
        `${"x".repeat(31)}:sparkles:`,
      ),
    ).toEqual({ ok: true, value: `${"x".repeat(31)}✨` });
    expect(
      coerceConfigValue(
        "voicechannels.channel.prefix",
        `${"x".repeat(32)}:sparkles:`,
      ).ok,
    ).toBe(false);
  });

  it("an import or adoption plan (no stored value) stays strict", () => {
    expect(
      coerceConfigValue("reactionroles.group_role_colour", "red", undefined).ok,
    ).toBe(false);
  });

  it("still resolve a shortcode before checking a prefix", () => {
    expect(
      coerceConfigValue("voicechannels.channel.prefix", ":sparkles:"),
    ).toEqual({ ok: true, value: "✨" });
  });
});

describe("timezoneChoices", () => {
  it("lists UTC exactly once, even though the runtime list omits it", () => {
    const zones = timezoneChoices();
    expect(zones.filter((z) => z === "UTC")).toHaveLength(1);
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones.length).toBe(listSupportedTimezones().length);
  });

  it("puts the first zone first and never repeats it", () => {
    const zones = timezoneChoices("Europe/Oslo");
    expect(zones[0]).toBe("Europe/Oslo");
    expect(zones.filter((z) => z === "Europe/Oslo")).toHaveLength(1);
    const utc = timezoneChoices("UTC");
    expect(utc[0]).toBe("UTC");
    expect(utc.filter((z) => z === "UTC")).toHaveLength(1);
  });
});

describe("renderTimezoneSelect", () => {
  function select(html: string): HTMLSelectElement {
    return doc(html).querySelector("select") as HTMLSelectElement;
  }

  it("leads with the default, which posts nothing when the key may be blank", () => {
    const el = select(
      renderTimezoneSelect("value_events.timezone", "", {
        defaultZone: "Europe/Oslo",
        blank: true,
        id: "set-events.timezone",
      }),
    );
    expect(el.id).toBe("set-events.timezone");
    expect(el.options[0].value).toBe("");
    expect(el.options[0].textContent).toBe("Default (Europe/Oslo)");
    expect(el.options[0].selected).toBe(true);
    expect(el.value).toBe("");
    const values = [...el.options].map((o) => o.value);
    expect(values).toContain("UTC");
    expect(values.filter((v) => v === "UTC")).toHaveLength(1);
  });

  it("can post the default zone itself, listed once", () => {
    const el = select(
      renderTimezoneSelect("timezone", "Europe/Oslo", {
        defaultZone: "Europe/Oslo",
      }),
    );
    const values = [...el.options].map((o) => o.value);
    expect(values[0]).toBe("Europe/Oslo");
    expect(values.filter((v) => v === "Europe/Oslo")).toHaveLength(1);
    expect(el.value).toBe("Europe/Oslo");
  });

  it("dedupes when the server zone is UTC", () => {
    const el = select(
      renderTimezoneSelect("timezone", "UTC", { defaultZone: "UTC" }),
    );
    const values = [...el.options].map((o) => o.value);
    expect(values.filter((v) => v === "UTC")).toHaveLength(1);
    expect(values[0]).toBe("UTC");
  });

  it("selects a listed zone the key holds", () => {
    const el = select(
      renderTimezoneSelect("timezone", "Asia/Tokyo", {
        defaultZone: "Europe/Oslo",
        blank: true,
      }),
    );
    expect(el.value).toBe("Asia/Tokyo");
  });

  it("keeps a stored zone the runtime does not list as a selected custom option", () => {
    const el = select(
      renderTimezoneSelect("timezone", "Mars/Olympus", {
        defaultZone: "Europe/Oslo",
        blank: true,
      }),
    );
    expect(el.value).toBe("Mars/Olympus");
    expect(el.selectedOptions[0].textContent).toBe("Mars/Olympus (custom)");
    expect(
      [...el.options].filter((o) => o.value === "Mars/Olympus"),
    ).toHaveLength(1);
  });

  it("escapes what it is given", () => {
    const el = select(
      renderTimezoneSelect("timezone", '"><img src=x>', {
        defaultZone: "Europe/Oslo",
      }),
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.value).toBe('"><img src=x>');
  });

  it("has a hidden search box that never posts, and can be locked", () => {
    const d = doc(
      renderTimezoneSelect("timezone", "", {
        defaultZone: "UTC",
        blank: true,
        disabled: true,
        invalid: true,
        describedBy: "h1",
      }),
    );
    const search = d.querySelector("[data-tz-search]") as HTMLInputElement;
    expect(search.hidden).toBe(true);
    expect(search.getAttribute("form")).toBe("none");
    expect(search.hasAttribute("name")).toBe(false);
    expect(search.getAttribute("aria-label")).toBe("Search timezones");
    const sel = d.querySelector("select") as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
    expect(sel.hasAttribute("data-dep-locked")).toBe(true);
    expect(sel.getAttribute("aria-invalid")).toBe("true");
    expect(sel.getAttribute("aria-describedby")).toBe("h1");
  });
});

describe("TIMEZONE_SELECT_SCRIPT", () => {
  function mount(current = "", blank = true): JSDOM {
    return boot(
      renderTimezoneSelect("timezone", current, {
        defaultZone: "Europe/Oslo",
        blank,
      }),
      [TIMEZONE_SELECT_SCRIPT],
    );
  }
  function type(dom: JSDOM, text: string): void {
    const s = dom.window.document.querySelector(
      "[data-tz-search]",
    ) as HTMLInputElement;
    s.value = text;
    s.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  function visible(dom: JSDOM): string[] {
    const sel = dom.window.document.querySelector(
      "select",
    ) as HTMLSelectElement;
    return [...sel.options].filter((o) => !o.hidden).map((o) => o.value);
  }

  it("shows the search box and keeps the select as it was", () => {
    const dom = mount("Asia/Tokyo");
    expect(
      (dom.window.document.querySelector("[data-tz-search]") as HTMLElement)
        .hidden,
    ).toBe(false);
    expect(
      (dom.window.document.querySelector("select") as HTMLSelectElement).value,
    ).toBe("Asia/Tokyo");
  });

  it("filters by words, treating underscores and slashes as spaces", () => {
    const dom = mount();
    type(dom, "new york");
    const shown = visible(dom);
    expect(shown).toContain("America/New_York");
    expect(shown).not.toContain("Asia/Tokyo");
    const status = dom.window.document.querySelector(
      "[data-tz-status]",
    ) as HTMLElement;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toMatch(/timezones? match/);
  });

  it("never hides the selected zone or the original one, and the option count stays", () => {
    const dom = mount("Asia/Tokyo");
    const sel = dom.window.document.querySelector(
      "select",
    ) as HTMLSelectElement;
    const count = sel.options.length;
    type(dom, "oslo");
    expect(sel.options.length).toBe(count);
    const shown = visible(dom);
    expect(shown).toContain("Asia/Tokyo");
    expect(shown).toContain("Europe/Oslo");
    expect(sel.value).toBe("Asia/Tokyo");
  });

  it("finds UTC", () => {
    const dom = mount();
    type(dom, "utc");
    expect(visible(dom)).toContain("UTC");
  });

  it("says when nothing matches, and clears the note when the box is emptied", () => {
    const dom = mount();
    type(dom, "zzzzzz");
    const status = dom.window.document.querySelector(
      "[data-tz-status]",
    ) as HTMLElement;
    expect(status.textContent).toBe("No timezones match");
    type(dom, "");
    expect(status.hidden).toBe(true);
    expect(visible(dom).length).toBeGreaterThan(400);
  });

  it("Enter picks the first match, announces the change and does not submit", () => {
    const dom = mount();
    const sel = dom.window.document.querySelector(
      "select",
    ) as HTMLSelectElement;
    let changed = 0;
    sel.addEventListener("change", () => (changed += 1));
    type(dom, "tokyo");
    const s = dom.window.document.querySelector(
      "[data-tz-search]",
    ) as HTMLInputElement;
    const enter = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    s.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(sel.value).toBe("Asia/Tokyo");
    expect(changed).toBe(1);
  });

  it("is idempotent", () => {
    const dom = mount();
    dom.window.eval(TIMEZONE_SELECT_SCRIPT);
    let runs = 0;
    const sel = dom.window.document.querySelector(
      "select",
    ) as HTMLSelectElement;
    sel.addEventListener("change", () => (runs += 1));
    type(dom, "tokyo");
    (
      dom.window.document.querySelector("[data-tz-search]") as HTMLInputElement
    ).dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(runs).toBe(1);
  });
});

describe("renderColourInput", () => {
  function parts(html: string) {
    const d = doc(html);
    return {
      color: d.querySelector("[data-colour-input]") as HTMLInputElement,
      def: d.querySelector("[data-colour-default]") as HTMLInputElement,
      keep: d.querySelector("[data-colour-keep]") as HTMLInputElement | null,
      note: d.querySelector(".kb-help"),
    };
  }

  it("shows a stored colour on the swatch with Use default off", () => {
    const p = parts(renderColourInput("value_c", "use_default_c", "#A95F55"));
    expect(p.color.type).toBe("color");
    expect(p.color.value).toBe("#a95f55");
    expect(p.color.name).toBe("value_c");
    expect(p.def.checked).toBe(false);
    expect(p.def.name).toBe("use_default_c");
    expect(p.def.value).toBe("true");
    expect(p.keep).toBeNull();
  });

  it("normalises a colour stored without the hash", () => {
    const p = parts(renderColourInput("value_c", "use_default_c", "A95F55"));
    expect(p.color.value).toBe("#a95f55");
  });

  it("an empty value ticks Use default and shows Discord's default grey", () => {
    const p = parts(renderColourInput("value_c", "use_default_c", ""));
    expect(p.def.checked).toBe(true);
    expect(p.color.value).toBe(DEFAULT_COLOUR_SWATCH);
  });

  it("a stored value that is not a colour gets a ticked Keep box, so it is not posted as black", () => {
    const p = parts(renderColourInput("value_c", "use_default_c", "red"));
    expect(p.keep?.name).toBe("keep_c");
    expect(p.keep?.checked).toBe(true);
    expect(p.keep?.value).toBe("true");
    expect(p.color.name).toBe("value_c");
    expect(p.def.checked).toBe(false);
    expect(p.note?.textContent).toContain("not a #RRGGBB colour");
  });

  it("locks both controls with the dependency lock", () => {
    const p = parts(
      renderColourInput("value_c", "use_default_c", "#112233", {
        disabled: true,
      }),
    );
    expect(p.color.disabled).toBe(true);
    expect(p.def.disabled).toBe(true);
  });

  it("a locked legacy colour posts one value: the round trip, not the disabled swatch", () => {
    const dom = new JSDOM(
      `<!doctype html><body><form>${renderColourInput("value_c", "use_default_c", "red", { disabled: true })}` +
        `<input type="hidden" name="value_c" value="red"></form></body>`,
    );
    const form = dom.window.document.querySelector("form") as HTMLFormElement;
    expect(new dom.window.FormData(form).getAll("value_c")).toEqual(["red"]);
    expect(
      (
        dom.window.document.querySelector(
          "[data-colour-keep]",
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  it("is a labelled control", () => {
    const d = doc(
      renderColourInput("value_c", "use_default_c", "", { id: "x" }),
    );
    expect((d.querySelector("#x") as HTMLInputElement).type).toBe("color");
    expect(d.querySelector("label.kb-colour__default")?.textContent).toContain(
      "Use default",
    );
  });
});

describe("COLOUR_INPUT_SCRIPT", () => {
  function mount(current: string, extra = ""): JSDOM {
    return boot(
      renderColourInput("value_c", "use_default_c", current) + extra,
      [COLOUR_INPUT_SCRIPT],
    );
  }
  function el<T extends HTMLElement>(dom: JSDOM, sel: string): T {
    return dom.window.document.querySelector(sel) as T;
  }
  function pick(dom: JSDOM, value: string): void {
    const c = el<HTMLInputElement>(dom, "[data-colour-input]");
    c.value = value;
    c.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }

  it("picking a colour unticks Use default, and the swatch stays pickable throughout", () => {
    const dom = mount("");
    const def = el<HTMLInputElement>(dom, "[data-colour-default]");
    expect(def.checked).toBe(true);
    expect(el<HTMLInputElement>(dom, "[data-colour-input]").disabled).toBe(
      false,
    );
    pick(dom, "#00ff00");
    expect(def.checked).toBe(false);
    pick(dom, "#ff0000");
    expect(def.checked).toBe(false);
  });

  it("picking a colour with Use default on unticks it and enables the swatch", () => {
    const dom = mount("");
    const c = el<HTMLInputElement>(dom, "[data-colour-input]");
    c.disabled = false;
    pick(dom, "#00ff00");
    expect(el<HTMLInputElement>(dom, "[data-colour-default]").checked).toBe(
      false,
    );
    expect(c.disabled).toBe(false);
  });

  it("ticking Use default leaves the swatch pickable: the tick wins at the server", () => {
    const dom = mount("#112233");
    const def = el<HTMLInputElement>(dom, "[data-colour-default]");
    def.checked = true;
    def.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(el<HTMLInputElement>(dom, "[data-colour-input]").disabled).toBe(
      false,
    );
  });

  it("a stored non-colour is kept until a colour is picked, which unticks Keep", () => {
    const dom = mount("red");
    const keep = el<HTMLInputElement>(dom, "[data-colour-keep]");
    const swatch = el<HTMLInputElement>(dom, "[data-colour-input]");
    expect(keep.checked).toBe(true);
    expect(swatch.disabled).toBe(false);
    pick(dom, "#123456");
    expect(keep.checked).toBe(false);
    expect(swatch.disabled).toBe(false);
  });

  it("Use default and Keep exclude each other", () => {
    const dom = mount("red");
    const keep = el<HTMLInputElement>(dom, "[data-colour-keep]");
    const def = el<HTMLInputElement>(dom, "[data-colour-default]");
    def.checked = true;
    def.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(keep.checked).toBe(false);
    keep.checked = true;
    keep.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(def.checked).toBe(false);
  });

  it("leaves a dependency-locked control disabled", () => {
    const dom = boot(
      renderColourInput("value_c", "use_default_c", "#112233", {
        disabled: true,
      }),
      [COLOUR_INPUT_SCRIPT],
    );
    expect(el<HTMLInputElement>(dom, "[data-colour-input]").disabled).toBe(
      true,
    );
    expect(el<HTMLInputElement>(dom, "[data-colour-default]").disabled).toBe(
      true,
    );
  });
});

describe("what the browser posts after the colour script ran", () => {
  function posted(dom: JSDOM): Record<string, string> {
    const form = dom.window.document.querySelector("form") as HTMLFormElement;
    return Object.fromEntries(
      [...new dom.window.FormData(form).entries()].map(([k, v]) => [
        k,
        String(v),
      ]),
    );
  }

  it("ticking Use default on a stored non-colour saves the default, not the old text", () => {
    const dom = boot(
      renderColourInput(
        "value_reactionroles.group_role_colour",
        "use_default_reactionroles.group_role_colour",
        "red",
      ),
      [COLOUR_INPUT_SCRIPT],
    );
    const def = dom.window.document.querySelector(
      "[data-colour-default]",
    ) as HTMLInputElement;
    def.checked = true;
    def.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const body = posted(dom);
    expect(readSettingField(body, "reactionroles.group_role_colour")).toBe("");
    expect(
      readSettingField(
        { "value_reactionroles.group_role_colour": "red" },
        "reactionroles.group_role_colour",
      ),
    ).toBe("red");
  });

  it("picking a colour on a stored non-colour replaces it and leaves Use default off", () => {
    const dom = boot(
      renderColourInput(
        "value_reactionroles.group_role_colour",
        "use_default_reactionroles.group_role_colour",
        "red",
      ),
      [COLOUR_INPUT_SCRIPT],
    );
    const swatch = dom.window.document.querySelector(
      "[data-colour-input]",
    ) as HTMLInputElement;
    swatch.value = "#123456";
    swatch.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const body = posted(dom);
    expect(readSettingField(body, "reactionroles.group_role_colour")).toBe(
      "#123456",
    );
  });

  it("Keep posts the stored value, whatever it is; Use default wins over Keep", () => {
    const key = "reactionroles.group_role_colour";
    const body = {
      [`value_${key}`]: "#99aab5",
      [`keep_${key}`]: "true",
    };
    expect(readSettingField(body, key, "red")).toBe("red");
    expect(readSettingField(body, key)).toBe("#99aab5");
    expect(
      readSettingField({ ...body, [`use_default_${key}`]: "true" }, key, "red"),
    ).toBe("");
    // Only a colour key reads the boxes.
    expect(
      readSettingField(
        { "value_events.timezone": "UTC", "keep_events.timezone": "true" },
        "events.timezone",
        "Mars/Olympus",
      ),
    ).toBe("UTC");
  });

  it("an untouched stored colour posts as it was", () => {
    const dom = boot(
      renderColourInput(
        "value_reactionroles.group_role_colour",
        "use_default_reactionroles.group_role_colour",
        "#a95f55",
      ),
      [COLOUR_INPUT_SCRIPT],
    );
    expect(
      readSettingField(posted(dom), "reactionroles.group_role_colour"),
    ).toBe("#a95f55");
  });
});

describe("renderEmojiField and the shared emoji picker", () => {
  function mount(value: string): JSDOM {
    return boot(
      renderEmojiField("value_p", value, { label: "Channel prefix", id: "p" }),
      [groupRowsScript()],
    );
  }

  it("keeps the text box, so a value like a prefix with a separator can be typed", () => {
    const d = doc(
      renderEmojiField("value_p", "🎮 | ", { label: "Channel prefix" }),
    );
    const input = d.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.value).toBe("🎮 | ");
    expect(input.name).toBe("value_p");
    expect(d.querySelector("[data-marker-btn]")?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(d.querySelector("[role=group]")?.getAttribute("aria-label")).toBe(
      "Channel prefix",
    );
  });

  it("with the script, shows the button and leaves the text box visible", () => {
    const dom = mount("[Voice] ");
    const btn = dom.window.document.querySelector(
      "[data-marker-btn]",
    ) as HTMLButtonElement;
    const input = dom.window.document.querySelector(
      "[data-marker-input]",
    ) as HTMLInputElement;
    expect(btn.hidden).toBe(false);
    expect(input.hidden).toBe(false);
    expect(btn.getAttribute("aria-label")).toBe(
      "Choose an emoji for Channel prefix (now [Voice])",
    );
    // The stored text is untouched by enhancing.
    expect(input.value).toBe("[Voice] ");
  });

  it("opens the grid in emoji words, lists the defaults, and a pick replaces the value", () => {
    const dom = mount("[Voice] ");
    const d = dom.window.document;
    (d.querySelector("[data-marker-btn]") as HTMLButtonElement).click();
    const pop = d.querySelector(".kb-emoji-pop") as HTMLElement;
    expect(pop.hidden).toBe(false);
    expect(pop.getAttribute("aria-label")).toBe("Choose an emoji");
    expect(
      pop.querySelector("[data-emoji-search]")?.getAttribute("aria-label"),
    ).toBe("Search emoji");
    const offered = [...pop.querySelectorAll(".kb-emoji-grid button")].map(
      (b) => b.getAttribute("data-emoji"),
    );
    // The defaults of the three keys are in the grid.
    for (const emoji of ["🎮", "📅", "✨"]) expect(offered).toContain(emoji);
    (pop.querySelector('button[data-emoji="🎮"]') as HTMLButtonElement).click();
    const input = d.querySelector("[data-marker-input]") as HTMLInputElement;
    expect(input.value).toBe("🎮");
    expect(pop.hidden).toBe(true);
    // No emoji clears it.
    (d.querySelector("[data-marker-btn]") as HTMLButtonElement).click();
    expect(pop.querySelector('button[data-emoji=""]')?.textContent).toBe(
      "No emoji",
    );
    (pop.querySelector('button[data-emoji=""]') as HTMLButtonElement).click();
    expect(input.value).toBe("");
  });

  it("the picker's list only holds values the server accepts", () => {
    for (const { emoji } of pickableMarkers()) {
      expect(Array.from(emoji).length).toBeLessThanOrEqual(
        CHANNEL_AFFIX_MAX_CHARS,
      );
    }
  });

  it("loading the script twice does not enhance a field twice", () => {
    const dom = mount("🎮");
    dom.window.eval(groupRowsScript());
    const d = dom.window.document;
    (d.querySelector("[data-marker-btn]") as HTMLButtonElement).click();
    expect(d.querySelectorAll(".kb-emoji-pop")).toHaveLength(1);
    expect((d.querySelector(".kb-emoji-pop") as HTMLElement).hidden).toBe(
      false,
    );
  });
});

describe("the settings page", () => {
  function row(
    key: keyof typeof settingsMetadata,
    current: string,
  ): SettingRow {
    const meta = settingsMetadata[key];
    return {
      key,
      label: meta.label,
      current,
      defaultValue: "",
      type: "string",
      description: meta.description,
      category: meta.category,
      format: meta.format,
    };
  }
  function page(rows: SettingRow[]): string {
    return renderSettingsPage({
      csrfToken: "t",
      remainingMs: 600000,
      textChannels: [],
      voiceChannels: [],
      categoryChannels: [],
      roles: [],
      guildId: "111111111111111111",
      guildName: "G",
      groups: [{ category: "events", rows }],
    });
  }

  it("renders each picker key with its picker and its own label", () => {
    const d = doc(
      page([
        row("events.timezone", "Mars/Olympus"),
        row("events.channel_prefix", "📅"),
        row("reactionroles.group_role_colour", "#a95f55"),
        row("voicechannels.channel.prefix", "🎮"),
        row("voicechannels.channel.suffix", ""),
      ]),
    );
    const tz = d.querySelector(
      'select[name="value_events.timezone"]',
    ) as HTMLSelectElement;
    expect(tz.id).toBe("set-events.timezone");
    expect(tz.value).toBe("Mars/Olympus");
    expect(
      (
        d.querySelector(
          'input[type="color"][name="value_reactionroles.group_role_colour"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("#a95f55");
    expect(d.querySelectorAll("[data-emoji-field]")).toHaveLength(3);
    for (const key of [
      "events.channel_prefix",
      "voicechannels.channel.prefix",
      "voicechannels.channel.suffix",
    ]) {
      expect(d.querySelector(`input[name="value_${key}"]`)).not.toBeNull();
    }
  });

  it("sends each picker script once, only on a page that has the control", () => {
    const all = page([
      row("events.timezone", ""),
      row("reactionroles.group_role_colour", ""),
      row("voicechannels.channel.prefix", "🎮"),
    ]);
    expect(all.match(/koolGroupRows=/g)).toHaveLength(1);
    expect(all).toContain("data-tz-search");
    expect(all).toContain("data-colour-default");
    const plain = page([row("events.channel_prefix", "📅")]);
    expect(plain.match(/koolGroupRows=/g)).toHaveLength(1);
    expect(plain).not.toContain("data-tz-search");
    expect(plain).not.toContain("data-colour-default");
    const none = page([
      {
        key: "quotes.max_length",
        label: "n",
        current: 5,
        defaultValue: 5,
        type: "number",
        description: "",
        category: "quotes",
        min: 1,
        max: 9,
      },
    ]);
    expect(none).not.toContain("koolGroupRows=");
  });
});

describe("the event forms", () => {
  const props = {
    csrfToken: "t",
    timezone: "Europe/Oslo",
    defaultDurationMinutes: 60,
    groupLimits: { defaultCount: 2, maxCount: 8 },
  };

  it("the new event form offers the searchable select with its default first", () => {
    const d = doc(renderNewEventBody(props as never));
    const sel = d.querySelector("#new-event-timezone") as HTMLSelectElement;
    expect(sel.name).toBe("timezone");
    expect(sel.options[0].value).toBe("Europe/Oslo");
    expect(sel.value).toBe("Europe/Oslo");
    expect([...sel.options].filter((o) => o.value === "UTC")).toHaveLength(1);
    expect(d.querySelector("[data-tz-search]")).not.toBeNull();
    expect(d.querySelector('label[for="new-event-timezone"]')).not.toBeNull();
  });

  it("the edit form keeps the event's own zone, even one the runtime does not list", () => {
    const html = renderEventEditBody({
      event: {
        id: "e1",
        title: "T",
        description: "",
        durationMinutes: 60,
        timezone: "Mars/Olympus",
        date: "2030-01-01",
        time: "18:00",
        when: "x",
        version: "1",
        mode: "full",
      },
      csrfToken: "t",
    });
    const d = doc(html);
    const sel = d.querySelector("#edit-timezone") as HTMLSelectElement;
    expect(sel.tagName).toBe("SELECT");
    expect(sel.value).toBe("Mars/Olympus");
    expect(sel.options[0].textContent).toBe("Current (Mars/Olympus)");
  });
});

describe("the accessibility fixtures (#1426)", () => {
  const pages = allPages();
  const html = (name: string): string => {
    const page = pages.find((p) => p.name === name);
    if (!page) throw new Error(`no fixture named ${name}`);
    return page.html;
  };

  it("scan every page that now shows a picker, with the picker in it", () => {
    const withPickers: Array<[string, string[]]> = [
      [
        "Settings (timezone select, colour input, emoji fields)",
        ["data-tz-search", "data-colour-default", "data-emoji-field"],
      ],
      [
        "Settings (pickers holding values they cannot produce, rejected)",
        ["(custom)", "data-colour-keep", "data-emoji-field"],
      ],
      [
        "Setup wizard step (timezone and emoji settings)",
        ["data-tz-search", "data-emoji-field"],
      ],
      ["Events", ["data-tz-search"]],
      ["Voice channels", ["data-emoji-field"]],
      ["/me new event", ["data-tz-search"]],
      ["/me edit event (not started)", ["data-tz-search"]],
    ];
    for (const [name, markers] of withPickers) {
      for (const marker of markers) expect(html(name)).toContain(marker);
    }
  });
});
