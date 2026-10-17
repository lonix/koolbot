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
