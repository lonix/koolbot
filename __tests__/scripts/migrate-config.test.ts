import { describe, it, expect } from "@jest/globals";
import {
  coerceToSchemaType,
  defaultConfig,
} from "../../src/services/config-schema.js";

// The migration writes go through the globally-mocked mongoose/ConfigService
// (see __tests__/setup.ts), so these tests cover the pure coercion helper that
// decides what type each migrated value is stored as (#859, #867).
//
// The helper is driven by the *schema* type of the target key rather than by
// the shape of the string, so each case names the key whose declared type it
// is exercising.
describe("coerceToSchemaType", () => {
  it("keeps an empty value for a string key as a string instead of coercing it to 0", () => {
    // Number("") === 0, so a bare isNaN(Number(value)) check used to turn the
    // intended "unset" value of keys like voicechannels.channel.suffix into
    // the number 0.
    expect(typeof defaultConfig["voicechannels.channel.suffix"]).toBe("string");
    expect(coerceToSchemaType("voicechannels.channel.suffix", "")).toBe("");
  });

  it("keeps a whitespace-only value for a string key as a string", () => {
    expect(coerceToSchemaType("voicechannels.channel.suffix", "   ")).toBe(
      "   ",
    );
  });

  it("preserves a deliberately-empty value for a string key with a non-empty default", () => {
    // `LOBBY_CHANNEL_NAME=` is an operator saying "empty", not "unset".
    expect(defaultConfig["voicechannels.lobby.name"]).toBe("Lobby");
    expect(coerceToSchemaType("voicechannels.lobby.name", "")).toBe("");
  });

  it("returns undefined for a key that is not declared in the schema", () => {
    expect(coerceToSchemaType("voicetracking.announcements.channel", "x")).toBe(
      undefined,
    );
  });

  it("coerces boolean-looking values for a boolean key", () => {
    expect(coerceToSchemaType("voicechannels.enabled", "true")).toBe(true);
    expect(coerceToSchemaType("voicechannels.enabled", "false")).toBe(false);
  });

  it("rejects a non-boolean value for a boolean key", () => {
    expect(coerceToSchemaType("voicechannels.enabled", "1")).toBe(undefined);
    expect(coerceToSchemaType("voicechannels.enabled", "")).toBe(undefined);
    expect(coerceToSchemaType("voicechannels.enabled", "yes")).toBe(undefined);
  });

  it("coerces numeric values for a number key", () => {
    expect(coerceToSchemaType("quotes.max_length", "1000")).toBe(1000);
    expect(coerceToSchemaType("quotes.cooldown", "0")).toBe(0);
    expect(coerceToSchemaType("quotes.cooldown", "-1.5")).toBe(-1.5);
  });

  it("rejects an empty or non-numeric value for a number key rather than storing 0", () => {
    expect(coerceToSchemaType("quotes.max_length", "")).toBe(undefined);
    expect(coerceToSchemaType("quotes.max_length", "   ")).toBe(undefined);
    expect(coerceToSchemaType("quotes.max_length", "123,456")).toBe(undefined);
    expect(coerceToSchemaType("quotes.max_length", "Infinity")).toBe(undefined);
  });

  it("leaves a numeric-looking value alone when the schema says string", () => {
    // Guessing from the string would retype IDs and prefixes.
    expect(coerceToSchemaType("voicechannels.channel.prefix", "12345")).toBe(
      "12345",
    );
    expect(coerceToSchemaType("quotes.channel_id", "934812345678901234")).toBe(
      "934812345678901234",
    );
    expect(coerceToSchemaType("voicechannels.lobby.name", "Lobby")).toBe(
      "Lobby",
    );
    expect(coerceToSchemaType("voicechannels.channel.prefix", "🎮")).toBe("🎮");
  });
});
