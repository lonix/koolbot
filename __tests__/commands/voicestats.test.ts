import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/voicestats.js';

describe('VoiceStats Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('voicestats');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Voice channel statistics and leaderboards');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'voicestats');
      expect(data.toJSON()).toHaveProperty('description');
    });

    it('should have two subcommands', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(2);
    });
  });

  describe('top subcommand', () => {
    it('should have top subcommand', () => {
      const json = data.toJSON();
      const topSubcommand = json.options?.find((opt: any) => opt.name === 'top');
      expect(topSubcommand).toBeDefined();
      expect(topSubcommand?.type).toBe(1); // SUB_COMMAND type
      expect(topSubcommand?.description).toBe('Show top voice channel users');
    });

    it('should have optional limit parameter with constraints', () => {
      const json = data.toJSON();
      const topSubcommand = json.options?.find((opt: any) => opt.name === 'top');
      const limitOption = topSubcommand?.options?.find((opt: any) => opt.name === 'limit');
      expect(limitOption).toBeDefined();
      expect(limitOption?.required).toBe(false);
      expect(limitOption?.min_value).toBe(1);
      expect(limitOption?.max_value).toBe(50);
    });

    it('should have optional period parameter with choices', () => {
      const json = data.toJSON();
      const topSubcommand = json.options?.find((opt: any) => opt.name === 'top');
      const periodOption = topSubcommand?.options?.find((opt: any) => opt.name === 'period');
      expect(periodOption).toBeDefined();
      expect(periodOption?.required).toBe(false);
      expect(periodOption?.choices).toBeDefined();
      expect(periodOption?.choices?.length).toBe(3);
    });
  });

  describe('user subcommand', () => {
    it('should have user subcommand', () => {
      const json = data.toJSON();
      const userSubcommand = json.options?.find((opt: any) => opt.name === 'user');
      expect(userSubcommand).toBeDefined();
      expect(userSubcommand?.type).toBe(1); // SUB_COMMAND type
      expect(userSubcommand?.description).toBe('Show voice channel statistics for a user');
    });

    it('should have optional user parameter', () => {
      const json = data.toJSON();
      const userSubcommand = json.options?.find((opt: any) => opt.name === 'user');
      const userOption = userSubcommand?.options?.find((opt: any) => opt.name === 'user');
      expect(userOption).toBeDefined();
      expect(userOption?.required).toBe(false);
    });

    it('should have optional period parameter with choices', () => {
      const json = data.toJSON();
      const userSubcommand = json.options?.find((opt: any) => opt.name === 'user');
      const periodOption = userSubcommand?.options?.find((opt: any) => opt.name === 'period');
      expect(periodOption).toBeDefined();
      expect(periodOption?.required).toBe(false);
      expect(periodOption?.choices).toBeDefined();
      expect(periodOption?.choices?.length).toBe(3);
    });
  });
});
