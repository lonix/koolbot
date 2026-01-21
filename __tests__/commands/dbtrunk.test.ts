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

  describe('execute', () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;
    let mockTruncationService: any;

    beforeEach(() => {
      jest.clearAllMocks();

      mockInteraction = {
        client: {} as Client,
        options: {
          getSubcommand: jest.fn().mockReturnValue('status'),
        } as any,
        reply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
      };

      mockTruncationService = {
        runCleanup: jest.fn(),
        getStatus: jest.fn(),
      };

      (VoiceChannelTruncationService.getInstance as jest.Mock).mockReturnValue(mockTruncationService);
    });

    it('should handle status subcommand', async () => {
      mockTruncationService.getStatus.mockResolvedValue({
        isScheduled: true,
        isRunning: false,
        isConnected: true,
        lastCleanupDate: new Date('2024-01-01'),
      });

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('Service Status'),
        ephemeral: true,
      });
    });

    it('should handle run subcommand', async () => {
      mockInteraction.options!.getSubcommand = jest.fn().mockReturnValue('run');
      mockTruncationService.runCleanup.mockResolvedValue({
        sessionsRemoved: 10,
        dataAggregated: 5,
        executionTime: 1234,
        errors: [],
      });

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('Running voice channel data cleanup'),
        ephemeral: true,
      });
      expect(mockInteraction.editReply).toHaveBeenCalledWith({
        content: expect.stringContaining('Cleanup completed'),
      });
    });

    it('should handle errors in run subcommand', async () => {
      mockInteraction.options!.getSubcommand = jest.fn().mockReturnValue('run');
      mockTruncationService.runCleanup.mockRejectedValue(new Error('Cleanup failed'));

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith({
        content: expect.stringContaining('Error during cleanup execution'),
      });
    });

    it('should handle errors in execute', async () => {
      mockInteraction.options!.getSubcommand = jest.fn().mockImplementation(() => {
        throw new Error('Command error');
      });

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('error occurred'),
        ephemeral: true,
      });
    });
  });
});
