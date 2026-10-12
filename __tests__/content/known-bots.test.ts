import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  KNOWN_BOTS,
  KOOLBOT_FEATURES,
  findKnownBot,
} from "../../src/content/known-bots.js";
import { defaultConfig } from "../../src/services/config-schema.js";

const SNOWFLAKE = /^\d{17,20}$/;

describe("known-bots catalogue (#1026)", () => {
  it("has unique keys and non-empty names and descriptions", () => {
    const keys = KNOWN_BOTS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const bot of KNOWN_BOTS) {
      expect(bot.name.trim()).not.toBe("");
      expect(bot.description.trim()).not.toBe("");
      expect(bot.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("uses snowflake ids that no two bots share", () => {
    const seen = new Map<string, string>();
    for (const bot of KNOWN_BOTS) {
      for (const id of bot.ids) {
        expect(id).toMatch(SNOWFLAKE);
        expect(seen.get(id)).toBeUndefined();
        seen.set(id, bot.key);
      }
    }
  });

  it("makes every coverage level carry the field it requires", () => {
    for (const bot of KNOWN_BOTS) {
      for (const cap of bot.capabilities) {
        const c = cap.coverage;
        if (c.level === "partial") expect(c.missing.trim()).not.toBe("");
        if (c.level === "planned")
          expect(Number.isInteger(c.issue) && c.issue > 0).toBe(true);
        if (c.level === "keep") expect(c.reason.trim()).not.toBe("");
        if (c.level === "full" || c.level === "partial") {
          expect(cap.feature).toBeDefined();
        }
        if (c.level === "none" || c.level === "keep" || c.level === "planned") {
          expect(cap.feature).toBeUndefined();
        }
      }
    }
  });

  it("only references features that exist, and config keys in defaultConfig", () => {
    for (const bot of KNOWN_BOTS) {
      for (const cap of bot.capabilities) {
        if (cap.feature) expect(KOOLBOT_FEATURES).toHaveProperty(cap.feature);
      }
    }
    for (const feature of Object.values(KOOLBOT_FEATURES)) {
      expect(feature.enabledKey in defaultConfig).toBe(true);
      expect(feature.steps.length).toBeGreaterThan(0);
      expect(feature.webPath.startsWith("/admin/")).toBe(true);
    }
  });

  it("names, in each step, only config keys that exist", () => {
    for (const feature of Object.values(KOOLBOT_FEATURES)) {
      for (const step of feature.steps) {
        const keys = step.match(/\b[a-z_]+(?:\.[a-z_]+)+\b/g) ?? [];
        for (const key of keys) {
          // Skip file names like "docs.md"; real config keys have a schema entry.
          expect(key in defaultConfig).toBe(true);
        }
      }
    }
  });

  it("links web pages that have a read route", () => {
    const routes = readFileSync("src/web/read-only-routes.ts", "utf8");
    for (const feature of Object.values(KOOLBOT_FEATURES)) {
      const path = feature.webPath.replace("/admin", "").split("#")[0];
      if (path === "/settings") continue;
      expect(routes).toContain(`"${path}"`);
    }
  });

  it("never offers coverage for music, XP levelling or auto-moderation", () => {
    for (const bot of KNOWN_BOTS) {
      for (const cap of bot.capabilities) {
        if (["music", "message-xp", "auto-mod"].includes(cap.id)) {
          expect(["keep", "none"]).toContain(cap.coverage.level);
        }
      }
    }
  });

  it("seeds the bots named in the issue comments", () => {
    const names = KNOWN_BOTS.map((b) => b.name);
    for (const n of [
      "Dyno",
      "Zira",
      "Emoji.gg",
      "Notifiarr",
      "Lara",
      "TempVoice",
      "Color-Chan",
      "YAGPDB",
      "Jockie Music",
    ]) {
      expect(names).toContain(n);
    }
    const zira = KNOWN_BOTS.find((b) => b.key === "zira")!;
    expect(zira.capabilities.every((c) => c.coverage.level === "full")).toBe(
      true,
    );
  });

  it("finds a bot by id and not by name", () => {
    const dyno = KNOWN_BOTS.find((b) => b.key === "dyno")!;
    expect(findKnownBot(dyno.ids[0]!)?.key).toBe("dyno");
    expect(findKnownBot("999999999999999999")).toBeNull();
    expect(findKnownBot("Dyno")).toBeNull();
  });
});
