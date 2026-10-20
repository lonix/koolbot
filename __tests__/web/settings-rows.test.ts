/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global HTMLInputElement, HTMLElement, HTMLFormElement, HTMLButtonElement, HTMLOptionElement, Document, DOMParser */
/**
 * The settings rows as the Settings page and the feature cards render them
 * (#1318): switches, segmented controls, selects for long lists, changed-value
 * dot and reset, More, and dependents nested under their parent. Markup is
 * checked through a DOM, never with regular expressions over HTML.
 */

import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderFeatureSettingsCard,
  renderSettingsPage,
  type SettingRow,
} from "../../src/web/admin-views.js";

const COMMON = { csrfToken: "tok", remainingMs: 60_000 };

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

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function settingsPage(rows: SettingRow[], category = "x"): Document {
  return parse(
    renderSettingsPage({
      ...COMMON,
      textChannels: [],
      voiceChannels: [],
      categoryChannels: [],
      roles: [],
      guildId: "g",
      guildName: "G",
      groups: [{ category, rows }],
    }),
  );
}

function card(
  rows: SettingRow[],
  dependencyState?: ReadonlyMap<string, boolean>,
): Document {
  return parse(
    renderFeatureSettingsCard({
      category: "x",
      settingRows: rows,
      returnTo: "/admin/x",
      csrfToken: "tok",
      dependencyState,
    }),
  );
}

const PERIOD = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "alltime", label: "All time" },
];

