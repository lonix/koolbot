import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/setup-wizard.js';

describe('Setup Wizard Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('setup');
    });

    it('should have a description', () => {
      expect(data.description).toBeDefined();
      expect(typeof data.description).toBe('string');
    });

    it('should be a valid slash command', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('name', 'setup');
      expect(json).toHaveProperty('description');
    });

    it('should have subcommands', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(Array.isArray(json.options)).toBe(true);
      expect(json.options?.length).toBeGreaterThan(0);
    });

    it('should have wizard subcommand', () => {
      const json = data.toJSON();
      const wizardSubcommand = json.options?.find((opt: any) => opt.name === 'wizard');
      expect(wizardSubcommand).toBeDefined();
    });
  });
});
