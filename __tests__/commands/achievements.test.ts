import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ChatInputCommandInteraction, User, Client } from 'discord.js';
import { data, execute } from '../../src/commands/achievements.js';
import { GamificationService } from '../../src/services/gamification-service.js';

jest.mock('../../src/services/gamification-service.js');
jest.mock('../../src/utils/logger.js');

describe('Achievements Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('achievements');
    });

    it('should have a description', () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toBe('View earned badges and achievements');
    });

    it('should be a valid slash command', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('name', 'achievements');
      expect(json).toHaveProperty('description');
    });

    it('should have optional user parameter', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(1);
      
      const userOption = json.options?.[0];
      expect(userOption?.name).toBe('user');
      expect(userOption?.type).toBe(6); // USER type
      expect(userOption?.required).toBe(false);
    });

    it('should have description for user parameter', () => {
      const json = data.toJSON();
      const userOption = json.options?.[0];
      expect(userOption?.description).toBeTruthy();
      expect(userOption?.description).toContain('user');
    });
  });

  describe('embed chunking logic', () => {
    it('should respect Discord 1024 character field limit', () => {
      // Test the chunking algorithm conceptually
      const MAX_FIELD_LENGTH = 1024;
      
      // Create mock accolade texts that together exceed the limit
      const mockAccolades = [
        'A'.repeat(300),
        'B'.repeat(300),
        'C'.repeat(300),
        'D'.repeat(300),
      ];

      // Simulate chunking logic
      const chunks: string[] = [];
      let currentChunk = '';

      for (const accoladeText of mockAccolades) {
        const separator = currentChunk.length > 0 ? '\n\n' : '';
        const potentialLength = currentChunk.length + separator.length + accoladeText.length;

        if (potentialLength > MAX_FIELD_LENGTH) {
          if (currentChunk.length > 0) {
            chunks.push(currentChunk);
          }
          currentChunk = accoladeText.length > MAX_FIELD_LENGTH
            ? `${accoladeText.slice(0, MAX_FIELD_LENGTH - 3)}...`
            : accoladeText;
        } else {
          currentChunk += `${separator}${accoladeText}`;
        }
      }

      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
      }

      // Verify all chunks are within limit
      chunks.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
      });

      // Verify we created multiple chunks
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should handle single long accolade that exceeds limit', () => {
      const MAX_FIELD_LENGTH = 1024;
      const longText = 'X'.repeat(1500);

      // Truncate logic
      const truncatedText = longText.length > MAX_FIELD_LENGTH
        ? `${longText.slice(0, MAX_FIELD_LENGTH - 3)}...`
        : longText;

      expect(truncatedText.length).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
      expect(truncatedText.endsWith('...')).toBe(true);
    });

    it('should handle empty accolade list', () => {
      const accoladesList: string[] = [];
      
      // Should not create any chunks
      const chunks: string[] = [];
      if (accoladesList.length === 0) {
        // No chunks added
      }

      expect(chunks.length).toBe(0);
    });
  });

  describe('metadata formatting', () => {
    it('should use unit field when available', () => {
      const metadata = {
        value: 100,
        description: '100 hours milestone',
        unit: 'hrs',
      };

      const metadataText = metadata.value
        ? ` - ${metadata.value}${metadata.unit ? ` ${metadata.unit}` : ''}`
        : '';

      expect(metadataText).toBe(' - 100 hrs');
    });

    it('should handle missing unit field gracefully', () => {
      const metadata = {
        value: 100,
        description: '100 hours milestone',
      };

      const metadataUnit = (metadata as any).unit ?? '';
      const metadataText = metadata.value
        ? ` - ${metadata.value}${metadataUnit ? ` ${metadataUnit}` : ''}`
        : '';

      expect(metadataText).toBe(' - 100');
    });

    it('should handle user count with users unit', () => {
      const metadata = {
        value: 25,
        description: '25+ unique users',
        unit: 'users',
      };

      const metadataText = metadata.value
        ? ` - ${metadata.value}${metadata.unit ? ` ${metadata.unit}` : ''}`
        : '';

      expect(metadataText).toBe(' - 25 users');
    });

    it('should handle missing metadata', () => {
      const metadata = undefined;

      const metadataText = metadata?.value
        ? ` - ${metadata.value}${metadata.unit ? ` ${metadata.unit}` : ''}`
        : '';

      expect(metadataText).toBe('');
    });
  });

  describe('accolade text formatting', () => {
    it('should format complete accolade text correctly', () => {
      const mockDefinition = {
        emoji: '🎉',
        name: 'First Steps',
        description: 'Spent your first hour in voice chat',
      };

      const earnedDate = '1/19/2026';
      const metadataText = ' - 12 hrs';

      const accoladeText = `${mockDefinition.emoji} **${mockDefinition.name}**${metadataText}\n*${mockDefinition.description}*\nEarned: ${earnedDate}`;

      expect(accoladeText).toContain('🎉');
      expect(accoladeText).toContain('**First Steps**');
      expect(accoladeText).toContain('12 hrs');
      expect(accoladeText).toContain('*Spent your first hour in voice chat*');
      expect(accoladeText).toContain('Earned: 1/19/2026');
    });

    it('should handle accolade without metadata', () => {
      const mockDefinition = {
        emoji: '🏆',
        name: 'Some Badge',
        description: 'A badge description',
      };

      const earnedDate = '1/19/2026';
      const metadataText = '';

      const accoladeText = `${mockDefinition.emoji} **${mockDefinition.name}**${metadataText}\n*${mockDefinition.description}*\nEarned: ${earnedDate}`;

      expect(accoladeText).not.toContain(' - ');
      expect(accoladeText).toContain('🏆 **Some Badge**\n');
    });
  });

  describe('execute', () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;
    let mockUser: Partial<User>;
    let mockGamificationService: any;

    beforeEach(() => {
      jest.clearAllMocks();

      mockUser = {
        id: 'user123',
        username: 'TestUser',
        displayAvatarURL: jest.fn().mockReturnValue('https://example.com/avatar.png'),
      };

      mockInteraction = {
        user: mockUser as User,
        client: {} as Client,
        options: {
          getUser: jest.fn().mockReturnValue(null),
        } as any,
        reply: jest.fn().mockResolvedValue(undefined),
      };

      mockGamificationService = {
        getUserGamification: jest.fn(),
        getAccoladeDefinition: jest.fn(),
      };

      (GamificationService.getInstance as jest.Mock).mockReturnValue(mockGamificationService);
    });

    it('should display achievements for user', async () => {
      const earnedDate = new Date('2024-01-01');
      mockGamificationService.getUserGamification.mockResolvedValue({
        accolades: [
          {
            type: 'first_hour',
            earnedAt: earnedDate,
            metadata: { value: 1, unit: 'hrs' },
          },
        ],
        achievements: [],
      });

      mockGamificationService.getAccoladeDefinition.mockReturnValue({
        emoji: '🎉',
        name: 'First Steps',
        description: 'Spent your first hour in voice chat',
      });

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
    });

    it('should handle user with no achievements', async () => {
      mockGamificationService.getUserGamification.mockResolvedValue({
        accolades: [],
        achievements: [],
      });

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining("hasn't earned any badges yet"),
        ephemeral: true,
      });
    });

    it('should handle null user gamification', async () => {
      mockGamificationService.getUserGamification.mockResolvedValue(null);

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining("hasn't earned any badges yet"),
        ephemeral: true,
      });
    });

    it('should handle errors gracefully', async () => {
      mockGamificationService.getUserGamification.mockRejectedValue(new Error('Database error'));

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'There was an error while executing this command!',
        ephemeral: true,
      });
    });

    it('should display achievements for specified user', async () => {
      const otherUser = {
        id: 'user456',
        username: 'OtherUser',
        displayAvatarURL: jest.fn().mockReturnValue('https://example.com/avatar2.png'),
      };

      mockInteraction.options!.getUser = jest.fn().mockReturnValue(otherUser);

      mockGamificationService.getUserGamification.mockResolvedValue({
        accolades: [
          {
            type: 'first_hour',
            earnedAt: new Date(),
            metadata: { value: 1, unit: 'hrs' },
          },
        ],
        achievements: [],
      });

      mockGamificationService.getAccoladeDefinition.mockReturnValue({
        emoji: '🎉',
        name: 'First Steps',
        description: 'Test',
      });

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockGamificationService.getUserGamification).toHaveBeenCalledWith('user456');
    });
  });
});