describe.each([
  ["the Settings page", settingsPage],
  ["a feature card", card],
] as const)("controls on %s", (_name, render) => {
  it("renders a boolean as a switch named by the row", () => {
    const doc = render([
      row({
        key: "x.flag",
        type: "boolean",
        label: "Flag",
        current: true,
        defaultValue: true,
        description: "Turn the flag on.",
      }),
    ]);
    const input = doc.querySelector<HTMLInputElement>(
      "input[type=checkbox][role=switch]",
    );
    expect(input).not.toBeNull();
    expect(input?.checked).toBe(true);
    expect(input?.name).toBe("value_x.flag");
    expect(input?.closest("label.kb-switch")).not.toBeNull();
    // named by the row name, described by its one-line help
    const nameId = input?.getAttribute("aria-labelledby") ?? "";
    expect(doc.getElementById(nameId)?.textContent).toBe("Flag");
    const helpId = input?.getAttribute("aria-describedby") ?? "";
    expect(doc.getElementById(helpId)?.textContent).toBe("Turn the flag on.");
    // no select-style "Off: / On:" text and no old true/false text
    expect(doc.querySelector(".kb-switch__state")?.textContent).toBe("");
  });

  it("renders an enum of two to four options as a segmented control", () => {
    const doc = render([
      row({
        key: "x.period",
        type: "string",
        label: "Period",
        current: "month",
        defaultValue: "month",
        options: PERIOD,
      }),
    ]);
    const group = doc.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group?.id).toBe("set-x.period");
    const nameId = group?.getAttribute("aria-labelledby") ?? "";
    expect(doc.getElementById(nameId)?.textContent).toBe("Period");
    // the row name of a group is not a <label for> pointing at a div
    expect(doc.querySelector('label[for="set-x.period"]')).toBeNull();
    const radios = Array.from(
      group?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? [],
    );
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ["week", false],
      ["month", true],
      ["alltime", false],
    ]);
    expect(doc.querySelector("select")).toBeNull();
  });

  it("keeps a select for more than four options", () => {
    const doc = render([
      row({
        key: "x.period",
        type: "string",
        current: "month",
        defaultValue: "month",
        options: [
          ...PERIOD,
          { value: "year", label: "This year" },
          { value: "day", label: "Today" },
        ],
      }),
    ]);
    expect(doc.querySelector("select.kb-select")).not.toBeNull();
    expect(doc.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("keeps a select when the stored value is not one of the options", () => {
    const doc = render([
      row({
        key: "x.period",
        type: "string",
        current: "fortnight",
        defaultValue: "week",
        options: PERIOD,
      }),
    ]);
    expect(doc.querySelector('[role="radiogroup"]')).toBeNull();
    expect(
      doc.querySelector<HTMLOptionElement>("select option:checked")?.value,
    ).toBe("fortnight");
  });

  it("shows no dot and no reset for a value at its default, and no type badge", () => {
    const doc = render([
      row({ key: "x.n", type: "number", current: 5, defaultValue: 5 }),
    ]);
    expect(doc.querySelector(".kb-setting__changed")).toBeNull();
    expect(doc.querySelector('button[name="key"]')).toBeNull();
    expect(doc.querySelector(".tag")).toBeNull();
    expect(doc.querySelector("table")).toBeNull();
  });

  it("shows a dot and a reset button naming the default for a changed value", () => {
    const doc = render([
      row({
        key: "x.flag",
        type: "boolean",
        label: "Flag",
        current: false,
        defaultValue: true,
      }),
      row({
        key: "x.n",
        type: "number",
        label: "Count",
        current: 2,
        defaultValue: 10,
      }),
      row({
        key: "x.period",
        type: "string",
        label: "Period",
        current: "week",
        defaultValue: "month",
        options: PERIOD,
      }),
      row({
        key: "x.name",
        type: "string",
        label: "Name",
        current: "hi",
        defaultValue: "",
      }),
    ]);
    const labels = Array.from(
      doc.querySelectorAll<HTMLButtonElement>('button[name="key"]'),
    ).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Reset Flag to its default, On",
      "Reset Count to its default, 10",
      "Reset Period to its default, This month",
      "Reset Name to its default, not set",
    ]);
    expect(doc.querySelectorAll(".kb-setting__changed")).toHaveLength(4);
    expect(doc.body.textContent).not.toContain("Default:");
    expect(doc.querySelector(".kb-setting__default")).toBeNull();
    expect(doc.body.textContent).toContain("(changed)");
  });

  it("truncates a very long default in the reset label and keeps it whole in the title", () => {
    const long = "Welcome to the server, please read the rules. ".repeat(4);
    const doc = render([
      row({
        key: "x.msg",
        type: "string",
        label: "Message",
        current: "hi",
        defaultValue: long,
      }),
    ]);
    const button = doc.querySelector<HTMLButtonElement>('button[name="key"]');
    const label = button?.getAttribute("aria-label") ?? "";
    expect(label.length).toBeLessThan(100);
    expect(label.endsWith("…")).toBe(true);
    expect(button?.getAttribute("title")).toBe(`Reset to default: ${long}`);
    expect(doc.body.textContent).not.toContain("Welcome to the server");
  });

  it("submits reset through a sibling form, never as a button of the save form", () => {
    const doc = render([
      row({ key: "x.n", type: "number", current: 2, defaultValue: 10 }),
    ]);
    const save = doc.querySelector<HTMLFormElement>(
      'form[action="/admin/settings/save-section"]',
    ) as HTMLFormElement;
    const button = doc.querySelector<HTMLButtonElement>(
      'button[name="key"]',
    ) as HTMLButtonElement;
    // It sits in the row, but its `form` attribute makes the reset form its
    // owner, so it is not a button of the save form.
    const target = doc.getElementById(button.getAttribute("form") ?? "");
    expect(target?.tagName).toBe("FORM");
    expect(target?.getAttribute("action")).toBe("/admin/settings/reset");
    expect(button.form).toBe(target);
    expect(button.form).not.toBe(save);
    expect(
      target?.querySelector<HTMLInputElement>('input[name="_csrf"]')?.value,
    ).toBe("tok");
    // The only submit button owned by the save form is Save, so Enter in a
    // text field saves instead of resetting a row.
    const owned = Array.from(
      doc.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
    ).filter((b) => b.form === save);
    expect(owned).toHaveLength(1);
    expect(owned[0].textContent).toMatch(/^Save/);
  });

  it("puts the long part of a description and the key behind More", () => {
    const long =
      "How long a session is kept before it is pruned from the database. " +
      "Set 0 to keep sessions forever; shorter windows free space sooner and make the recap smaller. " +
      "Existing rows are pruned on the next run.";
    const doc = render([
      row({
        key: "x.days",
        type: "number",
        current: 3,
        defaultValue: 3,
        description: long,
      }),
    ]);
    expect(doc.querySelector(".kb-setting__desc")?.textContent).toBe(
      "How long a session is kept before it is pruned from the database.",
    );
    const more = doc.querySelector("details.kb-disclosure--inline");
    expect(more?.querySelector("summary")?.textContent).toContain("More");
    expect(more?.textContent).toContain("Set 0 to keep sessions forever");
    expect(more?.querySelector("code.kb-mono")?.textContent).toBe("x.days");
    // collapsed by default
    expect(more?.hasAttribute("open")).toBe(false);
  });

  it("lists every key exactly once, with unique ids, nested or not", () => {
    const rows = [
      row({
        key: "x.enabled",
        type: "boolean",
        current: true,
        defaultValue: false,
      }),
      row({ key: "x.a", type: "number", current: 1, defaultValue: 2 }),
      row({ key: "x.b", type: "string", current: "q", defaultValue: "" }),
      row({ key: "x.c", type: "boolean", current: false, defaultValue: true }),
    ];
    const doc = render(rows);
    const keys = Array.from(
      doc.querySelectorAll<HTMLInputElement>('input[name="keys"]'),
    ).map((i) => i.value);
    expect(keys.sort()).toEqual(rows.map((r) => r.key).sort());
    const ids = Array.from(doc.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("escapes the label, description and values", () => {
    const doc = render([
      row({
        key: "x.name",
        type: "string",
        label: '<img src=x onerror="1">',
        current: '"><script>1</script>',
        defaultValue: "",
        description: "<b>bold</b>",
      }),
    ]);
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("b")).toBeNull();
    expect(doc.querySelector("main script, .kb-settings script")).toBeNull();
    expect(doc.querySelector<HTMLInputElement>("input[type=text]")?.value).toBe(
      '"><script>1</script>',
    );
  });
});

describe("dependent settings nest under their parent (#1299, #1318)", () => {
  const master = row({
    key: "voicetracking.enabled",
    type: "boolean",
    label: "Voice tracking",
    current: false,
    defaultValue: false,
    category: "voicetracking",
  });
  const child = row({
    key: "voicetracking.announcements.enabled",
    type: "boolean",
    label: "Announcements",
    current: true,
    defaultValue: false,
    category: "voicetracking",
  });

  it("renders a child inside its parent's row, disabled only while the parent is right above it", () => {
    const doc = card([child, master]);
    const parentRow = doc
      .querySelector("#set-voicetracking\\.enabled")
      ?.closest(".kb-setting") as HTMLElement;
    const nested = parentRow.querySelector(
      ":scope > .kb-setting__extra > .kb-nested",
    );
    expect(nested).not.toBeNull();
    const childInput = nested?.querySelector<HTMLInputElement>(
      "#set-voicetracking\\.announcements\\.enabled",
    );
    expect(childInput).not.toBeNull();
    // parent is off, so the child is locked and says why, directly under it
    expect(childInput?.disabled).toBe(true);
    expect(nested?.querySelector(".settings-dep-hint")?.textContent).toContain(
      "Requires",
    );
    expect(nested?.querySelector(".kb-setting--locked")).not.toBeNull();
    // the parent's own row is not locked
    expect(parentRow.classList.contains("kb-setting--locked")).toBe(false);
    // the child is not also rendered as a top-level sibling
    expect(
      doc.querySelectorAll("#set-voicetracking\\.announcements\\.enabled"),
    ).toHaveLength(1);
  });

  it("leaves the child enabled when the parent is on", () => {
    const doc = card([{ ...master, current: true }, child]);
    const childInput = doc.querySelector<HTMLInputElement>(
      "#set-voicetracking\\.announcements\\.enabled",
    );
    expect(childInput?.disabled).toBe(false);
    expect(childInput?.closest(".kb-nested")).not.toBeNull();
    expect(doc.querySelector(".kb-setting--locked")).toBeNull();
  });

  it("nests the feature's other settings under the master toggle", () => {
    const doc = card([
      row({
        key: "quotes.enabled",
        type: "boolean",
        current: true,
        defaultValue: true,
      }),
      row({
        key: "quotes.max_length",
        type: "number",
        current: 5,
        defaultValue: 5,
      }),
    ]);
    const nested = doc.querySelector(".kb-nested");
    expect(nested?.querySelector("#set-quotes\\.max_length")).not.toBeNull();
    expect(nested?.querySelector("#set-quotes\\.enabled")).toBeNull();
  });

  it("shows a row whose parent is on another card without a control, naming what to turn on", () => {
    const dependent = row({
      key: "digest.include_achievements",
      type: "boolean",
      label: "Include achievements",
      current: true,
      defaultValue: false,
      category: "digest",
    });
    const doc = card([dependent], new Map([["achievements.enabled", false]]));
    // No disabled control without its parent right above it...
    expect(doc.querySelector("#set-digest\\.include_achievements")).toBeNull();
    expect(doc.querySelector("input[type=checkbox]")).toBeNull();
    // ...the row says what it needs...
    expect(doc.querySelector(".settings-dep-hint")?.textContent).toContain(
      "Requires",
    );
    // ...and its stored value stays in the form, so a save cannot flip it.
    expect(
      doc.querySelector<HTMLInputElement>(
        'input[type=hidden][name="value_digest.include_achievements"]',
      )?.value,
    ).toBe("true");
    expect(
      doc.querySelector<HTMLInputElement>('input[name="keys"]')?.value,
    ).toBe("digest.include_achievements");
  });

  it("links the missing dependency to its section on the Settings page", () => {
    const dependent = row({
      key: "digest.include_achievements",
      type: "boolean",
      current: true,
      defaultValue: false,
      category: "digest",
    });
    const doc = settingsPage([dependent], "digest");
    expect(
      doc.querySelector('.settings-dep-hint a[href="#section-achievements"]'),
    ).not.toBeNull();
  });
});

describe("cascade script on the new rows (#485, #666, #1318)", () => {
  function pageDom(rows: SettingRow[], category: string): JSDOM {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [],
      voiceChannels: [],
      categoryChannels: [],
      roles: [],
      guildId: "g",
      guildName: "G",
      groups: [{ category, rows }],
    });
    return new JSDOM(html, { runScripts: "dangerously" });
  }

  it("disables and dims the nested settings while the master is off, and restores them", () => {
    const dom = pageDom(
      [
        row({
          key: "quotes.enabled",
          type: "boolean",
          current: true,
          defaultValue: true,
        }),
        row({
          key: "quotes.max_length",
          type: "number",
          current: 5,
          defaultValue: 5,
        }),
      ],
      "quotes",
    );
    const doc = dom.window.document;
    const master = doc.querySelector<HTMLInputElement>(
      "#set-quotes\\.enabled",
    ) as HTMLInputElement;
    const child = doc.querySelector<HTMLInputElement>(
      "#set-quotes\\.max_length",
    ) as HTMLInputElement;
    const childRow = child.closest(".kb-setting") as HTMLElement;
    expect(child.disabled).toBe(false);
    expect(childRow.classList.contains("is-inactive")).toBe(false);

    master.checked = false;
    master.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(child.disabled).toBe(true);
    expect(childRow.classList.contains("is-inactive")).toBe(true);
    // the master's own row is never dimmed by its own switch
    expect(
      master.closest(".kb-setting")?.classList.contains("is-inactive"),
    ).toBe(false);

    master.checked = true;
    master.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(child.disabled).toBe(false);
    expect(childRow.classList.contains("is-inactive")).toBe(false);
  });

  it("keeps a dependency-locked child disabled and dimmed when the section master is on", () => {
    const dom = pageDom(
      [
        row({
          key: "voicetracking.enabled",
          type: "boolean",
          current: false,
          defaultValue: false,
          category: "voicetracking",
        }),
        row({
          key: "voicetracking.announcements.enabled",
          type: "boolean",
          current: true,
          defaultValue: false,
          category: "voicetracking",
        }),
      ],
      "voicetracking",
    );
    const doc = dom.window.document;
    const master = doc.querySelector<HTMLInputElement>(
      "#set-voicetracking\\.enabled",
    ) as HTMLInputElement;
    const child = doc.querySelector<HTMLInputElement>(
      "#set-voicetracking\\.announcements\\.enabled",
    ) as HTMLInputElement;
    master.checked = true;
    master.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    // The lock is rendered from the saved state: it outlasts the cascade
    // toggling, which only ever adds disabling to a locked control.
    expect(child.disabled).toBe(true);
    expect(
      child.closest(".kb-setting")?.classList.contains("kb-setting--locked"),
    ).toBe(true);
  });
});

