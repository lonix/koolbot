import { describe, it, expect } from "@jest/globals";
import {
  defaultConfig,
  settingsMetadata,
} from "../../src/services/config-schema.js";

describe("settingsMetadata", () => {
  it("has an entry for every key in defaultConfig", () => {
    const missing: string[] = [];
    for (const key of Object.keys(defaultConfig)) {
      if (
        !(key in settingsMetadata) ||
        !settingsMetadata[key as keyof typeof settingsMetadata]
      ) {
        missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("provides a non-empty description and category for every key", () => {
    const violations: string[] = [];
    for (const [key, meta] of Object.entries(settingsMetadata)) {
      if (!meta.description || meta.description.length === 0) {
        violations.push(`empty description for ${key}`);
      }
      if (!meta.category || meta.category.length === 0) {
        violations.push(`empty category for ${key}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses only known feature categories that match the Mongo Config model enum", () => {
    // The Mongo Config model's category enum is grouped by feature
    // (voicechannels, voicetracking, quotes, …). Most settings keys are
    // dot-prefixed with that same group. Anything that diverges should be
    // intentional, not accidental.
    const knownCategories = new Set([
      "voicechannels",
      "voicetracking",
      "ping",
      "help",
      "amikool",
      "quotes",
      "core",
      "fun",
      "ratelimit",
      "announcements",
      "achievements",
      "reactionroles",
      "wizard",
      "notices",
      "polls",
      "leaderboard_roles",
    ]);
    const violations: string[] = [];
    for (const [key, meta] of Object.entries(settingsMetadata)) {
      if (!knownCategories.has(meta.category)) {
        violations.push(`unknown category "${meta.category}" for ${key}`);
      }
      if (key.includes(".")) {
        const prefix = key.slice(0, key.indexOf("."));
        if (knownCategories.has(prefix) && meta.category !== prefix) {
          violations.push(
            `${key} category "${meta.category}" disagrees with key prefix "${prefix}"`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
