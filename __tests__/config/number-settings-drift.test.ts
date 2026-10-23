import { describe, it, expect } from "@jest/globals";
import {
  defaultConfig,
  isManagedSetting,
  settingsMetadata,
} from "../../src/services/config-schema.js";
import {
  CHANNEL_LEAD_MAX,
  GROUP_COUNT_HARD_MAX,
} from "../../src/services/event-groups.js";
import { EVENT_DURATION_MAX } from "../../src/services/event-edit.js";
import { MAX_PARTY_SIZE } from "../../src/services/lfg-service.js";
import { MAX_TIMEOUT_MINUTES } from "../../src/utils/moderation-guards.js";

/**
 * Every number setting is a bounded whole number (#1304): the Settings input
 * carries `min` and `max`, and the write boundary refuses anything outside
 * them instead of clamping. A number key added without both bounds, or with a
 * default outside its own range (which would make every save of its section
 * fail), is caught here.
 */
const numberKeys = Object.keys(settingsMetadata).filter(
  (k) => settingsMetadata[k as keyof typeof settingsMetadata].type === "number",
);

describe("number settings are bounded (#1304)", () => {
  it("finds the number keys", () => {
    expect(numberKeys.length).toBeGreaterThan(50);
  });

  it("agrees with defaultConfig about which keys are numbers", () => {
    const byDefault = Object.entries(defaultConfig)
      .filter(([, v]) => typeof v === "number")
      .map(([k]) => k);
    expect([...numberKeys].sort()).toEqual([...byDefault].sort());
  });

  it.each(numberKeys)("%s declares an integer min and max", (key) => {
    const meta = settingsMetadata[key as keyof typeof settingsMetadata];
    expect(Number.isInteger(meta.min)).toBe(true);
    expect(Number.isInteger(meta.max)).toBe(true);
    expect(meta.min as number).toBeLessThanOrEqual(meta.max as number);
  });

  it.each(numberKeys)("%s default sits inside its own range", (key) => {
    const meta = settingsMetadata[key as keyof typeof settingsMetadata];
    const value = defaultConfig[key as keyof typeof defaultConfig] as number;
    expect(value).toBeGreaterThanOrEqual(meta.min as number);
    expect(value).toBeLessThanOrEqual(meta.max as number);
  });

  it("keeps a schema max equal to the hard cap the service enforces", () => {
    const max = (key: string): number | undefined =>
      settingsMetadata[key as keyof typeof settingsMetadata].max;
    expect(max("events.groups.max_count")).toBe(GROUP_COUNT_HARD_MAX);
    expect(max("events.groups.default_count")).toBe(GROUP_COUNT_HARD_MAX);
    expect(max("events.create_lead_minutes")).toBe(CHANNEL_LEAD_MAX);
    expect(max("events.default_duration_minutes")).toBe(EVENT_DURATION_MAX);
    expect(max("lfg.default_size")).toBe(MAX_PARTY_SIZE);
    expect(max("moderation.raid.timeout_minutes")).toBe(MAX_TIMEOUT_MINUTES);
    expect(max("moderation.raid.window_seconds")).toBe(3600);
    expect(max("polls.default_duration_hours")).toBe(768);
  });
});

describe("bot-managed settings (#1304)", () => {
  it("are the posted-message ids, each naming the channel it was posted in", () => {
    const managed = Object.keys(settingsMetadata).filter(isManagedSetting);
    expect(managed.sort()).toEqual([
      "notices.header_message_id",
      "quotes.header_message_id",
      "rules.message_id",
    ]);
    for (const key of managed) {
      const channelKey =
        settingsMetadata[key as keyof typeof settingsMetadata].managed
          ?.channelKey;
      expect(channelKey).toBeDefined();
      expect(channelKey as string).toMatch(/channel_id$/);
      expect((channelKey as string) in defaultConfig).toBe(true);
    }
  });

  it("leaves welcome.roles_message_id editable: an operator sets it, nothing writes it", () => {
    expect(isManagedSetting("welcome.roles_message_id")).toBe(false);
  });
});
