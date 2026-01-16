import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/help.js';

describe('Help Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('help');
    });

    it('should have a description', () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toBe('Get help with KoolBot commands');
    });

    it('should be a valid slash command', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('name', 'help');
      expect(json).toHaveProperty('description');
    });

    it('should have optional command parameter', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(1);
      
      const commandOption = json.options?.[0];
      expect(commandOption?.name).toBe('command');
      expect(commandOption?.type).toBe(3); // STRING type
      expect(commandOption?.required).toBe(false);
    });

    it('should have description for command parameter', () => {
      const json = data.toJSON();
      const commandOption = json.options?.[0];
      expect(commandOption?.description).toBeTruthy();
      expect(commandOption?.description).toContain('specific command');
    });
  });
});
