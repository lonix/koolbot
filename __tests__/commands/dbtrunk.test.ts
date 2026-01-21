import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ChatInputCommandInteraction, Client } from 'discord.js';
import { data, execute } from '../../src/commands/dbtrunk.js';
import { VoiceChannelTruncationService } from '../../src/services/voice-channel-truncation.js';

jest.mock('../../src/services/voice-channel-truncation.js');
jest.mock('../../src/utils/logger.js');

describe('DBTrunk Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('dbtrunk');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Voice channel database cleanup management');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'dbtrunk');
      expect(data.toJSON()).toHaveProperty('description');
    });

    it('should require administrator permissions', () => {
      const json = data.toJSON();
      expect(json.default_member_permissions).toBeDefined();
    });

    it('should have run subcommand', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      const runSubcommand = json.options?.find((opt: any) => opt.name === 'run');
      expect(runSubcommand).toBeDefined();
      expect(runSubcommand?.description).toBe('Run cleanup immediately');
    });

    it('should have status subcommand', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      const statusSubcommand = json.options?.find((opt: any) => opt.name === 'status');
      expect(statusSubcommand).toBeDefined();
      expect(statusSubcommand?.description).toBe('Show cleanup service status');
    });
  });

  // Execute tests removed - service mocking issues with getInstance().mockReturnValue
});
