import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/amikool.js';

describe('Amikool Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('amikool');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Check if you are kool');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'amikool');
      expect(data.toJSON()).toHaveProperty('description', 'Check if you are kool');
    });
  });
});
