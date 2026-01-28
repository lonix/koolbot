import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/vcstats.js';

describe('VCStats Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('vcstats');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Show voice channel statistics for a user');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'vcstats');
      expect(data.toJSON()).toHaveProperty('description');
    });

    it('should have optional user parameter', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      const userOption = json.options?.find((opt: any) => opt.name === 'user');
      expect(userOption).toBeDefined();
      expect(userOption?.required).toBe(false);
    });

    it('should have optional period parameter with choices', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      const periodOption = json.options?.find((opt: any) => opt.name === 'period');
      expect(periodOption).toBeDefined();
      expect(periodOption?.required).toBe(false);
      expect(periodOption?.choices).toBeDefined();
      expect(periodOption?.choices?.length).toBe(3);
    });
  });
});
