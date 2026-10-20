/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global HTMLElement, document */
/**
 * The settings form controls (#1318): switch, segmented control, reset
 * button, description split and the dependency tree. Markup is checked through
 * a DOM, never with regular expressions over HTML.
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildSettingTree,
  renderChangedMark,
  renderResetControl,
  renderSegmented,
  renderSwitch,
  segmentedFits,
  splitDescription,
  type SettingNode,
} from "../../src/web/setting-controls.js";

function dom(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

const OPTIONS = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "alltime", label: "All time" },
];

describe("renderSwitch", () => {
  it("is a real checkbox with role=switch and no companion field", () => {
    const host = dom(
      renderSwitch("value_a.enabled", true, {
        id: "set-a.enabled",
        labelledBy: "set-a.enabled-label",
        describedBy: "set-a.enabled-help",
      }),
    );
    const inputs = host.querySelectorAll("input");
    // One input only: an unchecked switch posts nothing and the save handlers
    // read a listed-but-absent key as false, so no hidden "false" field.
    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    expect(input.type).toBe("checkbox");
    expect(input.getAttribute("role")).toBe("switch");
    expect(input.name).toBe("value_a.enabled");
    expect(input.value).toBe("true");
    expect(input.checked).toBe(true);
    expect(input.id).toBe("set-a.enabled");
    expect(input.getAttribute("aria-labelledby")).toBe("set-a.enabled-label");
    expect(input.getAttribute("aria-describedby")).toBe("set-a.enabled-help");
    // checked state is the native attribute, not a duplicate aria-checked
    expect(input.hasAttribute("aria-checked")).toBe(false);
  });

  it("draws the On/Off text from CSS and hides it from assistive tech", () => {
    const host = dom(renderSwitch("v", false));
    const label = host.querySelector("label");
    expect(label?.className).toBe("kb-switch");
    const state = host.querySelector(".kb-switch__state");
    expect(state?.textContent).toBe("");
    expect(state?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".kb-switch__track")).not.toBeNull();
  });

  it("renders unchecked without the checked attribute", () => {
    const input = dom(renderSwitch("v", false)).querySelector("input");
    expect(input?.checked).toBe(false);
    expect(input?.hasAttribute("checked")).toBe(false);
  });

  it("marks a locked switch disabled and dep-locked, and an invalid one aria-invalid", () => {
    const locked = dom(
      renderSwitch("v", true, { disabled: true }),
    ).querySelector("input");
    expect(locked?.disabled).toBe(true);
    expect(locked?.hasAttribute("data-dep-locked")).toBe(true);
    const invalid = dom(
      renderSwitch("v", true, { invalid: true, describedByBase: "h" }),
    ).querySelector("input");
    expect(invalid?.getAttribute("aria-invalid")).toBe("true");
    expect(invalid?.getAttribute("data-describedby-base")).toBe("h");
  });

  it("escapes the field name and keeps extra attributes", () => {
    const input = dom(
      renderSwitch('a"><script>x</script>', true, {}, " data-cascade-master"),
    ).querySelector("input");
    expect(input?.name).toBe('a"><script>x</script>');
    expect(input?.hasAttribute("data-cascade-master")).toBe(true);
    expect(
      dom(renderSwitch('a"><b>', true)).querySelector("script"),
    ).toBeNull();
  });
});

describe("renderSegmented", () => {
  it("is a radiogroup named by aria-labelledby, one radio per option", () => {
    const host = dom(
      renderSegmented("value_p", OPTIONS, "month", {
        id: "set-p",
        labelledBy: "set-p-label",
        describedBy: "set-p-help",
      }),
    );
    const group = host.querySelector("div.kb-segmented");
    expect(group?.getAttribute("role")).toBe("radiogroup");
    expect(group?.id).toBe("set-p");
    expect(group?.getAttribute("aria-labelledby")).toBe("set-p-label");
    expect(group?.getAttribute("aria-describedby")).toBe("set-p-help");
    const radios = Array.from(host.querySelectorAll("input"));
    expect(radios.map((r) => r.type)).toEqual(["radio", "radio", "radio"]);
    expect(radios.map((r) => r.value)).toEqual(["week", "month", "alltime"]);
    expect(radios.map((r) => r.name)).toEqual(Array(3).fill("value_p"));
    expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
    // unique ids, distinct from the group's own id
    expect(radios.map((r) => r.id)).toEqual(["set-p-0", "set-p-1", "set-p-2"]);
    // each radio sits in a label with its visible text
    expect(
      Array.from(host.querySelectorAll("label")).map((l) => l.textContent),
    ).toEqual(["This week", "This month", "All time"]);
  });

  it("marks every radio disabled when locked and the group aria-invalid when rejected", () => {
    const locked = dom(
      renderSegmented("v", OPTIONS, "week", { disabled: true }),
    );
    expect(
      Array.from(locked.querySelectorAll("input")).every((r) => r.disabled),
    ).toBe(true);
    const invalid = dom(
      renderSegmented("v", OPTIONS, "week", { invalid: true }),
    ).querySelector("div");
    expect(invalid?.getAttribute("aria-invalid")).toBe("true");
  });

  it("escapes option values and labels", () => {
    const host = dom(
      renderSegmented("v", [{ value: 'x"y', label: "<i>a</i>" }], 'x"y'),
    );
    expect(host.querySelector("i")).toBeNull();
    expect(host.querySelector("input")?.value).toBe('x"y');
    expect(host.querySelector("span")?.textContent).toBe("<i>a</i>");
  });
});

describe("segmentedFits", () => {
  it("accepts two to four short options with a known current value", () => {
    expect(segmentedFits(OPTIONS.slice(0, 2), "week")).toBe(true);
    expect(segmentedFits(OPTIONS, "alltime")).toBe(true);
    const four = [...OPTIONS, { value: "year", label: "This year" }];
    expect(segmentedFits(four, "year")).toBe(true);
  });

  it("keeps a select for fewer than two or more than four options", () => {
    expect(segmentedFits(OPTIONS.slice(0, 1), "week")).toBe(false);
    expect(segmentedFits(undefined, "week")).toBe(false);
    const five = [
      ...OPTIONS,
      { value: "year", label: "This year" },
      { value: "day", label: "Today" },
    ];
    expect(segmentedFits(five, "week")).toBe(false);
  });

  it("keeps a select for long labels", () => {
    expect(
      segmentedFits(
        [
          { value: "a", label: "Direct message (ephemeral fallback)" },
          { value: "b", label: "Ephemeral reply" },
        ],
        "a",
      ),
    ).toBe(false);
  });

  it("keeps a select when the current value is not an option, so it is not lost on save", () => {
    expect(segmentedFits(OPTIONS, "fortnight")).toBe(false);
    expect(segmentedFits(OPTIONS, "")).toBe(false);
  });
});

describe("renderResetControl and renderChangedMark", () => {
  it("names the setting and its default, and submits the card's reset form", () => {
    const host = dom(
      renderResetControl("a.b", "Cleanup <log>", "On", "form-core-reset"),
    );
    const button = host.querySelector("button");
    expect(button?.getAttribute("form")).toBe("form-core-reset");
    expect(button?.name).toBe("key");
    expect(button?.value).toBe("a.b");
    expect(button?.type).toBe("submit");
    expect(button?.getAttribute("aria-label")).toBe(
      "Reset Cleanup <log> to its default, On",
    );
    expect(host.querySelector(".kb-setting__default")?.textContent).toBe(
      "Default: On",
    );
    expect(host.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector("b, script, log")).toBeNull();
  });

  it("falls back to the key when the row has no label", () => {
    const button = dom(renderResetControl("a.b", "", "x", "f")).querySelector(
      "button",
    );
    expect(button?.getAttribute("aria-label")).toBe(
      "Reset a.b to its default, x",
    );
  });

  it("marks a changed row with a dot and a visually hidden text", () => {
    const host = dom(renderChangedMark());
    expect(host.querySelector(".kb-setting__changed")).not.toBeNull();
    expect(host.querySelector(".kb-visually-hidden")?.textContent).toBe(
      " (changed)",
    );
  });
});

describe("splitDescription", () => {
  it("keeps a short description whole", () => {
    expect(splitDescription("Turn it on.")).toEqual({
      short: "Turn it on.",
      rest: "",
    });
  });

  it("puts everything after the first sentence behind More for a long one", () => {
    const long =
      "How long a session is kept before it is pruned from the database. " +
      "Set 0 to keep sessions forever; shorter windows free space sooner and make the Rewind recap smaller. " +
      "Existing rows are pruned on the next run.";
    const { short, rest } = splitDescription(long);
    expect(short).toBe(
      "How long a session is kept before it is pruned from the database.",
    );
    expect(rest.startsWith("Set 0 to keep sessions forever")).toBe(true);
    expect(`${short} ${rest}`).toBe(long);
  });

  it("does not split after e.g. or i.e.", () => {
    const long =
      "Channels the bot may use for announcements (e.g. a general channel) and similar places where members read. " +
      "Pick one the bot can post in. " +
      "x".repeat(60);
    const { short } = splitDescription(long);
    expect(short).toContain("(e.g. a general channel)");
  });

  it("keeps one long sentence whole", () => {
    const long = "word ".repeat(40).trim();
    expect(splitDescription(long)).toEqual({ short: long, rest: "" });
  });
});

describe("buildSettingTree", () => {
  const keys = (nodes: SettingNode<{ key: string }>[]): unknown[] =>
    nodes.map((n) => [n.row.key, keys(n.children)]);
  const rows = (...ks: string[]): { key: string }[] =>
    ks.map((key) => ({ key }));
  const none = (): string[] => [];
  const on = (): boolean => true;

  it("nests every other row under the master toggle", () => {
    const tree = buildSettingTree(
      rows("a.enabled", "a.x", "a.y"),
      "a.enabled",
      none,
      on,
    );
    expect(keys(tree)).toEqual([
      [
        "a.enabled",
        [
          ["a.x", []],
          ["a.y", []],
        ],
      ],
    ]);
  });

  it("nests a dependent under its parent, recursively, wherever it sits in the input", () => {
    const deps: Record<string, string[]> = {
      "a.child": ["a.parent"],
      "a.grandchild": ["a.child"],
    };
    const tree = buildSettingTree(
      rows("a.grandchild", "a.child", "a.parent", "a.other"),
      null,
      (k) => deps[k] ?? [],
      on,
    );
    expect(keys(tree)).toEqual([
      ["a.parent", [["a.child", [["a.grandchild", []]]]]],
      ["a.other", []],
    ]);
  });

  it("prefers an off in-form dependency as the parent", () => {
    const tree = buildSettingTree(
      rows("a.p1", "a.p2", "a.c"),
      null,
      (k) => (k === "a.c" ? ["a.p1", "a.p2"] : []),
      (k) => k !== "a.p2",
    );
    expect(keys(tree)).toEqual([
      ["a.p1", []],
      ["a.p2", [["a.c", []]]],
    ]);
  });

  it("leaves a row whose dependency is not in the form at the top level (or under the master)", () => {
    const deps = (k: string): string[] =>
      k === "a.c" ? ["other.enabled"] : [];
    expect(keys(buildSettingTree(rows("a.c"), null, deps, on))).toEqual([
      ["a.c", []],
    ]);
    expect(
      keys(buildSettingTree(rows("a.enabled", "a.c"), "a.enabled", deps, on)),
    ).toEqual([["a.enabled", [["a.c", []]]]]);
  });

  it("ignores a dependency cycle and still renders every row exactly once", () => {
    const deps: Record<string, string[]> = { "a.x": ["a.y"], "a.y": ["a.x"] };
    const tree = buildSettingTree(
      rows("a.x", "a.y"),
      null,
      (k) => deps[k] ?? [],
      on,
    );
    const flat: string[] = [];
    const walk = (n: SettingNode<{ key: string }>[]): void =>
      n.forEach((x) => {
        flat.push(x.row.key);
        walk(x.children);
      });
    walk(tree);
    expect(flat.sort()).toEqual(["a.x", "a.y"]);
  });
});
