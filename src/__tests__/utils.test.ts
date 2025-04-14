import { describe, it, expect } from "@jest/globals";
import { formatDuration, formatTimeAgo, formatDateInTimezone } from "../utils/time.js";

describe("Utils", () => {
  describe("formatDuration", () => {
    it("should format duration in minutes correctly", () => {
      expect(formatDuration(30000)).toBe("30 seconds");
      expect(formatDuration(60000)).toBe("1 minute");
      expect(formatDuration(120000)).toBe("2 minutes");
      expect(formatDuration(3600000)).toBe("1 hour");
      expect(formatDuration(7200000)).toBe("2 hours");
      expect(formatDuration(86400000)).toBe("1 day");
      expect(formatDuration(90000000)).toBe("1 day, 1 hour");
    });
  });

  describe("formatTimeAgo", () => {
    it("should format time ago correctly", () => {
      const now = new Date();
      const oneMinuteAgo = new Date(now.getTime() - 60000);
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const oneDayAgo = new Date(now.getTime() - 86400000);

      expect(formatTimeAgo(oneMinuteAgo)).toMatch(/about 1 minute ago/);
      expect(formatTimeAgo(oneHourAgo)).toMatch(/about 1 hour ago/);
      expect(formatTimeAgo(oneDayAgo)).toMatch(/about 1 day ago/);
    });
  });

  describe("formatDateInTimezone", () => {
    it("should format date in specified timezone", () => {
      const date = new Date("2024-01-01T00:00:00Z");
      expect(formatDateInTimezone(date, "UTC")).toBe("2024-01-01 00:00:00");
      expect(formatDateInTimezone(date, "America/New_York")).toBe("2023-12-31 19:00:00");
    });

    it("should fallback to UTC for invalid timezone", () => {
      const date = new Date("2024-01-01T00:00:00Z");
      expect(formatDateInTimezone(date, "Invalid/Timezone")).toBe("2024-01-01 00:00:00");
    });
  });
});
