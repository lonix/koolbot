import { describe, it, expect } from "@jest/globals";
import { coerceConfigValue } from "../../src/scripts/migrate-config.js";

// The migration writes go through the globally-mocked mongoose/ConfigService
// (see __tests__/setup.ts), so these tests cover the pure coercion helper that
// decides what type each migrated value is stored as (#859).
describe("migrate-config coerceConfigValue", () => {
  it("keeps an empty-string default as a string instead of coercing it to 0", () => {
    // Number("") === 0, so a bare isNaN(Number(value)) check used to turn the
    // intended "unset" default of keys like voicechannels.channel.suffix into
    // the number 0.
    expect(coerceConfigValue("")).toBe("");
  });

  it("keeps a whitespace-only value as a string", () => {
    expect(coerceConfigValue("   ")).toBe("   ");
  });

  it("passes undefined through when a migration declares no default", () => {
    expect(coerceConfigValue(undefined)).toBeUndefined();
  });

  it("coerces boolean-looking values to booleans", () => {
    expect(coerceConfigValue("true")).toBe(true);
    expect(coerceConfigValue("false")).toBe(false);
  });

  it("coerces numeric values to numbers", () => {
    expect(coerceConfigValue("1000")).toBe(1000);
    expect(coerceConfigValue("0")).toBe(0);
    expect(coerceConfigValue("-1.5")).toBe(-1.5);
  });

  it("leaves non-numeric strings untouched", () => {
    expect(coerceConfigValue("Lobby")).toBe("Lobby");
    expect(coerceConfigValue("🎮")).toBe("🎮");
    expect(coerceConfigValue("123,456")).toBe("123,456");
  });
});
