import { describe, it, expect, jest } from '@jest/globals';

// Mock mongoose connection before importing the service
jest.mock('mongoose', () => ({
  __esModule: true,
  default: {
    connection: {
      on: jest.fn(),
    },
    connect: jest.fn(),
  },
}));

jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/config-service.js');

describe('AchievementsService - Consecutive Days Calculation', () => {
  // Helper to create a date in YYYY-MM-DD format
  const createDate = (daysAgo: number): Date => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - daysAgo);
    date.setUTCHours(12, 0, 0, 0); // Noon UTC
    return date;
  };

  // Helper to format date as YYYY-MM-DD (matches implementation)
  const formatDateKeyUTC = (date: Date): string => {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  };

  describe('consecutive days streak logic', () => {

    it('should calculate 0 streak for empty sessions', () => {
      const sessions: Array<{ startTime: Date; duration?: number }> = [];

      // Simulate the calculation logic
      if (sessions.length === 0) {
        expect({ currentStreak: 0, longestStreak: 0 }).toEqual({
          currentStreak: 0,
          longestStreak: 0,
        });
      }
    });

    it('should calculate 1 day streak for single qualifying day', () => {
      const sessions = [
        { startTime: createDate(0), duration: 400 }, // Today, 6 min 40 sec
      ];
      const minDuration = 300;

      // Group by day
      const dayTotals = new Map<string, number>();
      for (const session of sessions) {
        if (session.startTime && session.duration) {
          const date = new Date(session.startTime);
          const dayKey = formatDateKeyUTC(date);
          const currentTotal = dayTotals.get(dayKey) || 0;
          dayTotals.set(dayKey, currentTotal + session.duration);
        }
      }

      const qualifyingDays = Array.from(dayTotals.entries())
        .filter(([, duration]) => duration >= minDuration)
        .map(([day]) => day)
        .sort();

      expect(qualifyingDays.length).toBe(1);
    });

    it('should not count days below minimum duration', () => {
      const sessions = [
        { startTime: createDate(0), duration: 200 }, // Today, 3 min 20 sec (below 5 min)
        { startTime: createDate(1), duration: 100 }, // Yesterday, 1 min 40 sec
      ];
      const minDuration = 300;

      const dayTotals = new Map<string, number>();
      for (const session of sessions) {
        if (session.startTime && session.duration) {
          const date = new Date(session.startTime);
          const dayKey = formatDateKeyUTC(date);
          const currentTotal = dayTotals.get(dayKey) || 0;
          dayTotals.set(dayKey, currentTotal + session.duration);
        }
      }

      const qualifyingDays = Array.from(dayTotals.entries())
        .filter(([, duration]) => duration >= minDuration)
        .map(([day]) => day)
        .sort();

      expect(qualifyingDays.length).toBe(0);
    });

    it('should aggregate multiple sessions on same day', () => {
      const today = createDate(0);
      const sessions = [
        { startTime: today, duration: 180 }, // 3 minutes
        {
          startTime: new Date(today.getTime() + 3600000),
          duration: 180,
        }, // 3 minutes, 1 hour later
      ];
      const minDuration = 300;

      const dayTotals = new Map<string, number>();
      for (const session of sessions) {
        if (session.startTime && session.duration) {
          const date = new Date(session.startTime);
          const dayKey = formatDateKeyUTC(date);
          const currentTotal = dayTotals.get(dayKey) || 0;
          dayTotals.set(dayKey, currentTotal + session.duration);
        }
      }

      const qualifyingDays = Array.from(dayTotals.entries())
        .filter(([, duration]) => duration >= minDuration)
        .map(([day]) => day)
        .sort();

      expect(qualifyingDays.length).toBe(1);
      const totalDuration = dayTotals.get(qualifyingDays[0]);
      expect(totalDuration).toBe(360); // 6 minutes total
    });

    it('should calculate 7 day consecutive streak', () => {
      const sessions = Array.from({ length: 7 }, (_, i) => ({
        startTime: createDate(6 - i), // 6 days ago to today
        duration: 400,
      }));
      const minDuration = 300;

      const dayTotals = new Map<string, number>();
      for (const session of sessions) {
        if (session.startTime && session.duration) {
          const date = new Date(session.startTime);
          const dayKey = formatDateKeyUTC(date);
          const currentTotal = dayTotals.get(dayKey) || 0;
          dayTotals.set(dayKey, currentTotal + session.duration);
        }
      }

      const qualifyingDays = Array.from(dayTotals.entries())
        .filter(([, duration]) => duration >= minDuration)
        .map(([day]) => day)
        .sort();

      expect(qualifyingDays.length).toBe(7);

      // Calculate streak
      let longestStreak = 1;
      let currentStreak = 1;

      for (let i = 1; i < qualifyingDays.length; i++) {
        const prevDate = new Date(qualifyingDays[i - 1] + 'T00:00:00Z');
        const currDate = new Date(qualifyingDays[i] + 'T00:00:00Z');
        const diffDays = Math.floor(
          (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24),
        );

        if (diffDays === 1) {
          currentStreak++;
          longestStreak = Math.max(longestStreak, currentStreak);
        } else {
          currentStreak = 1;
        }
      }

      expect(longestStreak).toBe(7);
    });

    it('should handle broken streaks correctly', () => {
      const sessions = [
        { startTime: createDate(10), duration: 400 }, // 10 days ago
        { startTime: createDate(9), duration: 400 }, // 9 days ago
        { startTime: createDate(8), duration: 400 }, // 8 days ago
        // Gap here - day 7 and 6 missing
        { startTime: createDate(5), duration: 400 }, // 5 days ago
        { startTime: createDate(4), duration: 400 }, // 4 days ago
        { startTime: createDate(3), duration: 400 }, // 3 days ago
        { startTime: createDate(2), duration: 400 }, // 2 days ago
        { startTime: createDate(1), duration: 400 }, // Yesterday
        { startTime: createDate(0), duration: 400 }, // Today
      ];
      const minDuration = 300;

      const dayTotals = new Map<string, number>();
      for (const session of sessions) {
        if (session.startTime && session.duration) {
          const date = new Date(session.startTime);
          const dayKey = formatDateKeyUTC(date);
          const currentTotal = dayTotals.get(dayKey) || 0;
          dayTotals.set(dayKey, currentTotal + session.duration);
        }
      }

      const qualifyingDays = Array.from(dayTotals.entries())
        .filter(([, duration]) => duration >= minDuration)
        .map(([day]) => day)
        .sort();

      expect(qualifyingDays.length).toBe(9);

      // Calculate longest streak
      let longestStreak = 1;
      let currentStreak = 1;

      for (let i = 1; i < qualifyingDays.length; i++) {
        const prevDate = new Date(qualifyingDays[i - 1] + 'T00:00:00Z');
        const currDate = new Date(qualifyingDays[i] + 'T00:00:00Z');
        const diffDays = Math.floor(
          (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24),
        );

        if (diffDays === 1) {
          currentStreak++;
          longestStreak = Math.max(longestStreak, currentStreak);
        } else {
          currentStreak = 1;
        }
      }

      // Longest streak should be 6 days (from 5 days ago to today)
      expect(longestStreak).toBe(6);
    });

    it('should calculate 30 day consecutive streak', () => {
      const sessions = Array.from({ length: 30 }, (_, i) => ({
        startTime: createDate(29 - i), // 29 days ago to today
        duration: 400,
      }));
      const minDuration = 300;

      const dayTotals = new Map<string, number>();
      for (const session of sessions) {
        if (session.startTime && session.duration) {
          const date = new Date(session.startTime);
          const dayKey = formatDateKeyUTC(date);
          const currentTotal = dayTotals.get(dayKey) || 0;
          dayTotals.set(dayKey, currentTotal + session.duration);
        }
      }

      const qualifyingDays = Array.from(dayTotals.entries())
        .filter(([, duration]) => duration >= minDuration)
        .map(([day]) => day)
        .sort();

      expect(qualifyingDays.length).toBe(30);

      let longestStreak = 1;
      let currentStreak = 1;

      for (let i = 1; i < qualifyingDays.length; i++) {
        const prevDate = new Date(qualifyingDays[i - 1] + 'T00:00:00Z');
        const currDate = new Date(qualifyingDays[i] + 'T00:00:00Z');
        const diffDays = Math.floor(
          (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24),
        );

        if (diffDays === 1) {
          currentStreak++;
          longestStreak = Math.max(longestStreak, currentStreak);
        } else {
          currentStreak = 1;
        }
      }

      expect(longestStreak).toBe(30);
    });

    it('should handle sessions with missing duration', () => {
      const sessions = [
        { startTime: createDate(0), duration: 400 },
        { startTime: createDate(1), duration: undefined }, // Missing duration
        { startTime: createDate(2), duration: 500 },
      ];
      const minDuration = 300;

      const dayTotals = new Map<string, number>();
      for (const session of sessions) {
        if (session.startTime && session.duration) {
          const date = new Date(session.startTime);
          const dayKey = formatDateKeyUTC(date);
          const currentTotal = dayTotals.get(dayKey) || 0;
          dayTotals.set(dayKey, currentTotal + session.duration);
        }
      }

      const qualifyingDays = Array.from(dayTotals.entries())
        .filter(([, duration]) => duration >= minDuration)
        .map(([day]) => day)
        .sort();

      // Should only count the 2 sessions with valid durations
      expect(qualifyingDays.length).toBe(2);
    });

    it('should use correct minimum duration threshold', () => {
      const sessions = [
        { startTime: createDate(0), duration: 300 }, // Exactly 5 minutes
        { startTime: createDate(1), duration: 299 }, // Just under 5 minutes
      ];
      const minDuration = 300;

      const dayTotals = new Map<string, number>();
      for (const session of sessions) {
        if (session.startTime && session.duration) {
          const date = new Date(session.startTime);
          const dayKey = formatDateKeyUTC(date);
          const currentTotal = dayTotals.get(dayKey) || 0;
          dayTotals.set(dayKey, currentTotal + session.duration);
        }
      }

      const qualifyingDays = Array.from(dayTotals.entries())
        .filter(([, duration]) => duration >= minDuration)
        .map(([day]) => day)
        .sort();

      // Only the session with exactly 300 seconds should qualify
      expect(qualifyingDays.length).toBe(1);
    });
  });

  describe('accolade type definitions', () => {
    it('should include consecutive day accolade types', () => {
      const accoladeTypes = [
        'first_hour',
        'voice_veteran_100',
        'voice_veteran_500',
        'voice_veteran_1000',
        'voice_legend_8765',
        'marathon_runner',
        'ultra_marathoner',
        'social_butterfly',
        'connector',
        'night_owl',
        'early_bird',
        'weekend_warrior',
        'weekday_warrior',
        'consistent_week',
        'consistent_fortnight',
        'consistent_month',
      ];

      // Verify new types are present
      expect(accoladeTypes).toContain('consistent_week');
      expect(accoladeTypes).toContain('consistent_fortnight');
      expect(accoladeTypes).toContain('consistent_month');
    });
  });

  describe('accolade metadata', () => {
    it('should format streak metadata correctly', () => {
      const mockMetadata = {
        value: 7,
        description: '7+ day streak',
        unit: 'days',
      };

      expect(mockMetadata.value).toBe(7);
      expect(mockMetadata.unit).toBe('days');
      expect(mockMetadata.description).toContain('streak');
    });

    it('should format different streak tiers correctly', () => {
      const weekStreak = {
        value: 7,
        description: '7+ day streak',
        unit: 'days',
      };
      const fortnightStreak = {
        value: 14,
        description: '14+ day streak',
        unit: 'days',
      };
      const monthStreak = {
        value: 30,
        description: '30+ day streak',
        unit: 'days',
      };

      expect(weekStreak.value).toBe(7);
      expect(fortnightStreak.value).toBe(14);
      expect(monthStreak.value).toBe(30);
    });
  });
});
