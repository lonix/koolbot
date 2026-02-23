import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ChannelType, type Client, type VoiceChannel, type Guild, type GuildChannel } from 'discord.js';

// Mock dependencies before importing
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/voice-channel-tracker.js');
jest.mock('../../src/services/config-service.js');

// Import after mocks
import { VoiceChannelManager } from '../../src/services/voice-channel-manager.js';
import { ConfigService } from '../../src/services/config-service.js';

const mockConfigService = ConfigService as jest.Mocked<typeof ConfigService>;

describe('VoiceChannelManager - Live & Waiting Room', () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let mockChannel: Partial<VoiceChannel>;
  let mockGuild: Partial<Guild>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset the singleton instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (VoiceChannelManager as any).instance = undefined;

    (mockConfigService.getInstance as unknown as jest.Mock) = jest.fn(() => ({
      getBoolean: jest.fn().mockResolvedValue(false),
      getString: jest.fn().mockResolvedValue(''),
      getNumber: jest.fn().mockResolvedValue(0),
    }));

    mockGuild = {
      id: 'guild-id',
      roles: {
        everyone: { id: 'everyone-role-id' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      channels: {
        create: jest.fn().mockResolvedValue({
          id: 'waiting-room-id',
          name: '⏳ Test Channel Waiting',
          type: ChannelType.GuildVoice,
          delete: jest.fn().mockResolvedValue(undefined),
          members: { size: 0, values: jest.fn().mockReturnValue([]) },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    mockChannel = {
      id: 'channel-id',
      name: '🎮 Test Channel',
      type: ChannelType.GuildVoice,
      parent: null,
      setName: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      permissionOverwrites: {
        cache: new Map(),
        create: jest.fn().mockResolvedValue(undefined),
      },
      guild: mockGuild as Guild,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    mockClient = {
      user: { id: 'bot-user-id' } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      channels: {
        cache: new Map<string, GuildChannel>(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    manager = VoiceChannelManager.getInstance(mockClient as Client);
  });

  // ── Live indicator ─────────────────────────────────────────────────────────

  describe('isLive / setLiveStatus', () => {
    it('should return false for an untracked channel', () => {
      expect(manager.isLive('channel-id')).toBe(false);
    });

    it('should return true after setLiveStatus(true)', () => {
      manager.setLiveStatus('channel-id', true);
      expect(manager.isLive('channel-id')).toBe(true);
    });

    it('should return false after setLiveStatus(false)', () => {
      manager.setLiveStatus('channel-id', true);
      manager.setLiveStatus('channel-id', false);
      expect(manager.isLive('channel-id')).toBe(false);
    });
  });

  describe('toggleLive', () => {
    it('should toggle from offline to live and apply suffix to channel name', async () => {
      const result = await manager.toggleLive(mockChannel as VoiceChannel);

      expect(result).toBe(true);
      expect(manager.isLive('channel-id')).toBe(true);
      // Suffix is appended, preserving the managed prefix
      expect(mockChannel.setName).toHaveBeenCalledWith('🎮 Test Channel 🔴');
    });

    it('should toggle from live to offline and remove suffix', async () => {
      // Pre-mark as live and give it the suffix name
      manager.setLiveStatus('channel-id', true);
      (mockChannel as any).name = '🎮 Test Channel 🔴'; // eslint-disable-line @typescript-eslint/no-explicit-any

      const result = await manager.toggleLive(mockChannel as VoiceChannel);

      expect(result).toBe(false);
      expect(manager.isLive('channel-id')).toBe(false);
      expect(mockChannel.setName).toHaveBeenCalledWith('🎮 Test Channel');
    });

    it('should NOT prepend 🔴 to channel name (suffix-only to preserve managed prefix)', async () => {
      await manager.toggleLive(mockChannel as VoiceChannel);

      const calls = (mockChannel.setName as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      // New name must NOT start with 🔴
      const newName = calls[0][0] as string;
      expect(newName.startsWith('🔴')).toBe(false);
      // New name must END with 🔴
      expect(newName.endsWith('🔴')).toBe(true);
    });

    it('should post a live announcement message when going live', async () => {
      await manager.toggleLive(mockChannel as VoiceChannel);
      expect(mockChannel.send).toHaveBeenCalledWith(
        expect.stringContaining('LIVE'),
      );
    });

    it('should post an offline announcement message when going offline', async () => {
      manager.setLiveStatus('channel-id', true);
      (mockChannel as any).name = '🎮 Test Channel 🔴'; // eslint-disable-line @typescript-eslint/no-explicit-any

      await manager.toggleLive(mockChannel as VoiceChannel);
      expect(mockChannel.send).toHaveBeenCalledWith(
        expect.stringContaining('no longer live'),
      );
    });
  });

  // ── Waiting room ───────────────────────────────────────────────────────────

  describe('getWaitingRoom / getMainChannelForWaitingRoom', () => {
    it('should return undefined for untracked channels', () => {
      expect(manager.getWaitingRoom('channel-id')).toBeUndefined();
      expect(manager.getMainChannelForWaitingRoom('waiting-room-id')).toBeUndefined();
    });
  });

  describe('createWaitingRoom', () => {
    it('should create a waiting room and track it', async () => {
      const waitingRoom = await manager.createWaitingRoom(
        mockChannel as VoiceChannel,
        'owner-id',
      );

      expect(waitingRoom).not.toBeNull();
      expect(manager.getWaitingRoom('channel-id')).toBe('waiting-room-id');
      expect(manager.getMainChannelForWaitingRoom('waiting-room-id')).toBe('channel-id');
    });

    it('should return null if a waiting room already exists', async () => {
      await manager.createWaitingRoom(mockChannel as VoiceChannel, 'owner-id');

      const second = await manager.createWaitingRoom(
        mockChannel as VoiceChannel,
        'owner-id',
      );
      expect(second).toBeNull();
    });
  });

  describe('removeWaitingRoom', () => {
    it('should remove tracking after deletion', async () => {
      // Create first
      await manager.createWaitingRoom(mockChannel as VoiceChannel, 'owner-id');
      expect(manager.getWaitingRoom('channel-id')).toBeDefined();

      // Point the channel cache to the waiting room so delete is called
      const waitingRoomId = manager.getWaitingRoom('channel-id')!;
      const mockWaitingRoom = {
        id: waitingRoomId,
        type: ChannelType.GuildVoice,
        members: { size: 0, values: jest.fn().mockReturnValue([]) },
        delete: jest.fn().mockResolvedValue(undefined),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient.channels!.cache as any).set(waitingRoomId, mockWaitingRoom);

      await manager.removeWaitingRoom('channel-id');

      expect(manager.getWaitingRoom('channel-id')).toBeUndefined();
      expect(manager.getMainChannelForWaitingRoom(waitingRoomId)).toBeUndefined();
    });

    it('should be a no-op when no waiting room exists', async () => {
      // Should not throw
      await expect(manager.removeWaitingRoom('nonexistent-id')).resolves.toBeUndefined();
    });
  });
});
