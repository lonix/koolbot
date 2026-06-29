import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// IMPORTANT: This file must NOT statically import from
// `rewind-service.js` — the static import would cache the real
// Mongoose models before the `jest.unstable_mockModule` calls below
// register the test doubles. All bindings come via the `await import`
// once mocks are in place.

const mockFindOneVc = jest.fn();
const mockFindVc = jest.fn();
const mockAggregateVc = jest.fn();
const mockFindOneAch = jest.fn();
const mockFindOneMsg = jest.fn();
const mockSnapFindOne = jest.fn();
const mockSnapFind = jest.fn();
const mockSnapCreate = jest.fn();

jest.unstable_mockModule("../../src/models/voice-channel-tracking.js", () => ({
  VoiceChannelTracking: {
    findOne: mockFindOneVc,
    find: mockFindVc,
    aggregate: mockAggregateVc,
  },
}));

jest.unstable_mockModule("../../src/models/rewind-snapshot.js", () => ({
  RewindSnapshot: {
    findOne: mockSnapFindOne,
    find: mockSnapFind,
    create: mockSnapCreate,
  },
}));

jest.unstable_mockModule("../../src/models/user-achievements.js", () => ({
  UserAchievements: {
    findOne: mockFindOneAch,
  },
}));

// Text-message detail (#496). Only consulted when `messagetracking.enabled`
// is on, so the default-off tests never touch it; the section-gating tests
// (#665) enable the gate and supply rows through this double.
jest.unstable_mockModule(
  "../../src/models/message-activity-tracking.js",
  () => ({
    MessageActivityTracking: {
      findOne: mockFindOneMsg,
    },
  }),
);

// Reaction activity (#653). `findOne(...).lean()` returns the per-year
// buckets; the default `mockGetBoolean` leaves reaction tracking disabled so
// existing getSummary tests never reach this model.
const mockFindOneReaction = jest.fn();
jest.unstable_mockModule(
  "../../src/models/reaction-activity-tracking.js",
  () => ({
    ReactionActivityTracking: {
      findOne: mockFindOneReaction,
    },
  }),
);

// Config is consulted by `computeTextActivity` / `computeReactionActivity`
// for their `*.enabled` gates. Default everything off so the voice-only
// tests are unaffected; individual tests override per key as needed.
const mockGetBoolean = jest.fn(async () => false);
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({ getBoolean: mockGetBoolean }),
  },
}));

jest.unstable_mockModule("../../src/content/accolades.js", () => ({
  ACCOLADE_METADATA: {
    night_owl: {
      emoji: "🦉",
      name: "Night Owl",
      description: "Earned for late-night voice activity.",
    },
  },
}));

