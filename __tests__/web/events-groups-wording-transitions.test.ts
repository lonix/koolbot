/* global HTMLFormElement, HTMLSelectElement, HTMLInputElement, HTMLElement, Document */
/**
 * Leaving or changing the checked preset must never leave a wording dropdown
 * showing one word while a submit saves another (#1471, review of #1614). Every
 * step of the table runs the real page script in jsdom, reads what the form
 * would post through parseGroupForm + validateGroupSetup, and checks that the
 * displayed word, the saved word and (for the builder) the generated names agree.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { JSDOM } from "jsdom";

jest.unstable_mockModule("../../src/models/event-group-last-setup.js", () => ({
  EventGroupLastSetup: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { prefillFromStored } =
  await import("../../src/services/event-last-setup-service.js");
const { parseGroupForm, validateGroupSetup } =
  await import("../../src/services/event-groups.js");
const { renderAdminNewEvent } = await import("./new-event-page-helper.js");
const { renderNewEventBody } = await import("../../src/web/event-new-view.js");

const rows = [
  { name: "A", kind: "team" as const, size: null, tag: "", marker: "" },
  { name: "B", kind: "team" as const, size: null, tag: "", marker: "" },
];
const crew = {
  id: "lib:crew",
  label: "Crew night",
  description: "",
  groupLabel: "Crew",
  leaderLabel: "Boss",
  groups: rows,
};
const raid = {
  id: "lib:raid",
  label: "Raid night",
  description: "",
  groupLabel: "Raid",
  groups: rows,
};
const presets = [crew, raid];
const wording = { group: "Team", leader: "Leader" };

function prefill() {
  const out = prefillFromStored(
    {
      presetId: crew.id,
      groupLabel: "Crew",
      leaderLabel: "Boss",
      channelLeadMinutes: null,
      groups: rows,
      captainsEnabled: true,
      captainCustomisationEnabled: false,
      captainsLobby: false,
      tagsEnabled: false,
      tagsSuffix: false,
    },
    { maxCount: 15, presets, wording },
  );
  if (!out) throw new Error("expected a prefill");
  return { prefill: out, resetHref: null };
}

type Form = "admin" | "member";

function page(
  form: Form,
  draft?: Record<string, unknown>,
  scripts = true,
): JSDOM {
  const remembered = prefill();
  let html =
    form === "admin"
      ? renderAdminNewEvent({
          groupRemembered: remembered,
          groupPresets: presets,
          groupLimits: { defaultCount: 2, maxCount: 15, wording },
        })
      : renderNewEventBody({
          csrfToken: "csrf",
          timezone: "UTC",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 15, wording },
          groupPresets: presets,
          groupPresetsNotice: null,
          groupRemembered: remembered,
        });
  if (draft) {
    html = html.replace(
      "<form",
      '<div class="notice err" data-flash>Groups: nope</div><form',
    );
  }
  const dom = new JSDOM(html, {
    url: "http://localhost/events/new",
    runScripts: "outside-only",
  });
  if (draft) {
    dom.window.sessionStorage.setItem(
      "koolbot-event-form-draft",
      JSON.stringify(draft),
    );
  }
  if (!scripts) return dom;
  const sources = [
    ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  dom.window.eval(sources.find((c) => c.includes("koolGroupRows="))!);
  dom.window.eval(sources.find((c) => c.includes("koolbot-event-form-draft"))!);
  return dom;
}

const doc = (dom: JSDOM): Document => dom.window.document;
const form = (dom: JSDOM): HTMLFormElement =>
  doc(dom).querySelector("form[data-event-form]") as HTMLFormElement;
const el = <T extends HTMLElement>(dom: JSDOM, name: string): T =>
  form(dom).elements.namedItem(name) as unknown as T;

/** The word a dropdown shows. */
function shown(dom: JSDOM, kind: "group" | "leader"): string {
  const base = kind === "group" ? "groups_label" : "groups_leader_label";
  const s = el<HTMLSelectElement>(dom, `${base}_choice`);
  if (s.value === "custom") return el<HTMLInputElement>(dom, base).value;
  if (s.value) return s.value;
  const text = s.options[s.selectedIndex].textContent ?? "";
  return /\((.*)\)$/.exec(text)![1];
}

/** What posting the form unchanged saves. */
function saved(dom: JSDOM): { group: string; leader: string } {
  const body: Record<string, string> = { groups_enabled: "1" };
  for (const e of Array.from(form(dom).elements) as HTMLInputElement[]) {
    if (!e.name || e.disabled) continue;
    if (e.type === "radio" || e.type === "checkbox") {
      if (e.checked) body[e.name] = e.value;
    } else body[e.name] = e.value;
  }
  const result = validateGroupSetup(parseGroupForm(body), {
    maxCount: 15,
    wording,
    resolvePreset: (id) => {
      const p = presets.find((x) => x.id === id);
      return p ? { preset: p } : { refused: "unknown" };
    },
  });
  if (!result.ok) throw new Error(result.errors.join(" "));
  return { group: result.setup.groupLabel, leader: result.setup.leaderLabel };
}

