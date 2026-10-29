import { describe, expect, it } from "@jest/globals";
import {
  groupPickerDescription,
  groupPickerHint,
} from "../../src/utils/reaction-role-copy.js";

describe("group picker copy (#1522)", () => {
  it.each([
    ["unique", "Pick one: reacting swaps you to that role."],
    ["sticky", "Removing your reaction keeps the role."],
    ["toggle", "Remove your reaction to lose the role."],
  ])("says what reacting does in %s mode", (mode, sentence) => {
    expect(groupPickerHint(mode)).toBe(sentence);
  });

  it("puts the hint before the option list", () => {
    expect(
      groupPickerDescription("Colours", "unique", [
        "🔴 — **Red**",
        "🔵 — **Blue**",
      ]),
    ).toBe(
      "React to choose your **Colours** role. Pick one: reacting swaps you to that role.\n\n🔴 — **Red**\n🔵 — **Blue**",
    );
  });
});
