import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// IMPORTANT: This file must NOT statically import from
// `rewind-service.js` — the static import would cache the real
// Mongoose models before the `jest.unstable_mockModule` calls below
// register the test doubles. All bindings come via the `await import`
// once mocks are in place.

const mockFindOneVc = jest.fn();
const mockAggregateVc = jest.fn();
const mockFindOneAch = jest.fn();

jest.unstable_mockModule("../../src/models/voice-channel-tracking.js", () => ({
  VoiceChannelTracking: {
    findOne: mockFindOneVc,
    aggregate: mockAggregateVc,
  },
}));

jest.unstable_mockModule("../../src/models/user-achievements.js", () => ({
  UserAchievements: {
    findOne: mockFindOneAch,
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
  computeLongestStreak,
  computePeakDay,
  computeTopChannels,
  computePeakMessageDay,
  computeTopTextChannels,
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

  describe("computeTopChannels", () => {
    it("sums duration per channel and ranks by total", () => {
      const sessions = [
        {
          startTime: new Date("2026-01-01T10:00:00Z"),
          duration: 600,
          channelId: "a",
          channelName: "alpha",
        },
        {
          startTime: new Date("2026-01-02T10:00:00Z"),
          duration: 1200,
          channelId: "b",
          channelName: "beta",
        },
        {
          startTime: new Date("2026-01-03T10:00:00Z"),
          duration: 300,
          channelId: "a",
          channelName: "alpha",
        },
      ];
      const top = computeTopChannels(sessions, 3);
      expect(top).toHaveLength(2);
      expect(top[0]).toMatchObject({ channelId: "b", totalSeconds: 1200 });
      expect(top[1]).toMatchObject({ channelId: "a", totalSeconds: 900 });
    });

    it("uses the most recent non-empty channel name for renames", () => {
      const sessions = [
        {
          startTime: new Date("2026-01-01T10:00:00Z"),
          duration: 600,
          channelId: "a",
          channelName: "old-name",
        },
        {
          startTime: new Date("2026-01-02T10:00:00Z"),
          duration: 600,
          channelId: "a",
          channelName: "new-name",
        },
      ];
      const [first] = computeTopChannels(sessions, 3);
      expect(first.channelName).toBe("new-name");
    });

    it("honours the limit", () => {
      const sessions = [
        { startTime: new Date(), duration: 1, channelId: "a" },
        { startTime: new Date(), duration: 2, channelId: "b" },
        { startTime: new Date(), duration: 3, channelId: "c" },
        { startTime: new Date(), duration: 4, channelId: "d" },
      ];
      expect(computeTopChannels(sessions, 2)).toHaveLength(2);
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

  beforeEach(() => {
    jest.clearAllMocks();
    resetSingleton();
    // Default chainable returns so tests that don't override the
    // `findOne` calls still chain through `.lean()` without crashing.
    mockFindOneVc.mockReturnValue(lean({ sessions: [] }));
    mockFindOneAch.mockReturnValue(lean(null));
    mockAggregateVc.mockResolvedValue([]);
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
    expect(summary!.topChannels).toEqual([]);
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
    expect(summary!.topChannels.map((c) => c.channelId)).toEqual([
      "general",
      "gaming",
    ]);
    expect(summary!.peakDay).toEqual({
      date: "2026-01-15",
      totalSeconds: 5400,
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
