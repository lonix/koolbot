import { describe, it, expect } from "@jest/globals";
import { parseDuration } from "../../src/utils/time.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe("parseDuration", () => {
  describe("single units", () => {
    it("parses minutes", () => {
      expect(parseDuration("30m")).toBe(30 * MINUTE);
    });

    it("parses hours", () => {
      expect(parseDuration("2h")).toBe(2 * HOUR);
    });

    it("parses days", () => {
      expect(parseDuration("3d")).toBe(3 * DAY);
    });

    it("parses weeks", () => {
      expect(parseDuration("1w")).toBe(WEEK);
    });
  });

  describe("compound and lenient input", () => {
    it("sums a compound duration", () => {
      expect(parseDuration("1h30m")).toBe(HOUR + 30 * MINUTE);
    });

    it("sums three segments", () => {
      expect(parseDuration("1d2h3m")).toBe(DAY + 2 * HOUR + 3 * MINUTE);
    });

    it("ignores whitespace between segments", () => {
      expect(parseDuration(" 1h 30m ")).toBe(HOUR + 30 * MINUTE);
    });

    it("is case-insensitive", () => {
      expect(parseDuration("1H30M")).toBe(HOUR + 30 * MINUTE);
    });

    it("accepts segments in any order", () => {
      expect(parseDuration("30m1h")).toBe(HOUR + 30 * MINUTE);
    });

    it("adds repeated units rather than rejecting them", () => {
      expect(parseDuration("1h1h")).toBe(2 * HOUR);
    });
  });

  describe("rejected input", () => {
    it.each([
      ["an empty string", ""],
      ["whitespace only", "   "],
      ["a bare number", "90"],
      ["a bare unit", "h"],
      ["an unknown unit", "5y"],
      ["seconds, which the minute-resolution scan cannot honour", "30s"],
      ["trailing junk", "2hx"],
      ["leading junk", "x2h"],
      ["a negative duration", "-5m"],
      ["a decimal", "1.5h"],
      ["free text", "tomorrow"],
      ["a zero total", "0m"],
      ["a zero compound total", "0h0m"],
    ])("rejects %s", (_label, input) => {
      expect(parseDuration(input)).toBeNull();
    });

    it("rejects a non-string input", () => {
      expect(parseDuration(undefined as unknown as string)).toBeNull();
    });

    it("rejects a duration too large to represent safely", () => {
      expect(parseDuration(`${Number.MAX_SAFE_INTEGER}w`)).toBeNull();
    });
  });
});
