/* global HTMLElement, HTMLButtonElement, HTMLSelectElement */
/**
 * The keyboard state matrix of the channel and role picker (review of #1482,
 * third round): every focus location x key x popover state x field state, run
 * against the real `CHANNEL_PICKER_SCRIPT` for the single and the multiple
 * select (they share the script). Each cell says whether the popover is open
 * afterwards, where focus is, and that nothing threw.
 *
 * jsdom does not do what the browser does after a keydown, so the test models
 * the two defaults that matter: Enter or Space on a button clicks it (unless
 * the script prevented the key), and Tab leaves the key to the browser (the
 * popover closing on focus leaving is the `focusout` handler's job, covered in
 * `channel-picker.test.ts`). A row in the list is never focusable
 * (`mousedown` is prevented, focus stays in the search box), so it is not a
 * focus location; its keys are the search box's.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM, VirtualConsole } from "jsdom";
import { CHANNEL_PICKER_SCRIPT } from "../../src/web/setting-pickers.js";

type Field = "single" | "multi" | "many";
type Focus = "search" | "trigger" | "remove" | "more" | "group";
type Where = Focus | "same" | "firstRevealed";

const KEYS = [
  "Escape",
  "ArrowDown",
  "ArrowUp",
  "Enter",
  " ",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Home",
  "End",
] as const;
type Key = (typeof KEYS)[number];

function mount(
  field: Field,
  disabled: boolean,
): { dom: JSDOM; errors: string[] } {
  const n = field === "many" ? 20 : 3;
  const opts = Array.from({ length: n }, (_, i) => {
    const on = field === "many" || (field === "multi" && i < 2) || i === 0;
    return `<option value="${i}"${on ? " selected" : ""}>c${i}</option>`;
  }).join("");
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => errors.push(String(e)));
  const dom = new JSDOM(
    `<!doctype html><body><main><form><label for="f">Channels</label><span class="kb-picker" data-picker data-picker-meta="[]">` +
      `<select id="f" name="v"${field === "single" ? "" : " multiple"}${disabled ? " disabled" : ""}>${opts}</select></span>` +
      `<button type="button" id="after">after</button></form></main></body>`,
    { runScripts: "outside-only", virtualConsole },
  );
  dom.window.eval(CHANNEL_PICKER_SCRIPT);
  return { dom, errors };
}

const q = (d: JSDOM, s: string): HTMLElement =>
  d.window.document.querySelector(s) as HTMLElement;
const qa = (d: JSDOM, s: string): HTMLElement[] =>
  Array.from(d.window.document.querySelectorAll(s)) as HTMLElement[];

function target(d: JSDOM, f: Focus): HTMLElement {
  return {
    search: q(d, ".kb-picker__search input"),
    trigger: q(d, ".kb-picker__trigger"),
    remove: q(d, ".kb-picker__chip-remove"),
    more: q(d, ".kb-picker__more"),
    group: q(d, ".kb-picker__chips"),
  }[f];
}

/** What a keydown on `from` should leave behind. */
function expected(c: {
  field: Field;
  disabled: boolean;
  focus: Focus;
  open: boolean;
  key: Key;
}): { open: boolean; where: Where; prevented: boolean } {
  const { field, focus, open, key } = c;
  const same = { open, where: "same" as Where, prevented: false };
  if (c.disabled) {
    // Nothing opens; "+N more" still expands and hands focus to the chip group.
    if (focus === "more" && (key === "Enter" || key === " "))
      return { open: false, where: "group", prevented: false };
    return { open: false, where: "same", prevented: false };
  }
  switch (key) {
    case "Escape":
      return open
        ? { open: false, where: "trigger", prevented: true }
        : { ...same };
    case "ArrowDown":
    case "ArrowUp":
      if (focus === "search") return { open, where: "search", prevented: true };
      if (focus === "trigger")
        return { open: true, where: "search", prevented: true };
      return { ...same };
    case "Enter":
    case " ":
      if (focus === "search")
        // Enter chooses the active row (a multiple select stays open); Space types.
        return key === "Enter" && field === "single"
          ? { open: false, where: "trigger", prevented: true }
          : { open, where: "search", prevented: key === "Enter" };
      if (focus === "trigger")
        return open
          ? { open: false, where: "trigger", prevented: false }
          : { open: true, where: "search", prevented: false };
      if (focus === "remove")
        return { open, where: "trigger", prevented: false };
      if (focus === "more")
        return { open, where: "firstRevealed", prevented: false };
      return { ...same };
    case "Tab":
    case "Shift+Tab":
      return focus === "search" && open
        ? { open: false, where: "trigger", prevented: false }
        : { ...same };
    default:
      // Backspace (removes the last chip from an empty search of a multiple
      // select), Home and End (move the active row): focus and state stay.
      return {
        open,
        where: "same",
        prevented:
          focus === "search" &&
          open &&
          (key !== "Backspace" || field !== "single"),
      };
  }
}

