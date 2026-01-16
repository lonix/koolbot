import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/vc.js';

describe('VC Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('vc');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Voice channel management');
    });

    it('should require administrator permissions', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('default_member_permissions');
      // Administrator permission bit is "8"
      expect(json.default_member_permissions).toBe('8');
    });

    it('should be a valid slash command', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('name', 'vc');
      expect(json).toHaveProperty('description');
    });
  });

  describe('subcommands', () => {
    const json = data.toJSON();
    const options = json.options || [];

    it('should have reload subcommand', () => {
      const reloadSubcommand = options.find(
        (opt: any) => opt.type === 1 && opt.name === 'reload'
      );
      expect(reloadSubcommand).toBeDefined();
      expect(reloadSubcommand?.description).toBe('Clean up empty voice channels');
    });

    it('should have force-reload subcommand', () => {
      const forceReloadSubcommand = options.find(
        (opt: any) => opt.type === 1 && opt.name === 'force-reload'
      );
      expect(forceReloadSubcommand).toBeDefined();
      expect(forceReloadSubcommand?.description).toBe(
        'Force cleanup of ALL unmanaged channels in category'
      );
    });

    it('should have customize subcommand group', () => {
      const customizeGroup = options.find(
        (opt: any) => opt.type === 2 && opt.name === 'customize'
      );
      expect(customizeGroup).toBeDefined();
      expect(customizeGroup?.description).toBe('Customize your voice channel settings');
    });
  });

  describe('customize subcommand group', () => {
    const json = data.toJSON();
    const options = json.options || [];
    const customizeGroup = options.find(
      (opt: any) => opt.type === 2 && opt.name === 'customize'
    );
    const subcommands = customizeGroup?.options || [];

    it('should have name subcommand', () => {
      const nameSubcommand = subcommands.find(
        (opt: any) => opt.name === 'name'
      );
      expect(nameSubcommand).toBeDefined();
      expect(nameSubcommand?.description).toBe('Set custom channel naming pattern');
      expect(nameSubcommand?.options).toHaveLength(1);
      expect(nameSubcommand?.options[0]).toMatchObject({
        name: 'pattern',
        type: 3, // String type
        required: true,
      });
    });

    it('should have limit subcommand', () => {
      const limitSubcommand = subcommands.find(
        (opt: any) => opt.name === 'limit'
      );
      expect(limitSubcommand).toBeDefined();
      expect(limitSubcommand?.description).toBe('Set user limit for your voice channel');
      expect(limitSubcommand?.options).toHaveLength(1);
      expect(limitSubcommand?.options[0]).toMatchObject({
        name: 'number',
        type: 4, // Integer type
        required: true,
        min_value: 0,
        max_value: 99,
      });
    });

    it('should have bitrate subcommand', () => {
      const bitrateSubcommand = subcommands.find(
        (opt: any) => opt.name === 'bitrate'
      );
      expect(bitrateSubcommand).toBeDefined();
      expect(bitrateSubcommand?.description).toBe(
        'Set audio quality for your voice channel'
      );
      expect(bitrateSubcommand?.options).toHaveLength(1);
      expect(bitrateSubcommand?.options[0]).toMatchObject({
        name: 'kbps',
        type: 4, // Integer type
        required: true,
        min_value: 8,
        max_value: 384,
      });
    });

    it('should have reset subcommand', () => {
      const resetSubcommand = subcommands.find(
        (opt: any) => opt.name === 'reset'
      );
      expect(resetSubcommand).toBeDefined();
      expect(resetSubcommand?.description).toBe(
        'Reset all your voice channel customizations'
      );
      // Options can be undefined or empty array
      expect(resetSubcommand?.options || []).toHaveLength(0);
    });

    it('should have exactly 4 subcommands in customize group', () => {
      expect(subcommands).toHaveLength(4);
      const subcommandNames = subcommands.map((opt: any) => opt.name);
      expect(subcommandNames).toEqual(
        expect.arrayContaining(['name', 'limit', 'bitrate', 'reset'])
      );
    });
  });

  describe('parameter validation', () => {
    const json = data.toJSON();
    const options = json.options || [];
    const customizeGroup = options.find(
      (opt: any) => opt.type === 2 && opt.name === 'customize'
    );
    const subcommands = customizeGroup?.options || [];

    it('name pattern parameter should be a required string', () => {
      const nameSubcommand = subcommands.find(
        (opt: any) => opt.name === 'name'
      );
      const patternOption = nameSubcommand?.options[0];
      
      expect(patternOption?.type).toBe(3); // String type
      expect(patternOption?.required).toBe(true);
      expect(patternOption?.name).toBe('pattern');
    });

    it('limit parameter should have correct constraints', () => {
      const limitSubcommand = subcommands.find(
        (opt: any) => opt.name === 'limit'
      );
      const numberOption = limitSubcommand?.options[0];
      
      expect(numberOption?.type).toBe(4); // Integer type
      expect(numberOption?.required).toBe(true);
      expect(numberOption?.min_value).toBe(0);
      expect(numberOption?.max_value).toBe(99);
    });

    it('bitrate parameter should have correct constraints', () => {
      const bitrateSubcommand = subcommands.find(
        (opt: any) => opt.name === 'bitrate'
      );
      const kbpsOption = bitrateSubcommand?.options[0];
      
      expect(kbpsOption?.type).toBe(4); // Integer type
      expect(kbpsOption?.required).toBe(true);
      expect(kbpsOption?.min_value).toBe(8);
      expect(kbpsOption?.max_value).toBe(384);
    });
  });
});
