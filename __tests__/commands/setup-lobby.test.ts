import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ChatInputCommandInteraction, Guild, Client } from 'discord.js';
import { command } from '../../src/commands/setup-lobby.js';
import { ChannelInitializer } from '../../src/services/channel-initializer.js';
import { ConfigService } from '../../src/services/config-service.js';

jest.mock('../../src/services/channel-initializer.js');
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');

describe('Setup Lobby Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(command.data.name).toBe('setup-lobby');
    });

    it('should have a description', () => {
      expect(command.data.description).toBe('Set up the voice channel lobby and category');
    });

    it('should be a valid slash command', () => {
      expect(command.data.toJSON()).toHaveProperty('name', 'setup-lobby');
      expect(command.data.toJSON()).toHaveProperty('description');
    });

    it('should have an execute function', () => {
      expect(typeof command.execute).toBe('function');
    });
  });

  describe('execute', () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;
    let mockConfigService: any;
    let mockInitializer: any;

    beforeEach(() => {
      jest.clearAllMocks();

      mockInteraction = {
        guild: {
          id: 'guild123',
        } as Guild,
        client: {} as Client,
        reply: jest.fn().mockResolvedValue(undefined),
        editReply: jest.fn().mockResolvedValue(undefined),
        replied: false,
      };

      mockConfigService = {
        getString: jest.fn().mockResolvedValue('Lobby'),
      };

      mockInitializer = {
        forceReinitialize: jest.fn().mockResolvedValue(undefined),
      };

      (ConfigService.getInstance as jest.Mock).mockReturnValue(mockConfigService);
      (ChannelInitializer.getInstance as jest.Mock).mockReturnValue(mockInitializer);
    });

    it('should setup lobby successfully', async () => {
      await command.execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockConfigService.getString).toHaveBeenCalledWith(
        'voice_channel.lobby_channel_name',
        'Lobby'
      );
      expect(mockInitializer.forceReinitialize).toHaveBeenCalledWith('guild123');
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.stringContaining('setup completed successfully')
      );
    });

    it('should handle missing guild', async () => {
      mockInteraction.guild = null;

      await command.execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        'This command can only be used in a server.'
      );
    });

    it('should handle errors gracefully', async () => {
      mockInitializer.forceReinitialize.mockRejectedValue(new Error('Setup failed'));

      await command.execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith({
        content: expect.stringContaining('error while executing'),
      });
    });
  });
});
