/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global document, HTMLElement, HTMLInputElement, HTMLButtonElement, Event */
/**
 * Axe over every state of the script-built channel picker (#1394). The page
 * fixtures in `a11y-pages.ts` drop inline scripts, so they only cover the
 * no-JavaScript select; the states that exist only after the script ran
 * (closed, open, filtered, no match, disabled) are scanned here.
 */
import { describe, it, expect } from "@jest/globals";
import { axe, toHaveNoViolations } from "jest-axe";
import { CHANNEL_PICKER_SCRIPT } from "../../src/web/setting-pickers.js";
import { channelKindIcons } from "../../src/web/discord-labels.js";

expect.extend(toHaveNoViolations);

/**
 * `data-picker-meta` holds one entry per option, in markup order, so each
 * fixture lists the entries for exactly its own options (#1485): the single
 * select starts with the `(none)` option, the multi-select has none.
 */
const toAttr = (entries: unknown[]): string =>
  JSON.stringify(entries).replace(/"/g, "&quot;");

const CHANNELS = [
  ["text", "general", "Chat"],
  ["voice", "Lobby", "Scratch"],
  ["role", "Mods", ""],
];
const META = toAttr([null, ...CHANNELS, ["missing", "77", ""]]);
const MULTI_META = toAttr(CHANNELS);

const SELECT = (disabled = false): string =>
  `<span class="kb-picker" data-picker data-picker-meta="${META}"><select class="kb-select" id="f" name="v"${disabled ? " disabled" : ""}>` +
  `<option value="">(none)</option>` +
  `<optgroup label="Text channels"><option value="1">x</option></optgroup>` +
  `<optgroup label="Voice channels"><option value="3" selected>x</option></optgroup>` +
  `<optgroup label="Roles"><option value="9">x</option></optgroup>` +
  `<option value="77">⚠ 77 (unavailable)</option>` +
  `</select></span>`;

function mount(disabled = false): void {
  document.body.innerHTML = `<main><h1>Settings</h1><label for="f">Announce channel</label>${SELECT(disabled)}</main>`;
  document.documentElement.setAttribute("lang", "en");
  document.title = "Picker";
  (0, eval)(CHANNEL_PICKER_SCRIPT);
}

const trigger = (): HTMLButtonElement =>
  document.querySelector(".kb-picker__trigger") as HTMLButtonElement;
const search = (): HTMLInputElement =>
  document.querySelector(".kb-picker__search input") as HTMLInputElement;

function typeInto(text: string): void {
  search().value = text;
  search().dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * What the script rendered for each of `selector`'s mentions: the name and the
 * kind its icon stands for (`role` has no icon and is told by its "@"). The
 * metadata is read by option index, so a fixture whose `data-picker-meta` is
 * shifted against its options would otherwise still pass axe on the wrong
 * markup (#1485).
 */
function kindsIn(selector: string): { text: string; kind: string }[] {
  const icons = channelKindIcons();
  const holder = document.createElement("span");
  const byIcon = new Map<string, string>();
  for (const [kind, html] of Object.entries(icons)) {
    holder.innerHTML = html;
    byIcon.set((holder.firstChild as HTMLElement).outerHTML, kind);
  }
  return Array.from(document.querySelectorAll(selector)).map((m) => {
    const icon = m.querySelector("svg");
    const text = m.textContent ?? "";
    return {
      text,
      kind: icon
        ? (byIcon.get(icon.outerHTML) ?? "unknown icon")
        : text.startsWith("@")
          ? "role"
          : "none",
    };
  });
}

const OPTIONS = { rules: { "color-contrast": { enabled: false } } } as const;

describe("channel picker accessibility (axe)", () => {
  it("closed", async () => {
    mount();
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
  });

  it("renders the rows as the kinds the options are", () => {
    mount();
    expect(kindsIn(".kb-picker__opt .kb-mention")).toEqual([
      { text: "(none)", kind: "none" },
      { text: "general", kind: "text" },
      { text: "Lobby", kind: "voice" },
      { text: "@Mods", kind: "role" },
      { text: "⚠ 77 (unavailable)", kind: "none" },
    ]);
  });

  it("open", async () => {
    mount();
    trigger().click();
    expect(document.activeElement).toBe(search());
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
  });

  it("filtered to voice channels", async () => {
    mount();
    trigger().click();
    typeInto("#!");
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
  });

  it("filtered to roles", async () => {
    mount();
    trigger().click();
    typeInto("@mo");
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
  });

  it("no match", async () => {
    mount();
    trigger().click();
    typeInto("zzz");
    expect(
      (document.querySelector('[role="status"]') as HTMLElement).textContent,
    ).toBe("No matches");
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
  });

  it("rejected, then cleared", async () => {
    mount();
    const sel = document.getElementById("f") as HTMLElement;
    const note = document.createElement("p");
    note.id = "err";
    note.textContent = "Rejected: pick a channel.";
    document.querySelector("main")?.appendChild(note);
    sel.setAttribute("aria-describedby", "err");
    sel.setAttribute("aria-invalid", "true");
    await Promise.resolve();
    expect(trigger().getAttribute("aria-invalid")).toBe("true");
    expect(trigger().getAttribute("aria-describedby")).toBe("err");
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
    trigger().click();
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
    // A later save accepts the value: the note is removed with the marks.
    note.remove();
    sel.removeAttribute("aria-invalid");
    sel.removeAttribute("aria-describedby");
    await Promise.resolve();
    expect(trigger().hasAttribute("aria-invalid")).toBe(false);
    expect(trigger().hasAttribute("aria-describedby")).toBe(false);
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
  });

  it("disabled", async () => {
    mount(true);
    expect(trigger().disabled).toBe(true);
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
  });
});

describe("multi-select channel picker accessibility (axe, #1473)", () => {
  const MULTI = (): void => {
    document.body.innerHTML =
      `<main><h1>Settings</h1><label for="f">Channels</label>` +
      `<span class="kb-picker" data-picker data-picker-meta="${MULTI_META}"><select id="f" name="v" multiple>` +
      `<optgroup label="Text channels"><option value="1" selected>x</option></optgroup>` +
      `<optgroup label="Voice channels"><option value="3" selected>x</option></optgroup>` +
      `<optgroup label="Roles"><option value="9">x</option></optgroup>` +
      `</select></span></main>`;
    document.documentElement.setAttribute("lang", "en");
    document.title = "Picker";
    (0, eval)(CHANNEL_PICKER_SCRIPT);
  };

  it("renders the chips and rows as the kinds the options are", () => {
    MULTI();
    expect(kindsIn(".kb-picker__chips .kb-mention")).toEqual([
      { text: "general", kind: "text" },
      { text: "Lobby", kind: "voice" },
    ]);
    expect(kindsIn(".kb-picker__opt .kb-mention")).toEqual([
      { text: "general", kind: "text" },
      { text: "Lobby", kind: "voice" },
      { text: "@Mods", kind: "role" },
    ]);
  });

  it("closed, with chips", async () => {
    MULTI();
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
  });

  it("open", async () => {
    MULTI();
    trigger().click();
    expect(await axe(document.body, OPTIONS)).toHaveNoViolations();
  });
});
