/* global HTMLSelectElement, HTMLElement, HTMLInputElement, HTMLButtonElement, HTMLFormElement, KeyboardEventInit */
/**
 * The Picker's create row (#1658, a proposal): "Create new <kind>: '<typed>'"
 * for channels, categories and roles. Server markup, the posted value and the
 * script in jsdom together with the save bar.
 */
import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import { JSDOM } from "jsdom";
import {
  CHANNEL_PICKER_CREATE_SCRIPT,
  CHANNEL_PICKER_SCRIPT,
  PICKER_CREATE_PREFIX,
  parsePickerCreateValue,
  pickerCreateValue,
  pickerMetaAttr,
  type PickerCreate,
} from "../../src/web/setting-pickers.js";
import { channelKindIcons } from "../../src/web/discord-labels.js";
import { renderSaveBar, SAVEBAR_SCRIPT } from "../../src/web/savebar.js";
import {
  renderRolePicker,
  renderRoleSelectPicker,
  renderSettingsPage,
  type ChannelOption,
  type SettingRow,
} from "../../src/web/admin-views.js";

const TEXT: ChannelOption[] = [
  { id: "1", name: "general", type: ChannelType.GuildText, parentName: "Chat" },
  {
    id: "2",
    name: "News",
    type: ChannelType.GuildAnnouncement,
    parentName: null,
  },
];
const ROLES = [
  { id: "9", name: "Mods" },
  { id: "10", name: "Admins" },
];
const CATS: ChannelOption[] = [
  {
    id: "20",
    name: "Events",
    type: ChannelType.GuildCategory,
    parentName: null,
  },
];

function row(type: string, current = ""): SettingRow {
  return {
    key: "x.y",
    label: "Thing",
    current,
    defaultValue: "",
    type,
    description: "d",
    category: "x",
  } as unknown as SettingRow;
}

function page(
  type: string,
  current: string,
  create?: (r: SettingRow) => PickerCreate | undefined,
): string {
  const html = renderSettingsPage({
    csrfToken: "t",
    guildName: "G",
    flash: null,
    groups: [{ category: "x", rows: [row(type, current)] }],
    textChannels: TEXT,
    voiceChannels: [],
    categoryChannels: CATS,
    roles: ROLES,
    ...(create ? { pickerCreate: create } : {}),
  } as unknown as Parameters<typeof renderSettingsPage>[0]);
  const m = html.match(
    /<span class="kb-picker" data-picker [^>]*>[\s\S]*?<\/select><\/span>/,
  );
  if (!m) throw new Error("no picker");
  return m[0];
}

