/**
 * Unit tests for the pure helpers exported from `src/web/write-routes.ts`.
 * Route-handler integration tests live alongside the higher-level admin
 * harness; here we focus on the bits that don't need Express + Mongo.
 */

import { describe, it, expect } from "@jest/globals";
import {
  coerceConfigValue,
  findSectionMasterKey,
  resetConfigToDefaults,
  type ResetConfigStore,
} from "../../src/web/write-routes.js";
import {
  BOOTSTRAP_VARS,
  PROTECTED_KEYS,
} from "../../src/web/bootstrap-vars.js";
import { defaultConfig } from "../../src/services/config-schema.js";

/**
 * In-memory `ResetConfigStore` seeded from `initial` rows. Records every
 * set/delete so the reset behaviour can be asserted without Mongo.
 */
function makeFakeStore(initial: Record<string, unknown>): ResetConfigStore & {
  rows: Map<string, unknown>;
  setCalls: Array<{ key: string; value: unknown }>;
  deleted: string[];
} {
  const rows = new Map<string, unknown>(Object.entries(initial));
  const setCalls: Array<{ key: string; value: unknown }> = [];
  const deleted: string[] = [];
  return {
    rows,
    setCalls,
    deleted,
    async getAll() {
      return Array.from(rows.keys()).map((key) => ({ key }));
    },
    async set(key, value) {
      setCalls.push({ key, value });
      rows.set(key, value);
    },
    async delete(key) {
      deleted.push(key);
      rows.delete(key);
    },
  };
}

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

  describe("fixed-options (selector) keys", () => {
    // leaderboard_roles.period is a string key with an `options` whitelist
    // (week / month / alltime); values outside it must be refused.
    it("accepts a value in the options whitelist", () => {
      expect(
        coerceConfigValue("leaderboard_roles.period", "week"),
      ).toEqual({ ok: true, value: "week" });
      expect(
        coerceConfigValue("leaderboard_roles.period", "month"),
      ).toEqual({ ok: true, value: "month" });
      expect(
        coerceConfigValue("leaderboard_roles.period", "alltime"),
      ).toEqual({ ok: true, value: "alltime" });
    });

    it("rejects a value outside the options whitelist with an enumerated reason", () => {
      const r = coerceConfigValue("leaderboard_roles.period", "daily");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/invalid option/i);
        // The error enumerates the valid choices so the operator can fix it.
        expect(r.reason).toContain("week");
        expect(r.reason).toContain("month");
        expect(r.reason).toContain("alltime");
      }
    });

    it("rejects an empty value for an options key (no blank choice)", () => {
      const r = coerceConfigValue("leaderboard_roles.period", "");
      expect(r.ok).toBe(false);
    });
  });
});

describe("findSectionMasterKey", () => {
  it("returns the shortest boolean .enabled key in the section (#485)", () => {
    expect(
      findSectionMasterKey([
        "voicechannels.enabled",
        "voicechannels.controlpanel.enabled",
        "voicechannels.lobby.name",
      ]),
    ).toBe("voicechannels.enabled");
  });

  it("ignores .enabled keys that aren't boolean in the schema", () => {
    // `quotes.channel_id` ends with neither; a hypothetical non-boolean
    // `.enabled` (not present in defaultConfig) is also skipped.
    expect(
      findSectionMasterKey(["quotes.channel_id", "quotes.max_length"]),
    ).toBeNull();
  });

  it("returns null for an unknown key that merely ends with .enabled", () => {
    expect(findSectionMasterKey(["bogus.feature.enabled"])).toBeNull();
  });
});

describe("resetConfigToDefaults (#487)", () => {
  const schemaKeys = Object.keys(defaultConfig);

  it("rewrites every schema key back to its default value", async () => {
    // Fixture DB with a couple of non-default overrides.
    const store = makeFakeStore({
      "voicechannels.enabled": true,
      "quotes.max_length": 999,
    });

    const { updated } = await resetConfigToDefaults(store);

    expect(updated).toBe(schemaKeys.length);
    // Every schema key was written exactly once, with its default value.
    expect(store.setCalls.map((c) => c.key).sort()).toEqual(
      [...schemaKeys].sort(),
    );
    for (const key of schemaKeys) {
      expect(store.rows.get(key)).toEqual(
        defaultConfig[key as keyof typeof defaultConfig],
      );
    }
  });

  it("deletes orphan DB keys that are no longer in the schema", async () => {
    const store = makeFakeStore({
      "voicechannels.enabled": true,
      "legacy.removed_feature": "stale",
      "another.orphan": 42,
    });

    const { updated, deleted } = await resetConfigToDefaults(store);

    expect(updated).toBe(schemaKeys.length);
    expect(deleted).toBe(2);
    expect(store.deleted.sort()).toEqual(
      ["another.orphan", "legacy.removed_feature"].sort(),
    );
    expect(store.rows.has("legacy.removed_feature")).toBe(false);
    expect(store.rows.has("another.orphan")).toBe(false);
  });

  it("never deletes a protected bootstrap key, even if a stray row exists", async () => {
    // PROTECTED_KEYS shouldn't live in the configs collection, but a stray
    // row must not be dropped by the reset.
    const store = makeFakeStore({
      DISCORD_TOKEN: "should-not-be-touched",
      "orphan.key": "x",
    });

    const { deleted } = await resetConfigToDefaults(store);

    expect(deleted).toBe(1);
    expect(store.deleted).toEqual(["orphan.key"]);
    expect(store.deleted).not.toContain("DISCORD_TOKEN");
    expect(store.rows.get("DISCORD_TOKEN")).toBe("should-not-be-touched");
  });

  it("collects per-key failures and keeps going (partial application)", async () => {
    const store = makeFakeStore({ "orphan.key": "x" });
    const firstSchemaKey = schemaKeys[0];
    const realSet = store.set.bind(store);
    store.set = async (key, value, description, category) => {
      if (key === firstSchemaKey) throw new Error("write boom");
      return realSet(key, value, description, category);
    };

    const { updated, deleted, failed } = await resetConfigToDefaults(store);

    expect(updated).toBe(schemaKeys.length - 1);
    expect(deleted).toBe(1);
    expect(failed).toEqual([{ key: firstSchemaKey, reason: "write boom" }]);
  });
});
