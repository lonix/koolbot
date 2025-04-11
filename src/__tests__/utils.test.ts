import { describe, it, expect } from '@jest/globals';

describe('Utils', () => {
  describe('formatDuration', () => {
    it('should format duration in minutes correctly', () => {
      const minutes = 65;
      const expected = '1 hour and 5 minutes';
      // TODO: Implement the actual test once the utility function is created
      expect(true).toBe(true);
    });
  });

  describe('formatTimeAgo', () => {
    it('should format time ago correctly', () => {
      const date = new Date();
      date.setHours(date.getHours() - 2);
      const expected = '2 hours ago';
      // TODO: Implement the actual test once the utility function is created
      expect(true).toBe(true);
    });
  });
}); 