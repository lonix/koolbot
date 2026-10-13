import { describe, it, expect } from "@jest/globals";
import { getFeatureEnabledKeys } from "../../src/services/notices-channel-manager.js";
import { BOT_FEATURES } from "../../src/content/bot-features.js";

/**
 * Forces a listing decision for every feature (#1131).
 *
 * The "KoolBot Features & Commands" notice lists a feature only when
 * `BOT_FEATURES` has an entry for it with `listed: true`. Without this guard a
 * new top-level `<feature>.enabled` gate would silently stay out of the notice
 * because nobody ever decided. A feature that members can use and would not
 * find on their own gets `listed: true`; anything else gets `listed: false`.
 */

const gateFeatures = getFeatureEnabledKeys().map((key) =>
  key.replace(/\.enabled$/, ""),
);

describe("BOT_FEATURES classification drift (#1131)", () => {
  it("classifies every top-level feature gate", () => {
    const unclassified = gateFeatures.filter(
      (feature) => !Object.prototype.hasOwnProperty.call(BOT_FEATURES, feature),
    );
    expect(unclassified).toEqual([]);
  });

  it("has no entry for a feature that no longer exists", () => {
    const stale = Object.keys(BOT_FEATURES).filter(
      (feature) => !gateFeatures.includes(feature),
    );
    expect(stale).toEqual([]);
  });

  it("sets an explicit boolean decision and copy on every entry", () => {
    for (const [feature, info] of Object.entries(BOT_FEATURES)) {
      expect({ feature, listed: typeof info.listed }).toEqual({
        feature,
        listed: "boolean",
      });
      expect(info.emoji).not.toBe("");
      expect(info.label).not.toBe("");
      expect(info.description).not.toBe("");
    }
  });
});
