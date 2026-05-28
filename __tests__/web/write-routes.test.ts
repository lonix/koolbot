/**
 * Unit tests for the pure helpers exported from `src/web/write-routes.ts`.
 * Route-handler integration tests live alongside the higher-level admin
 * harness; here we focus on the bits that don't need Express + Mongo.
 */

import { describe, it, expect } from "@jest/globals";
import { coerceConfigValue } from "../../src/web/write-routes.js";
import {
  BOOTSTRAP_VARS,
  PROTECTED_KEYS,
} from "../../src/web/bootstrap-vars.js";

describe("PROTECTED_KEYS", () => {
  it("covers every bootstrap env variable (derived from BOOTSTRAP_VARS)", () => {
    // PROTECTED_KEYS is derived from BOOTSTRAP_VARS so they cannot drift.
    // This assertion guards against an accidental refactor that re-introduces
    // a hand-maintained copy.
    for (const v of BOOTSTRAP_VARS) {
      expect(PROTECTED_KEYS.has(v.key)).toBe(true);
    }
    expect(PROTECTED_KEYS.size).toBe(BOOTSTRAP_VARS.length);
  });

  it("covers every bootstrap and WebUI env variable", () => {
    // Locked snapshot — adding a new env var must force an intentional
    // update of this list, otherwise YAML import could overwrite it.
    expect(Array.from(PROTECTED_KEYS).sort()).toEqual(
      [
        "CLIENT_ID",
        "DEBUG",
        "DISCORD_TOKEN",
        "GUILD_ID",
        "MONGODB_URI",
        "NODE_ENV",
        "WEBUI_BASE_URL",
        "WEBUI_ENABLED",
        "WEBUI_INACTIVITY_TIMEOUT_MINUTES",
        "WEBUI_SESSION_LIFETIME_HOURS",
        "WEBUI_SESSION_SECRET",
        "WEBUI_SESSION_TTL_MINUTES",
        "WEBUI_TRUST_PROXY",
      ].sort(),
    );
  });

  it("excludes regular config keys", () => {
    expect(PROTECTED_KEYS.has("voicechannels.enabled")).toBe(false);
    expect(PROTECTED_KEYS.has("quotes.max_length")).toBe(false);
  });
});

describe("coerceConfigValue", () => {
  it("rejects keys not present in defaultConfig", () => {
    const r = coerceConfigValue("bogus.key", "anything");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown key");
  });

  it("coerces HTML checkbox 'true' to a real boolean for boolean keys", () => {
    const r = coerceConfigValue("voicechannels.enabled", "true");
    expect(r).toEqual({ ok: true, value: true });
  });

  it("treats an absent checkbox (undefined) as false for boolean keys", () => {
    const r = coerceConfigValue("voicechannels.enabled", undefined);
    expect(r).toEqual({ ok: true, value: false });
  });

  it("accepts a real boolean for boolean keys (YAML import path)", () => {
    expect(coerceConfigValue("voicechannels.enabled", true)).toEqual({
      ok: true,
      value: true,
    });
    expect(coerceConfigValue("voicechannels.enabled", false)).toEqual({
      ok: true,
      value: false,
    });
  });

  it("parses numeric strings for number keys", () => {
    const r = coerceConfigValue("quotes.max_length", "500");
    expect(r).toEqual({ ok: true, value: 500 });
  });

  it("accepts native numbers for number keys", () => {
    expect(coerceConfigValue("quotes.max_length", 42)).toEqual({
      ok: true,
      value: 42,
    });
  });

  it("rejects non-numeric values for number keys", () => {
    const r = coerceConfigValue("quotes.max_length", "not a number");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid number");
  });

  it("stringifies values for string keys", () => {
    expect(coerceConfigValue("voicechannels.lobby.name", "Lobby")).toEqual({
      ok: true,
      value: "Lobby",
    });
    expect(
      coerceConfigValue("voicechannels.lobby.name", 123),
    ).toEqual({ ok: true, value: "123" });
    // null / undefined become an empty string rather than the literal
    // "null" / "undefined", which is what an unset string field should be.
    expect(
      coerceConfigValue("voicechannels.lobby.name", null),
    ).toEqual({ ok: true, value: "" });
  });

  it("joins array input into a comma-separated string for *_list keys", () => {
    // The Settings page renders channel_list / role_list as <select
    // multiple>, which posts repeated `value=…` params and lands here as
    // an array. Backend storage is CSV so we collapse on the way in.
    expect(
      coerceConfigValue("voicetracking.excluded_channels", ["111", "222"]),
    ).toEqual({ ok: true, value: "111,222" });
    expect(
      coerceConfigValue("quotes.delete_roles", ["roleA", "roleB", "roleC"]),
    ).toEqual({ ok: true, value: "roleA,roleB,roleC" });
  });

  it("drops empty strings from array input for *_list keys", () => {
    // Browsers sometimes send a stray empty option in select-multiple
    // payloads; ignore them rather than producing a CSV with a leading
    // or interior empty token.
    expect(
      coerceConfigValue("voicetracking.excluded_channels", ["", "111", ""]),
    ).toEqual({ ok: true, value: "111" });
  });

  it("yields an empty string when nothing is selected in a multi-select", () => {
    expect(
      coerceConfigValue("voicetracking.excluded_channels", []),
    ).toEqual({ ok: true, value: "" });
  });

  it("rejects an array payload for a non-list string key", () => {
    // A misconfigured YAML import or crafted form post mustn't silently
    // CSV-join an accidental list into a string-typed key. Only the two
    // *_list types accept array input.
    const r = coerceConfigValue("voicechannels.lobby.name", ["a", "b"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/array/i);
    }
  });

  it("rejects an array payload for a number key", () => {
    const r = coerceConfigValue("quotes.max_length", [500]);
    expect(r.ok).toBe(false);
  });
});
