import { describe, it, expect } from "@jest/globals";
import {
  defaultConfig,
  settingsMetadata,
  categoryMetadata,
  getDependencies,
  REWIND_RETENTION_MIN_DAYS,
  type ConfigSchema,
} from "../../src/services/config-schema.js";

describe("Config Schema", () => {
  describe("defaultConfig", () => {
    it("should have all core features disabled by default for security", () => {
      expect(defaultConfig["voicechannels.enabled"]).toBe(false);
      expect(defaultConfig["voicetracking.enabled"]).toBe(false);
      expect(defaultConfig["ping.enabled"]).toBe(false);
      expect(defaultConfig["quotes.enabled"]).toBe(false);
    });

    it("should have reasonable default values for voice channel settings", () => {
      expect(defaultConfig["voicechannels.category_id"]).toBe("");
      expect(defaultConfig["voicechannels.lobby.name"]).toBe("Lobby");
      expect(defaultConfig["voicechannels.channel.prefix"]).toBe("🎮");
    });

    it("should have reasonable default values for cleanup retention", () => {
      expect(
        defaultConfig["voicetracking.cleanup.retention.detailed_sessions_days"],
      ).toBeGreaterThan(0);
      expect(
        defaultConfig[
          "voicetracking.cleanup.retention.monthly_summaries_months"
        ],
      ).toBeGreaterThan(0);
      expect(
        defaultConfig["voicetracking.cleanup.retention.yearly_summaries_years"],
      ).toBeGreaterThan(0);
    });

    it("keeps Rewind-relevant retention defaults at or above a full year (#575)", () => {
      // Rewind is built live from detailed voice sessions and per-message
      // detail; out-of-the-box defaults must cover a full year-in-review.
      expect(
        defaultConfig["voicetracking.cleanup.retention.detailed_sessions_days"],
      ).toBeGreaterThanOrEqual(REWIND_RETENTION_MIN_DAYS);
      expect(
        defaultConfig["messagetracking.cleanup.retention.detailed_days"],
      ).toBeGreaterThanOrEqual(REWIND_RETENTION_MIN_DAYS);
    });

    it("should have reasonable default values for quote system", () => {
      expect(defaultConfig["quotes.max_length"]).toBeGreaterThan(0);
      expect(defaultConfig["quotes.cooldown"]).toBeGreaterThanOrEqual(0);
    });

    it("should have valid cron schedule defaults", () => {
      // Default schedules should be strings (even if empty)
      expect(typeof defaultConfig["voicetracking.announcements.schedule"]).toBe(
        "string",
      );
      expect(typeof defaultConfig["voicetracking.cleanup.schedule"]).toBe(
        "string",
      );
    });

    it("should have channel_id fields as strings", () => {
      expect(typeof defaultConfig["quotes.channel_id"]).toBe("string");
      expect(typeof defaultConfig["reactionroles.message_channel_id"]).toBe(
        "string",
      );
    });

    it("should have string fields for comma-separated values", () => {
      expect(typeof defaultConfig["voicetracking.excluded_channels"]).toBe(
        "string",
      );
      expect(typeof defaultConfig["quotes.delete_roles"]).toBe("string");
    });

    it("should have voicetracking.excluded_channels default to empty string", () => {
      expect(defaultConfig["voicetracking.excluded_channels"]).toBe("");
    });

    it("should have rate limiting disabled by default for security", () => {
      expect(defaultConfig["ratelimit.enabled"]).toBe(false);
    });

    it("should have reasonable default values for rate limiting", () => {
      expect(defaultConfig["ratelimit.max_commands"]).toBeGreaterThan(0);
      expect(defaultConfig["ratelimit.window_seconds"]).toBeGreaterThan(0);
      expect(typeof defaultConfig["ratelimit.bypass_admin"]).toBe("boolean");
    });
  });

  describe("settingsMetadata", () => {
    it("has a non-empty label, description, category, and type for every key in defaultConfig", () => {
      const missingLabel: string[] = [];
      const missingDescription: string[] = [];
      const missingCategory: string[] = [];
      const missingType: string[] = [];
      for (const key of Object.keys(defaultConfig)) {
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        if (!meta) {
          missingLabel.push(key);
          missingDescription.push(key);
          missingCategory.push(key);
          missingType.push(key);
          continue;
        }
        if (!meta.label || meta.label.trim() === "") missingLabel.push(key);
        if (!meta.description || meta.description.trim() === "")
          missingDescription.push(key);
        if (!meta.category || meta.category.trim() === "")
          missingCategory.push(key);
        if (!meta.type || (meta.type as string).trim() === "")
          missingType.push(key);
      }
      expect(missingLabel).toEqual([]);
      expect(missingDescription).toEqual([]);
      expect(missingCategory).toEqual([]);
      expect(missingType).toEqual([]);
    });

    it("declares a `type` consistent with the runtime defaultConfig value shape", () => {
      // The schema-declared type must not contradict the runtime shape:
      // a `boolean`-typed key has a boolean default, a `number`-typed key
      // has a numeric default, and every other kind ("string", "cron",
      // "channel"/"category"/"role" and their list variants) stores a
      // string. Catches accidental drift between the declared metadata and
      // the underlying default value.
      const mismatches: string[] = [];
      for (const [key, defaultValue] of Object.entries(defaultConfig)) {
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        if (!meta) continue;
        const dv = typeof defaultValue;
        if (meta.type === "boolean" && dv !== "boolean") mismatches.push(key);
        else if (meta.type === "number" && dv !== "number")
          mismatches.push(key);
        else if (
          meta.type !== "boolean" &&
          meta.type !== "number" &&
          dv !== "string"
        )
          mismatches.push(key);
      }
      expect(mismatches).toEqual([]);
    });

    it("attaches a warnBelow hint at the Rewind threshold to both detailed-retention keys (#575)", () => {
      const voice =
        settingsMetadata[
          "voicetracking.cleanup.retention.detailed_sessions_days"
        ];
      const message =
        settingsMetadata["messagetracking.cleanup.retention.detailed_days"];
      for (const meta of [voice, message]) {
        expect(meta.warnBelow).toBeDefined();
        expect(meta.warnBelow?.value).toBe(REWIND_RETENTION_MIN_DAYS);
        expect(meta.warnBelow?.message.trim()).not.toBe("");
      }
    });

    it("does not have stale entries for keys that no longer exist in defaultConfig", () => {
      const orphans = Object.keys(settingsMetadata).filter(
        (k) => !(k in defaultConfig),
      );
      expect(orphans).toEqual([]);
    });
  });

  describe("feature dependencies (dependsOn / #662)", () => {
    // The hard-dependency table from #659: each key may only be enabled
    // when every listed key is also enabled. This is the single source of
    // truth consumed by write-time enforcement (#663) and the Settings
    // "requires X" hint (#666). Rewind is deliberately absent — it is a
    // graceful aggregator that must never be blocked on enable.
    // `satisfies` checks every key/value against `keyof ConfigSchema` at
    // compile time, so a typo in a config key fails the build instead of
    // being hidden by a runtime cast.
    const EXPECTED_DEPENDENCIES = {
      "leaderboard_roles.enabled": ["voicetracking.enabled"],
      "digest.enabled": ["voicetracking.enabled"],
      "digest.include_achievements": ["achievements.enabled"],
      "achievements.enabled": ["voicetracking.enabled"],
      "voicetracking.announcements.enabled": ["voicetracking.enabled"],
    } satisfies Partial<Record<keyof ConfigSchema, (keyof ConfigSchema)[]>>;

    it("declares exactly the #659 hard-dependency table", () => {
      const declared: Record<string, (keyof ConfigSchema)[]> = {};
      for (const [key, meta] of Object.entries(settingsMetadata)) {
        if (meta.dependsOn && meta.dependsOn.length > 0) {
          declared[key] = meta.dependsOn;
        }
      }
      expect(declared).toEqual(EXPECTED_DEPENDENCIES);
    });

    it("exposes each key's dependencies through getDependencies()", () => {
      for (const [key, deps] of Object.entries(EXPECTED_DEPENDENCIES)) {
        expect(getDependencies(key as keyof ConfigSchema)).toEqual(deps);
      }
    });

    it("returns an empty array for keys with no declared dependencies", () => {
      expect(getDependencies("voicetracking.enabled")).toEqual([]);
      expect(getDependencies("quotes.enabled")).toEqual([]);
    });

    it("does NOT declare dependsOn on any rewind key (graceful aggregator)", () => {
      const rewindKeys = Object.keys(settingsMetadata).filter((k) =>
        k.startsWith("rewind."),
      );
      // Sanity check that rewind keys actually exist in the schema.
      expect(rewindKeys.length).toBeGreaterThan(0);
      for (const key of rewindKeys) {
        expect(getDependencies(key as keyof ConfigSchema)).toEqual([]);
      }
    });

    it("only points dependencies at real, enableable config keys", () => {
      for (const deps of Object.values(EXPECTED_DEPENDENCIES)) {
        for (const dep of deps) {
          expect(dep in defaultConfig).toBe(true);
          // Hard dependencies are always on an `*.enabled` gate.
          expect(dep.endsWith(".enabled")).toBe(true);
        }
      }
    });
  });

  describe("categoryMetadata", () => {
    it("covers every category referenced by settingsMetadata", () => {
      const usedCategories = new Set(
        Object.values(settingsMetadata).map((m) => m.category),
      );
      const missing: string[] = [];
      for (const cat of usedCategories) {
        const meta = categoryMetadata[cat];
        if (!meta || !meta.title.trim() || !meta.description.trim()) {
          missing.push(cat);
        }
      }
      expect(missing).toEqual([]);
    });
  });

  describe("enabled-default audit (#445)", () => {
    // The audit's principle (documented in defaultConfig's leading comment):
    //   1. Top-level feature gates default to false (opt-in).
    //   2. Sub-feature toggles may default to true if they're inert
    //      until the parent feature is enabled and the operator who
    //      turns the parent on almost certainly wants them.
    //
    // The matrix below is the *complete* set of `*enabled` keys in
    // defaultConfig at this PR. The first test below derives the actual
    // set from defaultConfig and fails when it drifts, forcing a future
    // contributor to deliberately audit any new toggle they add.

    const EXPECTED_ENABLED_DEFAULTS: Record<string, boolean> = {
      // ─── Top-level feature gates (rule 1: must be false) ────────────
      "voicechannels.enabled": false,
      "voicetracking.enabled": false,
      "ping.enabled": false,
      "quotes.enabled": false,
      "ratelimit.enabled": false,
      "announcements.enabled": false,
      "achievements.enabled": false,
      "digest.enabled": false,
      "rewind.enabled": false,
      "birthdays.enabled": false,
      "reactionroles.enabled": false,
      "notices.enabled": false,
      "polls.enabled": false,
      "leaderboard_roles.enabled": false,
      "messagetracking.enabled": false,
      "reactiontracking.enabled": false,

      // ─── Sub-features that default off (auxiliary opt-ins) ──────────
      "voicechannels.presets.enabled": false,
      "voicetracking.stats.top.enabled": false,
      "voicetracking.stats.user.enabled": false,
      "voicetracking.seen.enabled": false,
      "voicetracking.companions.enabled": false,
      "voicetracking.announcements.enabled": false,
      "voicetracking.cleanup.enabled": false,
      "messagetracking.cleanup.enabled": false,
      "polls.participation.enabled": false,
      // Rewind end-of-year DM nudge — auxiliary opt-in under the rewind
      // feature gate, independent of `rewind.enabled` (#608).
      "rewind.nudge.enabled": false,

      // ─── Sub-features that default on (rule 2: parent-gated) ────────
      "voicechannels.controlpanel.enabled": true,
      "quotes.header_enabled": true,
      "quotes.header_pin_enabled": true,
      "achievements.announcements.enabled": true,
      "achievements.dm_notifications.enabled": true,
      "digest.include_achievements": true,
      "notices.header_enabled": true,
      "notices.header_pin_enabled": true,

      // ─── Core infrastructure (always on; not feature-gated) ─────────
      // Audit logging is a cross-cutting operator-visibility feature
      // rather than a user-facing toggle, so it ships on by default —
      // analogous to how WebAuditLog records every WebUI write without
      // requiring opt-in.
      "core.command_audit.enabled": true,
      // Persisted command metrics (#648) — same rationale as audit logging:
      // a cross-cutting operator-visibility feature, on by default so fresh
      // installs get historical command analytics out of the box.
      "monitoring.metrics_persistence.enabled": true,
    };

    // Parent feature each rule-2 (default-true) sub-feature is gated by.
    // Used to prove the sub-feature is inert on a fresh install.
    const PARENT_OF_DEFAULT_TRUE: Record<string, string> = {
      "voicechannels.controlpanel.enabled": "voicechannels.enabled",
      "quotes.header_enabled": "quotes.enabled",
      "quotes.header_pin_enabled": "quotes.enabled",
      "achievements.announcements.enabled": "achievements.enabled",
      "achievements.dm_notifications.enabled": "achievements.enabled",
      "digest.include_achievements": "digest.enabled",
      "notices.header_enabled": "notices.enabled",
      "notices.header_pin_enabled": "notices.enabled",
    };

    it("audits every `*enabled` key in defaultConfig (no drift)", () => {
      // Derive the live set so a new toggle added to defaultConfig
      // without an entry above immediately fails this test.
      const liveEnabledKeys = Object.keys(defaultConfig).filter((k) =>
        /enabled$/.test(k),
      );
      const audited = new Set(Object.keys(EXPECTED_ENABLED_DEFAULTS));
      const unaudited = liveEnabledKeys.filter((k) => !audited.has(k));
      const stale = Object.keys(EXPECTED_ENABLED_DEFAULTS).filter(
        (k) => !(k in defaultConfig),
      );
      expect(unaudited).toEqual([]);
      expect(stale).toEqual([]);
    });

    it("every audited `*enabled` key matches its expected default value", () => {
      for (const [key, expected] of Object.entries(EXPECTED_ENABLED_DEFAULTS)) {
        expect(defaultConfig[key as keyof typeof defaultConfig]).toBe(expected);
      }
    });

    it("every default-true sub-feature has a parent gate that defaults to false", () => {
      for (const [key, parent] of Object.entries(PARENT_OF_DEFAULT_TRUE)) {
        expect(defaultConfig[key as keyof typeof defaultConfig]).toBe(true);
        expect(defaultConfig[parent as keyof typeof defaultConfig]).toBe(false);
      }
    });

    it("does not declare wizard.enabled (#434 / #445 — wizard is always on)", () => {
      expect("wizard.enabled" in defaultConfig).toBe(false);
    });
  });
});
