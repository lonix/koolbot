/* global HTMLInputElement, HTMLSelectElement, HTMLElement */
/**
 * The wording dropdowns of the Groups section (#1471): markup for each state
 * (server default, listed word, Custom, refused as typed) and the script that
 * shows the Custom box and follows a preset, run in jsdom against the real page.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { renderAdminNewEvent } from "./new-event-page-helper.js";
import { EVENT_GROUP_PRESETS } from "../../src/content/event-group-presets.js";
import type { GroupFormPrefill } from "../../src/services/event-last-setup-service.js";

function prefill(extra: Partial<GroupFormPrefill> = {}): {
  prefill: GroupFormPrefill;
  resetHref: null;
} {
  return {
    resetHref: null,
    prefill: {
      presetId: "",
      groupLabel: "",
      leaderLabel: "",
      channelLeadMinutes: "",
      rows: [{ name: "Red", kind: "team", size: "", tag: "", marker: "" }],
      captainsEnabled: true,
      captainCustomisationEnabled: false,
      captainsLobby: false,
      tagsEnabled: false,
      tagsSuffix: false,
      ...extra,
    },
  };
}

function page(
  remembered: ReturnType<typeof prefill> | null,
  wording?: { group: string; leader: string },
): JSDOM {
  const html = renderAdminNewEvent({
    groupRemembered: remembered,
    ...(wording
      ? { groupLimits: { defaultCount: 2, maxCount: 15, wording } }
      : {}),
  });
  const dom = new JSDOM(html, {
    url: "http://localhost/admin/events/new",
    runScripts: "outside-only",
  });
  const scripts = [
    ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  dom.window.eval(scripts.find((c) => c.includes("koolGroupRows="))!);
  dom.window.eval(scripts.find((c) => c.includes("koolbot-event-form-draft"))!);
  return dom;
}

const sel = (dom: JSDOM, name: string): HTMLSelectElement =>
  dom.window.document.querySelector(
    `select[name="${name}"]`,
  ) as HTMLSelectElement;
const box = (dom: JSDOM, name: string): HTMLInputElement =>
  dom.window.document.querySelector(
    `input[name="${name}"]`,
  ) as HTMLInputElement;
const customBox = (dom: JSDOM, kind: string): HTMLElement =>
  dom.window.document.querySelector(
    `[data-wording="${kind}"] [data-wording-custom]`,
  ) as HTMLElement;
const optionTexts = (s: HTMLSelectElement): string[] =>
  [...s.options].map((o) => o.textContent ?? "");

describe("wording dropdown markup", () => {
  it("offers the server default first, the listed words, then Custom, in a labelled select", () => {
    const dom = page(null, { group: "Squad", leader: "Captain" });
    expect(optionTexts(sel(dom, "groups_label_choice"))).toEqual([
      "Server default (Squad)",
      "Team",
      "Squad",
      "Room",
      "Party",
      "Custom",
    ]);
    expect(optionTexts(sel(dom, "groups_leader_label_choice"))).toEqual([
      "Server default (Captain)",
      "Leader",
      "Captain",
      "Custom",
    ]);
    const label = dom.window.document.querySelector(
      'label[for="groups-label-choice"]',
    );
    expect(label?.textContent).toBe("What a group is called");
    expect(sel(dom, "groups_label_choice").value).toBe("");
  });

  it("falls back to the built-in words and has no datalist of suggestions", () => {
    const dom = page(null);
    expect(optionTexts(sel(dom, "groups_label_choice"))[0]).toBe(
      "Server default (Team)",
    );
    expect(dom.window.document.querySelector("datalist")).toBeNull();
  });

  it.each([
    ["a listed word", "Room", "Room", ""],
    ["free text saved earlier", "Raiders", "custom", "Raiders"],
    ["the default (stored empty)", "", "", ""],
  ])("shows %s as the right choice", (_n, stored, choice, text) => {
    const dom = page(prefill({ groupLabel: stored }));
    expect(sel(dom, "groups_label_choice").value).toBe(choice);
    expect(box(dom, "groups_label").value).toBe(text);
  });

  it("puts a refused form back as typed: Custom with a listed word typed stays Custom", () => {
    const dom = page(
      prefill({
        groupLabel: "Team",
        groupLabelChoice: "custom",
        leaderLabel: "",
        leaderLabelChoice: "custom",
      }),
    );
    expect(sel(dom, "groups_label_choice").value).toBe("custom");
    expect(box(dom, "groups_label").value).toBe("Team");
    expect(sel(dom, "groups_leader_label_choice").value).toBe("custom");
    expect(box(dom, "groups_leader_label").value).toBe("");
  });

  it("escapes the text typed into the Custom box", () => {
    const html = renderAdminNewEvent({
      groupRemembered: prefill({
        groupLabel: '"><script>x</script>',
        groupLabelChoice: "custom",
      }),
    });
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("wording dropdown script", () => {
  it("shows the Custom box only while Custom is chosen", () => {
    const dom = page(null);
    expect(customBox(dom, "group").hidden).toBe(true);
    const s = sel(dom, "groups_label_choice");
    s.value = "custom";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(customBox(dom, "group").hidden).toBe(false);
    s.value = "Party";
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    expect(customBox(dom, "group").hidden).toBe(true);
  });

  it("starts with the box shown for a Custom wording", () => {
    const dom = page(prefill({ groupLabel: "Raiders" }));
    expect(customBox(dom, "group").hidden).toBe(false);
    expect(customBox(dom, "leader").hidden).toBe(true);
  });

  it("follows a preset's wording: a listed word picks the option, other text becomes Custom", () => {
    const dom = page(null);
    const radios = [
      ...dom.window.document.querySelectorAll(
        "input[type=radio][name=groups_preset]",
      ),
    ] as HTMLInputElement[];
    const withWord = (word: string): HTMLInputElement => {
      const r = radios.find((x) => x.value === EVENT_GROUP_PRESETS[0].id)!;
      r.setAttribute("data-label", word);
      return r;
    };
    for (const [word, choice] of [
      ["Squad", "Squad"],
      ["Crew", "custom"],
    ] as const) {
      const r = withWord(word);
      r.checked = true;
      r.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      expect(sel(dom, "groups_label_choice").value).toBe(choice);
      if (choice === "custom") {
        expect(box(dom, "groups_label").value).toBe("Crew");
        expect(customBox(dom, "group").hidden).toBe(false);
      }
    }
  });
});

describe("the quick builder's numbered names use the chosen wording", () => {
  it.each([
    ["the server default", "", "Squad", "Squad 1"],
    ["a listed word", "Room", "Squad", "Room 1"],
    ["a Custom word", "custom", "Squad", "Raiders 1"],
  ])("with %s", (_n, choice, serverDefault, expected) => {
    const dom = page(null, { group: serverDefault, leader: "Leader" });
    const s = sel(dom, "groups_label_choice");
    s.value = choice;
    box(dom, "groups_label").value = "Raiders";
    const doc = dom.window.document;
    (doc.querySelector("[data-build-count]") as HTMLInputElement).value = "1";
    (
      doc.querySelector(
        "input[name=groups_build_names][value=numbers]",
      ) as HTMLInputElement
    ).checked = true;
    (doc.querySelector("[data-build]") as HTMLElement).click();
    expect(box(dom, "group_0_name").value).toBe(expected);
  });
});
