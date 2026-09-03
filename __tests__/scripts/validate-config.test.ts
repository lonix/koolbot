import { describe, it, expect, afterEach } from "@jest/globals";
import {
  schemaKeys,
  expectedPrimitive,
  formatValue,
  validateSetting,
  buildEnvFindings,
  buildFeatureFindings,
  buildReport,
  summarize,
  REQUIRED_WHEN_ENABLED,
  type Finding,
} from "../../src/scripts/validate-config.js";
import {
  defaultConfig,
  settingsMetadata,
  type ConfigSchema,
} from "../../src/services/config-schema.js";

// The script's DB access goes through the globally-mocked ConfigService /
// mongoose (see __tests__/setup.ts), so these tests cover the pure report
// builders per TESTING.md.

// The env-var findings read process.env, so snapshot and restore it the way
// __tests__/config/env.test.ts does — Jest workers are shared between suites.
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const find = (findings: Finding[], key: string): Finding => {
  const finding = findings.find((f) => f.key === key);
  if (!finding) throw new Error(`no finding for ${key}`);
  return finding;
};

describe("validate-config key list", () => {
  // Regression guard for #858: the script used to check a hand-maintained
  // copy of the key names that had drifted entirely out of the schema.
  it("checks exactly the keys declared in the config schema", () => {
    const keys = schemaKeys();
    expect(keys.length).toBe(Object.keys(defaultConfig).length);
    for (const key of keys) {
      expect(settingsMetadata[key]).toBeDefined();
    }
  });

  it("no longer checks the retired pre-rename key names", () => {
    const { settings } = buildReport(new Map(), []);
    const checked = settings.map((f) => f.key);
    for (const stale of [
      "voice_channel.enabled",
      "voice_channel.category_name",
      "voice_channel.lobby_channel_name",
      "voice_channel.lobby_channel_name_offline",
      "tracking.enabled",
      "tracking.weekly_announcement_channel",
    ]) {
      expect(checked).not.toContain(stale);
    }
    expect(checked).toEqual(
      expect.arrayContaining([
        "voicechannels.enabled",
        "voicechannels.category_id",
        "voicechannels.lobby.name",
        "voicechannels.lobby.offlinename",
        "voicetracking.enabled",
        "voicetracking.announcements.channel_id",
      ]),
    );
  });

  it("reports the schema's real default, not a second hardcoded copy", () => {
    // The old script claimed voice channel management defaults to `true`;
    // the schema ships it off.
    const finding = validateSetting("voicechannels.enabled", null);
    expect(finding.severity).toBe("default");
    expect(finding.message).toContain("false");
    expect(defaultConfig["voicechannels.enabled"]).toBe(false);
  });

  it("only gates on keys that exist in the schema", () => {
    for (const { gate, key } of REQUIRED_WHEN_ENABLED) {
      expect(settingsMetadata[gate]).toBeDefined();
      expect(settingsMetadata[gate].type).toBe("boolean");
      expect(settingsMetadata[key]).toBeDefined();
    }
  });
});

describe("expectedPrimitive", () => {
  it("maps the Discord and cron setting types onto strings", () => {
    expect(expectedPrimitive("boolean")).toBe("boolean");
    expect(expectedPrimitive("number")).toBe("number");
    for (const type of [
      "string",
      "cron",
      "channel",
      "category",
      "role",
      "channel_list",
      "role_list",
    ] as const) {
      expect(expectedPrimitive(type)).toBe("string");
    }
  });
});

describe("validateSetting", () => {
  it("accepts a value the runtime can read", () => {
    expect(validateSetting("voicetracking.enabled", true).severity).toBe("ok");
    // ConfigService.getBoolean coerces the string form, so it is not an error.
    expect(validateSetting("voicetracking.enabled", "true").severity).toBe(
      "ok",
    );
    expect(
      validateSetting(
        "voicetracking.cleanup.retention.monthly_summaries_months",
        6,
      ).severity,
    ).toBe("ok");
  });

  it("errors on a value that cannot be read as the declared type", () => {
    const boolFinding = validateSetting("voicetracking.enabled", "yes");
    expect(boolFinding.severity).toBe("error");
    expect(boolFinding.message).toContain("expected boolean");

    const numFinding = validateSetting("polls.default_duration_hours", "soon");
    expect(numFinding.severity).toBe("error");
    expect(numFinding.message).toContain("expected number");
  });

  it("errors on a value outside a setting's fixed option list", () => {
    expect(validateSetting("leaderboard_roles.period", "month").severity).toBe(
      "ok",
    );
    const finding = validateSetting("leaderboard_roles.period", "fortnight");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("week");
  });

  it("warns when a Discord ID setting holds a name instead of an ID", () => {
    expect(
      validateSetting(
        "voicetracking.announcements.channel_id",
        "123456789012345678",
      ).severity,
    ).toBe("ok");
    const finding = validateSetting(
      "voicetracking.announcements.channel_id",
      "voice-stats",
    );
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("not a Discord ID");
  });

  it("checks every entry of a comma-separated ID list", () => {
    const finding = validateSetting(
      "voicetracking.excluded_channels",
      "123456789012345678, afk-channel",
    );
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("afk-channel");
  });

  it("warns when a retention drops below its recommended minimum", () => {
    const finding = validateSetting(
      "voicetracking.cleanup.retention.detailed_sessions_days",
      30,
    );
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("Rewind");
  });

  it("flags a retention below its declared minimum as an error (#835)", () => {
    const finding = validateSetting(
      "voicetracking.cleanup.retention.detailed_sessions_days",
      -1,
    );
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("minimum of 0");
  });

  it("does not raise the Rewind warning for 0, which means keep forever (#835)", () => {
    const finding = validateSetting(
      "voicetracking.cleanup.retention.detailed_sessions_days",
      0,
    );
    expect(finding.severity).toBe("ok");
  });

  it("refuses 0 for the TTL-driven metrics retention (#835)", () => {
    expect(
      validateSetting("monitoring.metrics_retention_days", 0).severity,
    ).toBe("error");
    expect(
      validateSetting("monitoring.metrics_retention_days", 1).severity,
    ).toBe("ok");
  });

  it("treats an unset key as using the schema default", () => {
    for (const key of schemaKeys()) {
      expect(validateSetting(key, null).severity).toBe("default");
    }
  });

  it("distinguishes a stored empty string from an unset key", () => {
    const finding = validateSetting("voicechannels.category_id", "");
    expect(finding.severity).toBe("ok");
    expect(finding.message).toContain("(empty)");
  });
});