function mount(inner: string): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><body><form><label for="f">Thing</label>${inner.replace(/<select /, '<select id="f" ')}${renderSaveBar("Save")}</form></body>`,
    { runScripts: "outside-only" },
  );
  dom.window.eval(
    inner.includes('data-picker-meta="{')
      ? CHANNEL_PICKER_CREATE_SCRIPT
      : CHANNEL_PICKER_SCRIPT,
  );
  dom.window.eval(SAVEBAR_SCRIPT);
  return dom;
}

const ok = (kind: PickerCreate["kind"]): PickerCreate => ({ kind, ok: true });

function $<T extends HTMLElement>(dom: JSDOM, s: string): T {
  return dom.window.document.querySelector(s) as T;
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
function open(dom: JSDOM): HTMLInputElement {
  $<HTMLButtonElement>(dom, ".kb-picker__trigger").click();
  return $<HTMLInputElement>(dom, ".kb-picker__search input");
}
const createRow = (dom: JSDOM): HTMLElement =>
  $<HTMLElement>(dom, "[data-create].kb-picker__opt");
function posted(dom: JSDOM, name = "value_x.y"): string[] {
  return new dom.window.FormData($<HTMLFormElement>(dom, "form"))
    .getAll(name)
    .map(String);
}
const live = (dom: JSDOM): string =>
  $(dom, ".kb-picker > .kb-visually-hidden[role=status]").textContent ?? "";

describe("server markup", () => {
  it("is byte-identical to today when the caller passes no flag", () => {
    const plain = page("channel", "1");
    expect(plain).toBe(page("channel", "1", () => undefined));
    expect(plain).toContain('data-picker-meta="[null,[&quot;text&quot;');
    expect(plain).not.toContain("create");
  });

  it("carries the flag in data-picker-meta, beside the same items", () => {
    const html = page("category", "20", () => ({
      kind: "category",
      ok: false,
      reason: "The bot needs Manage Channels.",
    }));
    const meta = JSON.parse(
      (html.match(/data-picker-meta="([^"]*)"/) as RegExpMatchArray)[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&"),
    );
    expect(meta.create).toEqual({
      kind: "category",
      ok: false,
      reason: "The bot needs Manage Channels.",
    });
    expect(meta.items[1]).toEqual(["category", "Events", ""]);
    expect(html).toContain("<select");
    expect(html).not.toContain("will be created");
  });

  it("does not offer the row on a channel list unless the key is a role list", () => {
    const list = page("channel_list", "1", () => ok("channel"));
    expect(list).toBe(page("channel_list", "1"));
  });

  it("the role helpers take the flag too, and are unchanged without it", () => {
    const base = { id: "r", name: "n", options: ROLES };
    expect(renderRolePicker({ ...base, selected: [] })).not.toContain("create");
    expect(
      renderRolePicker({ ...base, selected: [], create: ok("role") }),
    ).toContain("&quot;create&quot;:{&quot;kind&quot;:&quot;role&quot;");
    expect(
      renderRoleSelectPicker({
        ...base,
        selected: "",
        emptyLabel: "None",
        create: ok("role"),
      }),
    ).toContain("&quot;kind&quot;:&quot;role&quot;");
  });

  it("pickerMetaAttr escapes", () => {
    expect(pickerMetaAttr([["text", 'a"b', ""]])).toBe(
      "[[&quot;text&quot;,&quot;a\\&quot;b&quot;,&quot;&quot;]]",
    );
  });
});

describe("posted value", () => {
  it("round trips and is never a stored id", () => {
    expect(pickerCreateValue("Mods 2")).toBe(`${PICKER_CREATE_PREFIX}Mods 2`);
    expect(parsePickerCreateValue(pickerCreateValue("  Mods 2 "))).toEqual({
      ok: true,
      name: "Mods 2",
    });
    expect(parsePickerCreateValue("123456789012345678")).toBeNull();
    expect(parsePickerCreateValue("")).toBeNull();
  });
  it("refuses blank and over-long names like the browser does", () => {
    expect(parsePickerCreateValue("create:   ")).toEqual({
      ok: false,
      error: "The name cannot be blank.",
    });
    expect(parsePickerCreateValue("create:" + "a".repeat(100))?.ok).toBe(true);
    expect(parsePickerCreateValue("create:" + "a".repeat(101))?.ok).toBe(false);
  });
});

describe("single select: states", () => {
  const html = page("channel", "1", () => ok("channel"));

  it("idle: no create row, nothing added to the select", () => {
    const dom = mount(html);
    open(dom);
    expect(createRow(dom).hidden).toBe(true);
    expect($<HTMLSelectElement>(dom, "select").options.length).toBe(3);
  });

  it("typed text with no match offers the row as the last row, and Enter chooses it", () => {
    const dom = mount(html);
    const inp = open(dom);
    type(dom, "  Support ");
    const r = createRow(dom);
    expect(r.hidden).toBe(false);
    expect(r.textContent).toBe("Create new channel: 'Support'");
    expect(r.getAttribute("role")).toBe("option");
    expect(r.parentElement?.lastElementChild).toBe(r);
    // With no other row matching, it is the active one.
    expect(inp.getAttribute("aria-activedescendant")).toBe(r.id);
    key(dom, inp, "Enter");
    const sel = $<HTMLSelectElement>(dom, "select");
    expect(sel.value).toBe("create:Support");
    expect(posted(dom)).toEqual(["create:Support"]);
    expect($<HTMLElement>(dom, ".kb-picker__pop").hidden).toBe(true);
    const trig = $(dom, ".kb-picker__trigger");
    expect(trig.textContent).toContain("Support");
    expect(trig.textContent).toContain("(will be created)");
    expect(live(dom)).toBe(
      "Will be created: channel 'Support'. Choose another row to undo.",
    );
  });

  it("partial matches stay above it, arrows reach it, Enter on a match selects the match", () => {
    const dom = mount(html);
    const inp = open(dom);
    type(dom, "gen");
    expect(createRow(dom).hidden).toBe(false);
    key(dom, inp, "ArrowDown");
    expect(inp.getAttribute("aria-activedescendant")).toBe(createRow(dom).id);
    key(dom, inp, "ArrowUp");
    key(dom, inp, "Enter");
    expect($<HTMLSelectElement>(dom, "select").value).toBe("1");
  });

  it("a name that matches an existing one (any case) selects it and offers no row", () => {
    const dom = mount(html);
    const inp = open(dom);
    type(dom, "NEWS");
    expect(createRow(dom).hidden).toBe(true);
    key(dom, inp, "Enter");
    expect($<HTMLSelectElement>(dom, "select").value).toBe("2");
    expect(
      $<HTMLSelectElement>(dom, "select").querySelector("[data-create]"),
    ).toBeNull();
  });

  it("a stored id is not overwritten: choosing another row undoes it and the pending option goes", () => {
    const dom = mount(html);
    let inp = open(dom);
    type(dom, "Support");
    key(dom, inp, "Enter");
    const sel = $<HTMLSelectElement>(dom, "select");
    expect(sel.options.length).toBe(4);
    inp = open(dom);
    type(dom, "general");
    key(dom, inp, "Enter");
    expect(sel.value).toBe("1");
    // The pending option stays (the save bar remembers options by index) but is not selected, so not posted.
    expect(sel.options.length).toBe(4);
    expect(posted(dom)).toEqual(["1"]);
    expect(live(dom)).toContain("Removed: new channel 'Support'");
    expect($(dom, ".kb-picker__trigger").textContent).not.toContain(
      "will be created",
    );
  });

  it("only one pending name at a time in a single select", () => {
    const dom = mount(html);
    for (const n of ["A", "B"]) {
      const inp = open(dom);
      type(dom, n);
      key(dom, inp, "Enter");
    }
    const sel = $<HTMLSelectElement>(dom, "select");
    expect(
      [...sel.options].filter((o) => o.hasAttribute("data-create")).length,
    ).toBe(1);
    expect(sel.value).toBe("create:B");
  });

  it("the save bar sees the pending choice as a change and Discard restores the stored id", () => {
    const dom = mount(html);
    const inp = open(dom);
    type(dom, "Support");
    key(dom, inp, "Enter");
    const bar = $<HTMLElement>(dom, ".kb-savebar");
    expect(bar.hidden).toBe(false);
    $<HTMLButtonElement>(dom, "[data-savebar-discard]").click();
    expect($<HTMLSelectElement>(dom, "select").value).toBe("1");
    expect($(dom, ".kb-picker__trigger").textContent).not.toContain(
      "will be created",
    );
    expect(posted(dom)).toEqual(["1"]);
  });

  it("blank text and a name over 100 characters offer nothing; the long one says why", () => {
    const dom = mount(html);
    open(dom);
    type(dom, "   ");
    expect(createRow(dom).hidden).toBe(true);
    type(dom, "a".repeat(101));
    expect(createRow(dom).hidden).toBe(true);
    expect(
      $(dom, ".kb-picker__pop .kb-picker__hint[role=status]").textContent,
    ).toBe("No matches. Names can be up to 100 characters.");
    type(dom, "a".repeat(100));
    expect(createRow(dom).hidden).toBe(false);
  });

  it("a filter prefix is not part of the name; a prefix for another kind offers nothing", () => {
    const dom = mount(html);
    open(dom);
    type(dom, "#Chat room");
    expect(createRow(dom).textContent).toBe("Create new channel: 'Chat room'");
    type(dom, "@Chat");
    expect(createRow(dom).hidden).toBe(true);
    type(dom, "#!Chat");
    expect(createRow(dom).hidden).toBe(true);
  });

  it("Escape closes without creating", () => {
    const dom = mount(html);
    const inp = open(dom);
    type(dom, "Support");
    key(dom, inp, "Escape");
    expect($<HTMLElement>(dom, ".kb-picker__pop").hidden).toBe(true);
    expect($<HTMLSelectElement>(dom, "select").value).toBe("1");
  });

  it("a click on the row chooses it; the text is set as text, never markup", () => {
    const dom = mount(html);
    open(dom);
    type(dom, "<b>x</b>");
    expect(createRow(dom).querySelector("b")).toBeNull();
    createRow(dom).click();
    expect($<HTMLSelectElement>(dom, "select").value).toBe("create:<b>x</b>");
    expect($(dom, ".kb-picker__trigger").querySelector("b")).toBeNull();
  });

  it("when creation cannot work the caller's reason shows instead of the row", () => {
    const dom = mount(
      page("channel", "1", () => ({
        kind: "channel",
        ok: false,
        reason: "The bot needs Manage Channels.",
      })),
    );
    open(dom);
    type(dom, "Support");
    expect(createRow(dom).hidden).toBe(true);
    expect(
      $(dom, ".kb-picker__pop .kb-picker__hint[role=status]").textContent,
    ).toBe("No matches. The bot needs Manage Channels.");
  });

  it("the server flag is not read from an array meta: a page without it behaves as today", () => {
    const dom = mount(page("channel", "1"));
    open(dom);
    type(dom, "Support");
    expect(dom.window.document.querySelector("[data-create]")).toBeNull();
  });
});

describe("kinds", () => {
  it("a category matches against categories only and shows an uppercase mention", () => {
    const dom = mount(page("category", "20", () => ok("category")));
    const inp = open(dom);
    type(dom, "events");
    expect(createRow(dom).hidden).toBe(true);
    type(dom, "Staff");
    expect(createRow(dom).textContent).toBe("Create new category: 'Staff'");
    key(dom, inp, "Enter");
    expect($(dom, ".kb-picker__trigger .kb-mention--category")).not.toBeNull();
  });

  it("a channel may reuse a category's name; a role shows as @name", () => {
    let dom = mount(page("channel", "1", () => ok("channel")));
    open(dom);
    type(dom, "events");
    expect(createRow(dom).hidden).toBe(false);
    dom = mount(page("role", "9", () => ok("role")));
    const inp = open(dom);
    type(dom, "mods");
    expect(createRow(dom).hidden).toBe(true);
    type(dom, "Helpers");
    expect(createRow(dom).textContent).toBe("Create new role: 'Helpers'");
    key(dom, inp, "Enter");
    expect($(dom, ".kb-picker__trigger .kb-mention").textContent).toBe(
      "@Helpers",
    );
  });
});

describe("multi-select (a role list)", () => {
  const multi = (): JSDOM =>
    mount(
      renderRolePicker({
        id: "f",
        name: "value_x.y",
        options: ROLES,
        selected: ["9"],
        create: ok("role"),
      }).replace(' id="f"', ""),
    );

  it("adds a pending chip, stays open, and posts it beside the ids", () => {
    const dom = multi();
    const inp = open(dom);
    type(dom, "Helpers");
    key(dom, inp, "Enter");
    expect($<HTMLElement>(dom, ".kb-picker__pop").hidden).toBe(false);
    expect(inp.value).toBe("");
    const chips = [...dom.window.document.querySelectorAll(".kb-picker__chip")];
    expect(chips.map((c) => c.textContent)).toEqual([
      "@Mods",
      "@Helpers (will be created)",
    ]);
    expect(posted(dom)).toEqual(["9", "create:Helpers"]);
    expect(chips[1].querySelector("button")?.getAttribute("aria-label")).toBe(
      "Remove @Helpers (will be created)",
    );
  });

  it("does not offer a name already pending or existing", () => {
    const dom = multi();
    const inp = open(dom);
    type(dom, "Helpers");
    key(dom, inp, "Enter");
    type(dom, "helpers");
    expect(createRow(dom).hidden).toBe(true);
    type(dom, "mods");
    expect(createRow(dom).hidden).toBe(true);
  });

  it("Backspace on empty search and the chip's remove button take a pending chip away", () => {
    const dom = multi();
    const inp = open(dom);
    for (const n of ["A1", "B1"]) {
      type(dom, n);
      key(dom, inp, "Enter");
    }
    key(dom, inp, "Backspace");
    expect(posted(dom)).toEqual(["9", "create:A1"]);
    expect(live(dom)).toBe("Removed: new role 'A1'".replace("A1", "B1"));
    $<HTMLButtonElement>(
      dom,
      ".kb-picker__chip-remove[aria-label*='A1']",
    ).click();
    expect(posted(dom)).toEqual(["9"]);
    expect(live(dom)).toBe("Removed: new role 'A1'");
    expect(
      dom.window.document
        .querySelector("[data-create].kb-picker__opt")
        ?.hasAttribute("hidden"),
    ).toBe(true);
  });

  it("Discard drops the pending chips", () => {
    const dom = multi();
    const inp = open(dom);
    type(dom, "Helpers");
    key(dom, inp, "Enter");
    $<HTMLButtonElement>(dom, "[data-savebar-discard]").click();
    expect(posted(dom)).toEqual(["9"]);
    expect(
      dom.window.document.querySelectorAll(".kb-picker__chip").length,
    ).toBe(1);
  });
});

describe("script variants", () => {
  it("the plain script holds no create code", () => {
    for (const t of ["data-create", "will be created", "PFX", "pendOpts"]) {
      expect(CHANNEL_PICKER_SCRIPT).not.toContain(t);
      expect(CHANNEL_PICKER_CREATE_SCRIPT).toContain(t);
    }
  });
  it("the layout sends the create script only with a flagged picker", () => {
    const flagged = renderSettingsPage({
      csrfToken: "t",
      guildName: "G",
      flash: null,
      groups: [{ category: "x", rows: [row("channel", "1")] }],
      textChannels: TEXT,
      voiceChannels: [],
      categoryChannels: [],
      roles: [],
      pickerCreate: () => ({ kind: "channel", ok: true }),
    } as unknown as Parameters<typeof renderSettingsPage>[0]);
    const plain = renderSettingsPage({
      csrfToken: "t",
      guildName: "G",
      flash: null,
      groups: [{ category: "x", rows: [row("channel", "1")] }],
      textChannels: TEXT,
      voiceChannels: [],
      categoryChannels: [],
      roles: [],
    } as unknown as Parameters<typeof renderSettingsPage>[0]);
    expect(flagged).toContain("pendOpts");
    expect(plain).not.toContain("pendOpts");
    expect(plain).toContain("function init(box)");
  });
});

function errorsOf(dom: JSDOM): unknown[] {
  const errs: unknown[] = [];
  dom.window.addEventListener("error", (e) => errs.push(e.error ?? e.message));
  return errs;
}

describe("review findings on #1699", () => {
  it("1: picking an existing row while a pending choice is being saved does not break the save bar", () => {
    const dom = mount(page("channel", "1", () => ok("channel")));
    const errs = errorsOf(dom);
    let inp = open(dom);
    type(dom, "Support");
    key(dom, inp, "Enter");
    const form = $<HTMLFormElement>(dom, "form");
    form.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    inp = open(dom);
    type(dom, "news");
    key(dom, inp, "Enter");
    form.dispatchEvent(new dom.window.Event("kb-saved", { bubbles: true }));
    expect(errs).toEqual([]);
    const sel = $<HTMLSelectElement>(dom, "select");
    // The saved baseline is the pending choice; the live choice is News, so the form is dirty.
    expect(sel.value).toBe("2");
    expect($<HTMLElement>(dom, ".kb-savebar").hidden).toBe(false);
    $<HTMLButtonElement>(dom, "[data-savebar-discard]").click();
    expect(sel.value).toBe("create:Support");
  });

  const refs: Array<[string, () => string]> = [
    [
      "renderRoleSelectPicker",
      () =>
        renderRoleSelectPicker({
          name: "value_x.y",
          options: ROLES,
          selected: "create:Helpers",
          emptyLabel: "None",
          create: ok("role"),
        }),
    ],
    [
      "renderRolePicker",
      () =>
        renderRolePicker({
          id: "f",
          name: "value_x.y",
          options: ROLES,
          selected: ["create:Helpers"],
          create: ok("role"),
        }).replace(' id="f"', ""),
    ],
    [
      "settings role row",
      () => page("role", "create:Helpers", () => ok("role")),
    ],
  ];
  it.each(refs)(
    "2: %s draws a posted create value again as a pending option",
    (_n, html) => {
      const h = html();
      expect(h).not.toContain("unavailable");
      expect(h).toContain(
        '<option value="create:Helpers" data-create data-name="Helpers" selected>Helpers (will be created)</option>',
      );
      const dom = mount(h);
      expect($(dom, ".kb-picker").textContent).toContain("(will be created)");
      const inp = open(dom);
      type(dom, "helpers");
      expect(createRow(dom).hidden).toBe(true);
      expect(posted(dom)).toEqual(["create:Helpers"]);
      key(dom, inp, "Escape");
    },
  );
  it("2: without the flag a create value stays an unavailable id, and a blank one is not pending", () => {
    expect(
      renderRoleSelectPicker({
        name: "n",
        options: ROLES,
        selected: "create:Helpers",
        emptyLabel: "None",
      }),
    ).toContain("unavailable");
    expect(
      renderRoleSelectPicker({
        name: "n",
        options: ROLES,
        selected: "create:  ",
        emptyLabel: "None",
        create: ok("role"),
      }),
    ).toContain("unavailable");
  });

  function voicePage(sub: "voice" | "text", current = ""): string {
    const html = renderSettingsPage({
      csrfToken: "t",
      guildName: "G",
      flash: null,
      groups: [
        {
          category: "x",
          rows: [
            {
              ...row("channel", current),
              ...(sub === "voice" ? { channelKind: "voice" } : {}),
            },
          ],
        },
      ],
      textChannels: [],
      voiceChannels: [],
      categoryChannels: [],
      roles: [],
      pickerCreate: () => ok("channel"),
    } as unknown as Parameters<typeof renderSettingsPage>[0]);
    return (
      html.match(
        /<span class="kb-picker" data-picker [^>]*>[\s\S]*?<\/select><\/span>/,
      ) as RegExpMatchArray
    )[0];
  }
  const subs: Array<["voice" | "text", string, string, boolean]> = [
    ["voice", "#!Lobby", "Lobby", true],
    ["voice", "#Lobby", "", false],
    ["text", "#Lobby", "Lobby", true],
    ["text", "#!Lobby", "", false],
    ["voice", "Lobby", "Lobby", true],
  ];
  it.each(subs)(
    "3: a %s setting, typing %j, with an empty list",
    (sub, typed, name, offered) => {
      const dom = mount(voicePage(sub));
      const inp = open(dom);
      type(dom, typed);
      expect(createRow(dom).hidden).toBe(!offered);
      if (!offered) return;
      expect(createRow(dom).textContent).toBe(`Create new channel: '${name}'`);
      key(dom, inp, "Enter");
      const icon = $(dom, ".kb-picker__trigger .kb-mention svg").outerHTML;
      const probe = dom.window.document.createElement("span");
      probe.innerHTML = channelKindIcons()[sub];
      expect(icon).toBe((probe.firstChild as HTMLElement).outerHTML);
    },
  );

  it.each([["@Staff"], ["#Staff"], ["#!Staff"]])(
    "5: a category picker offers nothing for %j",
    (typed) => {
      const dom = mount(page("category", "20", () => ok("category")));
      open(dom);
      type(dom, typed);
      expect(createRow(dom).hidden).toBe(true);
      type(dom, "Staff");
      expect(createRow(dom).hidden).toBe(false);
    },
  );

  describe("6: role groups are not roles", () => {
    const withGroup = (extra: Array<{ id: string; name: string }>): string =>
      renderRoleSelectPicker({
        name: "value_x.y",
        options: [{ id: "group:7", name: "Staff (group)" }, ...ROLES, ...extra],
        selected: "",
        emptyLabel: "None",
        create: ok("role"),
      });
    it("a group name does not suppress creating a role of that name", () => {
      const dom = mount(withGroup([]));
      const inp = open(dom);
      type(dom, "Staff (group)");
      expect(createRow(dom).hidden).toBe(false);
      key(dom, inp, "ArrowDown");
      key(dom, inp, "Enter");
      expect($<HTMLSelectElement>(dom, "select").value).toBe(
        "create:Staff (group)",
      );
    });
    it("a real role of that name wins over the group", () => {
      const dom = mount(withGroup([{ id: "55", name: "Staff (group)" }]));
      const inp = open(dom);
      type(dom, "staff (group)");
      expect(createRow(dom).hidden).toBe(true);
      key(dom, inp, "Enter");
      expect($<HTMLSelectElement>(dom, "select").value).toBe("55");
    });
  });

  it("7: removing a pending chip while its name is in the search offers the row again", () => {
    const dom = mount(
      renderRolePicker({
        id: "f",
        name: "value_x.y",
        options: ROLES,
        selected: [],
        create: ok("role"),
      }).replace(' id="f"', ""),
    );
    const inp = open(dom);
    type(dom, "Helpers");
    key(dom, inp, "Enter");
    type(dom, "Helpers");
    expect(createRow(dom).hidden).toBe(true);
    $<HTMLButtonElement>(dom, ".kb-picker__chip-remove").click();
    expect(createRow(dom).hidden).toBe(false);
    key(dom, inp, "Enter");
    expect(posted(dom)).toEqual(["create:Helpers"]);
  });

  describe("4: Discard announces what it took away", () => {
    it("single select", () => {
      const dom = mount(page("channel", "1", () => ok("channel")));
      const inp = open(dom);
      type(dom, "Support");
      key(dom, inp, "Enter");
      $<HTMLButtonElement>(dom, "[data-savebar-discard]").click();
      expect(live(dom)).toBe(
        "Removed: new channel 'Support'. Restored: # general · CHAT.".replace(
          "# general · CHAT",
          "#general",
        ),
      );
    });
    it("multi-select, two pending names", () => {
      const dom = mount(
        renderRolePicker({
          id: "f",
          name: "value_x.y",
          options: ROLES,
          selected: ["9"],
          create: ok("role"),
        }).replace(' id="f"', ""),
      );
      const inp = open(dom);
      for (const n of ["A1", "B1"]) {
        type(dom, n);
        key(dom, inp, "Enter");
      }
      $<HTMLButtonElement>(dom, "[data-savebar-discard]").click();
      expect(live(dom)).toBe("Removed: new role 'A1', 'B1'. Restored: @Mods.");
    });
    it("a Discard that removes nothing pending says nothing new", () => {
      const dom = mount(page("channel", "1", () => ok("channel")));
      const inp = open(dom);
      key(dom, inp, "ArrowDown");
      key(dom, inp, "Enter");
      $<HTMLButtonElement>(dom, "[data-savebar-discard]").click();
      expect(live(dom)).toBe("");
    });
  });

  describe("second review", () => {
    function listPage(current: unknown): string {
      const html = renderSettingsPage({
        csrfToken: "t",
        guildName: "G",
        flash: null,
        groups: [{ category: "x", rows: [{ ...row("role_list"), current }] }],
        textChannels: [],
        voiceChannels: [],
        categoryChannels: [],
        roles: ROLES,
        pickerCreate: () => ok("role"),
      } as unknown as Parameters<typeof renderSettingsPage>[0]);
      return html;
    }
    it("a: a pending name with a comma stays one value when the caller passes an array", () => {
      const html = listPage(["9", "create:Community, Support"]);
      expect(html).not.toContain("unavailable");
      expect(html).toContain(
        '<option value="create:Community, Support" data-create data-name="Community, Support" selected>Community, Support (will be created)</option>',
      );
      expect(html).toContain(
        "Selected: @Mods, Community, Support (will be created)",
      );
      const dom = mount(
        (
          html.match(
            /<span class="kb-picker" data-picker [^>]*>[\s\S]*?<\/select><\/span>/,
          ) as RegExpMatchArray
        )[0],
      );
      expect(posted(dom)).toEqual(["9", "create:Community, Support"]);
    });
    it("a: a stored CSV string still splits on commas (ids hold none)", () => {
      const html = listPage("9,10");
      expect(html.match(/ selected>/g)?.length).toBe(2);
    });

    it("2: Discard announces a pending choice it brings back", () => {
      const dom = mount(
        renderRoleSelectPicker({
          name: "value_x.y",
          options: ROLES,
          selected: "create:Helpers",
          emptyLabel: "None",
          create: ok("role"),
        }),
      );
      const inp = open(dom);
      key(dom, inp, "ArrowDown");
      key(dom, inp, "ArrowDown");
      key(dom, inp, "Enter");
      expect($<HTMLSelectElement>(dom, "select").value).not.toBe(
        "create:Helpers",
      );
      // The refused page's pending choice is the baseline; Discard restores it.
      $<HTMLButtonElement>(dom, "[data-savebar-discard]").click();
      expect($<HTMLSelectElement>(dom, "select").value).toBe("create:Helpers");
      expect(live(dom)).toBe(
        "Will be created: role 'Helpers'. Restored: @Helpers (will be created).",
      );
    });

    it("4: replacing a pending name in a single select says the old one is dropped", () => {
      const dom = mount(page("channel", "1", () => ok("channel")));
      for (const n of ["Old", "Fresh"]) {
        const inp = open(dom);
        type(dom, n);
        key(dom, inp, "Enter");
      }
      expect(live(dom)).toBe(
        "Will be created: channel 'Fresh'. Removed: new channel 'Old'. Choose another row to undo.",
      );
      expect(posted(dom)).toEqual(["create:Fresh"]);
    });
  });

  describe("third review: the state model", () => {
    const R = [...ROLES, { id: "11", name: "Helpers Extra" }];
    const single = (): JSDOM =>
      mount(
        renderRoleSelectPicker({
          name: "value_x.y",
          options: R,
          selected: "",
          emptyLabel: "None",
          create: ok("role"),
        }),
      );
    const multi = (): JSDOM =>
      mount(
        renderRolePicker({
          id: "f",
          name: "value_x.y",
          options: R,
          selected: [],
          create: ok("role"),
        }).replace(' id="f"', ""),
      );
    const status = (dom: JSDOM): string =>
      $(dom, ".kb-picker__pop .kb-picker__hint[role=status]").textContent ?? "";
    const activeText = (dom: JSDOM): string | null => {
      const id = $<HTMLInputElement>(
        dom,
        ".kb-picker__search input",
      ).getAttribute("aria-activedescendant");
      return id
        ? (dom.window.document.getElementById(id)?.textContent ?? "")
        : null;
    };

    // typed text -> [create row shown, active row text, status]
    const table: Array<[string, boolean, string | null, string]> = [
      [
        "zzz",
        true,
        "Create new role: 'zzz'",
        "No existing role matches. You can create 'zzz'.",
      ],
      ["Help", true, "@Helpers Extra", "1 match, or create 'Help'."],
      ["helpers extra", false, "@Helpers Extra", "1 match"],
    ];
    it.each(table)("no pending: %j", (typed, row, active, text) => {
      for (const make of [single, multi]) {
        const dom = make();
        open(dom);
        type(dom, typed);
        expect(createRow(dom).hidden).toBe(!row);
        expect(activeText(dom)).toBe(active);
        expect(status(dom)).toBe(text);
      }
    });

    it.each([
      ["single", single],
      ["multi", multi],
    ] as const)(
      "%s: an exact pending name leaves no row active, so Enter cannot pick a neighbour",
      (_m, make) => {
        const dom = make();
        const inp = open(dom);
        type(dom, "Helpers");
        // "Helpers Extra" matches partly; the create row is below it.
        expect(createRow(dom).hidden).toBe(false);
        key(dom, inp, "ArrowDown");
        key(dom, inp, "Enter");
        expect(posted(dom)).toEqual(["create:Helpers"]);
        const inp2 = open(dom);
        type(dom, "helpers");
        expect(createRow(dom).hidden).toBe(true);
        expect(activeText(dom)).toBeNull();
        expect(status(dom)).toBe("'helpers' is already chosen to be created.");
        key(dom, inp2, "Enter");
        expect(posted(dom)).toEqual(["create:Helpers"]);
      },
    );

    it("the undo instruction is the one that works in each mode", () => {
      for (const [make, text] of [
        [single, "Choose another row to undo."],
        [
          multi,
          "Press Backspace in the empty search, or use its remove button, to undo.",
        ],
      ] as const) {
        const dom = make();
        const inp = open(dom);
        type(dom, "Zed");
        key(dom, inp, "Enter");
        expect(live(dom)).toBe(`Will be created: role 'Zed'. ${text}`);
      }
      // ...and in the multi-select that instruction does what it says.
      const dom = multi();
      const inp = open(dom);
      type(dom, "Zed");
      key(dom, inp, "Enter");
      key(dom, inp, "Backspace");
      expect(posted(dom)).toEqual([]);
    });

    it("the pending marker is a nowrap kb-pill, in the trigger and in a chip", () => {
      let dom = single();
      let inp = open(dom);
      type(dom, "Zed");
      key(dom, inp, "Enter");
      expect($(dom, ".kb-picker__trigger .kb-pill").textContent).toContain(
        "(will be created)",
      );
      dom = multi();
      inp = open(dom);
      type(dom, "Zed");
      key(dom, inp, "Enter");
      expect($(dom, ".kb-picker__chip .kb-pill").textContent).toContain(
        "(will be created)",
      );
    });
  });
});
