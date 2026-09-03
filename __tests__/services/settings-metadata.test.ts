import { describe, it, expect } from "@jest/globals";
import {
  defaultConfig,
  settingsMetadata,
} from "../../src/services/config-schema.js";
import { CONFIG_CATEGORIES } from "../../src/models/config.js";

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

  it("uses only categories present in the Mongo Config model's CONFIG_CATEGORIES", () => {
    // CONFIG_CATEGORIES is the single source of truth for valid categories: it
    // backs the Mongoose enum AND the set ConfigService.cleanupUnknownSettings()
    // uses to decide which rows to keep. A metadata category that is missing
    // from it is silently *deleted from Mongo* on every restart / `/config
    // reload` (#609 `polls.*`/`notices.*`, #834 `celebrations.*`). This test
    // must import the real list rather than hardcode its own copy, otherwise
    // it passes while the invariant it protects is broken.
    const knownCategories = new Set<string>(CONFIG_CATEGORIES);
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
