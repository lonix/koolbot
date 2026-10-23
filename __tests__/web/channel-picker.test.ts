/* global HTMLSelectElement, HTMLElement, HTMLInputElement, HTMLButtonElement, HTMLFormElement, KeyboardEventInit */
/**
 * The searchable channel, category and role picker (#1394): the server markup
 * (a plain select that works without JavaScript) and `CHANNEL_PICKER_SCRIPT`
 * run in jsdom together with the save bar.
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
  {
    id: "1",
    name: "general",
    type: ChannelType.GuildText,
    parentName: "Chat",
  },
  {
    id: "2",
    name: "news",
    type: ChannelType.GuildAnnouncement,
    parentName: null,
  },
];
const VOICE: ChannelOption[] = [
  {
    id: "3",
    name: "Lobby",
    type: ChannelType.GuildVoice,
    parentName: "Scratch",
  },
  {
    id: "4",
    name: "Stage",
    type: ChannelType.GuildStageVoice,
    parentName: "Scratch",
  },
];

/** The select the Settings page renders for a `channel` setting spanning text and voice. */
function selectHtml(current: string, options = [...TEXT, ...VOICE]): string {
  const html = renderSettingsPage({
    csrfToken: "t",
    guildName: "G",
    flash: null,
    groups: [
      {
        category: "events",
        rows: [
          {
            key: "events.announce_channel_id",
            label: "Announce channel",
            current,
            defaultValue: "",
            type: "channel",
            description: "Where it goes.",
            category: "events",
          },
        ],
      },
    ],
    textChannels: options.filter((o) => o.type === ChannelType.GuildText),
    voiceChannels: [],
    categoryChannels: [],
    roles: [],
  } as unknown as Parameters<typeof renderSettingsPage>[0]);
  const m = html.match(
    /<span class="kb-picker" data-picker [^>]*>[\s\S]*?<\/select><\/span>/,
  );
  if (!m) throw new Error("no picker in page");
  return m[0];
}

function mount(inner: string): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><body><form><label for="f">Channel</label>${inner.replace("<select ", '<select id="f" ')}${renderSaveBar("Save")}</form></body>`,
    { runScripts: "outside-only" },
  );
  dom.window.eval(CHANNEL_PICKER_SCRIPT);
  dom.window.eval(SAVEBAR_SCRIPT);
  return dom;
}

/** A hand-built picker with every kind, so the filters have something to find. */
function mixed(roleName = "Mods"): string {
  const meta = [
    null,
    ["text", "general", "Chat"],
    ["announcement", "news", ""],
    ["voice", "Lobby", "Scratch"],
    ["category", "Events", ""],
    ["role", roleName, ""],
    ["missing", "77", ""],
  ];
  const attr = JSON.stringify(meta)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  return `<span class="kb-picker" data-picker data-picker-meta="${attr}"><select class="kb-select" name="v">
