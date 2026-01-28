import { describe, it, expect } from '@jest/globals';
import { formatDuration } from '../../src/utils/time.js';

describe('Time Utilities - Edge Cases', () => {
  describe('formatDuration - additional edge cases', () => {
    it('should format exact 1 minute', () => {
      const result = formatDuration(60000);
      expect(result).toBe('1 minute');
    });

    it('should format exact 1 hour', () => {
      const result = formatDuration(3600000);
      expect(result).toBe('1 hour');
    });

    it('should format exact 1 day', () => {
      const result = formatDuration(86400000);
      expect(result).toBe('1 day');
    });

    it('should format hours with no minutes', () => {
      const result = formatDuration(7200000); // 2 hours exactly
      expect(result).toBe('2 hours');
    });

    it('should format days with hours and minutes', () => {
      const result = formatDuration(90060000); // 1 day, 1 hour, 1 minute
      expect(result).toBe('1 day, 1 hour, 1 minute');
    });

    it('should format large duration correctly', () => {
      const result = formatDuration(345600000); // 4 days exactly
      expect(result).toBe('4 days');
    });

    it('should format duration with all components', () => {
      const result = formatDuration(183780000); // 2 days, 3 hours, 3 minutes
      expect(result).toBe('2 days, 3 hours, 3 minutes');
    });

    it('should not show seconds when there are larger units', () => {
      const result = formatDuration(125000); // 2 minutes 5 seconds
      expect(result).toBe('2 minutes');
      expect(result).not.toContain('second');
    });

    it('should show seconds only when it is the only unit', () => {
      const result = formatDuration(30000); // 30 seconds
      expect(result).toBe('30 seconds');
    });

    it('should handle very large durations', () => {
      const result = formatDuration(31536000000); // 365 days
      expect(result).toContain('days');
    });
  });
});