describe("a master that waits on another card keeps guarding its children (#485, #666)", () => {
  const rows = (masterOn: boolean): SettingRow[] => [
    row({
      key: "digest.enabled",
      type: "boolean",
      label: "Digest",
      current: masterOn,
      defaultValue: false,
      category: "digest",
    }),
    row({
      key: "digest.channel_id",
      type: "string",
      label: "Digest channel",
      current: "123",
      defaultValue: "",
      category: "digest",
    }),
  ];

  it("locks the children while the master is off and waiting for voice tracking", () => {
    const doc = card(rows(false), new Map([["voicetracking.enabled", false]]));
    // The master has no control (its parent is on another card)...
    expect(doc.querySelector("#set-digest\\.enabled")).toBeNull();
    expect(doc.querySelector("[data-cascade-master]")).toBeNull();
    // ...so its children must not be left editable: the save would write only
    // the master and silently drop their edits.
    const child = doc.querySelector<HTMLInputElement>(
      "#set-digest\\.channel_id",
    );
    expect(child?.disabled).toBe(true);
    expect(child?.hasAttribute("data-dep-locked")).toBe(true);
    expect(child?.closest(".kb-setting--locked")).not.toBeNull();
    // their stored value still travels with the form
    expect(
      doc.querySelector<HTMLInputElement>(
        'input[type=hidden][name="value_digest.channel_id"]',
      )?.value,
    ).toBe("123");
  });

  it("leaves the children editable when the stored master is on, as the server will write them", () => {
    const doc = card(rows(true), new Map([["voicetracking.enabled", false]]));
    const child = doc.querySelector<HTMLInputElement>(
      "#set-digest\\.channel_id",
    );
    expect(child).not.toBeNull();
    expect(child?.disabled).toBe(false);
  });
});

describe("the AJAX save script and reset buttons (#555, #1318)", () => {
  it("disables the Save button, not a reset button, while a save is in flight", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [],
      voiceChannels: [],
      categoryChannels: [],
      roles: [],
      guildId: "g",
      guildName: "G",
      groups: [
        {
          category: "x",
          rows: [
            row({ key: "x.n", type: "number", current: 2, defaultValue: 10 }),
          ],
        },
      ],
    });
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      beforeParse(window) {
        // a save that never answers, so the in-flight state can be observed
        (window as unknown as { fetch: () => Promise<never> }).fetch = () =>
          new Promise<never>(() => undefined);
      },
    });
    const doc = dom.window.document;
    const form = doc.querySelector<HTMLFormElement>(
      'form[action="/admin/settings/save-section"]',
    ) as HTMLFormElement;
    form.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    const reset = doc.querySelector<HTMLButtonElement>('button[name="key"]');
    const save = Array.from(
      doc.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
    ).find((b) => b.form === form);
    expect(reset).not.toBeNull();
    expect(save?.disabled).toBe(true);
    expect(reset?.disabled).toBe(false);
  });
});
