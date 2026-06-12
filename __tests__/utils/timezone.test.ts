/**
 * Unit tests for the per-user timezone helpers (#524).
 */

import { describe, it, expect } from "@jest/globals";
import {
  formatDateTimeInZone,
  formatInZone,
  getServerTimezone,
  isValidTimezone,
  isoDateInZone,
  listSupportedTimezones,
  resolveTimezone,
} from "../../src/utils/timezone.js";

describe("timezone utils", () => {
  describe("isValidTimezone", () => {
    it("accepts recognized IANA identifiers", () => {
      expect(isValidTimezone("America/New_York")).toBe(true);
      expect(isValidTimezone("Europe/London")).toBe(true);
      expect(isValidTimezone("UTC")).toBe(true);
    });

    it("rejects unknown zones and non-strings", () => {
      expect(isValidTimezone("Mars/Phobos")).toBe(false);
      expect(isValidTimezone("America/Fakeville")).toBe(false);
      expect(isValidTimezone("")).toBe(false);
      expect(isValidTimezone("not a zone")).toBe(false);
      expect(isValidTimezone(undefined)).toBe(false);
      expect(isValidTimezone(null)).toBe(false);
      expect(isValidTimezone(42)).toBe(false);
    });
  });

  describe("listSupportedTimezones", () => {
    it("returns a sorted, non-empty list of known zones", () => {
      const zones = listSupportedTimezones();
      expect(zones.length).toBeGreaterThan(0);
      expect(zones).toContain("America/New_York");
      const sorted = [...zones].sort();
      expect(zones).toEqual(sorted);
    });
  });

  describe("getServerTimezone", () => {
    it("returns a usable IANA zone", () => {
      expect(isValidTimezone(getServerTimezone())).toBe(true);
    });
  });

  describe("resolveTimezone", () => {
    it("returns the zone as-is when valid", () => {
      expect(resolveTimezone("Europe/Berlin")).toBe("Europe/Berlin");
    });

    it("falls back to the server timezone when unset or invalid", () => {
      const server = getServerTimezone();
      expect(resolveTimezone(null)).toBe(server);
      expect(resolveTimezone(undefined)).toBe(server);
      expect(resolveTimezone("")).toBe(server);
      expect(resolveTimezone("Nope/Nowhere")).toBe(server);
    });
  });

  describe("formatInZone", () => {
    it("formats a UTC instant in the requested zone", () => {
      const d = new Date("2026-06-12T12:00:00Z");
      expect(formatInZone(d, "UTC", "yyyy-MM-dd HH:mm")).toBe("2026-06-12 12:00");
      // 12:00 UTC is 08:00 in New York (EDT, UTC-4) in June.
      expect(formatInZone(d, "America/New_York", "yyyy-MM-dd HH:mm")).toBe(
        "2026-06-12 08:00",
      );
    });
  });

  describe("isoDateInZone", () => {
    it("buckets the calendar day in the given zone", () => {
      // 02:00 UTC on Jan 1 is still Dec 31 in New York.
      const d = new Date("2026-01-01T02:00:00Z");
      expect(isoDateInZone(d, "UTC")).toBe("2026-01-01");
      expect(isoDateInZone(d, "America/New_York")).toBe("2025-12-31");
      // ...and already Jan 1 in Tokyo (UTC+9).
      expect(isoDateInZone(d, "Asia/Tokyo")).toBe("2026-01-01");
    });
  });

  describe("formatDateTimeInZone", () => {
    it("includes the resolved zone name", () => {
      const d = new Date("2026-06-12T12:00:00Z");
      expect(formatDateTimeInZone(d, "UTC")).toBe("2026-06-12 12:00 (UTC)");
    });

    it("falls back to the server timezone for an unset value", () => {
      const d = new Date("2026-06-12T12:00:00Z");
      expect(formatDateTimeInZone(d, null)).toContain(
        `(${getServerTimezone()})`,
      );
    });
  });
});
