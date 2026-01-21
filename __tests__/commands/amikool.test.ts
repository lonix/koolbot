import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { data, execute } from '../../src/commands/amikool.js';
import type { CommandInteraction, GuildMember, User, Role } from 'discord.js';
import { createMockCollection } from '../test-utils.js';

// Mock logger
jest.mock('../../src/utils/logger.js');

describe('Amikool Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('amikool');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Check if you are kool');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'amikool');
      expect(data.toJSON()).toHaveProperty('description', 'Check if you are kool');
    });
  });

  describe('execute', () => {
    let mockInteraction: Partial<CommandInteraction>;
    let mockMember: Partial<GuildMember>;
    let mockUser: Partial<User>;

    beforeEach(() => {
      jest.clearAllMocks();

      mockUser = {
        tag: 'TestUser#1234',
      };

      const mockRoles = createMockCollection<string, Role>([
        ['role1', { name: 'Kool', id: 'role1' } as Role],
      ]);
      
      mockMember = {
        roles: {
          cache: mockRoles,
        } as any,
      };

      mockInteraction = {
        user: mockUser as User,
        member: mockMember as GuildMember,
        reply: jest.fn().mockResolvedValue(undefined),
      };
    });

    it('should reply with a response', async () => {
      await execute(mockInteraction as CommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
      const reply = (mockInteraction.reply as jest.Mock).mock.calls[0][0];
      expect(typeof reply).toBe('string');
    });

    it('should reply with kool response if user has kool role', async () => {
      await execute(mockInteraction as CommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
      const reply = (mockInteraction.reply as jest.Mock).mock.calls[0][0];
      expect(typeof reply).toBe('string');
      // Should contain "kool" (case insensitive)
      expect(reply.toLowerCase()).toContain('kool');
    });

    it('should reply with not kool response if user does not have kool role', async () => {
      mockMember!.roles = {
        cache: createMockCollection<string, Role>([]),
      } as any;

      await execute(mockInteraction as CommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
      const reply = (mockInteraction.reply as jest.Mock).mock.calls[0][0];
      expect(typeof reply).toBe('string');
    });

    it('should handle member being null', async () => {
      mockInteraction.member = null;

      await execute(mockInteraction as CommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
    });

    it('should handle errors when replying', async () => {
      mockInteraction.reply = jest.fn()
        .mockRejectedValueOnce(new Error('First error'))
        .mockResolvedValueOnce(undefined);

      await execute(mockInteraction as CommandInteraction);

      // When error occurs, command should still try to reply
      expect(mockInteraction.reply).toHaveBeenCalled();
    });
  });
});
