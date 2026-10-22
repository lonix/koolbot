/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global document, Document, HTMLInputElement, HTMLAnchorElement, Event, DOMParser */
/**
 * Bounded number boxes and bot-managed values on the settings controls
 * (#1304). Markup is checked through a DOM, never with regular expressions
 * over HTML, and the browser script runs against a real form.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  messageJumpUrl,
  renderSettingsPage,
  type SettingRow,
} from "../../src/web/admin-views.js";
import {
  renderManagedValue,
  renderNumberInput,
} from "../../src/web/setting-controls.js";
import { NUMBER_INPUT_SCRIPT } from "../../src/web/number-input.js";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const MESSAGE = "333333333333333333";

function row(
  over: Partial<SettingRow> & Pick<SettingRow, "key" | "type">,
): SettingRow {
  return {
    label: over.key,
    current: "",
    defaultValue: "",
    description: "",
    category: over.key.split(".")[0],
    ...over,
  };
}

function page(rows: SettingRow[]): Document {
  const html = renderSettingsPage({
    csrfToken: "t",
    remainingMs: 600000,
    textChannels: [],
    voiceChannels: [],
    categoryChannels: [],
    roles: [],
    guildId: GUILD,
    guildName: "G",
    groups: [{ category: "quotes", rows }],
  });
  return new DOMParser().parseFromString(html, "text/html");
}

describe("renderNumberInput", () => {
  function parse(html: string): HTMLInputElement {
    document.body.innerHTML = html;
    return document.querySelector("input") as HTMLInputElement;
  }

  it("is a digit-only text box, not type=number (Safari and Firefox let letters in)", () => {
    const input = parse(renderNumberInput("value_x", 5, { min: 1, max: 25 }));
    expect(input.type).toBe("text");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("pattern")).toBe("[0-9]*");
    expect(input.getAttribute("data-min")).toBe("1");
    expect(input.getAttribute("data-max")).toBe("25");
    // No maxlength: it would cut an oversized paste to a different valid number.
    expect(input.hasAttribute("maxlength")).toBe(false);
    expect(input.required).toBe(true);
    expect(input.title).toBe("Whole number from 1 to 25");
  });

  it("leaves out bounds it was not given", () => {
    const input = parse(renderNumberInput("value_x", 5, {}));
    expect(input.hasAttribute("data-min")).toBe(false);
    expect(input.hasAttribute("data-max")).toBe(false);
  });

  it("marks a locked control disabled and invalid state through the shared attributes", () => {
    const input = parse(
      renderNumberInput(
        "value_x",
        5,
        { min: 0, max: 9 },
        { id: "set-x", invalid: true, disabled: true, describedBy: "h" },
      ),
    );
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("h");
    expect(input.id).toBe("set-x");
  });
});

describe("NUMBER_INPUT_SCRIPT", () => {
  let input: HTMLInputElement;

  beforeEach(() => {
    document.body.innerHTML =
      `<form>${renderNumberInput("value_x", 5, { min: 1, max: 25 })}` +
      `<input id="order" type="number" value="-5" min="-1000" max="10000"></form>`;
    input = document.querySelector("input[data-number]") as HTMLInputElement;
    new Function(NUMBER_INPUT_SCRIPT)();
  });

  function type(value: string): void {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** A keystroke or paste as `beforeinput`; returns true when it was blocked. */
  function attempt(text: string, paste = false): boolean {
    const ev = new Event("beforeinput", { bubbles: true, cancelable: true });
    Object.assign(ev, {
      inputType: paste ? "insertFromPaste" : "insertText",
      data: paste ? null : text,
      dataTransfer: paste ? { getData: () => text } : null,
    });
    input.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  it("blocks a keystroke or paste that would leave a non-digit, keeping the value", () => {
    input.value = "5";
    input.setSelectionRange(1, 1);
    for (const text of ["-", ".", "e", "T", "1e3", "-1", "1.5", "a1"]) {
      expect(attempt(text)).toBe(true);
      expect(attempt(text, true)).toBe(true);
    }
    expect(input.value).toBe("5");
    expect(attempt("2")).toBe(false);
    expect(attempt("12", true)).toBe(false);
  });

  it("never rewrites what got in: it keeps it and flags it, so the server still sees it", () => {
    for (const raw of ["TEN", "1a2", "1e3", "-4", "-1", "1.5", "0x10"]) {
      type(raw);
      expect(input.value).toBe(raw);
      expect(input.validity.valid).toBe(false);
      expect(input.validationMessage).toContain("Digits only");
    }
  });

  it("flags an oversized paste instead of truncating it into a valid number", () => {
    type("14400");
    expect(input.value).toBe("14400");
    expect(input.validity.valid).toBe(false);
    expect(input.validationMessage).toBe("Enter a whole number from 1 to 25.");
  });

  it("holds the form back outside the range, with a message", () => {
    type("99");
    expect(input.validity.valid).toBe(false);
    expect(input.validationMessage).toBe("Enter a whole number from 1 to 25.");
    type("0");
    expect(input.validity.valid).toBe(false);
    type("25");
    expect(input.validity.valid).toBe(true);
  });

  it("leaves other number inputs (the display order) alone", () => {
    const order = document.getElementById("order") as HTMLInputElement;
    order.dispatchEvent(new Event("input", { bubbles: true }));
    expect(order.value).toBe("-5");
  });
});

