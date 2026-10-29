/* global Document, Element, HTMLInputElement, HTMLSelectElement */
/**
 * The Reaction roles forms and the Channel claims pairing choose a role, a
 * message and an emoji instead of typing ids (#1530): the picker markup, the
 * message select's own empty label, the emoji fields, a refused form drawn
 * again as typed, and the names a browser without JavaScript posts.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderReactionRolesPage,
  renderRoleSelectPicker,
} from "../../src/web/admin-views.js";
import {
  CHANNEL_PICKER_SCRIPT,
  REACTION_ROLE_MESSAGE_NEW_LABEL,
  REACTION_ROLE_MESSAGE_NONE_LABEL,
  renderReactionRoleMessageSelect,
} from "../../src/web/setting-pickers.js";
import type { RefusedForm } from "../../src/web/form-errors.js";

const BASE = {
  guildId: "g1",
  csrfToken: "csrf",
  remainingMs: 60_000,
  navFeatureStatus: {},
  enabled: true,
};
const ROLES = [
  { id: "200000000000000001", name: "Gamer <b>" },
  { id: "200000000000000002", name: "Artist" },
];
const MESSAGES = {
  options: [
    { messageId: "100000000000000001", label: "# roles · 🎮 Gamer" },
    { messageId: "100000000000000002", label: "# roles · 📚 Reader" },
  ],
  truncated: false,
};

const page = (
  over: {
    refusedForm?: RefusedForm | null;
    messages?: typeof MESSAGES | null;
  } = {},
): Document =>
  new JSDOM(
    renderReactionRolesPage({
      ...BASE,
      configChannel: null,
      active: [],
      archived: [],
      roles: ROLES,
      messages: MESSAGES,
      ...over,
    }),
  ).window.document;

const bindForm = (d: Document): Element =>
  d.querySelector('form[action="/admin/reaction-roles/bind"]') as Element;

describe("Bind an existing role (#1530)", () => {
  it("chooses the role in a Picker that still posts roleId", () => {
    const form = bindForm(page());
    expect(form.querySelector("input[name=roleId]")).toBeNull();
    const select = form.querySelector(
      "span.kb-picker[data-picker] select[name=roleId]",
    ) as HTMLSelectElement;
    expect(select.required).toBe(true);
    expect(select.getAttribute("aria-label")).toBe("Role");
    const options = [...select.options].map((o) => [o.value, o.text]);
    expect(options).toEqual([
      ["", "Choose a role"],
      ["200000000000000001", "@Gamer <b>"],
      ["200000000000000002", "@Artist"],
    ]);
    expect(select.value).toBe("");
    const meta = JSON.parse(
      form.querySelector("[data-picker]")?.getAttribute("data-picker-meta") ??
        "[]",
    );
    expect(meta).toHaveLength(3);
  });

  it("chooses the message in the message select with its own empty label", () => {
    const form = bindForm(page());
    expect(form.querySelector("input[name=messageId]")).toBeNull();
    const select = form.querySelector(
      "select[name=messageId]",
    ) as HTMLSelectElement;
    expect(select.getAttribute("aria-label")).toBe("Message");
    expect([...select.options].map((o) => [o.value, o.text])).toEqual([
      ["", "Post a new message"],
      ["100000000000000001", "# roles · 🎮 Gamer"],
      ["100000000000000002", "# roles · 📚 Reader"],
    ]);
    expect(select.value).toBe("");
    expect(form.innerHTML).not.toContain(REACTION_ROLE_MESSAGE_NONE_LABEL);
  });

  it("says a new message is posted when there are none, and keeps going when the list cannot be read", () => {
    const none = bindForm(
      page({ messages: { options: [], truncated: false } }),
    );
    expect(none.textContent).toContain(
      "There are no reaction-role messages yet, so this posts a new one.",
    );
    expect(none.querySelector('a[href="/admin/reaction-roles"]')).toBeNull();
  });

  it("falls back to a text box for the message id when the list cannot be read", () => {
    const form = bindForm(page({ messages: null }));
    expect(form.querySelector("select[name=messageId]")).toBeNull();
    const input = form.querySelector(
      "input[name=messageId]",
    ) as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.required).toBe(false);
    expect(input.maxLength).toBe(30);
    expect(input.value).toBe("");
    input.value = "100000000000000042";
    const win = form.ownerDocument.defaultView as unknown as {
      FormData: new (f: Element) => { get(n: string): unknown };
    };
    expect(new win.FormData(form).get("messageId")).toBe("100000000000000042");
    expect(form.textContent).toContain("Message ID (optional)");
    expect(input.closest("label")?.textContent).toContain(
      "Leave empty to post a new message. The id of an existing reaction-role message adds this mapping to it.",
    );
  });

  it("keeps a typed message id as typed when a refused form falls back to the text box", () => {
    const form = bindForm(
      page({
        messages: null,
        refusedForm: {
          formId: "reaction-role-bind",
          errors: { messageId: "That is not a message of mine <b>" },
          values: { roleId: "", emoji: "🎨", messageId: " 12<3> " },
        },
      }),
    );
    const input = form.querySelector(
      "input[name=messageId]",
    ) as HTMLInputElement;
    expect(input.value).toBe(" 12<3> ");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(
      "reaction-role-bind-messageId-error",
    );
    expect(form.querySelector("p.kb-field__error")?.textContent).toBe(
      "That is not a message of mine <b>",
    );
  });

  it("uses the emoji field, keeping the text box that takes custom emoji", () => {
    const form = bindForm(page());
    const field = form.querySelector("[data-emoji-field]") as Element;
    const input = field.querySelector("input[name=emoji]") as HTMLInputElement;
    expect(input.required).toBe(true);
    expect(input.maxLength).toBe(100);
    expect(input.type).toBe("text");
    expect(input.getAttribute("aria-label")).toBe("Emoji for the bound role");
    expect(
      field.querySelector("[data-marker-btn]")?.getAttribute("aria-label"),
    ).toBe("Choose an emoji for the bound role");
  });

  it("draws a refused form again with the role, emoji and message as typed", () => {
    const d = page({
      refusedForm: {
        formId: "reaction-role-bind",
        errors: { emoji: "Use at most 100 characters." },
        values: {
          roleId: "999999999999999999",
          emoji: "<:wave:1234>",
          messageId: " 555 ",
        },
      },
    });
    const form = bindForm(d);
    const role = form.querySelector("select[name=roleId]") as HTMLSelectElement;
    expect(role.value).toBe("999999999999999999");
    expect(role.selectedOptions[0].text).toContain("unavailable");
    const message = form.querySelector(
      "select[name=messageId]",
    ) as HTMLSelectElement;
    expect(message.value).toBe(" 555 ");
    expect(message.selectedOptions[0].text).toContain("not found");
    const emoji = form.querySelector("input[name=emoji]") as HTMLInputElement;
    expect(emoji.value).toBe("<:wave:1234>");
    expect(emoji.getAttribute("aria-invalid")).toBe("true");
    expect(emoji.getAttribute("aria-describedby")).toBe(
      "reaction-role-bind-emoji-error",
    );
  });

  it("keeps a chosen role and message selected when the form is refused", () => {
    const form = bindForm(
      page({
        refusedForm: {
          formId: "reaction-role-bind",
          errors: { emoji: "x" },
          values: {
            roleId: "200000000000000002",
            emoji: "🎨",
            messageId: "100000000000000002",
          },
        },
      }),
    );
    expect(
      (form.querySelector("select[name=roleId]") as HTMLSelectElement).value,
    ).toBe("200000000000000002");
    expect(
      (form.querySelector("select[name=messageId]") as HTMLSelectElement).value,
    ).toBe("100000000000000002");
  });
});

describe("the emoji boxes of the other Reaction roles forms (#1530)", () => {
  it("uses the emoji field on Create a reaction role", () => {
    const form = page().querySelector(
      'form[action="/admin/reaction-roles/create"]',
    ) as Element;
    const input = form.querySelector("[data-emoji-field] input[name=emoji]");
    expect(input?.getAttribute("aria-label")).toBe("Emoji for the new role");
    expect(input?.hasAttribute("required")).toBe(true);
  });

  it("names each option row of both group forms for the grid's button", () => {
    const d = page();
    for (const action of [
      "/admin/reaction-roles/group/create",
      "/admin/reaction-roles/group/generate",
    ]) {
      const form = d.querySelector(`form[action="${action}"]`) as Element;
      const fields = form.querySelectorAll("[data-emoji-field]");
      expect(fields.length).toBeGreaterThanOrEqual(6);
      expect(
        fields[2]
          .querySelector("[data-marker-btn]")
          ?.getAttribute("aria-label"),
      ).toMatch(/^Choose an emoji for .+: option 3$/);
      expect(fields[2].querySelector("input")?.getAttribute("name")).toBe(
        "emoji",
      );
      expect(form.querySelectorAll('input[name="emoji"]')).toHaveLength(
        fields.length,
      );
    }
  });

  it("draws a refused group form with the typed emoji and the field's error", () => {
    const d = page({
      refusedForm: {
        formId: "reaction-role-group-create",
        errors: { "emoji-1": "Not an emoji." },
        values: {
          groupName: "Colour",
          "roleName-0": "Red",
          "emoji-0": "🔴",
          "emoji-1": "<b>",
        },
      },
    });
    const form = d.querySelector(
      'form[action="/admin/reaction-roles/group/create"]',
    ) as Element;
    const inputs = form.querySelectorAll<HTMLInputElement>("input[name=emoji]");
    expect(inputs[0].value).toBe("🔴");
    expect(inputs[1].value).toBe("<b>");
    expect(inputs[1].getAttribute("aria-invalid")).toBe("true");
    expect(inputs[1].getAttribute("aria-describedby")).toBe(
      "reaction-role-group-create-emoji-1-error",
    );
  });
});

describe("renderReactionRoleMessageSelect noneLabel (#1530)", () => {
  it("labels the empty option as asked, the welcome picker keeping its own", () => {
    const html = (noneLabel?: string): string =>
      renderReactionRoleMessageSelect("messageId", "", {
        messages: MESSAGES,
        noneLabel,
      });
    expect(html(REACTION_ROLE_MESSAGE_NEW_LABEL)).toContain(
      `<option value="" selected>${REACTION_ROLE_MESSAGE_NEW_LABEL}</option>`,
    );
    expect(html()).toContain(
      `<option value="" selected>${REACTION_ROLE_MESSAGE_NONE_LABEL}</option>`,
    );
  });

  it("escapes a custom empty-list line once", () => {
    const html = renderReactionRoleMessageSelect("m", "", {
      messages: { options: [], truncated: false },
      emptyNote: "a <b> & c",
    });
    expect(html).toContain("a &lt;b&gt; &amp; c");
    expect(html).not.toContain("&amp;amp;");
  });
});

describe("the enhanced role picker keeps its name and the choice (#1530)", () => {
  const enhanced = (label: boolean): { dom: JSDOM; trigger: Element } => {
    const picker = renderRoleSelectPicker({
      id: label ? "r" : undefined,
      ariaLabel: label ? undefined : "Role",
      name: "roleId",
      options: ROLES,
      selected: "",
      emptyLabel: "Choose a role",
    });
    const dom = new JSDOM(
      `<!doctype html><body>${label ? '<label for="r">Role</label>' : ""}${picker}</body>`,
      { runScripts: "outside-only" },
    );
    dom.window.eval(CHANNEL_PICKER_SCRIPT);
    return {
      dom,
      trigger: dom.window.document.querySelector(
        ".kb-picker__trigger",
      ) as Element,
    };
  };
  const choose = (dom: JSDOM, value: string): void => {
    const select = dom.window.document.querySelector(
      "select",
    ) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };

  it("names the trigger with the choice when the select has only an aria-label", () => {
    const { dom, trigger } = enhanced(false);
    expect(trigger.getAttribute("aria-label")).toBe("Role: Choose a role");
    choose(dom, "200000000000000002");
    expect(trigger.getAttribute("aria-label")).toBe("Role: @Artist");
    choose(dom, "");
    expect(trigger.getAttribute("aria-label")).toBe("Role: Choose a role");
  });

  it("leaves a picker with a visible label to name itself from it", () => {
    const { trigger } = enhanced(true);
    expect(trigger.hasAttribute("aria-label")).toBe(false);
    expect(trigger.getAttribute("aria-labelledby")).toContain(trigger.id);
  });
});

describe("the notes under the message select when an id is retained (#1530)", () => {
  const refused = (messages: typeof MESSAGES | null): Element =>
    bindForm(
      page({
        messages,
        refusedForm: {
          formId: "reaction-role-bind",
          errors: { emoji: "x" },
          values: { roleId: "", emoji: "", messageId: "100000000000000009" },
        },
      }),
    );

  it("does not promise a new message for an empty list while one stays selected", () => {
    const form = refused({ options: [], truncated: false });
    const select = form.querySelector(
      "select[name=messageId]",
    ) as HTMLSelectElement;
    expect(select.value).toBe("100000000000000009");
    const note = form.querySelector(".kb-msgpick .kb-help")?.textContent ?? "";
    expect(note).toContain("Choose Post a new message to start a new one.");
    expect(note).not.toContain("this posts a new one");
  });

  it("keeps the plain wording when no id is retained", () => {
    expect(
      bindForm(page({ messages: { options: [], truncated: false } }))
        .textContent,
    ).toContain("yet, so this posts a new one.");
  });
});
