import { describe, it, expect } from '@jest/globals';
import { data as voiceStatsData } from '../../src/commands/voicestats.js';
import { data as seenData } from '../../src/commands/seen.js';

describe('Command Options Validation', () => {
  describe('VoiceStats Command Options', () => {
    const json = voiceStatsData.toJSON();

    it('should have two subcommands', () => {
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(2);
    });

    it('should have top subcommand', () => {
      const topSubcommand = json.options?.find((opt: any) => opt.name === 'top');
      expect(topSubcommand).toBeDefined();
      expect(topSubcommand?.type).toBe(1); // Subcommand type
      expect(topSubcommand?.description).toBe('Show top voice channel users');
    });

    it('should have user subcommand', () => {
      const userSubcommand = json.options?.find((opt: any) => opt.name === 'user');
      expect(userSubcommand).toBeDefined();
      expect(userSubcommand?.type).toBe(1); // Subcommand type
      expect(userSubcommand?.description).toBe('Show voice channel statistics for a user');
    });

    it('top subcommand should have correct limit option', () => {
      const topSubcommand = json.options?.find((opt: any) => opt.name === 'top');
      const limitOption = topSubcommand?.options?.find((opt: any) => opt.name === 'limit');
      expect(limitOption).toBeDefined();
      expect(limitOption?.type).toBe(4); // Integer type
      expect(limitOption?.required).toBe(false);
      expect(limitOption?.description).toBe('Number of users to show');
      expect(limitOption?.min_value).toBe(1);
      expect(limitOption?.max_value).toBe(50);
    });

    it('top subcommand should have correct period option', () => {
      const topSubcommand = json.options?.find((opt: any) => opt.name === 'top');
      const periodOption = topSubcommand?.options?.find((opt: any) => opt.name === 'period');
      expect(periodOption).toBeDefined();
      expect(periodOption?.type).toBe(3); // String type
      expect(periodOption?.required).toBe(false);
      expect(periodOption?.description).toBe('Time period to show stats for');
      expect(periodOption?.choices).toEqual([
        { name: 'This Week', value: 'week' },
        { name: 'This Month', value: 'month' },
        { name: 'All Time', value: 'alltime' },
      ]);
    });

    it('user subcommand should have correct user option', () => {
      const userSubcommand = json.options?.find((opt: any) => opt.name === 'user');
      const userOption = userSubcommand?.options?.find((opt: any) => opt.name === 'user');
      expect(userOption).toBeDefined();
      expect(userOption?.type).toBe(6); // User type
      expect(userOption?.required).toBe(false);
      expect(userOption?.description).toBe('The user to show statistics for');
    });

    it('user subcommand should have correct period option', () => {
      const userSubcommand = json.options?.find((opt: any) => opt.name === 'user');
      const periodOption = userSubcommand?.options?.find((opt: any) => opt.name === 'period');
      expect(periodOption).toBeDefined();
      expect(periodOption?.type).toBe(3); // String type
      expect(periodOption?.required).toBe(false);
      expect(periodOption?.description).toBe('Time period to show stats for');
      expect(periodOption?.choices).toEqual([
        { name: 'This Week', value: 'week' },
        { name: 'This Month', value: 'month' },
        { name: 'All Time', value: 'alltime' },
      ]);
    });
  });

  describe('Seen Command Options', () => {
    const json = seenData.toJSON();

    it('should have required user option', () => {
      const userOption = json.options?.[0];
      expect(userOption).toBeDefined();
      expect(userOption?.name).toBe('user');
      expect(userOption?.type).toBe(6); // User type
      expect(userOption?.required).toBe(true);
      expect(userOption?.description).toBe('The user to check');
    });

    it('should have exactly 1 option', () => {
      expect(json.options?.length).toBe(1);
    });
  });
});