describe("managed values on the Settings page", () => {
  const rows = [
    row({
      key: "quotes.channel_id",
      type: "channel",
      current: CHANNEL,
      defaultValue: "",
    }),
    row({
      key: "quotes.max_length",
      type: "number",
      current: 500,
      defaultValue: 1000,
      min: 1,
      max: 4000,
    }),
    row({
      key: "quotes.header_message_id",
      type: "string",
      current: MESSAGE,
      defaultValue: "",
      managed: { channelKey: "quotes.channel_id" },
      jumpUrl: messageJumpUrl(GUILD, CHANNEL, MESSAGE),
    }),
  ];

  it("shows the id as text with a jump link, never as an input", () => {
    const doc = page(rows);
    expect(
      doc.querySelector('[name="value_quotes.header_message_id"]'),
    ).toBeNull();
    const link = doc.querySelector(
      'a[href^="https://discord.com/channels/"]',
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
    );
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.textContent).toBe("Jump to message");
    expect(doc.body.textContent).toContain(MESSAGE);
  });

  it("is not listed in `keys`, so saving the section cannot blank the stored id", () => {
    const doc = page(rows);
    const keys = [...doc.querySelectorAll('input[name="keys"]')].map((i) =>
      i.getAttribute("value"),
    );
    expect(keys).toContain("quotes.max_length");
    expect(keys).not.toContain("quotes.header_message_id");
  });

  it("offers no reset or changed mark on a managed row", () => {
    const doc = page(rows);
    expect(doc.body.innerHTML).not.toContain("quotes.header_message_id-reset");
    const names = [...doc.querySelectorAll(".kb-setting__name")].filter((n) =>
      n.textContent?.includes("quotes.header_message_id"),
    );
    expect(names).toHaveLength(1);
    expect(names[0].querySelector("label")).toBeNull();
    expect(names[0].querySelector(".kb-setting__changed")).toBeNull();
  });

  it("says so when nothing has been posted yet", () => {
    const html = renderManagedValue("", undefined);
    expect(html).toContain("Not posted yet");
    expect(html).not.toContain("<a ");
  });

  it("renders the bounded number beside it", () => {
    const doc = page(rows);
    const input = doc.querySelector(
      '[name="value_quotes.max_length"]',
    ) as HTMLInputElement;
    expect(input.getAttribute("data-max")).toBe("4000");
    expect(input.getAttribute("type")).toBe("text");
  });
});

describe("messageJumpUrl", () => {
  it("builds the Discord link from three snowflakes", () => {
    expect(messageJumpUrl(GUILD, CHANNEL, MESSAGE)).toBe(
      `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
    );
  });

  it.each([
    ["no channel", GUILD, "", MESSAGE],
    ["no message", GUILD, CHANNEL, ""],
    ["a non-id message", GUILD, CHANNEL, "../../evil"],
    ["a non-id channel", GUILD, "x/y", MESSAGE],
    ["a non-id guild", "guild", CHANNEL, MESSAGE],
    ["a non-string value", GUILD, undefined, MESSAGE],
  ])("returns nothing for %s", (_label, guild, channel, message) => {
    expect(messageJumpUrl(guild, channel, message)).toBeUndefined();
  });
});
