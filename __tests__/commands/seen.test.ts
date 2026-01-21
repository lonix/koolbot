import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/seen.js';

describe('Seen Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('seen');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Shows when a user was last seen in a voice channel');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'seen');
      expect(data.toJSON()).toHaveProperty('description');
    });

    it('should have required user parameter', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBeGreaterThan(0);
      expect(json.options?.[0]).toMatchObject({
        name: 'user',
        type: 6, // User type
        required: true,
      });
    });
  });
});
