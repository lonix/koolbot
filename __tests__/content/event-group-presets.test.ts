import { describe, it, expect } from "@jest/globals";
import {
  BUILTIN_PRESET_PREFIX,
  EVENT_GROUP_PRESETS,
  getEventGroupPreset,
} from "../../src/content/event-group-presets.js";
import { validateGroupSetup } from "../../src/services/event-groups.js";

describe("built-in event group presets (#1188)", () => {
  it("has unique, namespaced ids and a label for every preset", () => {
    const ids = EVENT_GROUP_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of EVENT_GROUP_PRESETS) {
      expect(preset.id.startsWith(BUILTIN_PRESET_PREFIX)).toBe(true);
      expect(preset.label.trim()).not.toBe("");
      expect(preset.description.trim()).not.toBe("");
      expect(preset.groupLabel.trim()).not.toBe("");
    }
  });

  it.each(EVENT_GROUP_PRESETS.map((p) => [p.label, p] as const))(
    "%s passes the same validation the event form applies",
    (_label, preset) => {
      const result = validateGroupSetup(
        {
          enabled: true,
          presetId: preset.id,
          groupLabel: "",
          leaderLabel: "",
          channelLeadMinutes: "",
          rows: [],
        },
        { maxCount: 15 },
      );
      if (!result.ok) throw new Error(result.errors.join(" "));
      expect(result.setup.presetId).toBe(preset.id);
      expect(result.setup.groupLabel).toBe(preset.groupLabel);
      expect(result.setup.groups.map((g) => g.name)).toEqual(
        preset.groups.map((g) => g.name),
      );
    },
  );

  it("names the presets by team count, in that order", () => {
    expect(EVENT_GROUP_PRESETS.map((p) => p.label)).toEqual([
      "2 teams",
      "3 teams",
      "4 teams",
    ]);
    expect(EVENT_GROUP_PRESETS.map((p) => p.groups.length)).toEqual([2, 3, 4]);
  });

  it("keeps the historical ids, which events and switches store", () => {
    expect(EVENT_GROUP_PRESETS.map((p) => p.id)).toEqual([
      "builtin:red-vs-blue",
      "builtin:wardogs",
      "builtin:eve-factions",
    ]);
  });

  it("describes each preset by its team names and markers", () => {
    expect(EVENT_GROUP_PRESETS.map((p) => p.description)).toEqual([
      "Red 🔴, Blue 🔵",
      "Manticore 🟢, Valkyra 🔴, Lonestar 🔵",
      "Amarr 🟡, Caldari 🔵, Gallente 🟢, Minmatar 🔴",
    ]);
  });

  it("leaves an event's stored groups alone when the preset changes", () => {
    // An event keeps its own copy of the groups; the preset is only a
    // starting point for new events, and a stored copy wins over it.
    const result = validateGroupSetup(
      {
        enabled: true,
        presetId: "builtin:eve-factions",
        groupLabel: "Team",
        leaderLabel: "",
        channelLeadMinutes: "",
        rows: [
          {
            position: 1,
            name: "Amarr",
            kind: "team",
            size: "",
            tag: "",
            marker: "",
          },
          {
            position: 2,
            name: "Caldari",
            kind: "team",
            size: "",
            tag: "",
            marker: "",
          },
        ],
      },
      { maxCount: 15 },
    );
    if (!result.ok) throw new Error(result.errors.join(" "));
    expect(result.setup.groups.map((g) => [g.name, g.marker])).toEqual([
      ["Amarr", ""],
      ["Caldari", ""],
    ]);
  });

  it("offers Red vs Blue as two teams", () => {
    const preset = getEventGroupPreset("builtin:red-vs-blue");
    expect(preset?.groups.map((g) => [g.name, g.kind])).toEqual([
      ["Red", "team"],
      ["Blue", "team"],
    ]);
  });

  it("offers the four EVE factions", () => {
    expect(
      getEventGroupPreset("builtin:eve-factions")?.groups.map((g) => g.name),
    ).toEqual(["Amarr", "Caldari", "Gallente", "Minmatar"]);
  });

  it("offers Wardogs with the corrected faction colours", () => {
    expect(
      getEventGroupPreset("builtin:wardogs")?.groups.map((g) => [
        g.name,
        g.marker,
      ]),
    ).toEqual([
      ["Manticore", "🟢"],
      ["Valkyra", "🔴"],
      ["Lonestar", "🔵"],
    ]);
  });

  it("returns undefined for Custom, null and unknown ids", () => {
    expect(getEventGroupPreset(null)).toBeUndefined();
    expect(getEventGroupPreset("custom")).toBeUndefined();
    expect(getEventGroupPreset("builtin:nope")).toBeUndefined();
  });
});
