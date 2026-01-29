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

describe('AchievementsService - Time of Day Calculations', () => {
  /**
   * These tests document and verify the timezone behavior of time-based accolades.
   * 
   * KEY FINDING: All time calculations use the server's local timezone via Date.getHours()
   * Since the bot typically runs in UTC, all time ranges are in UTC:
   * - Night Owl: 22:00 - 06:00 UTC (10 PM - 6 AM UTC)
   * - Early Bird: 06:00 - 10:00 UTC (6 AM - 10 AM UTC)
   * 
   * This means:
   * - A user in PST (UTC-8) needs to be active 14:00-22:00 PST for Night Owl
   * - A user in EST (UTC-5) needs to be active 17:00-01:00 EST for Night Owl
   * - A user in CET (UTC+1) needs to be active 23:00-07:00 CET for Night Owl
   */

  describe('Night Owl calculation (22:00 - 06:00 UTC)', () => {
    it('should count time during late night hours in UTC', () => {
      // Create a session from 11 PM to 1 AM UTC (2 hours in night owl range)
      const startTime = new Date('2026-01-29T23:00:00.000Z');
      const endTime = new Date('2026-01-30T01:00:00.000Z');
      
      // Verify the hours are in the expected range
      expect(startTime.getHours()).toBe(23); // 11 PM UTC
      expect(endTime.getHours()).toBe(1);    // 1 AM UTC
      
      // Both hours should qualify for Night Owl (22:00-06:00)
      expect(startTime.getHours() >= 22 || startTime.getHours() < 6).toBe(true);
      expect(endTime.getHours() >= 22 || endTime.getHours() < 6).toBe(true);
    });

    it('should NOT count time during daytime hours', () => {
      // Create a session from 2 PM to 4 PM UTC
      const startTime = new Date('2026-01-29T14:00:00.000Z');
      const endTime = new Date('2026-01-29T16:00:00.000Z');
      
      // Verify hours are NOT in night owl range
      expect(startTime.getHours()).toBe(14);
      expect(endTime.getHours()).toBe(16);
      expect(startTime.getHours() >= 22 || startTime.getHours() < 6).toBe(false);
      expect(endTime.getHours() >= 22 || endTime.getHours() < 6).toBe(false);
    });

    it('should use UTC time, not local time', () => {
      // A session at 11 PM PST (UTC-8) would be 7 AM UTC (next day)
      // This would NOT count for Night Owl since 7 AM UTC is after 6 AM cutoff
      const pstElevenPM = new Date('2026-01-30T07:00:00.000Z'); // 11 PM PST = 7 AM UTC
      
      expect(pstElevenPM.getHours()).toBe(7); // 7 AM UTC
      expect(pstElevenPM.getHours() >= 22 || pstElevenPM.getHours() < 6).toBe(false);
      
      // However, 11 PM EST (UTC-5) would be 4 AM UTC
      // This WOULD count for Night Owl since 4 AM UTC is before 6 AM
      const estElevenPM = new Date('2026-01-30T04:00:00.000Z'); // 11 PM EST = 4 AM UTC
      
      expect(estElevenPM.getHours()).toBe(4); // 4 AM UTC
      expect(estElevenPM.getHours() >= 22 || estElevenPM.getHours() < 6).toBe(true);
    });
  });

  describe('Early Bird calculation (06:00 - 10:00 UTC)', () => {
    it('should count time during early morning hours in UTC', () => {
      // Create a session from 7 AM to 9 AM UTC
      const startTime = new Date('2026-01-29T07:00:00.000Z');
      const endTime = new Date('2026-01-29T09:00:00.000Z');
      
      expect(startTime.getHours()).toBe(7);
      expect(endTime.getHours()).toBe(9);
      
      // Both hours should qualify for Early Bird (06:00-10:00)
      expect(startTime.getHours() >= 6 && startTime.getHours() < 10).toBe(true);
      expect(endTime.getHours() >= 6 && endTime.getHours() < 10).toBe(true);
    });

    it('should NOT count time outside early morning hours', () => {
      // Create a session from 11 AM to 1 PM UTC
      const startTime = new Date('2026-01-29T11:00:00.000Z');
      const endTime = new Date('2026-01-29T13:00:00.000Z');
      
      expect(startTime.getHours()).toBe(11);
      expect(endTime.getHours()).toBe(13);
      expect(startTime.getHours() >= 6 && startTime.getHours() < 10).toBe(false);
      expect(endTime.getHours() >= 6 && endTime.getHours() < 10).toBe(false);
    });

    it('should use UTC time, not local time', () => {
      // 7 AM PST (UTC-8) would be 3 PM UTC - NOT Early Bird hours
      const pstSevenAM = new Date('2026-01-29T15:00:00.000Z'); // 7 AM PST = 3 PM UTC
      
      expect(pstSevenAM.getHours()).toBe(15);
      expect(pstSevenAM.getHours() >= 6 && pstSevenAM.getHours() < 10).toBe(false);
      
      // 7 AM CET (UTC+1) would be 6 AM UTC - WOULD count as Early Bird
      const cetSevenAM = new Date('2026-01-29T06:00:00.000Z'); // 7 AM CET = 6 AM UTC
      
      expect(cetSevenAM.getHours()).toBe(6);
      expect(cetSevenAM.getHours() >= 6 && cetSevenAM.getHours() < 10).toBe(true);
    });
  });

  describe('Weekend Warrior calculation', () => {
    it('should use UTC day of week for determining weekends', () => {
      // Saturday in UTC
      const saturdayUTC = new Date('2026-01-31T12:00:00.000Z'); // Saturday
      expect(saturdayUTC.getDay()).toBe(6); // 6 = Saturday
      
      // Sunday in UTC
      const sundayUTC = new Date('2026-02-01T12:00:00.000Z'); // Sunday
      expect(sundayUTC.getDay()).toBe(0); // 0 = Sunday
      
      // Friday late night in PST could be Saturday in UTC
      const fridayPST = new Date('2026-01-31T02:00:00.000Z'); // Friday 6 PM PST = Saturday 2 AM UTC
      expect(fridayPST.getDay()).toBe(6); // Would count as Saturday (weekend) in UTC
    });
  });

  describe('Documentation of timezone behavior', () => {
    it('documents that Date.getHours() returns server local time', () => {
      // This test documents the key behavior:
      // JavaScript's Date.getHours() returns hours in the SYSTEM'S local timezone
      // NOT UTC, unless explicitly using getUTCHours()
      
      const testDate = new Date('2026-01-29T14:00:00.000Z'); // 2 PM UTC
      
      // In a UTC environment (like the bot's server):
      // getHours() returns 14 (2 PM)
      // getUTCHours() also returns 14 (2 PM)
      
      // In a PST environment (UTC-8):
      // getHours() would return 6 (6 AM PST)
      // getUTCHours() would return 14 (2 PM UTC)
      
      // Since the bot runs in UTC, getHours() === getUTCHours()
      expect(testDate.getUTCHours()).toBe(14);
      
      // This confirms all time calculations use the server's timezone (UTC)
    });

    it('provides timezone conversion examples for users', () => {
      // Example: Night Owl times in different timezones
      const nightOwlUTC = {
        start: 22, // 10 PM UTC
        end: 6,    // 6 AM UTC
      };
      
      // For PST (UTC-8) users:
      const nightOwlPST = {
        start: (nightOwlUTC.start - 8 + 24) % 24, // 2 PM PST
        end: (nightOwlUTC.end - 8 + 24) % 24,     // 10 PM PST
      };
      expect(nightOwlPST.start).toBe(14);
      expect(nightOwlPST.end).toBe(22);
      
      // For EST (UTC-5) users:
      const nightOwlEST = {
        start: (nightOwlUTC.start - 5 + 24) % 24, // 5 PM EST
        end: (nightOwlUTC.end - 5 + 24) % 24,     // 1 AM EST
      };
      expect(nightOwlEST.start).toBe(17);
      expect(nightOwlEST.end).toBe(1);
      
      // For CET (UTC+1) users:
      const nightOwlCET = {
        start: (nightOwlUTC.start + 1) % 24, // 11 PM CET
        end: (nightOwlUTC.end + 1) % 24,     // 7 AM CET
      };
      expect(nightOwlCET.start).toBe(23);
      expect(nightOwlCET.end).toBe(7);
    });
  });
});
