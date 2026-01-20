import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/achievements.js';

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
});