jest.unstable_mockModule("../../src/content/achievements.js", () => ({
  ACHIEVEMENT_METADATA: {
    weekly_active: {
      emoji: "📅",
      name: "Weekly Active",
      description: "Active this week.",
    },
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  RewindService,
  normalizeSnapshotSummary,
  SNAPSHOT_SCHEMA_VERSION,
  computeLongestSession,
  computeLongestStreak,
  computePeakDay,
  computeVoiceActivityHeatmap,
  computeHourOfDayDistribution,
  computeDayOfWeekDistribution,
  peakIndex,
  formatHourLabel,
  DAY_NAMES,
  computeTopCompanions,
  computePeakMessageDay,
  computeTopTextChannels,
  extractYearlyReactionCount,
  reactionActivityYears,
  messagesInWindow,
  formatFunComparison,
  formatHoursMinutes,
  sessionSeconds,
  toIsoDate,
  yearBounds,
} = await import("../../src/services/rewind-service.js");

function resetSingleton(): void {
  (RewindService as unknown as { instance: unknown }).instance = undefined;
}

function makeClient(): unknown {
  return {} as unknown;
}

describe("RewindService pure helpers", () => {
  describe("yearBounds", () => {
    it("returns half-open UTC year bounds", () => {
      const { start, end } = yearBounds(2026);
      expect(start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });
  });

  describe("toIsoDate", () => {
    it("formats a UTC date as YYYY-MM-DD", () => {
      expect(toIsoDate(new Date("2026-03-15T23:45:00Z"))).toBe("2026-03-15");
    });
  });

  describe("sessionSeconds", () => {
    it("prefers explicit duration when present", () => {
      expect(
        sessionSeconds({
          startTime: new Date("2026-01-01T10:00:00Z"),
          endTime: new Date("2026-01-01T10:30:00Z"),
          duration: 60,
          channelId: "c",
        }),
      ).toBe(60);
    });

    it("falls back to endTime - startTime when duration missing", () => {
      expect(
        sessionSeconds({
          startTime: new Date("2026-01-01T10:00:00Z"),
          endTime: new Date("2026-01-01T11:00:00Z"),
          channelId: "c",
        }),
      ).toBe(3600);
    });

    it("returns 0 when neither duration nor endTime is present", () => {
      expect(
        sessionSeconds({
          startTime: new Date("2026-01-01T10:00:00Z"),
          channelId: "c",
        }),
      ).toBe(0);
    });
  });

  describe("computeTopCompanions", () => {
    it("returns an empty array for no sessions", () => {
      expect(computeTopCompanions([], 5)).toEqual([]);
    });

    it("returns an empty array when no session has otherUsers", () => {
      const sessions = [
        {
          startTime: new Date("2026-01-01T10:00:00Z"),
          duration: 600,
          channelId: "a",
          channelName: "alpha",
        },
        {
          startTime: new Date("2026-01-02T10:00:00Z"),
          duration: 600,
          channelId: "a",
          channelName: "alpha",
          otherUsers: [],
        },
      ];
      expect(computeTopCompanions(sessions, 5)).toEqual([]);
    });

    it("sums co-present seconds per companion and ranks by total", () => {
      const sessions = [
        {
          startTime: new Date("2026-01-01T10:00:00Z"),
          duration: 600,
          channelId: "a",
          channelName: "alpha",
          otherUsers: ["bob", "carol"],
        },
        {
          startTime: new Date("2026-01-02T10:00:00Z"),
          duration: 1200,
          channelId: "a",
          channelName: "alpha",
          otherUsers: ["bob"],
        },
        // Zero-duration sessions are ignored.
        {
          startTime: new Date("2026-01-03T10:00:00Z"),
          duration: 0,
          channelId: "a",
          channelName: "alpha",
          otherUsers: ["carol"],
        },
      ];
      const top = computeTopCompanions(sessions, 5);
      expect(top).toEqual([
        { userId: "bob", totalSeconds: 1800 },
        { userId: "carol", totalSeconds: 600 },
      ]);
    });

    it("honours the limit", () => {
      const sessions = [
        {
          startTime: new Date("2026-01-01T10:00:00Z"),
          duration: 600,
          channelId: "a",
          otherUsers: ["b", "c", "d", "e"],
        },
      ];
      expect(computeTopCompanions(sessions, 2)).toHaveLength(2);
    });
  });

  describe("computePeakDay", () => {
    it("returns the day with the highest summed seconds", () => {
      const peak = computePeakDay([
        {
          startTime: new Date("2026-03-15T10:00:00Z"),
          duration: 3600,
          channelId: "a",
        },
        {
          startTime: new Date("2026-03-15T14:00:00Z"),
          duration: 1800,
          channelId: "a",
        },
        {
          startTime: new Date("2026-03-16T10:00:00Z"),
          duration: 3600,
          channelId: "a",
        },
      ]);
      expect(peak).toEqual({ date: "2026-03-15", totalSeconds: 5400 });
    });

    it("returns null on empty input", () => {
      expect(computePeakDay([])).toBeNull();
    });

    it("buckets days in the supplied timezone (#524)", () => {
      // 02:00 UTC on the 16th is still the 15th in New York, so both
      // sessions fall on the same local day there but on different UTC days.
      const sessions = [
        {
          startTime: new Date("2026-03-15T20:00:00Z"),
          duration: 3600,
          channelId: "a",
        },
        {
          startTime: new Date("2026-03-16T02:00:00Z"),
          duration: 3600,
          channelId: "a",
        },
      ];
      expect(computePeakDay(sessions, "America/New_York")).toEqual({
        date: "2026-03-15",
        totalSeconds: 7200,
      });
      // Without a zone, the two sessions land on separate UTC days.
      expect(computePeakDay(sessions)?.totalSeconds).toBe(3600);
    });
  });

  describe("computeLongestSession", () => {
    it("returns null when there are no sessions", () => {
      expect(computeLongestSession([])).toBeNull();
    });

    it("returns null when no session has a positive duration", () => {
      expect(
        computeLongestSession([
          {
            startTime: new Date("2026-03-15T10:00:00Z"),
            duration: 0,
            channelId: "a",
          },
        ]),
      ).toBeNull();
    });

    it("returns the single session's duration, date and channel", () => {
      expect(
        computeLongestSession([
          {
            startTime: new Date("2026-03-14T08:00:00Z"),
            duration: 3600 * 6,
            channelId: "a",
            channelName: "General",
          },
        ]),
      ).toEqual({
        totalSeconds: 3600 * 6,
        date: "2026-03-14",
        channelId: "a",
        channelName: "General",
      });
    });

    it("picks the longest of several sessions with its own date", () => {
      const result = computeLongestSession([
        {
          startTime: new Date("2026-01-02T10:00:00Z"),
          duration: 1800,
          channelId: "a",
          channelName: "alpha",
        },
        {
          startTime: new Date("2026-03-14T09:00:00Z"),
          duration: 3600 * 6,
          channelId: "b",
          channelName: "beta",
        },
        {
          startTime: new Date("2026-05-20T10:00:00Z"),
          duration: 3600 * 2,
          channelId: "c",
          channelName: "gamma",
        },
      ]);
      expect(result).toEqual({
        totalSeconds: 3600 * 6,
        date: "2026-03-14",
        channelId: "b",
        channelName: "beta",
      });
    });

    it("falls back to endTime - startTime when duration is absent", () => {
      const result = computeLongestSession([
        {
          startTime: new Date("2026-03-14T09:00:00Z"),
          endTime: new Date("2026-03-14T12:00:00Z"),
          channelId: "b",
        },
        {
          startTime: new Date("2026-03-15T09:00:00Z"),
          duration: 1800,
          channelId: "a",
        },
      ]);
      expect(result).toEqual({
        totalSeconds: 3600 * 3,
        date: "2026-03-14",
        channelId: "b",
        channelName: null,
      });
    });

    it("keeps the earliest session on a duration tie", () => {
      const result = computeLongestSession([
        {
          startTime: new Date("2026-04-02T10:00:00Z"),
          duration: 3600,
          channelId: "late",
        },
        {
          startTime: new Date("2026-04-01T10:00:00Z"),
          duration: 3600,
          channelId: "early",
        },
      ]);
      expect(result?.channelId).toBe("early");
      expect(result?.date).toBe("2026-04-01");
    });

    it("buckets the date in the supplied timezone (#524)", () => {
      const result = computeLongestSession(
        [
          {
            startTime: new Date("2026-03-16T02:00:00Z"),
            duration: 3600 * 4,
            channelId: "a",
          },
        ],
        "America/New_York",
      );
      // 02:00 UTC on the 16th is still the 15th in New York.
      expect(result?.date).toBe("2026-03-15");
    });
  });

  describe("computeLongestStreak", () => {
    it("returns 1 for a single day of activity", () => {
      const r = computeLongestStreak([
        {
          startTime: new Date("2026-03-15T10:00:00Z"),
          duration: 600,
          channelId: "a",
        },
      ]);
      expect(r).toEqual({
        days: 1,
        startDate: "2026-03-15",
        endDate: "2026-03-15",
      });
    });

    it("returns the longest run of consecutive UTC days", () => {
      const r = computeLongestStreak([
        // Run of 3: 03-10 → 03-12
        {
          startTime: new Date("2026-03-10T10:00:00Z"),
          duration: 60,
          channelId: "a",
        },
        {
          startTime: new Date("2026-03-11T10:00:00Z"),
          duration: 60,
          channelId: "a",
        },
        {
          startTime: new Date("2026-03-12T10:00:00Z"),
          duration: 60,
          channelId: "a",
        },
        // Gap
        // Run of 2: 03-20 → 03-21
        {
          startTime: new Date("2026-03-20T10:00:00Z"),
          duration: 60,
          channelId: "a",
        },
        {
          startTime: new Date("2026-03-21T10:00:00Z"),
          duration: 60,
          channelId: "a",
        },
      ]);
      expect(r.days).toBe(3);
      expect(r.startDate).toBe("2026-03-10");
      expect(r.endDate).toBe("2026-03-12");
    });

    it("returns 0 on empty input", () => {
      expect(computeLongestStreak([])).toEqual({
        days: 0,
        startDate: null,
        endDate: null,
      });
    });
  });

  describe("voice activity heatmap (#675)", () => {
    it("returns all-zero distributions for empty input", () => {
      const hm = computeVoiceActivityHeatmap([]);
      expect(hm.hourOfDay).toHaveLength(24);
      expect(hm.dayOfWeek).toHaveLength(7);
      expect(hm.hourOfDay.every((v) => v === 0)).toBe(true);
      expect(hm.dayOfWeek.every((v) => v === 0)).toBe(true);
    });

    it("buckets a single in-hour session by start hour and weekday (UTC)", () => {
      // 2026-03-13 is a Friday. 10:00 UTC, 30 minutes.
      const sessions = [
        {
          startTime: new Date("2026-03-13T10:00:00Z"),
          duration: 30 * 60,
          channelId: "a",
        },
      ];
      const hm = computeVoiceActivityHeatmap(sessions);
      expect(hm.hourOfDay[10]).toBe(30);
      // Only hour 10 has activity.
      expect(hm.hourOfDay.reduce((a, b) => a + b, 0)).toBe(30);
      // 5 = Friday.
      expect(hm.dayOfWeek[5]).toBe(30);
      expect(hm.dayOfWeek.reduce((a, b) => a + b, 0)).toBe(30);
    });

    it("splits a multi-hour session across the hours it spans", () => {
      // 22:30 UTC for 2 hours → 30m in hour 22, 60m in hour 23, 30m in hour 0.
      const sessions = [
        {
          startTime: new Date("2026-03-13T22:30:00Z"),
          duration: 2 * 60 * 60,
          channelId: "a",
        },
      ];
      const hm = computeVoiceActivityHeatmap(sessions);
      expect(hm.hourOfDay[22]).toBe(30);
      expect(hm.hourOfDay[23]).toBe(60);
      expect(hm.hourOfDay[0]).toBe(30);
    });

    it("splits a midnight-crossing session across both weekdays", () => {
      // Friday 2026-03-13 23:00 UTC for 2 hours → 60m Friday, 60m Saturday.
      const sessions = [
        {
          startTime: new Date("2026-03-13T23:00:00Z"),
          duration: 2 * 60 * 60,
          channelId: "a",
        },
      ];
      const hm = computeVoiceActivityHeatmap(sessions);
      expect(hm.dayOfWeek[5]).toBe(60); // Friday
      expect(hm.dayOfWeek[6]).toBe(60); // Saturday
      expect(hm.hourOfDay[23]).toBe(60);
      expect(hm.hourOfDay[0]).toBe(60);
    });

    it("aggregates multiple sessions, weighting by duration", () => {
      const sessions = [
        {
          startTime: new Date("2026-03-13T10:00:00Z"),
          duration: 60 * 60,
          channelId: "a",
        },
        {
          startTime: new Date("2026-03-14T10:00:00Z"), // Saturday
          duration: 30 * 60,
          channelId: "a",
        },
        {
          startTime: new Date("2026-03-13T10:30:00Z"),
          duration: 30 * 60,
          channelId: "a",
        },
      ];
      const hm = computeVoiceActivityHeatmap(sessions);
      // Hour 10 collects 60 + 30 (split into 10:30→11:00 is still hour 10) + 30.
      expect(hm.hourOfDay[10]).toBe(60 + 30 + 30);
      expect(hm.dayOfWeek[5]).toBe(90); // Friday: 60 + 30
      expect(hm.dayOfWeek[6]).toBe(30); // Saturday
    });

    it("buckets in the supplied timezone", () => {
      // 02:00 UTC on Saturday is still 22:00 Friday in New York (EDT, -4).
      const sessions = [
        {
          startTime: new Date("2026-03-14T02:00:00Z"),
          duration: 60 * 60,
          channelId: "a",
        },
      ];
      const ny = computeVoiceActivityHeatmap(sessions, "America/New_York");
      expect(ny.hourOfDay[22]).toBe(60);
      expect(ny.dayOfWeek[5]).toBe(60); // Friday in NY
      const utc = computeVoiceActivityHeatmap(sessions);
      expect(utc.hourOfDay[2]).toBe(60);
      expect(utc.dayOfWeek[6]).toBe(60); // Saturday in UTC
    });

    it("ignores zero / negative-duration sessions", () => {
      const sessions = [
        {
          startTime: new Date("2026-03-13T10:00:00Z"),
          duration: 0,
          channelId: "a",
        },
      ];
      const hm = computeVoiceActivityHeatmap(sessions);
      expect(hm.hourOfDay.every((v) => v === 0)).toBe(true);
    });

    it("thin wrappers return just one axis", () => {
      const sessions = [
        {
          startTime: new Date("2026-03-13T10:00:00Z"),
          duration: 30 * 60,
          channelId: "a",
        },
      ];
      expect(computeHourOfDayDistribution(sessions)[10]).toBe(30);
      expect(computeDayOfWeekDistribution(sessions)[5]).toBe(30);
    });
  });

  describe("peakIndex", () => {
    it("returns null for empty or all-zero arrays", () => {
      expect(peakIndex([])).toBeNull();
      expect(peakIndex([0, 0, 0])).toBeNull();
    });
    it("returns the index of the max value", () => {
      expect(peakIndex([1, 5, 3])).toBe(1);
    });
    it("breaks ties toward the earliest index", () => {
      expect(peakIndex([4, 4, 1])).toBe(0);
    });
  });

  describe("formatHourLabel", () => {
    it("formats midnight and noon", () => {
      expect(formatHourLabel(0)).toBe("12 AM");
      expect(formatHourLabel(12)).toBe("12 PM");
    });
    it("formats morning and evening hours", () => {
      expect(formatHourLabel(1)).toBe("1 AM");
      expect(formatHourLabel(13)).toBe("1 PM");
      expect(formatHourLabel(23)).toBe("11 PM");
    });
    it("DAY_NAMES is Sunday-first and 7 long", () => {
      expect(DAY_NAMES).toHaveLength(7);
      expect(DAY_NAMES[0]).toBe("Sunday");
      expect(DAY_NAMES[5]).toBe("Friday");
    });
  });

  describe("formatHoursMinutes", () => {
    it("renders short for sub-hour values", () => {
      expect(formatHoursMinutes(45 * 60)).toBe("45 min");
    });
    it("renders hours-only for whole hours", () => {
      expect(formatHoursMinutes(2 * 3600)).toBe("2 hr");
    });
    it("renders combined hours/minutes", () => {
      expect(formatHoursMinutes(2 * 3600 + 15 * 60)).toBe("2 hr 15 min");
    });
  });

  describe("formatFunComparison", () => {
    it("returns null on zero seconds", () => {
      expect(formatFunComparison(0)).toBeNull();
    });
    it("returns a movie comparison for ~2 hours", () => {
      expect(formatFunComparison(2 * 3600)).toMatch(/movie/);
    });
    it("returns a trans-atlantic flight comparison for many hours", () => {
      expect(formatFunComparison(16 * 3600)).toMatch(/flight/);
    });
  });
});

// ---------------------------------------------------------------
// Service-level integration: mocks set up above.
// ---------------------------------------------------------------

describe("RewindService.getSummary", () => {
  function lean<T>(value: T): { lean: () => Promise<T> } {
    return { lean: jest.fn(async () => value) };
  }

  // The companion-username fallback query chains `.find().select().lean()`.
  function selectLean<T>(value: T): {
    select: () => { lean: () => Promise<T> };
  } {
    return { select: jest.fn(() => lean(value)) };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetSingleton();
    // Default chainable returns so tests that don't override the
    // `findOne` calls still chain through `.lean()` without crashing.
    mockFindOneVc.mockReturnValue(lean({ sessions: [] }));
    // Stored-username fallback (#606): no tracking docs by default.
    mockFindVc.mockReturnValue(selectLean([]));
    mockFindOneAch.mockReturnValue(lean(null));
    mockAggregateVc.mockResolvedValue([]);
    // By default no snapshots exist, so getSummary takes the live path.
    mockSnapFindOne.mockReturnValue(lean(null));
    mockSnapFind.mockReturnValue(lean([]));
    mockSnapCreate.mockResolvedValue({});
    // Rewind gates each section on its source feature (#665). These voice +
    // achievements assertions expect both sections rendered, so enable them;
    // text/reaction tracking stays off (those blocks opt in per-test).
    mockGetBoolean.mockImplementation(
      async (key: string) =>
        key === "voicetracking.enabled" || key === "achievements.enabled",
    );
  });

  it("returns hasData=false when the user has no sessions or achievements", async () => {
    mockFindOneVc.mockReturnValueOnce(lean({ sessions: [] }));
    mockFindOneAch.mockReturnValueOnce(lean(null));
    mockAggregateVc
      // collectAvailableYears
      .mockResolvedValueOnce([])
      // computeAnnualRank — skipped because userSeconds <= 0
      // computeWeeklyJourney — also skipped via short-circuit but we don't gate it
      .mockResolvedValueOnce([]); // weekly journey aggregate

    const svc = RewindService.getInstance(
      makeClient() as Parameters<typeof RewindService.getInstance>[0],
    );
    const summary = await svc.getSummary("u1", "g1", 2026);
    expect(summary).not.toBeNull();
    expect(summary!.hasData).toBe(false);
    expect(summary!.totalSeconds).toBe(0);
    expect(summary!.annualRank).toBeNull();
    expect(summary!.topCompanions).toEqual([]);
  });

  it("aggregates a full summary when the user has voice data", async () => {
    const year = 2026;
    const sessions = [
      {
        startTime: new Date(`${year}-01-15T10:00:00Z`),
        duration: 3600,
        channelId: "general",
        channelName: "general-vc",
      },
      {
        startTime: new Date(`${year}-01-15T14:00:00Z`),
        duration: 1800,
        channelId: "gaming",
        channelName: "gaming",
      },
      {
        startTime: new Date(`${year}-01-16T10:00:00Z`),
        duration: 1800,
        channelId: "general",
        channelName: "general-vc",
      },
      // Out-of-year session — should be filtered out
      {
        startTime: new Date(`2025-12-31T22:00:00Z`),
        duration: 9999,
        channelId: "general",
        channelName: "general-vc",
      },
    ];
    mockFindOneVc.mockReturnValueOnce(lean({ sessions }));
    mockFindOneAch.mockReturnValueOnce(lean(null));

    mockAggregateVc
      // collectAvailableYears
      .mockResolvedValueOnce([{ _id: 2026 }, { _id: 2025 }])
      // computeAnnualRank — sorted descending
      .mockResolvedValueOnce([
        { _id: "top-user", totalTime: 36000 },
        { _id: "u1", totalTime: 7200 },
        { _id: "another", totalTime: 3600 },
      ])
      // computeWeeklyJourney — first/last/best weekly rank for u1
      .mockResolvedValueOnce([
        {
          _id: { userId: "u1", isoYear: 2026, isoWeek: 3 },
          totalTime: 5400,
          rank: 5,
        },
        {
          _id: { userId: "u1", isoYear: 2026, isoWeek: 4 },
          totalTime: 7000,
          rank: 2,
        },
        {
          _id: { userId: "u1", isoYear: 2026, isoWeek: 5 },
          totalTime: 4000,
          rank: 8,
        },
      ]);

    const svc = RewindService.getInstance(
      makeClient() as Parameters<typeof RewindService.getInstance>[0],
    );
    const summary = await svc.getSummary("u1", "g1", year);
    expect(summary).not.toBeNull();
    expect(summary!.hasData).toBe(true);
    expect(summary!.totalSeconds).toBe(7200); // 3600 + 1800 + 1800
    expect(summary!.sessionCount).toBe(3);
    expect(summary!.daysActive).toBe(2);
    expect(summary!.peakDay).toEqual({
      date: "2026-01-15",
      totalSeconds: 5400,
    });
    expect(summary!.longestSession).toEqual({
      totalSeconds: 3600,
      date: "2026-01-15",
      channelId: "general",
      channelName: "general-vc",
    });
    expect(summary!.longestStreakDays).toBe(2);
    expect(summary!.annualRank).toBe(2);
    expect(summary!.annualGuildMembers).toBe(3);
    expect(summary!.percentAboveMedian).not.toBeNull();
    expect(summary!.weeklyJourney.first?.isoWeek).toBe(3);
    expect(summary!.weeklyJourney.last?.isoWeek).toBe(5);
    expect(summary!.weeklyJourney.best?.isoWeek).toBe(4);
    expect(summary!.availableYears).toEqual([2026, 2025]);
  });

  it("aggregates and resolves top voice companions (#567)", async () => {
    const year = 2026;
    const sessions = [
      {
        startTime: new Date(`${year}-02-01T10:00:00Z`),
        duration: 3600,
        channelId: "general",
        channelName: "general-vc",
        otherUsers: ["bob", "carol"],
      },
      {
        startTime: new Date(`${year}-02-02T10:00:00Z`),
        duration: 1800,
        channelId: "general",
        channelName: "general-vc",
        otherUsers: ["bob"],
      },
    ];
    mockFindOneVc.mockReturnValueOnce(lean({ sessions }));
    mockFindOneAch.mockReturnValueOnce(lean(null));
    mockAggregateVc
      .mockResolvedValueOnce([{ _id: 2026 }])
      .mockResolvedValueOnce([{ _id: "u1", totalTime: 5400 }])
      .mockResolvedValueOnce([]);

    // Client cache resolves bob (guild nickname) and carol (global
    // username); a left member would simply miss both caches.
    const client = {
      guilds: {
        cache: {
          get: (id: string) =>
            id === "g1"
              ? {
                  members: {
                    cache: {
                      get: (uid: string) =>
                        uid === "bob"
                          ? { displayName: "Bob the Builder" }
                          : undefined,
                    },
                  },
                }
              : undefined,
        },
      },
      users: {
        cache: {
          get: (uid: string) =>
            uid === "carol" ? { username: "carol123" } : undefined,
        },
      },
    };

    const svc = RewindService.getInstance(
      client as Parameters<typeof RewindService.getInstance>[0],
    );
    const summary = await svc.getSummary("u1", "g1", year);
    expect(summary!.topCompanions).toEqual([
      { userId: "bob", displayName: "Bob the Builder", totalSeconds: 5400 },
      { userId: "carol", displayName: "carol123", totalSeconds: 3600 },
    ]);
  });

  it("falls back to the stored tracking username when a companion is not cached (#606)", async () => {
    const year = 2026;
    const sessions = [
      {
        startTime: new Date(`${year}-02-01T10:00:00Z`),
        duration: 3600,
        channelId: "general",
        channelName: "general-vc",
        // "left" is in neither the guild member nor the user cache.
        otherUsers: ["left"],
      },
    ];
    mockFindOneVc.mockReturnValueOnce(lean({ sessions }));
    mockFindOneAch.mockReturnValueOnce(lean(null));
    // The companion query returns the last-known username we persisted.
    mockFindVc.mockReturnValueOnce(
      selectLean([{ userId: "left", username: "DeparturedDan" }]),
    );
    mockAggregateVc
      .mockResolvedValueOnce([{ _id: 2026 }])
      .mockResolvedValueOnce([{ _id: "u1", totalTime: 3600 }])
      .mockResolvedValueOnce([]);

    // Empty client caches — nothing resolves live.
    const svc = RewindService.getInstance(
      makeClient() as Parameters<typeof RewindService.getInstance>[0],
    );
    const summary = await svc.getSummary("u1", "g1", year);
    expect(summary!.topCompanions).toEqual([
      { userId: "left", displayName: "DeparturedDan", totalSeconds: 3600 },
    ]);
  });

  it("skips companions with no name anywhere instead of showing 'Unknown user' (#606)", async () => {
    const year = 2026;
    const sessions = [
      {
        startTime: new Date(`${year}-02-01T10:00:00Z`),
        duration: 3600,
        channelId: "general",
        channelName: "general-vc",
        otherUsers: ["ghost", "carol"],
      },
    ];
    mockFindOneVc.mockReturnValueOnce(lean({ sessions }));
    mockFindOneAch.mockReturnValueOnce(lean(null));
    // Only carol has a stored username; "ghost" is nameless everywhere.
    mockFindVc.mockReturnValueOnce(
      selectLean([{ userId: "carol", username: "carol123" }]),
    );
    mockAggregateVc
      .mockResolvedValueOnce([{ _id: 2026 }])
      .mockResolvedValueOnce([{ _id: "u1", totalTime: 3600 }])
      .mockResolvedValueOnce([]);

    const svc = RewindService.getInstance(
      makeClient() as Parameters<typeof RewindService.getInstance>[0],
    );
    const summary = await svc.getSummary("u1", "g1", year);
    // "ghost" is dropped entirely; only the named companion survives.
    expect(summary!.topCompanions).toEqual([
      { userId: "carol", displayName: "carol123", totalSeconds: 3600 },
    ]);
    expect(
      summary!.topCompanions.some((c) => c.displayName === "Unknown user"),
    ).toBe(false);
  });

  it("filters achievements and accolades by year and ignores unknown types", async () => {
    const year = 2026;
    mockFindOneVc.mockReturnValueOnce(lean({ sessions: [] }));
    mockFindOneAch.mockReturnValueOnce(
      lean({
        accolades: [
          { type: "night_owl", earnedAt: new Date(`${year}-04-01T00:00:00Z`) },
          // Wrong year — drop
          { type: "night_owl", earnedAt: new Date(`2025-12-31T00:00:00Z`) },
          // Unknown type — drop (no metadata)
          {
            type: "mystery_badge",
            earnedAt: new Date(`${year}-04-01T00:00:00Z`),
          },
        ],
        achievements: [
          {
            type: "weekly_active",
            earnedAt: new Date(`${year}-04-01T00:00:00Z`),
          },
        ],
      }),
    );
    mockAggregateVc
      .mockResolvedValueOnce([{ _id: 2026 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const svc = RewindService.getInstance(
      makeClient() as Parameters<typeof RewindService.getInstance>[0],
    );
    const summary = await svc.getSummary("u1", "g1", year);
    expect(summary!.accolades).toHaveLength(1);
    expect(summary!.accolades[0].name).toBe("Night Owl");
    expect(summary!.achievements).toHaveLength(1);
    expect(summary!.achievements[0].name).toBe("Weekly Active");
    expect(summary!.hasData).toBe(true);
  });

  it("returns null when the DB layer throws unexpectedly", async () => {
    mockFindOneVc.mockReturnValueOnce({
      lean: jest.fn(async () => {
        throw new Error("mongo exploded");
      }),
    });
    mockFindOneAch.mockReturnValueOnce(lean(null));
    mockAggregateVc.mockResolvedValue([]);

    const svc = RewindService.getInstance(
      makeClient() as Parameters<typeof RewindService.getInstance>[0],
    );
    const summary = await svc.getSummary("u1", "g1", 2026);
    expect(summary).toBeNull();
  });
});

// Rewind is the graceful aggregator (#659/#665): it renders each section
// only when that section's *source* feature is enabled, and is never blocked
// or short-circuited because a source is off. These tests pin the per-section
// gates for voice (`voicetracking.enabled`) and achievements
// (`achievements.enabled`) alongside the pre-existing text gate.
describe("RewindService.getSummary section gating (#665)", () => {
  function lean<T>(value: T): { lean: () => Promise<T> } {
    return { lean: jest.fn(async () => value) };
  }
  function selectLean<T>(value: T): {
    select: () => { lean: () => Promise<T> };
  } {
    return { select: jest.fn(() => lean(value)) };
  }

  // A client with the caches the text/companion resolvers touch, so a fully
  // enabled recap can resolve channel/user names instead of tripping the
  // service's defensive try/catch and silently emptying the section.
  function makeRichClient(): unknown {
    return {
      channels: { cache: { get: () => ({ name: "general" }) } },
      guilds: { cache: { get: () => undefined } },
      users: { cache: { get: () => undefined } },
    } as unknown;
  }

  // The current year recomputes live (a past year would short-circuit to a
  // snapshot before any gate runs), so use it for every case here.
  const year = new Date().getUTCFullYear();

  const sessions = [
    {
      startTime: new Date(`${year}-03-01T10:00:00Z`),
      duration: 3600,
      channelId: "general",
      channelName: "general-vc",
    },
  ];
  const achievementsDoc = {
    accolades: [
      { type: "night_owl", earnedAt: new Date(`${year}-04-01T00:00:00Z`) },
    ],
    achievements: [
      { type: "weekly_active", earnedAt: new Date(`${year}-04-01T00:00:00Z`) },
    ],
  };
  const messageDoc = {
    recentMessages: [
      { sentAt: new Date(`${year}-05-01T12:00:00Z`), channelId: "c1" },
    ],
  };
  const reactionDoc = {
    yearlyGiven: { [String(year)]: 5 },
    yearlyReceived: { [String(year)]: 2 },
  };

  function enableOnly(...keys: string[]) {
    mockGetBoolean.mockImplementation(async (key: string) =>
      keys.includes(key),
    );
  }

  function makeSvc() {
    return RewindService.getInstance(
      makeRichClient() as Parameters<typeof RewindService.getInstance>[0],
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetSingleton();
    // Every source has data available; only the per-section gate decides
    // whether it surfaces. Aggregates default to empty (rank/journey null),
    // which is orthogonal to the gating under test.
    mockFindOneVc.mockReturnValue(lean({ sessions }));
    mockFindVc.mockReturnValue(selectLean([]));
    mockFindOneAch.mockReturnValue(lean(achievementsDoc));
    mockFindOneMsg.mockReturnValue(lean(messageDoc));
    mockFindOneReaction.mockReturnValue(lean(reactionDoc));
    mockAggregateVc.mockResolvedValue([]);
    mockSnapFindOne.mockReturnValue(lean(null));
    mockSnapFind.mockReturnValue(lean([]));
    mockSnapCreate.mockResolvedValue({});
  });

  it("renders only the voice section when only voice tracking is enabled", async () => {
    enableOnly("voicetracking.enabled");

    const summary = await makeSvc().getSummary("u1", "g1", year);
    expect(summary).not.toBeNull();
    // Voice present...
    expect(summary!.totalSeconds).toBe(3600);
    expect(summary!.sessionCount).toBe(1);
    expect(summary!.hasData).toBe(true);
    // ...everything else hidden.
    expect(summary!.accolades).toEqual([]);
    expect(summary!.achievements).toEqual([]);
    expect(summary!.messagesSent).toBe(0);
    expect(summary!.reactionsGiven).toBe(0);
    expect(summary!.reactionsReceived).toBe(0);
    // Disabled sources are never queried — including the achievements doc.
    expect(mockFindOneAch).not.toHaveBeenCalled();
    expect(mockFindOneMsg).not.toHaveBeenCalled();
    expect(mockFindOneReaction).not.toHaveBeenCalled();
  });

  it("renders only the achievements section when only achievements is enabled", async () => {
    enableOnly("achievements.enabled");

    const summary = await makeSvc().getSummary("u1", "g1", year);
    expect(summary).not.toBeNull();
    // Achievements present...
    expect(summary!.accolades).toHaveLength(1);
    expect(summary!.accolades[0].name).toBe("Night Owl");
    expect(summary!.achievements).toHaveLength(1);
    expect(summary!.achievements[0].name).toBe("Weekly Active");
    expect(summary!.hasData).toBe(true);
    // ...voice section hidden, including the independently-aggregated
    // rank/journey, and the voice doc is never read.
    expect(summary!.totalSeconds).toBe(0);
    expect(summary!.sessionCount).toBe(0);
    expect(summary!.annualRank).toBeNull();
    expect(summary!.weeklyJourney).toEqual({
      first: null,
      last: null,
      best: null,
    });
    expect(summary!.messagesSent).toBe(0);
    // Voice is truly not queried: neither the per-user doc nor the
    // year-picker session aggregate runs when voice tracking is off (#665).
    expect(mockFindOneVc).not.toHaveBeenCalled();
    expect(mockAggregateVc).not.toHaveBeenCalled();
  });

  it("renders only the text section when only message tracking is enabled", async () => {
    enableOnly("messagetracking.enabled");

    const summary = await makeSvc().getSummary("u1", "g1", year);
    expect(summary).not.toBeNull();
    // Text present...
    expect(summary!.messagesSent).toBe(1);
    expect(summary!.hasData).toBe(true);
    // ...voice + achievements hidden.
    expect(summary!.totalSeconds).toBe(0);
    expect(summary!.accolades).toEqual([]);
    expect(summary!.achievements).toEqual([]);
    expect(summary!.reactionsGiven).toBe(0);
    // Voice + achievements are gated off, so none of their reads run.
    expect(mockFindOneVc).not.toHaveBeenCalled();
    expect(mockAggregateVc).not.toHaveBeenCalled();
    expect(mockFindOneAch).not.toHaveBeenCalled();
  });

  it("renders every section when all sources are enabled", async () => {
    enableOnly(
      "voicetracking.enabled",
      "achievements.enabled",
      "messagetracking.enabled",
      "reactiontracking.enabled",
    );

    const summary = await makeSvc().getSummary("u1", "g1", year);
    expect(summary).not.toBeNull();
    expect(summary!.totalSeconds).toBe(3600);
    expect(summary!.accolades).toHaveLength(1);
    expect(summary!.achievements).toHaveLength(1);
    expect(summary!.messagesSent).toBe(1);
    expect(summary!.reactionsGiven).toBe(5);
    expect(summary!.reactionsReceived).toBe(2);
    expect(summary!.hasData).toBe(true);
  });

  it("still produces a summary (never blocks) when every source is disabled", async () => {
    enableOnly();

    const summary = await makeSvc().getSummary("u1", "g1", year);
    // The aggregator degrades to an empty recap rather than failing — this
    // is the inverse of a hard dependency: rewind is never rejected.
    expect(summary).not.toBeNull();
    expect(summary!.hasData).toBe(false);
    expect(summary!.totalSeconds).toBe(0);
    expect(summary!.accolades).toEqual([]);
    expect(summary!.achievements).toEqual([]);
    expect(summary!.messagesSent).toBe(0);
    expect(summary!.reactionsGiven).toBe(0);
    // No source is queried at all when everything is off.
    expect(mockFindOneVc).not.toHaveBeenCalled();
    expect(mockAggregateVc).not.toHaveBeenCalled();
    expect(mockFindOneAch).not.toHaveBeenCalled();
    expect(mockFindOneMsg).not.toHaveBeenCalled();
    expect(mockFindOneReaction).not.toHaveBeenCalled();
  });
});

describe("RewindService.getDefaultRewindYear (#573)", () => {
  function lean<T>(value: T): { lean: () => Promise<T> } {
    return { lean: jest.fn(async () => value) };
  }

  function makeSvc() {
    return RewindService.getInstance(
      makeClient() as Parameters<typeof RewindService.getInstance>[0],
    );
  }

  const currentYear = new Date().getUTCFullYear();

  beforeEach(() => {
    jest.clearAllMocks();
    resetSingleton();
    // `clearAllMocks` does NOT drain queued `mockResolvedValueOnce`
    // implementations left over from earlier describe blocks, so reset the
    // shared aggregate mock outright before installing the default.
    mockAggregateVc.mockReset();
    mockFindOneAch.mockReturnValue(lean(null));
    mockAggregateVc.mockResolvedValue([]);
    mockSnapFind.mockReturnValue(lean([]));
    // Reset the shared config + reaction mocks (implementations survive
    // clearAllMocks). Voice + achievements year collection is gated on their
    // switches (#665), so enable both here; the reaction-only test opts down
    // to reaction tracking alone.
    mockGetBoolean.mockImplementation(
      async (key: string) =>
        key === "voicetracking.enabled" || key === "achievements.enabled",
    );
    mockFindOneReaction.mockReturnValue(lean(null));
  });

  it("lands on the prior year when the current year has no data", async () => {
    // collectAvailableYears aggregate — only the prior year has sessions.
    mockAggregateVc.mockResolvedValueOnce([{ _id: currentYear - 1 }]);

    const year = await makeSvc().getDefaultRewindYear("u1", "g1");
    expect(year).toBe(currentYear - 1);
  });

  it("lands on the current year when it already has data", async () => {
    mockAggregateVc.mockResolvedValueOnce([
      { _id: currentYear },
      { _id: currentYear - 1 },
    ]);

    const year = await makeSvc().getDefaultRewindYear("u1", "g1");
    expect(year).toBe(currentYear);
  });

  it("falls back to the current year when the user has no data anywhere", async () => {
    const year = await makeSvc().getDefaultRewindYear("u1", "g1");
    expect(year).toBe(currentYear);
  });

  it("lands on a reaction-only past year when it is the newest data (#653)", async () => {
    mockGetBoolean.mockImplementation(
      async (key: string) => key === "reactiontracking.enabled",
    );
    mockFindOneReaction.mockReturnValueOnce(
      lean({
        yearlyGiven: { [String(currentYear - 1)]: 4 },
        yearlyReceived: {},
      }),
    );

    const year = await makeSvc().getDefaultRewindYear("u1", "g1");
    expect(year).toBe(currentYear - 1);
  });

  it("considers snapshotted years that have outlived their raw data", async () => {
    // No live sessions/achievements, but a frozen snapshot remains.
    mockSnapFind.mockReturnValueOnce(lean([{ year: currentYear - 2 }]));

    const year = await makeSvc().getDefaultRewindYear("u1", "g1");
    expect(year).toBe(currentYear - 2);
  });

  it("degrades to the current year if a lookup throws", async () => {
    mockFindOneAch.mockReturnValueOnce({
      lean: jest.fn(async () => {
        throw new Error("mongo exploded");
      }),
    });

    const year = await makeSvc().getDefaultRewindYear("u1", "g1");
    expect(year).toBe(currentYear);
  });

  it("ignores non-finite years from corrupt data instead of returning NaN", async () => {
    // A snapshot row whose `year` is NaN passes a `typeof === number`
    // check; it must be filtered out before Math.max so the route fallback
    // never sees NaN.
    mockSnapFind.mockReturnValueOnce(lean([{ year: Number.NaN }]));
    mockAggregateVc.mockResolvedValueOnce([{ _id: currentYear - 1 }]);

    const year = await makeSvc().getDefaultRewindYear("u1", "g1");
    expect(Number.isFinite(year)).toBe(true);
    expect(year).toBe(currentYear - 1);
  });
});

describe("RewindService snapshots (#574)", () => {
  function lean<T>(value: T): { lean: () => Promise<T> } {
    return { lean: jest.fn(async () => value) };
  }

  function makeSvc() {
    return RewindService.getInstance(
      makeClient() as Parameters<typeof RewindService.getInstance>[0],
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetSingleton();
    mockFindOneVc.mockReturnValue(lean({ sessions: [] }));
    mockFindOneAch.mockReturnValue(lean(null));
    mockAggregateVc.mockResolvedValue([]);
    mockSnapFindOne.mockReturnValue(lean(null));
    mockSnapFind.mockReturnValue(lean([]));
    mockSnapCreate.mockResolvedValue({});
    // Voice + achievements on so getSummary's live path renders those
    // sections (#665); reaction tracking off so it skips the reaction query
    // (implementations survive clearAllMocks).
    mockGetBoolean.mockImplementation(
      async (key: string) =>
        key === "voicetracking.enabled" || key === "achievements.enabled",
    );
    mockFindOneReaction.mockReturnValue(lean(null));
  });

  describe("normalizeSnapshotSummary", () => {
    it("fills defaults and stamps the snapshot source + identity", () => {
      const norm = normalizeSnapshotSummary(
        { totalSeconds: 5, hasData: true },
        { userId: "u", guildId: "g", year: 2021 },
      );
      expect(norm.source).toBe("snapshot");
      expect(norm.userId).toBe("u");
      expect(norm.guildId).toBe("g");
      expect(norm.year).toBe(2021);
      expect(norm.totalSeconds).toBe(5);
      expect(norm.topCompanions).toEqual([]);
      expect(norm.weeklyJourney).toEqual({
        first: null,
        last: null,
        best: null,
      });
    });

    it("drops baked-in 'Unknown user' companion rows from legacy snapshots (#606)", () => {
      const norm = normalizeSnapshotSummary(
        {
          topCompanions: [
            { userId: "a", displayName: "Alice", totalSeconds: 100 },
            { userId: "b", displayName: "Unknown user", totalSeconds: 50 },
            { userId: "c", displayName: "Carol", totalSeconds: 25 },
          ],
        },
        { userId: "u", guildId: "g", year: 2021 },
      );
      expect(norm.topCompanions).toEqual([
        { userId: "a", displayName: "Alice", totalSeconds: 100 },
        { userId: "c", displayName: "Carol", totalSeconds: 25 },
      ]);
    });

    it("tolerates a null stored payload (empty state)", () => {
      const empty = normalizeSnapshotSummary(null, {
        userId: "u",
        guildId: "g",
        year: 2021,
      });
      expect(empty.hasData).toBe(false);
      expect(empty.availableYears).toEqual([]);
    });

    it("defaults reaction fields to 0 for pre-#653 (schema v1) snapshots", () => {
      const norm = normalizeSnapshotSummary(
        { totalSeconds: 5, hasData: true },
        { userId: "u", guildId: "g", year: 2021 },
      );
      expect(norm.reactionsGiven).toBe(0);
      expect(norm.reactionsReceived).toBe(0);
    });

    it("preserves stored reaction counts when present", () => {
      const norm = normalizeSnapshotSummary(
        { reactionsGiven: 11, reactionsReceived: 4 },
        { userId: "u", guildId: "g", year: 2021 },
      );
      expect(norm.reactionsGiven).toBe(11);
      expect(norm.reactionsReceived).toBe(4);
    });
  });

  describe("getSummary serving", () => {
    it("serves a completed year from its snapshot without recomputing live", async () => {
      mockSnapFindOne.mockReturnValueOnce(
        lean({
          summary: {
            userId: "u1",
            guildId: "g1",
            year: 2020,
            hasData: true,
            totalSeconds: 12345,
            availableYears: [2020],
          },
        }),
      );
      mockSnapFind.mockReturnValueOnce(lean([{ year: 2020 }, { year: 2019 }]));

      const summary = await makeSvc().getSummary("u1", "g1", 2020);

      expect(summary!.source).toBe("snapshot");
      expect(summary!.totalSeconds).toBe(12345);
      // Snapshotted years are merged in so they stay navigable.
      expect(summary!.availableYears).toEqual([2020, 2019]);
      // No live aggregation happened — the recap came straight from storage.
      expect(mockFindOneVc).not.toHaveBeenCalled();
    });

    it("computes the in-progress current year live even if a snapshot exists", async () => {
      const currentYear = new Date().getUTCFullYear();
      // Persistent (not `Once`) so an unconsumed queued value can't leak
      // into the next test — the current year never consults the snapshot.
      mockSnapFindOne.mockReturnValue(
        lean({ summary: { hasData: true, totalSeconds: 999 } }),
      );

      const summary = await makeSvc().getSummary("u1", "g1", currentYear);

      expect(summary!.source).toBe("live");
      // The snapshot lookup is never consulted for the current year.
      expect(mockSnapFindOne).not.toHaveBeenCalled();
    });

    it("computes a past year live when no snapshot exists", async () => {
      const summary = await makeSvc().getSummary("u1", "g1", 2020);
      expect(summary!.source).toBe("live");
      expect(mockFindOneVc).toHaveBeenCalled();
    });

    it("merges snapshot years into availableYears on the live path", async () => {
      const currentYear = new Date().getUTCFullYear();
      mockAggregateVc
        .mockResolvedValueOnce([{ _id: currentYear }]) // collectAvailableYears
        .mockResolvedValueOnce([]); // weekly journey
      mockSnapFind.mockReturnValueOnce(lean([{ year: 2019 }]));

      const summary = await makeSvc().getSummary("u1", "g1", currentYear);
      expect(summary!.availableYears).toEqual([currentYear, 2019]);
    });
  });

  describe("snapshotYear", () => {
    const session2020 = {
      startTime: new Date("2020-03-01T10:00:00Z"),
      duration: 3600,
      channelId: "a",
      channelName: "x",
    };

    it("creates a snapshot when none exists and the user has data", async () => {
      mockFindOneVc.mockReturnValue(lean({ sessions: [session2020] }));

      const outcome = await makeSvc().snapshotYear("u1", "g1", 2020, null);

      expect(outcome).toBe("created");
      expect(mockSnapCreate).toHaveBeenCalledTimes(1);
      const arg = mockSnapCreate.mock.calls[0][0] as {
        userId: string;
        guildId: string;
        year: number;
        schemaVersion: number;
        summary: { hasData: boolean };
      };
      expect(arg).toMatchObject({
        userId: "u1",
        guildId: "g1",
        year: 2020,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      });
      expect(arg.summary.hasData).toBe(true);
    });

    it("is idempotent — skips when a snapshot already exists", async () => {
      mockSnapFindOne.mockReturnValueOnce(lean({ _id: "existing" }));

      const outcome = await makeSvc().snapshotYear("u1", "g1", 2020, null);

      expect(outcome).toBe("exists");
      expect(mockSnapCreate).not.toHaveBeenCalled();
    });

    it("skips users with no data worth freezing", async () => {
      const outcome = await makeSvc().snapshotYear("u1", "g1", 2020, null);
      expect(outcome).toBe("skipped");
      expect(mockSnapCreate).not.toHaveBeenCalled();
    });

    it("treats a duplicate-key race as an existing snapshot", async () => {
      mockFindOneVc.mockReturnValue(lean({ sessions: [session2020] }));
      mockSnapCreate.mockRejectedValueOnce(
        Object.assign(new Error("dup"), { code: 11000 }),
      );

      const outcome = await makeSvc().snapshotYear("u1", "g1", 2020, null);
      expect(outcome).toBe("exists");
    });
  });
});

describe("RewindService singleton", () => {
  beforeEach(() => resetSingleton());

  it("returns the same instance for the same client", () => {
    const c = makeClient() as Parameters<typeof RewindService.getInstance>[0];
    expect(RewindService.getInstance(c)).toBe(RewindService.getInstance(c));
  });

  it("throws when called with a different client", () => {
    RewindService.getInstance(
      makeClient() as Parameters<typeof RewindService.getInstance>[0],
    );
    expect(() =>
      RewindService.getInstance(
        makeClient() as Parameters<typeof RewindService.getInstance>[0],
      ),
    ).toThrow(/different client/);
  });
});

describe("RewindService text helpers (#496)", () => {
  const msgs = [
    { sentAt: new Date("2023-12-31T23:59:59Z"), channelId: "c1" },
    { sentAt: new Date("2024-01-01T00:00:00Z"), channelId: "c1" },
    { sentAt: new Date("2024-06-15T12:00:00Z"), channelId: "c2" },
    { sentAt: new Date("2025-01-01T00:00:00Z"), channelId: "c1" },
  ];

  describe("messagesInWindow", () => {
    it("keeps only messages within the half-open year window", () => {
      const { start, end } = yearBounds(2024);
      const inYear = messagesInWindow(msgs, start, end);
      expect(inYear).toHaveLength(2);
      expect(inYear.map((m) => m.channelId)).toEqual(["c1", "c2"]);
    });

    it("includes the start boundary and excludes the end boundary", () => {
      const { start, end } = yearBounds(2024);
      const inYear = messagesInWindow(msgs, start, end);
      expect(inYear.some((m) => m.sentAt.getTime() === start.getTime())).toBe(
        true,
      );
      expect(inYear.some((m) => m.sentAt.getTime() === end.getTime())).toBe(
        false,
      );
    });

    it("drops messages older than the window (retention boundary)", () => {
      const { start, end } = yearBounds(2024);
      const older = [
        { sentAt: new Date("2020-05-01T00:00:00Z"), channelId: "c1" },
      ];
      expect(messagesInWindow(older, start, end)).toEqual([]);
    });
  });

  describe("computeTopTextChannels", () => {
    it("counts per channel, sorts desc, and applies the limit", () => {
      const m = [
        { sentAt: new Date("2024-01-01T00:00:00Z"), channelId: "c1" },
        { sentAt: new Date("2024-01-02T00:00:00Z"), channelId: "c2" },
        { sentAt: new Date("2024-01-03T00:00:00Z"), channelId: "c1" },
        { sentAt: new Date("2024-01-04T00:00:00Z"), channelId: "c1" },
      ];
      const top = computeTopTextChannels(m, 1);
      expect(top).toEqual([{ channelId: "c1", count: 3 }]);
    });

    it("returns an empty array when there are no messages", () => {
      expect(computeTopTextChannels([], 3)).toEqual([]);
    });
  });

  describe("computePeakMessageDay", () => {
    it("returns the UTC day with the most messages", () => {
      const m = [
        { sentAt: new Date("2024-01-01T10:00:00Z"), channelId: "c1" },
        { sentAt: new Date("2024-01-01T11:00:00Z"), channelId: "c1" },
        { sentAt: new Date("2024-01-02T10:00:00Z"), channelId: "c1" },
      ];
      expect(computePeakMessageDay(m)).toEqual({
        date: "2024-01-01",
        count: 2,
      });
    });

    it("returns null when there are no messages", () => {
      expect(computePeakMessageDay([])).toBeNull();
    });
  });
});

describe("RewindService reaction helpers (#653)", () => {
  describe("extractYearlyReactionCount", () => {
    it("reads the requested year's count from a plain object (lean shape)", () => {
      const bucket = { "2025": 7, "2026": 12 };
      expect(extractYearlyReactionCount(bucket, 2026)).toBe(12);
    });

    it("reads the requested year's count from a Map (hydrated shape)", () => {
      const bucket = new Map([
        ["2025", 7],
        ["2026", 12],
      ]);
      expect(extractYearlyReactionCount(bucket, 2026)).toBe(12);
    });

    it("returns 0 for a year absent from a populated bucket", () => {
      expect(extractYearlyReactionCount({ "2025": 7 }, 2026)).toBe(0);
    });

    it("returns 0 for an empty / missing bucket (zero-data)", () => {
      expect(extractYearlyReactionCount({}, 2026)).toBe(0);
      expect(extractYearlyReactionCount(null, 2026)).toBe(0);
      expect(extractYearlyReactionCount(undefined, 2026)).toBe(0);
    });

    it("coerces malformed / non-positive bucket values to 0", () => {
      expect(
        extractYearlyReactionCount(
          { "2026": Number.NaN } as Record<string, number>,
          2026,
        ),
      ).toBe(0);
      expect(extractYearlyReactionCount({ "2026": 0 }, 2026)).toBe(0);
    });
  });

  describe("reactionActivityYears", () => {
    it("unions the distinct years across both buckets (object shape)", () => {
      expect(
        reactionActivityYears(
          { "2024": 5, "2026": 9 },
          { "2025": 2, "2026": 4 },
        ).sort(),
      ).toEqual([2024, 2025, 2026]);
    });

    it("reads Map buckets too (hydrated shape)", () => {
      expect(
        reactionActivityYears(
          new Map([["2023", 1]]),
          new Map([["2024", 3]]),
        ).sort(),
      ).toEqual([2023, 2024]);
    });

    it("skips non-positive counts and unparseable keys", () => {
      expect(
        reactionActivityYears({
          "2024": 0,
          "2025": 7,
          notayear: 3,
        } as Record<string, number>),
      ).toEqual([2025]);
    });

    it("returns an empty array for nullish / empty buckets (zero-data)", () => {
      expect(reactionActivityYears(null, undefined, {})).toEqual([]);
    });
  });

  describe("getSummary reaction wiring", () => {
    function lean<T>(value: T): { lean: () => Promise<T> } {
      return { lean: jest.fn(async () => value) };
    }
    function selectLean<T>(value: T): {
      select: () => { lean: () => Promise<T> };
    } {
      return { select: jest.fn(() => lean(value)) };
    }

    beforeEach(() => {
      jest.clearAllMocks();
      resetSingleton();
      mockFindOneVc.mockReturnValue(lean({ sessions: [] }));
      mockFindVc.mockReturnValue(selectLean([]));
      mockFindOneAch.mockReturnValue(lean(null));
      mockAggregateVc.mockResolvedValue([]);
      mockSnapFindOne.mockReturnValue(lean(null));
      mockSnapFind.mockReturnValue(lean([]));
      mockSnapCreate.mockResolvedValue({});
      mockFindOneReaction.mockReturnValue(lean(null));
      // Reaction tracking on by default for this block; other gates off.
      mockGetBoolean.mockImplementation(
        async (key: string) => key === "reactiontracking.enabled",
      );
    });

    function makeSvc() {
      return RewindService.getInstance(
        makeClient() as Parameters<typeof RewindService.getInstance>[0],
      );
    }

    it("surfaces the requested year's given/received counts", async () => {
      mockFindOneReaction.mockReturnValueOnce(
        lean({
          yearlyGiven: { "2025": 3, "2026": 9 },
          yearlyReceived: { "2026": 4 },
        }),
      );

      const summary = await makeSvc().getSummary("u1", "g1", 2026);
      expect(summary!.reactionsGiven).toBe(9);
      expect(summary!.reactionsReceived).toBe(4);
    });

    it("treats a reaction-only year as data and offers its years in the picker", async () => {
      // No voice / text / achievements — reactions are the only activity.
      mockFindOneReaction.mockReturnValueOnce(
        lean({
          yearlyGiven: { "2025": 3, "2026": 9 },
          yearlyReceived: { "2026": 4 },
        }),
      );

      const summary = await makeSvc().getSummary("u1", "g1", 2026);
      expect(summary!.hasData).toBe(true);
      // Both reaction years are navigable, newest first.
      expect(summary!.availableYears).toEqual([2026, 2025]);
    });

    it("does not mark hasData when the requested year has no reactions", async () => {
      // Buckets exist for another year only — the requested 2026 is empty,
      // so with no other activity the page stays in its empty state.
      mockFindOneReaction.mockReturnValueOnce(
        lean({ yearlyGiven: { "2024": 5 }, yearlyReceived: {} }),
      );

      const summary = await makeSvc().getSummary("u1", "g1", 2026);
      expect(summary!.hasData).toBe(false);
      // 2024 is still offered so the user can navigate to it.
      expect(summary!.availableYears).toEqual([2024]);
    });

    it("reads 0 for a year the user has no bucket entry for", async () => {
      mockFindOneReaction.mockReturnValueOnce(
        lean({ yearlyGiven: { "2024": 5 }, yearlyReceived: { "2024": 2 } }),
      );

      const summary = await makeSvc().getSummary("u1", "g1", 2026);
      expect(summary!.reactionsGiven).toBe(0);
      expect(summary!.reactionsReceived).toBe(0);
    });

    it("reads 0 (and never queries the model) when reaction tracking is off", async () => {
      mockGetBoolean.mockImplementation(async () => false);

      const summary = await makeSvc().getSummary("u1", "g1", 2026);
      expect(summary!.reactionsGiven).toBe(0);
      expect(summary!.reactionsReceived).toBe(0);
      expect(mockFindOneReaction).not.toHaveBeenCalled();
    });

    it("reads 0 when the user has no reaction row", async () => {
      mockFindOneReaction.mockReturnValueOnce(lean(null));

      const summary = await makeSvc().getSummary("u1", "g1", 2026);
      expect(summary!.reactionsGiven).toBe(0);
      expect(summary!.reactionsReceived).toBe(0);
    });
  });
});
