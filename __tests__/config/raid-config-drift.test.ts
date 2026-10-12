import { describe, it, expect } from "@jest/globals";
import {
  defaultConfig,
  settingsMetadata,
} from "../../src/services/config-schema.js";
import { RAID_CONFIG_KEYS } from "../../src/services/raid-protection-service.js";
import { MODERATION_SETTING_KEYS } from "../../src/web/read-only-routes.js";
import { COMMAND_CONFIGS } from "../../src/services/command-registry.js";
import { CONFIG_CATEGORIES } from "../../src/models/config.js";
import {
  WIZARD_FEATURE_EXTRA_GATES,
  WIZARD_FEATURE_SETTINGS,
} from "../../src/web/routes/write/helpers.js";

/**
 * Guards the anti-raid key set (#1045) so the service, the schema, the
 * Moderation page card and the wizard cannot drift apart. SETTINGS.md is
 * covered by settings-doc-drift.test.ts.
 */
const schemaKeys = Object.keys(defaultConfig).filter((k) =>
  k.startsWith("moderation.raid."),
);

describe("moderation.raid.* keys", () => {
  it("are exactly the keys the service reads", () => {
    expect([...RAID_CONFIG_KEYS].sort()).toEqual([...schemaKeys].sort());
  });

  it("default to off, dry run, and the reversible action", () => {
    expect(defaultConfig["moderation.raid.enabled"]).toBe(false);
    expect(defaultConfig["moderation.raid.dry_run"]).toBe(true);
    expect(defaultConfig["moderation.raid.lockdown_action"]).toBe("timeout");
    expect(defaultConfig["moderation.raid.new_account_action"]).toBe("timeout");
    // The account gate is opt-in too.
    expect(defaultConfig["moderation.raid.min_account_age_hours"]).toBe(0);
  });

  it("each have metadata in a known category and are on the Moderation card", () => {
    for (const key of schemaKeys) {
      const meta = settingsMetadata[key as keyof typeof settingsMetadata];
      expect(meta).toBeDefined();
      expect(CONFIG_CATEGORIES).toContain(meta.category);
      expect(MODERATION_SETTING_KEYS).toContain(key);
    }
  });

  it("offer only real actions in the action selects", () => {
    for (const key of [
      "moderation.raid.lockdown_action",
      "moderation.raid.new_account_action",
    ] as const) {
      const values = settingsMetadata[key].options?.map((o) => o.value);
      expect(values?.sort()).toEqual(["kick", "quarantine", "timeout"]);
    }
  });

  it("are all reachable in the wizard, with the master gate still first", () => {
    const wizardKeys = WIZARD_FEATURE_SETTINGS.moderation;
    expect(wizardKeys[0]).toBe("moderation.enabled");
    for (const key of RAID_CONFIG_KEYS) expect(wizardKeys).toContain(key);
    expect(WIZARD_FEATURE_EXTRA_GATES.moderation).toContain(
      "moderation.raid.enabled",
    );
  });

  it("gate /raidmode on the raid switch, not the moderation log alone", () => {
    expect(COMMAND_CONFIGS.find((c) => c.name === "raidmode")?.configKey).toBe(
      "moderation.raid.enabled",
    );
  });
});
