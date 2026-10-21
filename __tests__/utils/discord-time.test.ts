import { describe, it, expect } from "@jest/globals";
import { discordTimestamp } from "../../src/utils/discord-time.js";

const NOW = new Date("2026-09-01T12:00:00Z");

describe("discordTimestamp", () => {
  it("renders the long form by default", () => {
    expect(discordTimestamp(NOW)).toBe("<t:1788264000:F>");
  });

  it.each(["t", "T", "d", "D", "f", "F", "R"] as const)(
    "renders style %s",
    (style) => {
      expect(discordTimestamp(NOW, style)).toBe(`<t:1788264000:${style}>`);
    },
  );

  it("rounds down to whole seconds", () => {
    expect(discordTimestamp(new Date(1788264000999), "R")).toBe(
      "<t:1788264000:R>",
    );
  });
});