const cells: Array<{
  field: Field;
  disabled: boolean;
  focus: Focus;
  open: boolean;
  key: Key;
}> = [];
const layouts: Array<{ field: Field; disabled: boolean; focus: Focus[] }> = [
  { field: "single", disabled: false, focus: ["search", "trigger"] },
  { field: "multi", disabled: false, focus: ["search", "trigger", "remove"] },
  {
    field: "many",
    disabled: false,
    focus: ["search", "trigger", "remove", "more"],
  },
  { field: "multi", disabled: true, focus: ["group"] },
  { field: "many", disabled: true, focus: ["group", "more"] },
];
for (const l of layouts)
  for (const focus of l.focus)
    for (const open of l.disabled ? [false] : [true, false])
      // The search box exists only inside an open popover.
      if (!(focus === "search" && !open))
        for (const key of KEYS)
          cells.push({
            field: l.field,
            disabled: l.disabled,
            focus,
            open,
            key,
          });

describe("keyboard state matrix of the picker script (review of #1482)", () => {
  it("covers every cell of the grid", () => {
    expect(cells.length).toBeGreaterThan(150);
  });

  for (const c of cells) {
    const name = `${c.field}${c.disabled ? " (disabled)" : ""}, focus on ${c.focus}, popover ${c.open ? "open" : "closed"}: ${c.key === " " ? "Space" : c.key}`;
    it(name, () => {
      const { dom, errors } = mount(c.field, c.disabled);
      const doc = dom.window.document;
      const pop = q(dom, ".kb-picker__pop");
      if (c.open) (q(dom, ".kb-picker__trigger") as HTMLButtonElement).click();
      expect(pop.hidden).toBe(!c.open);
      const from = target(dom, c.focus);
      from.focus();
      expect(doc.activeElement).toBe(from);
      const revealedAfter = c.focus === "more" ? 12 : -1;

      const ev = new dom.window.KeyboardEvent("keydown", {
        key: c.key === "Shift+Tab" ? "Tab" : c.key,
        shiftKey: c.key === "Shift+Tab",
        bubbles: true,
        cancelable: true,
      });
      const notPrevented = from.dispatchEvent(ev);
      if (notPrevented && (c.key === "Enter" || c.key === " "))
        if (from.tagName === "BUTTON" && !(from as HTMLButtonElement).disabled)
          from.click();

      const want = expected(c);
      expect(errors).toEqual([]);
      expect(pop.hidden).toBe(!want.open);
      expect(ev.defaultPrevented).toBe(want.prevented);
      const where = {
        search: q(dom, ".kb-picker__search input"),
        trigger: q(dom, ".kb-picker__trigger"),
        remove: q(dom, ".kb-picker__chip-remove"),
        more: q(dom, ".kb-picker__more"),
        group: q(dom, ".kb-picker__chips"),
        same: from,
        firstRevealed: qa(dom, ".kb-picker__chip-remove")[revealedAfter],
      }[want.where];
      expect(doc.activeElement).toBe(where);
      // Backspace in the empty search of an open multiple select drops the last chip, and nothing else changes a value here.
      const sel = q(dom, "select") as HTMLSelectElement;
      const start = c.field === "many" ? 20 : c.field === "multi" ? 2 : 1;
      const dropped =
        c.key === "Backspace" &&
        c.focus === "search" &&
        c.field !== "single" &&
        !c.disabled;
      const removed =
        c.focus === "remove" && (c.key === "Enter" || c.key === " ");
      const picked = c.focus === "search" && c.key === "Enter" && !c.disabled;
      const chosen = sel.selectedOptions.length;
      if (dropped || removed || (picked && c.field !== "single"))
        expect(chosen).not.toBe(start);
      else if (!picked) expect(chosen).toBe(start);
    });
  }
});
