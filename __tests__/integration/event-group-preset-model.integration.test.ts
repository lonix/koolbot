import { describe, it, expect } from "@jest/globals";
import { EventGroupPreset } from "../../src/models/event-group-preset.js";
import { validatePresetForm } from "../../src/services/event-group-preset-service.js";

/**
 * Schema guards of the preset model, checked with the real Mongoose schema
 * (this project does not load the global mongoose mock). No connection is
 * needed: `validateSync` only runs the schema's own validators.
 *
 * `nameKey` is the name lower-cased, and lower-casing can lengthen a string
 * ("İ" becomes two UTF-16 units), so a name the form accepts at its limit must
 * still give a key the schema accepts.
 */
describe("EventGroupPreset schema (#1200)", () => {
  const NAME = `${"a".repeat(49)}İ`;

  it("the form accepts a 50-unit name whose lower-cased key is 51 units long", () => {
    expect(NAME.length).toBe(50);
    expect(NAME.toLowerCase().length).toBe(51);
    const result = validatePresetForm(
      { preset_name: NAME, group_0_name: "A" },
      { maxCount: 15 },
    );
    expect(result.ok).toBe(true);
  });

  it("the schema accepts the row built from that name", () => {
    const doc = new EventGroupPreset({
      guildId: "g1",
      name: NAME,
      nameKey: NAME.toLowerCase(),
      groups: [{ name: "A", kind: "team", size: null, tag: "", marker: "" }],
    });
    expect(doc.validateSync()?.message).toBeUndefined();
  });

  it("still refuses a name over the limit", () => {
    const doc = new EventGroupPreset({
      guildId: "g1",
      name: "a".repeat(51),
      nameKey: "a".repeat(51),
      groups: [],
    });
    expect(doc.validateSync()?.errors.name).toBeDefined();
  });
});
