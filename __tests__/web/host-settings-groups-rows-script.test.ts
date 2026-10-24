/* global HTMLInputElement, HTMLFormElement, HTMLElement, Element */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";

/**
 * The host panel's group rows (#1406) with the shared group rows script, run for
 * real in jsdom: the emoji picker works on the live-edit field names, and what
 * the form would post is what the live-edit parser reads as a marker and a tag
 * change. The markup comes from `renderGroupEditor`, so what is tested ships.
 */

const { renderGroupEditor } =
  await import("../../src/web/host-settings-groups.js");
const { groupRowsScript } = await import("../../src/web/event-group-form.js");
const { parseSubmission } =
  await import("../../src/services/event-live-edit.js");
type GroupEditViewData =
  import("../../src/web/host-settings-groups.js").GroupEditViewData;

const A = "g_00000001";
const B = "g_00000002";

const view: GroupEditViewData = {
  groupLabel: "Team",
  groups: [
    {
      key: A,
      kind: "team",
      hasChannel: true,
      name: "Alpha",
      marker: "🔴",
      tag: "ALP",
      size: 3,
      memberCount: 2,
      overSize: false,
      namePending: false,
      sizePending: false,
    },
    {
      key: B,
      kind: "open",
      hasChannel: false,
      name: "Spectators",
      marker: "",
      tag: "",
      size: null,
      memberCount: 0,
      overSize: false,
      namePending: false,
      sizePending: false,
    },
  ],
  presets: [],
  presetNotice: null,
  presetBase: "{}",
  addKey: "g_0000abcd",
};

function boot(): JSDOM {
  const html = `<!doctype html><body><form method="POST" action="/x">${renderGroupEditor(view)}</form></body>`;
  const dom = new JSDOM(html, {
    url: "http://localhost/me/events/e/host",
    runScripts: "outside-only",
  });
  dom.window.eval(groupRowsScript());
  return dom;
}

const q = <T extends Element = HTMLInputElement>(
  dom: JSDOM,
  selector: string,
): T => {
  const el = dom.window.document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
};

/** What the browser would post: every named, enabled control of the form. */
function posted(dom: JSDOM): Record<string, string> {
  const form = q<HTMLFormElement>(dom, "form");
  const out: Record<string, string> = {};
  for (const el of Array.from(form.elements)) {
    const input = el as HTMLInputElement;
    if (!input.name || input.disabled) continue;
    out[input.name] = input.value;
  }
  return out;
}

describe("the host panel's group rows with the group rows script", () => {
  it("turns each marker box into a picker button that shows the stored marker", () => {
    const dom = boot();
    const buttons = Array.from(
      dom.window.document.querySelectorAll("[data-marker-btn]"),
    );
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLElement).hidden).toBe(false);
    expect(buttons[0].textContent).toBe("🔴");
    expect(buttons[1].textContent).toBe("+");
  });

  it("picking a marker sets the live-edit field, and the post reads as a marker change by group key", () => {
    const dom = boot();
    q(dom, "[data-marker-btn]").dispatchEvent(
      new dom.window.Event("click", { bubbles: true }),
    );
    q(dom, ".kb-emoji-pop button[data-emoji='🟣']").dispatchEvent(
      new dom.window.Event("click", { bubbles: true }),
    );
    const body = posted(dom);
    expect(body[`s_groupMarkers_${A}`]).toBe("🟣");
    expect(body[`b_groupMarkers_${A}`]).toBe("🔴");
    const parsed = parseSubmission(body);
    const markers = parsed.entries.find((e) => e.rowId === "groupMarkers");
    expect(markers).toEqual({
      rowId: "groupMarkers",
      to: { [A]: "🟣", [B]: "" },
      base: { [A]: "🔴", [B]: "" },
    });
    // Nothing else changed: the other rows of the same post read as untouched.
    for (const e of parsed.entries) {
      if (e.rowId !== "groupMarkers") expect(e.to).toEqual(e.base);
    }
  });

  it("an edited tag posts as the team-tags row's own field, keyed by group, and an open group posts no tag", () => {
    const dom = boot();
    q(dom, `[name="s_groupTags_${A}"]`).value = "ALPHA";
    const body = posted(dom);
    expect(body[`s_groupTags_${A}`]).toBe("ALPHA");
    expect(body[`b_groupTags_${A}`]).toBe("ALP");
    expect(
      Object.keys(body).some((k) => k.includes(B) && k.includes("Tags")),
    ).toBe(false);
    const parsed = parseSubmission(body);
    const tags = parsed.entries.find((e) => e.rowId === "groupTags");
    expect(tags).toEqual({
      rowId: "groupTags",
      to: { [A]: "ALPHA" },
      base: { [A]: "ALP" },
    });
  });

  it("posts the key each positional row was shown for, so a reorder is a conflict, and no event-form field names", () => {
    const body = posted(boot());
    expect(body.k_groupNameA).toBe(A);
    expect(body.k_groupSizeA).toBe(A);
    expect(body.k_groupNameB).toBe(B);
    expect(body.k_groupSizeB).toBe(B);
    expect(Object.keys(body).filter((k) => /^group_\d+_/.test(k))).toEqual([]);
  });
});
