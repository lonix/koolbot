import { describe, it, expect } from "@jest/globals";
import {
  formatDuration,
  formatTimeAgo,
  formatDateInTimezone,
  getIsoWeekKey,
} from "../../src/utils/time.js";

describe("Time Utilities", () => {
  describe("formatDuration", () => {
    it("should format seconds only", () => {
      const result = formatDuration(5000); // 5 seconds
      expect(result).toBe("5 seconds");
    });

    it("should format single second", () => {
      const result = formatDuration(1000); // 1 second
      expect(result).toBe("1 second");
    });

    it("should format minutes and seconds", () => {
      const result = formatDuration(90000); // 1 minute 30 seconds
      expect(result).toBe("1 minute");
    });

    it("should format hours and minutes", () => {
      const result = formatDuration(3660000); // 1 hour 1 minute
      expect(result).toBe("1 hour, 1 minute");
    });

    it("should format days, hours, and minutes", () => {
      const result = formatDuration(90000000); // 1 day 1 hour
      expect(result).toBe("1 day, 1 hour");
    });

    it("should handle multiple days", () => {
      const result = formatDuration(172800000); // 2 days
      expect(result).toBe("2 days");
    });

    it("should handle multiple hours", () => {
      const result = formatDuration(7200000); // 2 hours
      expect(result).toBe("2 hours");
    });

    it("should handle multiple minutes", () => {
      const result = formatDuration(120000); // 2 minutes
      expect(result).toBe("2 minutes");
    });

    it("should handle zero milliseconds", () => {
      const result = formatDuration(0);
      expect(result).toBe(""); // Returns empty string when no parts
    });

    it("should handle less than 1 second", () => {
      const result = formatDuration(500); // 0.5 seconds
      expect(result).toBe(""); // Returns empty string for sub-second durations
    });

    it("should format complex duration", () => {
      const result = formatDuration(93784000); // 1 day, 2 hours, 3 minutes, 4 seconds
      expect(result).toBe("1 day, 2 hours, 3 minutes");
    });
  });

  describe("formatTimeAgo", () => {
    it("should format recent time", () => {
      const date = new Date(Date.now() - 5000); // 5 seconds ago
      const result = formatTimeAgo(date);
      // date-fns may say "less than a minute ago" for very recent times
      expect(result).toContain("ago");
    });

    it("should format minutes ago", () => {
      const date = new Date(Date.now() - 120000); // 2 minutes ago
      const result = formatTimeAgo(date);
      expect(result).toContain("minute");
      expect(result).toContain("ago");
    });

    it("should format hours ago", () => {
      const date = new Date(Date.now() - 3600000); // 1 hour ago
      const result = formatTimeAgo(date);
      expect(result).toContain("hour");
      expect(result).toContain("ago");
    });

    it("should format days ago", () => {
      const date = new Date(Date.now() - 86400000); // 1 day ago
      const result = formatTimeAgo(date);
      expect(result).toContain("day");
      expect(result).toContain("ago");
    });

    it("should handle invalid date gracefully", () => {
      const result = formatTimeAgo(new Date("invalid"));
      expect(result).toBe("unknown time");
    });
  });

  describe("formatDateInTimezone", () => {
    it("should format date in UTC", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = formatDateInTimezone(date, "UTC");
      expect(result).toBe("2024-01-15 10:30:00");
    });

    it("should format date in America/New_York", () => {
      const date = new Date("2024-01-15T15:30:00Z");
      const result = formatDateInTimezone(date, "America/New_York");
      expect(result).toMatch(/2024-01-15 \d{2}:\d{2}:\d{2}/);
    });

    it("should handle invalid timezone by falling back to UTC format", () => {
      const date = new Date("2024-01-15T10:30:00Z");
      const result = formatDateInTimezone(date, "Invalid/Timezone");
      expect(result).toMatch(/2024-01-15 \d{2}:\d{2}:\d{2}/);
    });

    it("should format date in Europe/London", () => {
      const date = new Date("2024-01-15T12:00:00Z");
      const result = formatDateInTimezone(date, "Europe/London");
      expect(result).toMatch(/2024-01-15 \d{2}:\d{2}:\d{2}/);
    });
  });

  describe("getIsoWeekKey", () => {
    it("returns the ISO week of a mid-year date", () => {
      expect(getIsoWeekKey(new Date("2026-08-13T09:58:14Z"))).toBe("2026-W33");
    });

    it("zero-pads single-digit week numbers", () => {
      expect(getIsoWeekKey(new Date("2026-01-08T00:00:00Z"))).toBe("2026-W02");
    });

    it("uses the ISO week-year, not the calendar year, at a boundary", () => {
      // Dec 30 2024 is a Monday and belongs to ISO week 1 of 2025.
      expect(getIsoWeekKey(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
      // Jan 1 2027 is a Friday, still ISO week 53 of 2026.
      expect(getIsoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    });

    it("buckets by UTC, so a late-evening local time cannot shift the week", () => {
      const sundayEnd = new Date("2026-08-16T23:59:59Z");
      const mondayStart = new Date("2026-08-17T00:00:00Z");
      expect(getIsoWeekKey(sundayEnd)).toBe("2026-W33");
      expect(getIsoWeekKey(mondayStart)).toBe("2026-W34");
    });

    it("sorts lexicographically in chronological order (retention relies on it)", () => {
      const keys = [
        getIsoWeekKey(new Date("2026-01-05T00:00:00Z")),
        getIsoWeekKey(new Date("2025-12-29T00:00:00Z")),
        getIsoWeekKey(new Date("2026-11-30T00:00:00Z")),
      ];
      expect([...keys].sort()).toEqual([
        "2026-W01",
        "2026-W02",
        "2026-W49",
      ]);
    });
  });
});
