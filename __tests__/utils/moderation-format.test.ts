import { describe, it, expect } from "@jest/globals";
import {
  actionColor,
  actionLabel,
  formatHistorySummary,
  ACTION_SUMMARY_ORDER,
  type ModerationHistorySummary,
} from "../../src/utils/moderation-format.js";
import type { ModerationAction } from "../../src/models/moderation-log.js";

const ALL_ACTIONS: ModerationAction[] = [
  "warn",
  "kick",
  "ban",
  "unban",
  "timeout",
  "untimeout",
];

describe("actionLabel", () => {
  it("renders a label for every action", () => {
    expect(actionLabel("warn")).toContain("Warn");
    expect(actionLabel("kick")).toContain("Kick");
    expect(actionLabel("ban")).toContain("Ban");
    expect(actionLabel("unban")).toContain("Unban");
    expect(actionLabel("timeout")).toContain("Timeout");
    expect(actionLabel("untimeout")).toContain("lifted");
  });
});

describe("actionColor", () => {
  it("returns a colour for every action", () => {
    for (const action of ALL_ACTIONS) {
      expect(typeof actionColor(action)).toBe("number");
    }
  });

  it("uses the same green for both reversals", () => {
    expect(actionColor("unban")).toBe(actionColor("untimeout"));
  });
});

describe("formatHistorySummary (#907)", () => {
  const empty: ModerationHistorySummary = {
    total: 0,
    counts: {},
    mostRecent: null,
  };

  it("says so when there is no prior history", () => {
    expect(formatHistorySummary(empty)).toBe("No prior entries");
  });

  it("renders the issue's example shape", () => {
    const mostRecent = new Date("2026-05-08T12:00:00.000Z");
    const summary: ModerationHistorySummary = {
      total: 3,
      counts: { warn: 2, timeout: 1 },
      mostRecent,
    };

    // A Discord relative timestamp so each viewer sees "4 months ago" in
    // their own locale without the bot doing date maths.
    expect(formatHistorySummary(summary)).toBe(
      `2 warns, 1 timeout (most recent <t:${Math.floor(
        mostRecent.getTime() / 1000,
      )}:R>)`,
    );
  });

  it("uses singular nouns for a count of one", () => {
    expect(
      formatHistorySummary({
        total: 1,
        counts: { kick: 1 },
        mostRecent: null,
      }),
    ).toBe("1 kick");
  });

  it("lists actions in a fixed order regardless of the counts object", () => {
    const summary: ModerationHistorySummary = {
      total: 4,
      counts: { unban: 1, ban: 1, warn: 1, timeout: 1 },
      mostRecent: null,
    };

    expect(formatHistorySummary(summary)).toBe(
      "1 warn, 1 timeout, 1 ban, 1 unban",
    );
  });

  it("omits actions with no entries", () => {
    expect(
      formatHistorySummary({
        total: 2,
        counts: { warn: 2, kick: 0 },
        mostRecent: null,
      }),
    ).toBe("2 warns");
  });

  it("covers every action in the summary order", () => {
    expect([...ACTION_SUMMARY_ORDER].sort()).toEqual([...ALL_ACTIONS].sort());
  });
});
