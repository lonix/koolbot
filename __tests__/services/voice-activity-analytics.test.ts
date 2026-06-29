import { describe, it, expect, jest } from "@jest/globals";

// `buildGuildHeatmap` / `emptyGuildHeatmap` are pure, but the module imports
// the Mongoose model at load time — mock it so importing doesn't open a DB.
jest.unstable_mockModule("../../src/models/voice-channel-tracking.js", () => ({
  VoiceChannelTracking: { aggregate: jest.fn() },
}));

const { buildGuildHeatmap, emptyGuildHeatmap } = await import(
  "../../src/services/voice-activity-analytics.js"
);

describe("voice-activity-analytics (#675 Part B)", () => {
  describe("emptyGuildHeatmap", () => {
    it("is a 7×24 all-zero matrix with no peak", () => {
      const hm = emptyGuildHeatmap("UTC");
      expect(hm.matrix).toHaveLength(7);
      expect(hm.matrix[0]).toHaveLength(24);
      expect(hm.byHour).toHaveLength(24);
      expect(hm.byDay).toHaveLength(7);
      expect(hm.totalMinutes).toBe(0);
      expect(hm.peak).toBeNull();
      expect(hm.timeZone).toBe("UTC");
    });
  });

  describe("buildGuildHeatmap", () => {
    it("shifts $dayOfWeek (1=Sun) to a 0=Sun index and converts seconds→minutes", () => {
      // dow 6 = Friday → index 5; hour 22; 3600s → 60 min.
      const hm = buildGuildHeatmap(
        [{ _id: { dow: 6, hour: 22 }, totalSeconds: 3600 }],
        "UTC",
      );
      expect(hm.matrix[5][22]).toBe(60);
      expect(hm.byDay[5]).toBe(60);
      expect(hm.byHour[22]).toBe(60);
      expect(hm.totalMinutes).toBe(60);
      expect(hm.peak).toEqual({ day: 5, hour: 22, minutes: 60 });
    });

    it("accumulates and tracks the busiest cell as the peak", () => {
      const hm = buildGuildHeatmap(
        [
          { _id: { dow: 1, hour: 0 }, totalSeconds: 600 }, // Sun 00:00 → 10 min
          { _id: { dow: 7, hour: 23 }, totalSeconds: 6000 }, // Sat 23:00 → 100 min
          { _id: { dow: 1, hour: 0 }, totalSeconds: 600 }, // +10 min same cell
        ],
        "UTC",
      );
      expect(hm.matrix[0][0]).toBe(20);
      expect(hm.matrix[6][23]).toBe(100);
      expect(hm.totalMinutes).toBe(120);
      expect(hm.peak).toEqual({ day: 6, hour: 23, minutes: 100 });
    });

    it("skips out-of-range and non-positive rows defensively", () => {
      const hm = buildGuildHeatmap(
        [
          { _id: { dow: 0, hour: 5 }, totalSeconds: 600 }, // dow 0 → index -1, skip
          { _id: { dow: 3, hour: 99 }, totalSeconds: 600 }, // hour out of range
          { _id: { dow: 3, hour: 5 }, totalSeconds: 0 }, // zero minutes
        ],
        "UTC",
      );
      expect(hm.totalMinutes).toBe(0);
      expect(hm.peak).toBeNull();
    });
  });
});
