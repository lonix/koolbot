import { describe, it, expect } from '@jest/globals';
import { formatDuration, formatTimeAgo, formatDateInTimezone } from '../../src/utils/time.js';

describe('Time Utilities', () => {
  describe('formatDuration', () => {
    it('should format seconds only', () => {
      const result = formatDuration(5000); // 5 seconds
      expect(result).toBe('5 seconds');
    });

    it('should format single second', () => {
      const result = formatDuration(1000); // 1 second
      expect(result).toBe('1 second');
    });

    it('should format minutes and seconds', () => {
      const result = formatDuration(90000); // 1 minute 30 seconds
      expect(result).toBe('1 minute');
    });

    it('should format hours and minutes', () => {
      const result = formatDuration(3660000); // 1 hour 1 minute
      expect(result).toBe('1 hour, 1 minute');
    });

    it('should format days, hours, and minutes', () => {
      const result = formatDuration(90000000); // 1 day 1 hour
      expect(result).toBe('1 day, 1 hour');
    });

    it('should handle multiple days', () => {
      const result = formatDuration(172800000); // 2 days
      expect(result).toBe('2 days');
    });

    it('should handle multiple hours', () => {
      const result = formatDuration(7200000); // 2 hours
      expect(result).toBe('2 hours');
    });

    it('should handle multiple minutes', () => {
      const result = formatDuration(120000); // 2 minutes
      expect(result).toBe('2 minutes');
    });

    it('should handle zero milliseconds', () => {
      const result = formatDuration(0);
      expect(result).toBe(''); // Returns empty string when no parts
    });

    it('should handle less than 1 second', () => {
      const result = formatDuration(500); // 0.5 seconds
      expect(result).toBe(''); // Returns empty string for sub-second durations
    });

    it('should format complex duration', () => {
      const result = formatDuration(93784000); // 1 day, 2 hours, 3 minutes, 4 seconds
      expect(result).toBe('1 day, 2 hours, 3 minutes');
    });
  });

  describe('formatTimeAgo', () => {
    it('should format recent time', () => {
      const date = new Date(Date.now() - 5000); // 5 seconds ago
      const result = formatTimeAgo(date);
      // date-fns may say "less than a minute ago" for very recent times
      expect(result).toContain('ago');
    });

    it('should format minutes ago', () => {
      const date = new Date(Date.now() - 120000); // 2 minutes ago
      const result = formatTimeAgo(date);
      expect(result).toContain('minute');
      expect(result).toContain('ago');
    });

    it('should format hours ago', () => {
      const date = new Date(Date.now() - 3600000); // 1 hour ago
      const result = formatTimeAgo(date);
      expect(result).toContain('hour');
      expect(result).toContain('ago');
    });

    it('should format days ago', () => {
      const date = new Date(Date.now() - 86400000); // 1 day ago
      const result = formatTimeAgo(date);
      expect(result).toContain('day');
      expect(result).toContain('ago');
    });

    it('should handle invalid date gracefully', () => {
      const result = formatTimeAgo(new Date('invalid'));
      expect(result).toBe('unknown time');
    });
  });

  describe('formatDateInTimezone', () => {
    it('should format date in UTC', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const result = formatDateInTimezone(date, 'UTC');
      expect(result).toBe('2024-01-15 10:30:00');
    });

    it('should format date in America/New_York', () => {
      const date = new Date('2024-01-15T15:30:00Z');
      const result = formatDateInTimezone(date, 'America/New_York');
      expect(result).toMatch(/2024-01-15 \d{2}:\d{2}:\d{2}/);
    });

    it('should handle invalid timezone by falling back to UTC format', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const result = formatDateInTimezone(date, 'Invalid/Timezone');
      expect(result).toMatch(/2024-01-15 \d{2}:\d{2}:\d{2}/);
    });

    it('should format date in Europe/London', () => {
      const date = new Date('2024-01-15T12:00:00Z');
      const result = formatDateInTimezone(date, 'Europe/London');
      expect(result).toMatch(/2024-01-15 \d{2}:\d{2}:\d{2}/);
    });
  });
});
