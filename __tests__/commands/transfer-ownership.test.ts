import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ChatInputCommandInteraction, Guild, GuildMember, VoiceChannel, User, Client } from 'discord.js';
import { data, execute } from '../../src/commands/transfer-ownership.js';
import { VoiceChannelManager } from '../../src/services/voice-channel-manager.js';

jest.mock('../../src/services/voice-channel-manager.js');
jest.mock('../../src/utils/logger.js');

describe('Transfer Ownership Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('transfer-ownership');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Transfer ownership of your voice channel to another user');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'transfer-ownership');
      expect(data.toJSON()).toHaveProperty('description');
    });

    it('should have required user parameter', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBeGreaterThan(0);
      expect(json.options?.[0]).toMatchObject({
        name: 'user',
        type: 6, // User type
        required: true,
      });
    });

    it('should have description for user parameter', () => {
      const json = data.toJSON();
      expect(json.options?.[0].description).toBe('The user to transfer ownership to');
    });
  });

  describe('execute', () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;
    let mockVoiceChannelManager: any;
    let mockMember: Partial<GuildMember>;
    let mockTargetUser: Partial<User>;

    beforeEach(() => {
      jest.clearAllMocks();

      mockTargetUser = {
        id: 'targetUser123',
        username: 'TargetUser',
      };

      mockMember = {
        voice: {
          channel: {
            id: 'channel123',
            name: 'Test Channel',
          } as VoiceChannel,
        } as any,
      };

      mockInteraction = {
        user: {
          id: 'user123',
          username: 'TestUser',
        } as User,
        guild: {
          id: 'guild123',
          members: {
            cache: new Map([
              ['user123', mockMember],
            ]),
          } as any,
        } as Guild,
        client: {} as Client,
        options: {
          getUser: jest.fn().mockReturnValue(mockTargetUser),
        } as any,
        reply: jest.fn().mockResolvedValue(undefined),
      };

      mockVoiceChannelManager = {
        transferOwnership: jest.fn().mockResolvedValue(undefined),
      };

      (VoiceChannelManager.getInstance as jest.Mock).mockReturnValue(mockVoiceChannelManager);
    });

    it('should handle missing guild', async () => {
      mockInteraction.guild = null;

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'This command can only be used in a server!',
        ephemeral: true,
      });
    });

    it('should handle missing member', async () => {
      mockInteraction.guild!.members.cache = new Map();

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'Could not find your member information.',
        ephemeral: true,
      });
    });

    it('should handle user not in voice channel', async () => {
      mockMember.voice = { channel: null } as any;

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'You must be in a voice channel to transfer ownership!',
        ephemeral: true,
      });
    });

    it('should handle errors gracefully', async () => {
      mockVoiceChannelManager.transferOwnership.mockRejectedValue(new Error('Transfer failed'));

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('error'),
        ephemeral: true,
      });
    });
  });
});
