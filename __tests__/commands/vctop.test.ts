import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/vctop.js';

describe('VCTop Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('vctop');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Show top voice channel users');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'vctop');
      expect(data.toJSON()).toHaveProperty('description');
    });

    it('should have optional limit parameter with constraints', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      const limitOption = json.options?.find((opt: any) => opt.name === 'limit');
      expect(limitOption).toBeDefined();
      expect(limitOption?.required).toBe(false);
      expect(limitOption?.min_value).toBe(1);
      expect(limitOption?.max_value).toBe(50);
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
