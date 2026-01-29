import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { Client, VoiceChannel, GuildMember, Collection } from 'discord.js';

// Mock dependencies before importing
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/voice-channel-tracker.js');
jest.mock('../../src/services/config-service.js');

// Import after mocks
import { VoiceChannelManager } from '../../src/services/voice-channel-manager.js';

describe('VoiceChannelManager - Transfer Ownership', () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let mockChannel: Partial<VoiceChannel>;
  let mockOldOwner: Partial<GuildMember>;
  let mockNewOwner: Partial<GuildMember>;
  let mockPermissionOverwrites: {
    create: jest.Mock;
  };
  let mockMembers: Partial<Collection<string, GuildMember>>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset the singleton instance by setting it to undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (VoiceChannelManager as any).instance = undefined;

    // Mock permission overwrites
    mockPermissionOverwrites = {
      create: jest.fn().mockResolvedValue(undefined),
    };

    // Mock members collection
    mockMembers = {
      get: jest.fn((id: string) => {
        if (id === 'new-owner-id') {
          return mockNewOwner as GuildMember;
        }
        return undefined;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock owners
    mockOldOwner = {
      id: 'old-owner-id',
      displayName: 'OldOwner',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    mockNewOwner = {
      id: 'new-owner-id',
      displayName: 'NewOwner',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock channel
    mockChannel = {
      id: 'channel-id',
      name: 'Custom Channel Name',
      permissionOverwrites: mockPermissionOverwrites,
      members: mockMembers as Collection<string, GuildMember>,
      setName: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock client
    mockClient = {
      channels: {
        cache: {
          get: jest.fn().mockReturnValue(mockChannel),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Create manager instance
    manager = VoiceChannelManager.getInstance(mockClient as Client);
  });

  afterEach(() => {
    // Clean up singleton instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (VoiceChannelManager as any).instance = undefined;
  });

  describe('transferOwnership', () => {
    it('should grant ManageChannels permission to new owner', async () => {
      await manager.transferOwnership('channel-id', 'old-owner-id', 'new-owner-id');

      expect(mockPermissionOverwrites.create).toHaveBeenCalledWith('new-owner-id', {
        ManageChannels: true,
        Connect: true,
        Speak: true,
        ViewChannel: true,
      });
    });

    it('should remove ManageChannels permission from old owner', async () => {
      await manager.transferOwnership('channel-id', 'old-owner-id', 'new-owner-id');

      expect(mockPermissionOverwrites.create).toHaveBeenCalledWith('old-owner-id', {
        ManageChannels: false,
        Connect: true,
        Speak: true,
        ViewChannel: true,
      });
    });

    it('should not rename channel when it has a custom name', async () => {
      // Mark channel as having a custom name
      manager.setCustomChannelName('channel-id', 'Custom Channel Name');

      await manager.transferOwnership('channel-id', 'old-owner-id', 'new-owner-id');

      expect(mockChannel.setName).not.toHaveBeenCalled();
    });

    it('should rename channel when it does not have a custom name', async () => {
      // Do not mark channel as having a custom name
      await manager.transferOwnership('channel-id', 'old-owner-id', 'new-owner-id');

      expect(mockChannel.setName).toHaveBeenCalledWith("NewOwner's Channel");
    });

    it('should send notification to channel', async () => {
      await manager.transferOwnership('channel-id', 'old-owner-id', 'new-owner-id');

      expect(mockChannel.send).toHaveBeenCalledWith(
        'Channel ownership has been transferred to NewOwner'
      );
    });

    it('should throw error when channel is not found', async () => {
      mockClient.channels = {
        cache: {
          get: jest.fn().mockReturnValue(undefined),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      await expect(
        manager.transferOwnership('channel-id', 'old-owner-id', 'new-owner-id')
      ).rejects.toThrow('Channel not found');
    });

    it('should throw error when new owner is not in channel', async () => {
      mockMembers.get = jest.fn().mockReturnValue(undefined);

      await expect(
        manager.transferOwnership('channel-id', 'old-owner-id', 'new-owner-id')
      ).rejects.toThrow('New owner is not in the channel');
    });
  });

  describe('Custom name tracking', () => {
    it('should mark channel as having custom name', () => {
      manager.setCustomChannelName('channel-id', 'Custom Name');

      expect(manager.hasCustomName('channel-id')).toBe(true);
      expect(manager.getCustomChannelName('channel-id')).toBe('Custom Name');
    });

    it('should return false for channel without custom name', () => {
      expect(manager.hasCustomName('non-existent-id')).toBe(false);
      expect(manager.getCustomChannelName('non-existent-id')).toBeUndefined();
    });
  });
});