function card(dom: JSDOM, value: string): HTMLInputElement {
  return form(dom).querySelector(
    `input[type=radio][name=groups_preset][value="${value}"]`,
  ) as HTMLInputElement;
}
function choose(dom: JSDOM, value: string): void {
  const c = card(dom, value);
  c.checked = true;
  c.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}
function generate(dom: JSDOM): void {
  (form(dom).querySelector("[data-build-count]") as HTMLInputElement).value =
    "2";
  (
    form(dom).querySelector(
      "input[name=groups_build_names][value=numbers]",
    ) as HTMLInputElement
  ).checked = true;
  (form(dom).querySelector("[data-build]") as HTMLElement).click();
}

const steps: Array<{
  name: string;
  run: (dom: JSDOM) => void;
  expected: { group: string; leader: string };
  names?: string;
}> = [
  {
    name: "as rendered",
    run: () => {},
    expected: { group: "Crew", leader: "Boss" },
  },
  {
    name: "Generate names (leaves the preset)",
    run: generate,
    expected: { group: "Crew", leader: "Boss" },
    names: "Crew 1",
  },
  {
    name: "preset, then the Custom card by hand",
    run: (dom) => choose(dom, ""),
    expected: { group: "Crew", leader: "Boss" },
  },
  {
    name: "Custom card, then a preset again",
    run: (dom) => {
      choose(dom, "");
      choose(dom, crew.id);
    },
    expected: { group: "Crew", leader: "Boss" },
  },
  {
    name: "preset to another preset that has no leader word (the leader word stays as shown)",
    run: (dom) => choose(dom, raid.id),
    expected: { group: "Raid", leader: "Boss" },
  },
  {
    name: "other preset, then Custom",
    run: (dom) => {
      choose(dom, raid.id);
      choose(dom, "");
    },
    expected: { group: "Raid", leader: "Boss" },
  },
];

describe.each(["admin", "member"] as Form[])("wording on the %s form", (f) => {
  it.each(steps)("$name", ({ run, expected, names }) => {
    const dom = page(f);
    run(dom);
    expect({
      group: shown(dom, "group"),
      leader: shown(dom, "leader"),
    }).toEqual(expected);
    expect(saved(dom)).toEqual(expected);
    if (names)
      expect(el<HTMLInputElement>(dom, "group_0_name").value).toBe(names);
  });
});

describe.each(["admin", "member"] as Form[])(
  "a refused form put back on the %s form",
  (f) => {
    it.each([
      [
        "Custom card, empty dropdowns: the draft's choice stays (server default)",
        {
          groups_preset: "",
          groups_label_choice: "",
          groups_leader_label_choice: "",
        },
        { group: "Team", leader: "Leader" },
      ],
      [
        "preset card, empty dropdowns: the server default (what is shown)",
        {
          groups_preset: crew.id,
          groups_label_choice: "",
          groups_leader_label_choice: "",
        },
        { group: "Team", leader: "Leader" },
      ],
      [
        "Custom card, own words typed",
        {
          groups_preset: "",
          groups_label_choice: "custom",
          groups_label: "Gang",
          groups_leader_label_choice: "custom",
          groups_leader_label: "Chief",
        },
        { group: "Gang", leader: "Chief" },
      ],
    ])("%s", (_name, draft, expected) => {
      const dom = page(f, {
        groups_enabled: true,
        group_0_name: "A",
        group_1_name: "B",
        ...draft,
      });
      expect({
        group: shown(dom, "group"),
        leader: shown(dom, "leader"),
      }).toEqual(expected);
      expect(saved(dom)).toEqual(expected);
    });
  },
);

/** Without scripts a card change posts only what the controls show; nothing carries a word over. */
describe.each(["admin", "member"] as Form[])(
  "without scripts on the %s form",
  (f) => {
    it.each([
      ["as rendered", () => {}, { group: "Crew", leader: "Boss" }],
      [
        "the Custom card chosen",
        (dom: JSDOM) => {
          card(dom, "").checked = true;
        },
        { group: "Crew", leader: "Boss" },
      ],
      [
        "another preset chosen",
        (dom: JSDOM) => {
          card(dom, raid.id).checked = true;
        },
        { group: "Crew", leader: "Boss" },
      ],
    ])("%s: the shown word is the saved word", (_name, run, expected) => {
      const dom = page(f, undefined, false);
      run(dom);
      expect({
        group: shown(dom, "group"),
        leader: shown(dom, "leader"),
      }).toEqual(expected);
      expect(saved(dom)).toEqual(expected);
    });
  },
);
