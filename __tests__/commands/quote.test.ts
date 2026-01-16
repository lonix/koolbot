import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/quote.js';

describe('Quote Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('quote');
    });

    it('should have a description', () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toContain('quote');
    });

    it('should be a valid slash command', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('name', 'quote');
      expect(json).toHaveProperty('description');
    });

    it('should have text parameter', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBeGreaterThanOrEqual(2);
      
      const textOption = json.options?.find((opt: any) => opt.name === 'text');
      expect(textOption).toBeDefined();
      expect(textOption?.type).toBe(3); // STRING type
      expect(textOption?.required).toBe(true);
      expect(textOption?.description).toContain('quote text');
    });

    it('should have author parameter', () => {
      const json = data.toJSON();
      
      const authorOption = json.options?.find((opt: any) => opt.name === 'author');
      expect(authorOption).toBeDefined();
      expect(authorOption?.type).toBe(3); // STRING type
      expect(authorOption?.required).toBe(true);
      expect(authorOption?.description).toContain('author');
    });

    it('should require both text and author parameters', () => {
      const json = data.toJSON();
      const textOption = json.options?.find((opt: any) => opt.name === 'text');
      const authorOption = json.options?.find((opt: any) => opt.name === 'author');
      
      expect(textOption?.required).toBe(true);
      expect(authorOption?.required).toBe(true);
    });
  });
});
