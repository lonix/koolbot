import { describe, it, expect } from "@jest/globals";
import {
  SEED_USER_PREFIX,
  seedUserId,
  redactUri,
  buildIdentities,
  generateSampleDataset,
  parseOptions,
  type SeedOptions,
} from "../../src/scripts/seed-sample-data.js";

// Pure-helper coverage for the sample-data seeder (#667). The script's DB
// writes go through the globally-mocked mongoose (see __tests__/setup.ts), so
// these tests focus on the deterministic data-generation helpers per
// TESTING.md.

const baseOptions: SeedOptions = {
  users: 3,
  guildId: "guild-123",
  seed: 42,
  from: new Date("2026-01-01T00:00:00Z"),
  to: new Date("2026-06-01T00:00:00Z"),
};

describe("seed-sample-data helpers", () => {
  it("namespaces every fake user id behind the seed prefix", () => {
    const id = seedUserId(7);
    expect(id.startsWith(SEED_USER_PREFIX)).toBe(true);
    expect(id).toBe("seed-0007");
  });

  it("redacts the password embedded in a mongodb URI", () => {
    expect(redactUri("mongodb://user:s3cret@host:27017/db")).toBe(
      "mongodb://user:***@host:27017/db",
    );
    // URIs without credentials are returned unchanged.
    expect(redactUri("mongodb://mongodb:27017/koolbot")).toBe(
      "mongodb://mongodb:27017/koolbot",
    );
  });

  it("builds the requested number of distinct prefixed identities", () => {
    const identities = buildIdentities(5);
    expect(identities).toHaveLength(5);
    expect(new Set(identities.map((i) => i.userId)).size).toBe(5);
    expect(identities.every((i) => i.userId.startsWith(SEED_USER_PREFIX))).toBe(
      true,
    );
    expect(identities.every((i) => i.username.length > 0)).toBe(true);
  });

  it("is deterministic given a fixed seed and span", () => {
    const a = generateSampleDataset(baseOptions);
    const b = generateSampleDataset(baseOptions);
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
  });

  it("produces different data for a different seed", () => {
    const a = generateSampleDataset(baseOptions);
    const b = generateSampleDataset({ ...baseOptions, seed: 999 });
    expect(JSON.stringify(b)).not.toEqual(JSON.stringify(a));
  });

  it("populates every targeted surface for each user", () => {
    const ds = generateSampleDataset(baseOptions);
    expect(ds.identities).toHaveLength(3);
    expect(ds.voiceTracking).toHaveLength(3);
    expect(ds.messageActivity).toHaveLength(3);
    expect(ds.achievements).toHaveLength(3);
    expect(ds.reactions).toHaveLength(3);
    expect(ds.polls).toHaveLength(3);
    expect(ds.notificationPrefs).toHaveLength(3);
    expect(ds.voicePreferences).toHaveLength(3);
  });

  it("spreads voice sessions inside the requested date range with companions", () => {
    const ds = generateSampleDataset(baseOptions);
    const doc = ds.voiceTracking[0];
    expect(doc.sessions.length).toBeGreaterThan(0);
    for (const s of doc.sessions) {
      expect(s.startTime.getTime()).toBeGreaterThanOrEqual(
        baseOptions.from.getTime(),
      );
      expect(s.endTime.getTime()).toBeGreaterThanOrEqual(s.startTime.getTime());
      // otherUsers reference other seeded users, never the user itself.
      expect(s.otherUsers).not.toContain(doc.userId);
    }
    // totalTime equals the sum of session durations.
    const sum = doc.sessions.reduce((acc, s) => acc + s.duration, 0);
    expect(doc.totalTime).toBe(sum);
    // Yearly totals cover 2026.
    expect(doc.yearlyTotals.some((y) => y.year === "2026")).toBe(true);
  });

  it("uses real accolade type keys from src/content", () => {
    const ds = generateSampleDataset(baseOptions);
    const doc = ds.achievements[0];
    expect(doc.accolades.length).toBeGreaterThan(0);
    expect(doc.statistics.totalAccolades).toBe(doc.accolades.length);
    expect(doc.statistics.totalAchievements).toBe(doc.achievements.length);
  });

  it("builds per-year reaction and poll buckets that sum to the totals", () => {
    const ds = generateSampleDataset(baseOptions);
    const r = ds.reactions[0];
    expect(r.yearlyGiven["2026"]).toBeGreaterThanOrEqual(0);
    const given = Object.values(r.yearlyGiven).reduce((a, c) => a + c, 0);
    expect(r.totalGiven).toBe(given);

    const p = ds.polls[0];
    const votes = Object.values(p.yearlyVotes).reduce((a, c) => a + c, 0);
    expect(p.totalVotes).toBe(votes);
  });
});

describe("parseOptions", () => {
  it("applies defaults and the current-year span when no flags are given", () => {
    const opts = parseOptions(["--guild", "g1"]);
    expect(opts.users).toBe(10);
    expect(opts.seed).toBe(1337);
    expect(opts.guildId).toBe("g1");
    expect(opts.yes).toBe(false);
    expect(opts.clean).toBe(false);
    expect(opts.from.getUTCFullYear()).toBe(new Date().getUTCFullYear());
  });

  it("parses explicit users, seed, span and flags", () => {
    const opts = parseOptions([
      "--users",
      "25",
      "--seed",
      "7",
      "--from",
      "2024-01-01",
      "--to",
      "2024-12-31",
      "--guild",
      "g2",
      "--yes",
      "--clean",
    ]);
    expect(opts.users).toBe(25);
    expect(opts.seed).toBe(7);
    expect(opts.from.getUTCFullYear()).toBe(2024);
    expect(opts.to.getUTCFullYear()).toBe(2024);
    expect(opts.yes).toBe(true);
    expect(opts.clean).toBe(true);
  });

  it("derives the span from --years", () => {
    const opts = parseOptions(["--years", "2", "--guild", "g3"]);
    const span = opts.to.getUTCFullYear() - opts.from.getUTCFullYear();
    expect(span).toBe(2);
  });

  it("rejects an inverted date range", () => {
    expect(() =>
      parseOptions(["--from", "2026-12-31", "--to", "2026-01-01"]),
    ).toThrow();
  });
});
