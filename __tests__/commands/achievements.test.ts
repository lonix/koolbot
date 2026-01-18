import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/achievements.js';

describe('Achievements Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('achievements');
    });

    it('should have a description', () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toBe('View earned badges and achievements');
    });

    it('should be a valid slash command', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('name', 'achievements');
      expect(json).toHaveProperty('description');
    });

    it('should have optional user parameter', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(1);
      
      const userOption = json.options?.[0];
      expect(userOption?.name).toBe('user');
      expect(userOption?.type).toBe(6); // USER type
      expect(userOption?.required).toBe(false);
    });

    it('should have description for user parameter', () => {
      const json = data.toJSON();
      const userOption = json.options?.[0];
      expect(userOption?.description).toBeTruthy();
      expect(userOption?.description).toContain('user');
    });
  });
});
