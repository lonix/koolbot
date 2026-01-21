import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/botstats.js';

describe('Botstats Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('botstats');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Display bot performance and usage statistics');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'botstats');
      expect(data.toJSON()).toHaveProperty('description', 'Display bot performance and usage statistics');
    });
  });
});
