import { describe, it, expect } from "@jest/globals";
import {
  BOT_STATUS_POOLS,
  BOT_STATUS_POOL_META,
  STATUS_POOL_DEFAULTS,
  STATUS_TEXT_MAX,
  isBotStatusPool,
  validateStatusEntry,
  multipleUsersStatuses,
} from "../../src/content/statuses.js";

describe("isBotStatusPool", () => {
  it("accepts the three known pools", () => {
    for (const pool of BOT_STATUS_POOLS) {
      expect(isBotStatusPool(pool)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isBotStatusPool("bogus")).toBe(false);
    expect(isBotStatusPool("")).toBe(false);
  });
});

describe("validateStatusEntry", () => {
  it("rejects empty / whitespace-only text", () => {
    expect(validateStatusEntry("lonely", "")).toMatch(/cannot be empty/);
    expect(validateStatusEntry("lonely", "   ")).toMatch(/cannot be empty/);
  });

  it("rejects text longer than the cap", () => {
    const tooLong = "x".repeat(STATUS_TEXT_MAX + 1);
    expect(validateStatusEntry("lonely", tooLong)).toMatch(
      /characters or fewer/,
    );
  });

  it("accepts a plain entry for non-count pools", () => {
    expect(validateStatusEntry("lonely", "the void")).toBeNull();
    expect(validateStatusEntry("single", "a lone wanderer")).toBeNull();
  });

  it("requires the {count} placeholder for the multiple pool", () => {
    expect(validateStatusEntry("multiple", "lots of nerds")).toMatch(
      /\{count\} placeholder/,
    );
  });

  it("accepts a multiple-pool entry that contains {count}", () => {
    expect(validateStatusEntry("multiple", "{count} nerds")).toBeNull();
  });
});

describe("pool defaults and metadata", () => {
  it("has defaults and metadata for every pool", () => {
    for (const pool of BOT_STATUS_POOLS) {
      expect(STATUS_POOL_DEFAULTS[pool].length).toBeGreaterThan(0);
      expect(BOT_STATUS_POOL_META[pool].pool).toBe(pool);
    }
  });

  it("only flags the multiple pool as requiring {count}", () => {
    expect(BOT_STATUS_POOL_META.multiple.requiresCount).toBe(true);
    expect(BOT_STATUS_POOL_META.lonely.requiresCount).toBe(false);
    expect(BOT_STATUS_POOL_META.single.requiresCount).toBe(false);
  });

  it("ships multiple-pool defaults that all satisfy their own validation", () => {
    for (const entry of multipleUsersStatuses) {
      expect(validateStatusEntry("multiple", entry)).toBeNull();
    }
  });
});
