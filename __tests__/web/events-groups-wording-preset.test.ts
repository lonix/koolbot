/* global HTMLFormElement, HTMLSelectElement, HTMLInputElement */
/**
 * A remembered setup whose wording is its preset's own word (#1471, review of
 * #1614): the dropdown must show what a submit would save. An empty choice
 * means "the preset's word, else the server default", so the empty option has to
 * name the preset's word while that preset is the checked one.
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

const crew = {
  id: "lib:crew",
  label: "Crew night",
  description: "",
  groupLabel: "Crew",
  leaderLabel: "Boss",
  groups: [
    { name: "A", kind: "team" as const, size: null, tag: "", marker: "" },
    { name: "B", kind: "team" as const, size: null, tag: "", marker: "" },
  ],
};
const wording = { group: "Team", leader: "Leader" };

function remembered(preset: typeof crew | null) {
  const stored = {
    presetId: preset ? preset.id : null,
    groupLabel: preset ? preset.groupLabel : "Team",
    leaderLabel: preset ? preset.leaderLabel : "Leader",
    channelLeadMinutes: null,
    groups: [
      { name: "A", kind: "team", size: null, tag: "", marker: "" },
      { name: "B", kind: "team", size: null, tag: "", marker: "" },
    ],
    captainsEnabled: true,
    captainCustomisationEnabled: false,
    captainsLobby: false,
    tagsEnabled: false,
    tagsSuffix: false,
  };
  const prefill = prefillFromStored(stored, {
    maxCount: 15,
    presets: preset ? [preset] : [],
    wording,
  });
  if (!prefill) throw new Error("expected a prefill");
  return { prefill, resetHref: null };
}

/** What the page shows for a dropdown, and what posting the form unchanged saves. */
function roundTrip(preset: typeof crew | null): {
  shown: { group: string; leader: string };
  saved: { group: string; leader: string };
} {
  const dom = new JSDOM(
    renderAdminNewEvent({
      groupRemembered: remembered(preset),
      groupPresets: preset ? [preset] : [],
      groupLimits: { defaultCount: 2, maxCount: 15, wording },
    }),
  );
  const form = dom.window.document.querySelector(
    "form[data-event-form]",
  ) as HTMLFormElement;
  const selected = (name: string): string => {
    const s = form.elements.namedItem(name) as HTMLSelectElement;
    return s.options[s.selectedIndex].textContent ?? "";
  };
  const body: Record<string, string> = { groups_enabled: "1" };
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name || el.disabled) continue;
    if (el.type === "radio" || el.type === "checkbox") {
      if (el.checked) body[el.name] = el.value;
    } else body[el.name] = el.value;
  }
  const result = validateGroupSetup(parseGroupForm(body), {
    maxCount: 15,
    wording,
    resolvePreset: (id) =>
      preset && id === preset.id ? { preset } : { refused: "unknown" },
  });
  if (!result.ok) throw new Error(result.errors.join(" "));
  return {
    shown: {
      group: selected("groups_label_choice"),
      leader: selected("groups_leader_label_choice"),
    },
    saved: { group: result.setup.groupLabel, leader: result.setup.leaderLabel },
  };
}

describe("a remembered setup with its preset's own wording", () => {
  it("shows the word a submit saves, group and leader", () => {
    const { shown, saved } = roundTrip(crew);
    expect(saved).toEqual({ group: "Crew", leader: "Boss" });
    expect(shown.group).toContain(saved.group);
    expect(shown.leader).toContain(saved.leader);
  });

  it("still names the server default when no preset is checked", () => {
    const { shown, saved } = roundTrip(null);
    expect(saved).toEqual({ group: "Team", leader: "Leader" });
    expect(shown.group).toBe("Server default (Team)");
    expect(shown.leader).toBe("Server default (Leader)");
  });
});
