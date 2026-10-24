/* global HTMLInputElement, HTMLElement, Document */
/**
 * The Generate builder in both preset editors (#1472). It is the event form's
 * builder (one shared script in `event-group-form.ts`), so these tests run the
 * real page scripts of `/admin/events/presets` and `/me/events/presets` in jsdom
 * and check the same rules: names and markers, the cap, surplus rows cleared,
 * derived tags.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderEventPresetsPage,
  renderPresetEditorForm,
} from "../../src/web/event-presets-page.js";
import { renderMyEventPresetsBody } from "../../src/web/me-event-presets-page.js";
import { renderEventsPage } from "../../src/web/admin-views.js";

type Values = Record<string, string>;
type Surface = "admin" | "me";

function rowValues(count: number): Values {
  const v: Values = {};
  for (let i = 0; i < count; i++) {
    v[`group_${i}_name`] = `Old ${i + 1}`;
    v[`group_${i}_kind`] = "team";
    v[`group_${i}_size`] = "3";
    v[`group_${i}_tag`] = "";
    v[`group_${i}_marker`] = "";
  }
  return v;
}

function html(
  surface: Surface,
  values: Values = {},
  maxCount = 15,
  defaultCount = 2,
  flash = false,
): string {
  const flashDiv = '<div class="notice err" data-flash>nope</div>';
  if (surface === "me") {
    const body = renderMyEventPresetsBody({
      csrfToken: "t",
      presets: [],
      editing: null,
      editUnavailable: false,
      values,
      prefillNote: null,
      maxCount,
      defaultCount,
    });
    return flash ? flashDiv + body : body;
  }
  const page = renderEventPresetsPage({
    csrfToken: "t",
    remainingMs: 1,
    entries: [],
    state: "ok",
    maxCount,
    defaultCount,
    editing: null,
    values,
    prefillNote: null,
  });
  return flash
    ? page.replace(
        "<h1>Group presets</h1>",
        "<h1>Group presets</h1>" + flashDiv,
      )
    : page;
}

/** Load a page the way the browser does: the rows script, then the editor's. */
function boot(
  surface: Surface,
  values: Values = {},
  maxCount = 15,
  defaultCount = 2,
  draft?: string,
): JSDOM {
  const page = html(
    surface,
    values,
    maxCount,
    defaultCount,
    draft !== undefined,
  );
  const dom = new JSDOM(page, {
    url: "http://localhost/presets",
    runScripts: "outside-only",
  });
  if (draft !== undefined) {
    dom.window.sessionStorage.setItem("koolbot-event-preset-draft", draft);
  }
  const scripts = [
    ...page.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  const rows = scripts.find((c) => c.includes("koolGroupRows="));
  const editor = scripts.find((c) => c.includes("koolbot-event-preset-draft"));
  if (!rows || !editor) throw new Error("page scripts not found");
  dom.window.eval(rows);
  dom.window.eval(editor);
  return dom;
}

function el(dom: JSDOM, selector: string): HTMLInputElement {
  const found = dom.window.document.querySelector(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found as HTMLInputElement;
}
const field = (dom: JSDOM, name: string): HTMLInputElement =>
  el(dom, `[name="${name}"]`);
const rowCount = (dom: JSDOM): number =>
  dom.window.document.querySelectorAll("[data-group-row]").length;
const names = (dom: JSDOM): string[] =>
  Array.from(
    dom.window.document.querySelectorAll('[name^="group_"][name$="_name"]'),
  ).map((n) => (n as HTMLInputElement).value);
const get = (dom: JSDOM, i: number, k: string): string =>
  field(dom, `group_${i}_${k}`).value;

function generate(
  dom: JSDOM,
  opts: { count?: string; size?: string; naming?: "colours" | "numbers" } = {},
): void {
  if (opts.count !== undefined)
    el(dom, "[data-build-count]").value = opts.count;
  if (opts.size !== undefined) el(dom, "[data-build-size]").value = opts.size;
  if (opts.naming)
    el(dom, `input[name=groups_build_names][value=${opts.naming}]`).checked =
      true;
  el(dom, "[data-build]").click();
}
function change(dom: JSDOM, name: string, checked: boolean): void {
  const box = field(dom, name);
  box.checked = checked;
  box.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}
function type(dom: JSDOM, name: string, value: string): void {
  const input = field(dom, name);
  input.value = value;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

describe.each<Surface>(["admin", "me"])(
  "the Generate builder on the %s preset editor (#1472)",
  (surface) => {
    it("ships the builder hidden, in one place, with its fields outside the form", () => {
      const page = html(surface);
      expect(page.match(/ data-group-builder[ >]/g)).toHaveLength(1);
      expect(page).toMatch(/data-group-builder hidden/);
      expect(page.indexOf("data-group-builder")).toBeLessThan(
        page.indexOf("kb-grouprows__head"),
      );
      const doc = new JSDOM(page).window.document;
      const form = doc.querySelector("form[data-preset-form]") as HTMLElement;
      expect(form.contains(doc.querySelector("[data-group-builder]"))).toBe(
        true,
      );
      // `hidden` is on an unstyled wrapper: `.kb-field` sets display and would show it.
      const wrap = doc.querySelector("[data-group-builder]") as HTMLElement;
      expect(wrap.hasAttribute("class")).toBe(false);
      expect(wrap.firstElementChild?.classList.contains("kb-field")).toBe(true);
      const fields = Array.from(
        form.querySelectorAll("[data-group-builder] input"),
      );
      expect(fields).toHaveLength(4);
      for (const f of fields) expect(f.getAttribute("form")).toBe("none");
    });

    it("shows the builder once the script runs", () => {
      const dom = boot(surface);
      expect(el(dom, "[data-group-builder]").hidden).toBe(false);
    });

    it("generates colour-named groups with a marker, size and the cap button following", () => {
      const dom = boot(surface, {}, 6);
      generate(dom, { count: "4", size: "5" });
      expect(rowCount(dom)).toBe(4);
      expect(names(dom)).toEqual(["Red", "Blue", "Green", "Yellow"]);
      expect(get(dom, 0, "marker")).toBe("🔴");
      expect(get(dom, 3, "marker")).toBe("🟡");
      expect(get(dom, 2, "size")).toBe("5");
      expect(get(dom, 0, "kind")).toBe("team");
      expect(el(dom, "[data-add-group]").hidden).toBe(false);
    });

    it("numbers the groups with the group wording, or Team by default", () => {
      const dom = boot(surface);
      generate(dom, { count: "3", naming: "numbers" });
      expect(names(dom)).toEqual(["Team 1", "Team 2", "Team 3"]);
      type(dom, "groups_label", "Squad");
      generate(dom, { count: "2", naming: "numbers" });
      expect(names(dom)).toEqual(["Squad 1", "Squad 2", ""]);
    });

    it("falls back to numbered names when Colours has too few colours", () => {
      const dom = boot(surface);
      generate(dom, { count: "10", naming: "colours" });
      expect(names(dom)[0]).toBe("Team 1");
      expect(names(dom)[9]).toBe("Team 10");
      expect(get(dom, 9, "marker")).toBe("🔴");
    });

    it("leaves the size empty for a value outside the limits", () => {
      const dom = boot(surface);
      generate(dom, { count: "2", size: "" });
      expect(get(dom, 0, "size")).toBe("");
      generate(dom, { count: "2", size: "500" });
      expect(get(dom, 1, "size")).toBe("");
    });

    it("never allocates past the cap, and the Captains lobby takes one place", () => {
      const dom = boot(surface, {}, 4);
      generate(dom, { count: "9" });
      expect(rowCount(dom)).toBe(4);
      expect(el(dom, "[data-build-count]").value).toBe("4");
      expect(el(dom, "[data-add-group]").hidden).toBe(true);
      change(dom, "groups_captains_lobby", true);
      generate(dom, { count: "9" });
      expect(el(dom, "[data-build-count]").value).toBe("3");
      expect(names(dom)).toEqual(["Red", "Blue", "Green", ""]);
      expect(rowCount(dom)).toBe(4);
    });

    it("clears surplus rows, including a prefill over the cap, without allocating", () => {
      const dom = boot(surface, rowValues(5), 3);
      expect(rowCount(dom)).toBe(5);
      generate(dom, { count: "2" });
      expect(rowCount(dom)).toBe(5);
      expect(names(dom)).toEqual(["Red", "Blue", "", "", ""]);
      expect(get(dom, 4, "size")).toBe("");
      expect(get(dom, 4, "marker")).toBe("");
    });

    it("does not grow an over-cap prefill when more groups are asked for", () => {
      const dom = boot(surface, rowValues(5), 3);
      generate(dom, { count: "9" });
      expect(rowCount(dom)).toBe(5);
      expect(names(dom)).toEqual(["Red", "Blue", "Green", "", ""]);
    });

    it("derives a tag for each generated group while Clan tags is ticked", () => {
      const dom = boot(surface);
      change(dom, "groups_tags", true);
      generate(dom, { count: "3" });
      expect(get(dom, 0, "tag")).toBe("RED");
      expect(get(dom, 2, "tag")).toBe("GREE");
      // The generated tag keeps following the name until it is edited by hand.
      type(dom, "group_0_name", "Ruby");
      expect(get(dom, 0, "tag")).toBe("RUBY");
      type(dom, "group_1_tag", "BL");
      type(dom, "group_1_name", "Navy");
      expect(get(dom, 1, "tag")).toBe("BL");
    });

    it("generates no tags while Clan tags is off, and drops old ones", () => {
      const dom = boot(surface, { ...rowValues(2), group_0_tag: "OLD" });
      generate(dom, { count: "2" });
      expect(get(dom, 0, "tag")).toBe("");
      expect(get(dom, 1, "tag")).toBe("");
      // Ticking the box afterwards derives them from the names.
      change(dom, "groups_tags", true);
      expect(get(dom, 0, "tag")).toBe("RED");
    });

    it("sets every generated row back to a team", () => {
      const dom = boot(surface, {
        ...rowValues(2),
        group_1_kind: "open",
      });
      generate(dom, { count: "2" });
      expect(get(dom, 1, "kind")).toBe("team");
    });

    it("keeps generated rows through one refused save", () => {
      const first = boot(surface);
      change(first, "groups_tags", true);
      generate(first, { count: "3", size: "4" });
      first.window.document
        .querySelector("form[data-preset-form]")!
        .dispatchEvent(
          new first.window.Event("submit", { bubbles: true, cancelable: true }),
        );
      const draft = first.window.sessionStorage.getItem(
        "koolbot-event-preset-draft",
      ) as string;
      // The builder's own fields are not part of the saved draft.
      expect(draft).not.toContain("groups_build_names");
      expect(draft).not.toContain("data-build");
      const second = boot(surface, {}, 15, 2, draft);
      expect(names(second).slice(0, 3)).toEqual(["Red", "Blue", "Green"]);
      expect(get(second, 1, "marker")).toBe("🔵");
      expect(get(second, 2, "size")).toBe("4");
      expect(get(second, 0, "tag")).toBe("RED");
      type(second, "group_0_name", "Ruby");
      expect(get(second, 0, "tag")).toBe("RUBY");
    });
  },
);

describe("the shared builder (#1472)", () => {
  const section = (maxCount: number): string =>
    renderEventsPage({
      csrfToken: "t",
      remainingMs: 1,
      categoryConfigured: true,
      announcementConfigured: true,
      timezone: "UTC",
      settingRows: [],
      enabled: true,
      rows: [],
      groupLimits: { defaultCount: 2, maxCount },
    } as never);

  it("the event form and both preset editors carry the same builder markup", () => {
    const grab = (page: string): string => {
      const doc = new JSDOM(page).window.document;
      return (doc.querySelector("[data-group-builder]") as HTMLElement)
        .outerHTML;
    };
    const eventForm = grab(section(15));
    expect(grab(html("admin"))).toBe(eventForm);
    expect(grab(html("me"))).toBe(eventForm);
  });

  it("the builder's limit and default follow the editor's cap", () => {
    const doc = new JSDOM(html("admin", {}, 3)).window.document as Document;
    const count = doc.querySelector("[data-build-count]") as HTMLInputElement;
    expect(count.getAttribute("max")).toBe("3");
    expect(count.value).toBe("3");
  });

  it("an editor that cannot be loaded has no builder", () => {
    const page = renderPresetEditorForm({
      csrfInput: "",
      action: "/x",
      editing: null,
      editUnavailable: true,
      values: {},
      maxCount: 15,
      defaultCount: 2,
      cancelHref: "/x",
    });
    expect(page).not.toContain("data-group-builder");
  });
});

/**
 * The cap boundaries of the one shared Generate handler (`groupBuilderScript`),
 * on both preset editors and the event form. A ticked Captains lobby takes one
 * place under `events.groups.max_count`; with no place left Generate must
 * change nothing and say what to do, instead of leaving one team plus the lobby
 * against a cap of one (the server refuses that save).
 */
type AnySurface = Surface | "event";

function bootAny(
  surface: AnySurface,
  values: Values,
  maxCount: number,
  defaultCount: number,
): JSDOM {
  if (surface !== "event") return boot(surface, values, maxCount, defaultCount);
  const page = renderEventsPage({
    csrfToken: "t",
    remainingMs: 1,
    categoryConfigured: true,
    announcementConfigured: true,
    timezone: "UTC",
    settingRows: [],
    enabled: true,
    rows: [],
    groupLimits: { defaultCount, maxCount },
  } as never);
  const dom = new JSDOM(page, {
    url: "http://localhost/admin/events",
    runScripts: "outside-only",
  });
  const scripts = [
    ...page.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  dom.window.eval(scripts.find((c) => c.includes("koolGroupRows="))!);
  dom.window.eval(scripts.find((c) => c.includes("koolbot-event-form-draft"))!);
  return dom;
}

/** Tick Captains lobby (on the event form it first needs the leaders box). */
function tickLobby(dom: JSDOM, surface: AnySurface, on = true): void {
  if (surface === "event") change(dom, "groups_captains", true);
  change(dom, "groups_captains_lobby", on);
}

const note = (dom: JSDOM): HTMLElement => el(dom, "[data-build-note]");

interface CapCase {
  name: string;
  max: number;
  lobby: boolean;
  /** Rows the page starts with: the editor's prefill, or the default count. */
  rows: number;
  count: string;
  /** Names after Generate, from the first row on. */
  names: string[];
  /** Generate was refused: nothing changed and the note is shown. */
  blocked?: boolean;
  /** Only on the preset editors (the event form cannot be prefilled). */
  editorOnly?: boolean;
}

const OLD = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `Old ${i + 1}`);
const NUMBERED = (n: number, total = n): string[] =>
  Array.from({ length: total }, (_, i) => (i < n ? `Team ${i + 1}` : ""));

const CAP_CASES: CapCase[] = [
  // The finding: room is zero.
  {
    name: "max 1, lobby ticked, count 1",
    max: 1,
    lobby: true,
    rows: 1,
    count: "1",
    names: ["Old 1"],
    blocked: true,
    editorOnly: true,
  },
  {
    name: "max 1, lobby ticked, count 5",
    max: 1,
    lobby: true,
    rows: 1,
    count: "5",
    names: ["Old 1"],
    blocked: true,
    editorOnly: true,
  },
  {
    name: "max 1, lobby ticked, empty rows",
    max: 1,
    lobby: true,
    rows: 1,
    count: "1",
    names: [""],
    blocked: true,
  },
  {
    name: "max 1, lobby ticked, over-cap prefill left alone",
    max: 1,
    lobby: true,
    rows: 5,
    count: "2",
    names: OLD(5),
    blocked: true,
    editorOnly: true,
  },
  // The neighbours of the same expression.
  {
    name: "max 1, no lobby",
    max: 1,
    lobby: false,
    rows: 1,
    count: "3",
    names: ["Red"],
  },
  {
    name: "max 2, lobby ticked (room 1)",
    max: 2,
    lobby: true,
    rows: 2,
    count: "5",
    names: ["Red", ""],
  },
  {
    name: "max 2, no lobby",
    max: 2,
    lobby: false,
    rows: 2,
    count: "5",
    names: ["Red", "Blue"],
  },
  {
    name: "max 3, lobby ticked (room 2)",
    max: 3,
    lobby: true,
    rows: 2,
    count: "9",
    names: ["Red", "Blue"],
  },
  {
    name: "max 3, no lobby, count equals room",
    max: 3,
    lobby: false,
    rows: 2,
    count: "3",
    names: ["Red", "Blue", "Green"],
  },
  {
    name: "count below room",
    max: 6,
    lobby: false,
    rows: 2,
    count: "2",
    names: ["Red", "Blue"],
  },
  {
    name: "count 0 becomes 1",
    max: 6,
    lobby: false,
    rows: 2,
    count: "0",
    names: ["Red", ""],
  },
  {
    name: "negative count becomes 1",
    max: 6,
    lobby: false,
    rows: 2,
    count: "-4",
    names: ["Red", ""],
  },
  {
    name: "empty count becomes 1",
    max: 6,
    lobby: false,
    rows: 2,
    count: "",
    names: ["Red", ""],
  },
  {
    name: "non-numeric count becomes 1",
    max: 6,
    lobby: false,
    rows: 2,
    count: "abc",
    names: ["Red", ""],
  },
  {
    name: "the hard maximum of 25 groups",
    max: 25,
    lobby: false,
    rows: 2,
    count: "99",
    names: NUMBERED(25),
  },
  {
    name: "the hard maximum with the lobby (room 24)",
    max: 25,
    lobby: true,
    rows: 2,
    count: "99",
    names: NUMBERED(24),
  },
  {
    name: "over-cap prefill is emptied, not grown",
    max: 3,
    lobby: false,
    rows: 5,
    count: "2",
    names: ["Red", "Blue", "", "", ""],
    editorOnly: true,
  },
  {
    name: "a prefill at the 100-row form limit",
    max: 3,
    lobby: true,
    rows: 100,
    count: "9",
    names: ["Red", "Blue", ...Array<string>(98).fill("")],
    editorOnly: true,
  },
];

describe.each<AnySurface>(["admin", "me", "event"])(
  "Generate against the cap on the %s surface",
  (surface) => {
    it.each(CAP_CASES.filter((c) => !(c.editorOnly && surface === "event")))(
      "$name",
      (c) => {
        const values = c.editorOnly ? rowValues(c.rows) : {};
        const dom = bootAny(surface, values, c.max, c.rows);
        if (c.lobby) tickLobby(dom, surface);
        const before = names(dom);
        const total = rowCount(dom);
        generate(dom, { count: c.count });
        // Rows grow up to the groups made, never past the cap and never by a refused run.
        const made = c.blocked ? 0 : c.names.filter((n) => n !== "").length;
        expect(rowCount(dom)).toBe(Math.max(total, made));
        expect(names(dom).slice(0, c.names.length)).toEqual(c.names);
        if (c.blocked) {
          expect(names(dom)).toEqual(before);
          expect(note(dom).hidden).toBe(false);
          expect(note(dom).getAttribute("role")).toBe("status");
          expect(note(dom).textContent).toMatch(/Untick Captains lobby/);
        } else {
          expect(note(dom).hidden).toBe(true);
          expect(note(dom).textContent).toBe("");
        }
      },
    );

    it("a refused Generate works once the lobby is unticked, and the note goes", () => {
      const dom = bootAny(surface, {}, 1, 1);
      tickLobby(dom, surface);
      generate(dom, { count: "1" });
      expect(note(dom).hidden).toBe(false);
      tickLobby(dom, surface, false);
      expect(note(dom).hidden).toBe(true);
      generate(dom, { count: "1" });
      expect(names(dom)).toEqual(["Red"]);
      expect(note(dom).hidden).toBe(true);
    });

    it("never leaves more channels than the cap: rows plus a ticked lobby", () => {
      for (const max of [1, 2, 3]) {
        for (const lobby of [false, true]) {
          const dom = bootAny(surface, {}, max, 1);
          if (lobby) tickLobby(dom, surface);
          generate(dom, { count: "9" });
          const filled = names(dom).filter((n) => n !== "").length;
          expect(filled + (lobby ? 1 : 0)).toBeLessThanOrEqual(max);
        }
      }
    });
  },
);

describe("the Generate note markup (#1472)", () => {
  it("is one hidden status line next to the builder on every surface", () => {
    for (const surface of ["admin", "me"] as const) {
      const page = html(surface);
      expect(page.match(/<p [^>]*data-build-note/g)).toHaveLength(1);
      expect(page).toMatch(/<p [^>]*role="status" data-build-note hidden>/);
    }
  });
});
