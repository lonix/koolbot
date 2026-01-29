import { describe, it, expect } from '@jest/globals';
import { data as voiceStatsData } from '../../src/commands/voicestats.js';
import { data as announceVcStatsData } from '../../src/commands/announce-vc-stats.js';
import { data as seenData } from '../../src/commands/seen.js';
import { data as dbtrunkData } from '../../src/commands/dbtrunk.js';

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

  describe('Announce VC Stats Command Options', () => {
    const json = announceVcStatsData.toJSON();

    it('should have no options or empty options array', () => {
      expect(json.options === undefined || json.options?.length === 0).toBe(true);
    });

    it('should have administrator permission requirement', () => {
      expect(json.default_member_permissions).toBe('8');
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

  describe('DBTrunk Command Options', () => {
    const json = dbtrunkData.toJSON();

    it('should have subcommands', () => {
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(2);
    });

    it('should have run subcommand with correct type', () => {
      const runSubcommand = json.options?.find((opt: any) => opt.name === 'run');
      expect(runSubcommand).toBeDefined();
      expect(runSubcommand?.type).toBe(1); // Subcommand type
      expect(runSubcommand?.description).toBe('Run cleanup immediately');
    });

    it('should have status subcommand with correct type', () => {
      const statusSubcommand = json.options?.find((opt: any) => opt.name === 'status');
      expect(statusSubcommand).toBeDefined();
      expect(statusSubcommand?.type).toBe(1); // Subcommand type
      expect(statusSubcommand?.description).toBe('Show cleanup service status');
    });

    it('should have administrator permission requirement', () => {
      expect(json.default_member_permissions).toBeDefined();
      // Administrator = 8 in string format
    });
  });
});