<option value="">(none)</option>
<optgroup label="Text channels"><option value="1">x</option><option value="2">x</option></optgroup>
<optgroup label="Voice channels"><option value="3">x</option></optgroup>
<optgroup label="Categories"><option value="5">x</option></optgroup>
<optgroup label="Roles"><option value="9">x</option></optgroup>
<option value="77" selected>⚠ 77 (unavailable)</option>
</select></span>`;
}
const MIXED = mixed();

function $<T extends HTMLElement>(dom: JSDOM, sel: string): T {
  return dom.window.document.querySelector(sel) as T;
}
function key(dom: JSDOM, el: HTMLElement, k: string): void {
  el.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
    } as KeyboardEventInit),
  );
}
function type(dom: JSDOM, text: string): void {
  const i = $<HTMLInputElement>(dom, ".kb-picker__search input");
  i.value = text;
  i.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}
function visibleRows(dom: JSDOM): string[] {
  return [
    ...dom.window.document.querySelectorAll<HTMLElement>(".kb-picker__opt"),
  ]
    .filter((r) => !r.hidden)
    .map((r) => r.id.split("-").pop() ?? "");
}
function posted(dom: JSDOM): string {
  return String(
    new dom.window.FormData($<HTMLFormElement>(dom, "form")).get("v") ?? "",
  );
}

describe("server markup (no JavaScript)", () => {
  it("is a plain select with the same name and options inside span.kb-picker", () => {
    const html = selectHtml("1");
    expect(html).toContain(
      '<span class="kb-picker" data-picker data-picker-meta=',
    );
    expect(html).toContain('<select class="kb-select"');
    expect(html).toContain('name="value_events.announce_channel_id"');
    expect(html).toContain(
      '<option value="1" selected># general · CHAT</option>',
    );
    const meta = JSON.parse(
      (html.match(/data-picker-meta="([^"]*)"/) as RegExpMatchArray)[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&"),
    );
    // One entry per option in markup order: (none), then the Text channels group.
    expect(meta[0]).toBeNull();
    expect(meta[1]).toEqual(["text", "general", "Chat"]);
    expect(html).toContain("<optgroup");
    expect(html).not.toContain("hidden");
  });

  it("keeps a stored id that is not listed as a selected option", () => {
    const html = selectHtml("999");
    expect(html).toContain(
      '<option value="999" selected>⚠ 999 (unavailable)</option>',
    );
    expect(html).toContain(
      "[null,[&quot;text&quot;,&quot;general&quot;,&quot;Chat&quot;]",
    );
    expect(html).toContain(
      "[&quot;missing&quot;,&quot;999&quot;,&quot;&quot;]]",
    );
  });
});

describe("script", () => {
  it("shows the current value on a trigger and hides the select without [hidden]", () => {
    const dom = mount(MIXED);
    const trig = $<HTMLButtonElement>(dom, ".kb-picker__trigger");
    expect(trig.textContent).toContain("77 (unavailable)");
    const sel = $<HTMLSelectElement>(dom, "select");
    expect(sel.hidden).toBe(false);
    expect(sel.closest("[hidden]")).toBeNull();
    expect(sel.classList.contains("kb-visually-hidden")).toBe(true);
    expect($(dom, ".kb-picker__pop").hidden).toBe(true);
    expect(trig.getAttribute("aria-expanded")).toBe("false");
    expect(trig.getAttribute("aria-labelledby")).toContain(trig.id);
  });

  it("lists a group header per optgroup, the icon, category and a check", () => {
    const dom = mount(MIXED);
    const heads = [
      ...dom.window.document.querySelectorAll(".kb-picker__group"),
    ].map((h) => h.textContent);
    expect(heads).toEqual([
      "Text channels",
      "Voice channels",
      "Categories",
      "Roles",
    ]);
    const lobby = $(dom, "#kb-picker-1-list-3");
    expect(lobby.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Voice channel",
    );
    expect(lobby.querySelector(".kb-picker__cat")?.textContent).toBe("Scratch");
    expect($(dom, "#kb-picker-1-list-4 .kb-mention--category")).not.toBeNull();
    expect($(dom, "#kb-picker-1-list-6").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect($(dom, "#kb-picker-1-list-6 svg[data-check]")).not.toBeNull();
  });

  it("filters with #, #! and @ and by name or category, never disabling an option", () => {
    const dom = mount(MIXED);
    $<HTMLButtonElement>(dom, ".kb-picker__trigger").click();
    type(dom, "#");
    expect(visibleRows(dom)).toEqual(["1", "2"]);
    type(dom, "#!");
    expect(visibleRows(dom)).toEqual(["3"]);
    type(dom, "@");
    expect(visibleRows(dom)).toEqual(["5"]);
    type(dom, "@mo");
    expect(visibleRows(dom)).toEqual(["5"]);
    type(dom, "scratch");
    expect(visibleRows(dom)).toEqual(["3"]);
    type(dom, "#gen");
    expect(visibleRows(dom)).toEqual(["1"]);
    type(dom, "zzz");
    expect(visibleRows(dom)).toEqual([]);
    expect($(dom, '[role="status"]').textContent).toBe("No matches");
    expect(
      [...dom.window.document.querySelectorAll("select option")].some(
        (o) => (o as HTMLElement & { disabled: boolean }).disabled,
      ),
    ).toBe(false);
    // The group header of a group with no match is hidden too.
    type(dom, "#!");
    const shown = [
      ...dom.window.document.querySelectorAll<HTMLElement>(".kb-picker__group"),
    ]
      .filter((h) => !h.hidden)
      .map((h) => h.textContent);
    expect(shown).toEqual(["Voice channels"]);
  });

  it("chooses with the keyboard: arrows, aria-activedescendant, Enter, Escape", () => {
    const dom = mount(MIXED);
    const trig = $<HTMLButtonElement>(dom, ".kb-picker__trigger");
    const inp = $<HTMLInputElement>(dom, ".kb-picker__search input");
    key(dom, trig, "ArrowDown");
    expect($(dom, ".kb-picker__pop").hidden).toBe(false);
    expect(trig.getAttribute("aria-expanded")).toBe("true");
    expect(dom.window.document.activeElement).toBe(inp);
    // Opens on the selected (missing) row.
    expect(inp.getAttribute("aria-activedescendant")).toBe(
      "kb-picker-1-list-6",
    );
    key(dom, inp, "Home");
    expect(inp.getAttribute("aria-activedescendant")).toBe(
      "kb-picker-1-list-0",
    );
    key(dom, inp, "ArrowDown");
    key(dom, inp, "ArrowDown");
    expect(inp.getAttribute("aria-activedescendant")).toBe(
      "kb-picker-1-list-2",
    );
    expect($(dom, "#kb-picker-1-list-2").classList.contains("is-active")).toBe(
      true,
    );
    key(dom, inp, "Enter");
    expect(posted(dom)).toBe("2");
    expect($(dom, ".kb-picker__pop").hidden).toBe(true);
    expect(dom.window.document.activeElement).toBe(trig);
    expect(trig.textContent).toContain("news");

    key(dom, trig, "ArrowUp");
    key(dom, inp, "Escape");
    expect($(dom, ".kb-picker__pop").hidden).toBe(true);
    expect(posted(dom)).toBe("2");
    expect(dom.window.document.activeElement).toBe(trig);
  });

  it("Enter in the search box never submits the form", () => {
    const dom = mount(MIXED);
    let submitted = false;
    $<HTMLFormElement>(dom, "form").addEventListener("submit", () => {
      submitted = true;
    });
    $<HTMLButtonElement>(dom, ".kb-picker__trigger").click();
    const ev = new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    $<HTMLInputElement>(dom, ".kb-picker__search input").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(submitted).toBe(false);
  });

  it("a click chooses a row, and the save bar counts it and Discard restores it", () => {
    const dom = mount(MIXED);
    const bar = $(dom, ".kb-savebar");
    $<HTMLButtonElement>(dom, ".kb-picker__trigger").click();
    $<HTMLElement>(dom, "#kb-picker-1-list-3").click();
    expect(posted(dom)).toBe("3");
    expect($(dom, ".kb-picker__trigger").textContent).toContain("Lobby");
    expect(bar.hidden).toBe(false);
    $<HTMLElement>(dom, "[data-savebar-discard]").click();
    expect(posted(dom)).toBe("77");
    expect($(dom, ".kb-picker__trigger").textContent).toContain(
      "77 (unavailable)",
    );
  });

  it("an untouched stored id that is not listed still posts exactly as stored", () => {
    const dom = mount(MIXED);
    $<HTMLButtonElement>(dom, ".kb-picker__trigger").click();
    type(dom, "zzz");
    key(dom, $(dom, ".kb-picker__search input"), "Escape");
    expect(posted(dom)).toBe("77");
  });

  it("a disabled select gives a disabled trigger that does not open", () => {
    const dom = mount(MIXED.replace("<select ", "<select disabled "));
    const trig = $<HTMLButtonElement>(dom, ".kb-picker__trigger");
    expect(trig.disabled).toBe(true);
    key(dom, trig, "ArrowDown");
    expect($(dom, ".kb-picker__pop").hidden).toBe(true);
  });

  it("sets option text as text, never as markup", () => {
    const dom = mount(mixed("<img src=x onerror=alert(1)>"));
    expect(dom.window.document.querySelector(".kb-picker img")).toBeNull();
    expect($(dom, "#kb-picker-1-list-5").textContent).toContain("<img");
  });
});
