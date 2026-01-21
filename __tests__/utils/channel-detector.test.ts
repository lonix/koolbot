import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ChannelDetector } from '../../src/utils/channel-detector.js';
import type { Guild, Collection, CategoryChannel, VoiceChannel, TextChannel, GuildBasedChannel } from 'discord.js';
import { ChannelType } from 'discord.js';

describe('ChannelDetector', () => {
  let mockGuild: Partial<Guild>;
  let mockChannels: Map<string, Partial<GuildBasedChannel>>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChannels = new Map();

    mockGuild = {
      fetch: jest.fn().mockResolvedValue(undefined),
      channels: {
        fetch: jest.fn().mockResolvedValue(mockChannels as Collection<string, GuildBasedChannel>),
      } as any,
    };
  });

  describe('detectChannels', () => {
    it('should detect voice categories', async () => {
      mockChannels.set('cat1', {
        id: 'cat1',
        name: 'Voice Channels',
        type: ChannelType.GuildCategory,
      } as CategoryChannel);

      mockChannels.set('cat2', {
        id: 'cat2',
        name: 'VC Lobby',
        type: ChannelType.GuildCategory,
      } as CategoryChannel);

      const result = await ChannelDetector.detectChannels(mockGuild as Guild);

      expect(result.voiceCategories).toHaveLength(2);
      expect(result.lobbyChannels).toHaveLength(0);
      expect(result.textChannels).toHaveLength(0);
    });

    it('should detect lobby voice channels', async () => {
      mockChannels.set('vc1', {
        id: 'vc1',
        name: 'Lobby',
        type: ChannelType.GuildVoice,
      } as VoiceChannel);

      mockChannels.set('vc2', {
        id: 'vc2',
        name: 'Waiting Lounge',
        type: ChannelType.GuildVoice,
      } as VoiceChannel);

      const result = await ChannelDetector.detectChannels(mockGuild as Guild);

      expect(result.lobbyChannels).toHaveLength(2);
      expect(result.voiceCategories).toHaveLength(0);
      expect(result.textChannels).toHaveLength(0);
    });

    it('should detect text channels', async () => {
      mockChannels.set('txt1', {
        id: 'txt1',
        name: 'general',
        type: ChannelType.GuildText,
      } as TextChannel);

      mockChannels.set('txt2', {
        id: 'txt2',
        name: 'announcements',
        type: ChannelType.GuildText,
      } as TextChannel);

      const result = await ChannelDetector.detectChannels(mockGuild as Guild);

      expect(result.textChannels).toHaveLength(2);
      expect(result.voiceCategories).toHaveLength(0);
      expect(result.lobbyChannels).toHaveLength(0);
    });

    it('should detect all channel types together', async () => {
      mockChannels.set('cat1', {
        id: 'cat1',
        name: 'Voice Chat',
        type: ChannelType.GuildCategory,
      } as CategoryChannel);

      mockChannels.set('vc1', {
        id: 'vc1',
        name: 'Join Lobby',
        type: ChannelType.GuildVoice,
      } as VoiceChannel);

      mockChannels.set('txt1', {
        id: 'txt1',
        name: 'general',
        type: ChannelType.GuildText,
      } as TextChannel);

      const result = await ChannelDetector.detectChannels(mockGuild as Guild);

      expect(result.voiceCategories).toHaveLength(1);
      expect(result.lobbyChannels).toHaveLength(1);
      expect(result.textChannels).toHaveLength(1);
    });

    it('should ignore null channels', async () => {
      mockChannels.set('null1', null as any);
      mockChannels.set('txt1', {
        id: 'txt1',
        name: 'general',
        type: ChannelType.GuildText,
      } as TextChannel);

      const result = await ChannelDetector.detectChannels(mockGuild as Guild);

      expect(result.textChannels).toHaveLength(1);
    });

    it('should detect categories with "talk" in name', async () => {
      mockChannels.set('cat1', {
        id: 'cat1',
        name: 'Talk Channels',
        type: ChannelType.GuildCategory,
      } as CategoryChannel);

      const result = await ChannelDetector.detectChannels(mockGuild as Guild);

      expect(result.voiceCategories).toHaveLength(1);
    });

    it('should detect categories with "chat" in name', async () => {
      mockChannels.set('cat1', {
        id: 'cat1',
        name: 'Chat Rooms',
        type: ChannelType.GuildCategory,
      } as CategoryChannel);

      const result = await ChannelDetector.detectChannels(mockGuild as Guild);

      expect(result.voiceCategories).toHaveLength(1);
    });

    it('should handle errors gracefully', async () => {
      mockGuild.channels!.fetch = jest.fn().mockRejectedValue(new Error('Test error'));

      await expect(ChannelDetector.detectChannels(mockGuild as Guild)).rejects.toThrow('Test error');
    });

    it('should be case-insensitive when detecting channels', async () => {
      mockChannels.set('cat1', {
        id: 'cat1',
        name: 'VOICE CHANNELS',
        type: ChannelType.GuildCategory,
      } as CategoryChannel);

      mockChannels.set('vc1', {
        id: 'vc1',
        name: 'LOBBY',
        type: ChannelType.GuildVoice,
      } as VoiceChannel);

      const result = await ChannelDetector.detectChannels(mockGuild as Guild);

      expect(result.voiceCategories).toHaveLength(1);
      expect(result.lobbyChannels).toHaveLength(1);
    });
  });

  describe('findCategoryByName', () => {
    it('should find category by exact name', async () => {
      const mockCategory = {
        id: 'cat1',
        name: 'Voice Channels',
        type: ChannelType.GuildCategory,
      } as CategoryChannel;

      mockChannels.set('cat1', mockCategory);

      const result = await ChannelDetector.findCategoryByName(mockGuild as Guild, 'Voice Channels');

      expect(result).toBeDefined();
      expect(result).toBe(mockCategory);
    });

    it('should be case-insensitive', async () => {
      const mockCategory = {
        id: 'cat1',
        name: 'Voice Channels',
        type: ChannelType.GuildCategory,
      } as CategoryChannel;

      mockChannels.set('cat1', mockCategory);

      const result = await ChannelDetector.findCategoryByName(mockGuild as Guild, 'voice channels');

      expect(result).toBeDefined();
      expect(result).toBe(mockCategory);
    });

    it('should return null if category not found', async () => {
      const result = await ChannelDetector.findCategoryByName(mockGuild as Guild, 'NonExistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockGuild.channels!.fetch = jest.fn().mockRejectedValue(new Error('Test error'));

      const result = await ChannelDetector.findCategoryByName(mockGuild as Guild, 'Test');

      expect(result).toBeNull();
    });

    it('should ignore non-category channels', async () => {
      mockChannels.set('txt1', {
        id: 'txt1',
        name: 'Voice Channels',
        type: ChannelType.GuildText,
      } as TextChannel);

      const result = await ChannelDetector.findCategoryByName(mockGuild as Guild, 'Voice Channels');

      expect(result).toBeNull();
    });
  });

  describe('findVoiceChannelByName', () => {
    it('should find voice channel by exact name', async () => {
      const mockVoice = {
        id: 'vc1',
        name: 'Lobby',
        type: ChannelType.GuildVoice,
      } as VoiceChannel;

      mockChannels.set('vc1', mockVoice);

      const result = await ChannelDetector.findVoiceChannelByName(mockGuild as Guild, 'Lobby');

      expect(result).toBeDefined();
      expect(result).toBe(mockVoice);
    });

    it('should be case-insensitive', async () => {
      const mockVoice = {
        id: 'vc1',
        name: 'Lobby',
        type: ChannelType.GuildVoice,
      } as VoiceChannel;

      mockChannels.set('vc1', mockVoice);

      const result = await ChannelDetector.findVoiceChannelByName(mockGuild as Guild, 'lobby');

      expect(result).toBeDefined();
      expect(result).toBe(mockVoice);
    });

    it('should return null if voice channel not found', async () => {
      const result = await ChannelDetector.findVoiceChannelByName(mockGuild as Guild, 'NonExistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockGuild.channels!.fetch = jest.fn().mockRejectedValue(new Error('Test error'));

      const result = await ChannelDetector.findVoiceChannelByName(mockGuild as Guild, 'Test');

      expect(result).toBeNull();
    });
  });

  describe('findTextChannelByName', () => {
    it('should find text channel by exact name', async () => {
      const mockText = {
        id: 'txt1',
        name: 'general',
        type: ChannelType.GuildText,
      } as TextChannel;

      mockChannels.set('txt1', mockText);

      const result = await ChannelDetector.findTextChannelByName(mockGuild as Guild, 'general');

      expect(result).toBeDefined();
      expect(result).toBe(mockText);
    });

    it('should be case-insensitive', async () => {
      const mockText = {
        id: 'txt1',
        name: 'General',
        type: ChannelType.GuildText,
      } as TextChannel;

      mockChannels.set('txt1', mockText);

      const result = await ChannelDetector.findTextChannelByName(mockGuild as Guild, 'GENERAL');

      expect(result).toBeDefined();
      expect(result).toBe(mockText);
    });

    it('should return null if text channel not found', async () => {
      const result = await ChannelDetector.findTextChannelByName(mockGuild as Guild, 'NonExistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockGuild.channels!.fetch = jest.fn().mockRejectedValue(new Error('Test error'));

      const result = await ChannelDetector.findTextChannelByName(mockGuild as Guild, 'Test');

      expect(result).toBeNull();
    });
  });

  describe('resourceExists', () => {
    beforeEach(() => {
      mockChannels.set('cat1', {
        id: 'cat1',
        name: 'Voice',
        type: ChannelType.GuildCategory,
      } as CategoryChannel);

      mockChannels.set('vc1', {
        id: 'vc1',
        name: 'Lobby',
        type: ChannelType.GuildVoice,
      } as VoiceChannel);

      mockChannels.set('txt1', {
        id: 'txt1',
        name: 'general',
        type: ChannelType.GuildText,
      } as TextChannel);
    });

    it('should return true for existing category', async () => {
      const result = await ChannelDetector.resourceExists(mockGuild as Guild, 'category', 'Voice');

      expect(result).toBe(true);
    });

    it('should return true for existing voice channel', async () => {
      const result = await ChannelDetector.resourceExists(mockGuild as Guild, 'voice', 'Lobby');

      expect(result).toBe(true);
    });

    it('should return true for existing text channel', async () => {
      const result = await ChannelDetector.resourceExists(mockGuild as Guild, 'text', 'general');

      expect(result).toBe(true);
    });

    it('should return false for non-existing category', async () => {
      const result = await ChannelDetector.resourceExists(mockGuild as Guild, 'category', 'NonExistent');

      expect(result).toBe(false);
    });

    it('should return false for non-existing voice channel', async () => {
      const result = await ChannelDetector.resourceExists(mockGuild as Guild, 'voice', 'NonExistent');

      expect(result).toBe(false);
    });

    it('should return false for non-existing text channel', async () => {
      const result = await ChannelDetector.resourceExists(mockGuild as Guild, 'text', 'NonExistent');

      expect(result).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      mockGuild.channels!.fetch = jest.fn().mockRejectedValue(new Error('Test error'));

      const result = await ChannelDetector.resourceExists(mockGuild as Guild, 'text', 'general');

      expect(result).toBe(false);
    });

    it('should return false for invalid type', async () => {
      const result = await ChannelDetector.resourceExists(mockGuild as Guild, 'invalid' as any, 'Test');

      expect(result).toBe(false);
    });
  });
});