describe("buildEnvFindings", () => {
  it("errors for each missing required variable", () => {
    const findings = buildEnvFindings(["DISCORD_TOKEN", "GUILD_ID"]);
    expect(find(findings, "DISCORD_TOKEN").severity).toBe("error");
    expect(find(findings, "GUILD_ID").severity).toBe("error");
  });

  it("never echoes a secret value", () => {
    process.env.DISCORD_TOKEN = "super-secret-token";
    process.env.MONGODB_URI = "mongodb://user:hunter2@host:27017/koolbot";
    const findings = buildEnvFindings([]);
    for (const key of ["DISCORD_TOKEN", "MONGODB_URI"]) {
      const finding = find(findings, key);
      expect(finding.severity).toBe("ok");
      expect(finding.message).toContain("value hidden");
    }
    expect(JSON.stringify(findings)).not.toContain("super-secret-token");
    expect(JSON.stringify(findings)).not.toContain("hunter2");
  });
});

describe("buildFeatureFindings", () => {
  const stored = (
    entries: Partial<Record<keyof ConfigSchema, unknown>>,
  ): Map<keyof ConfigSchema, unknown> =>
    new Map(Object.entries(entries) as [keyof ConfigSchema, unknown][]);

  it("is quiet on a stock configuration", () => {
    expect(buildFeatureFindings(stored({}))).toEqual([]);
  });

  it("warns when an enabled feature is missing the ID it needs", () => {
    const findings = buildFeatureFindings(
      stored({ "voicechannels.enabled": true }),
    );
    const finding = find(findings, "voicechannels.category_id");
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("voicechannels.enabled is enabled");
  });

  it("stays quiet once the required ID is set", () => {
    const findings = buildFeatureFindings(
      stored({
        "voicechannels.enabled": true,
        "voicechannels.category_id": "123456789012345678",
      }),
    );
    expect(findings.map((f) => f.key)).not.toContain(
      "voicechannels.category_id",
    );
  });

  it("errors when an enabled feature's hard dependency is off", () => {
    const findings = buildFeatureFindings(
      stored({
        "voicetracking.announcements.enabled": true,
        "voicetracking.announcements.channel_id": "123456789012345678",
      }),
    );
    const finding = find(findings, "voicetracking.announcements.enabled");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("voicetracking.enabled");
  });

  it("accepts a feature enabled together with its dependency", () => {
    const findings = buildFeatureFindings(
      stored({
        "voicetracking.enabled": true,
        "voicetracking.announcements.enabled": true,
        "voicetracking.announcements.channel_id": "123456789012345678",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("does not judge default-on sub-toggles against the dependency graph", () => {
    // `digest.include_achievements` ships on while `achievements.enabled`
    // ships off — inert, not a misconfiguration (schema rule 2), so a stock
    // install must not be reported as broken.
    expect(defaultConfig["digest.include_achievements"]).toBe(true);
    expect(defaultConfig["achievements.enabled"]).toBe(false);
    expect(
      buildFeatureFindings(stored({ "achievements.enabled": false })),
    ).toEqual([]);
  });
});

describe("summarize", () => {
  it("counts a fresh install as all defaults with no errors", () => {
    process.env.DISCORD_TOKEN = "token";
    process.env.CLIENT_ID = "client";
    process.env.GUILD_ID = "guild";
    process.env.MONGODB_URI = "mongodb://mongodb:27017/koolbot";

    const summary = summarize(buildReport(new Map(), []));
    expect(summary.errors).toBe(0);
    expect(summary.warnings).toBe(0);
    expect(summary.defaults).toBe(schemaKeys().length);
    expect(summary.ok).toBe(4);
  });

  it("counts a broken configuration as errors", () => {
    const stored = new Map<keyof ConfigSchema, unknown>([
      ["voicetracking.enabled", "yes"],
    ]);
    const summary = summarize(buildReport(stored, ["DISCORD_TOKEN"]));
    expect(summary.errors).toBeGreaterThanOrEqual(2);
  });
});

describe("formatValue", () => {
  it("makes an empty string visible and strips log-injection newlines", () => {
    expect(formatValue("")).toBe("(empty)");
    expect(formatValue(undefined)).toBe("(unset)");
    expect(formatValue("a\nb")).toBe("a b");
    expect(formatValue(false)).toBe("false");
  });
});
