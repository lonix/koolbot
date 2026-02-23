import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ChannelType, type ButtonInteraction, type Guild, type VoiceChannel, type Client } from 'discord.js';

// Mock dependencies before importing
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/voice-channel-manager.js');

// Import after mocks
import { VoiceChannelManager } from '../../src/services/voice-channel-manager.js';
import { handleVCControlButton } from '../../src/handlers/vc-control-button-handler.js';

const mockVoiceChannelManager = VoiceChannelManager as jest.Mocked<typeof VoiceChannelManager>;

describe('VCControlButtonHandler', () => {
  let mockInteraction: Partial<ButtonInteraction>;
  let mockGuild: Partial<Guild>;
  let mockChannel: Partial<VoiceChannel>;
  let mockManagerInstance: {
    isLive: jest.Mock;
    setLiveStatus: jest.Mock;
    getWaitingRoom: jest.Mock;
    createWaitingRoom: jest.Mock;
    removeWaitingRoom: jest.Mock;
    rebuildControlPanel: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockManagerInstance = {
      isLive: jest.fn().mockReturnValue(false),
      setLiveStatus: jest.fn(),
      getWaitingRoom: jest.fn().mockReturnValue(undefined),
      createWaitingRoom: jest.fn().mockResolvedValue({ name: '⏳ Test Waiting' }),
      removeWaitingRoom: jest.fn().mockResolvedValue(undefined),
      rebuildControlPanel: jest.fn().mockResolvedValue(undefined),
    };

    (mockVoiceChannelManager.getInstance as unknown as jest.Mock) = jest.fn(
      () => mockManagerInstance,
    );

    mockChannel = {
      id: 'channel-id',
      name: 'Test Channel',
      type: ChannelType.GuildVoice,
      setName: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      permissionOverwrites: {
        cache: { get: jest.fn().mockReturnValue(undefined) },
        delete: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockResolvedValue(undefined),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      guild: {
        roles: { everyone: { id: 'everyone-role-id' } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      parent: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    mockGuild = {
      id: 'guild-id',
      channels: {
        fetch: jest.fn().mockResolvedValue(mockChannel),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      members: {
        fetch: jest.fn().mockResolvedValue({
          displayName: 'WaitingUser',
          id: 'waiting-user-id',
          voice: { channelId: 'waiting-room-id', setChannel: jest.fn().mockResolvedValue(undefined) },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    mockInteraction = {
      customId: 'vc_control_live_channel-id_owner-id',
      user: {
        id: 'owner-id',
        displayName: 'OwnerUser',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      reply: jest.fn().mockResolvedValue(undefined),
      guild: mockGuild as Guild,
      message: {
        edit: jest.fn().mockResolvedValue(undefined),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      client: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });

  describe('Owner check', () => {
    it('should reject non-owner interaction', async () => {
      mockInteraction.user = { id: 'other-user-id', displayName: 'Other' } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Only the channel owner') }),
      );
    });
  });

  describe('Live toggle', () => {
    it('should mark channel as live when not currently live', async () => {
      mockManagerInstance.isLive.mockReturnValue(false);
      mockInteraction.customId = 'vc_control_live_channel-id_owner-id';

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockManagerInstance.setLiveStatus).toHaveBeenCalledWith('channel-id', true);
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('LIVE') }),
      );
    });

    it('should mark channel as offline when currently live', async () => {
      mockManagerInstance.isLive.mockReturnValue(true);
      mockInteraction.customId = 'vc_control_live_channel-id_owner-id';

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockManagerInstance.setLiveStatus).toHaveBeenCalledWith('channel-id', false);
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('offline') }),
      );
    });
  });

  describe('Waiting room toggle', () => {
    it('should create waiting room when none exists', async () => {
      mockManagerInstance.getWaitingRoom.mockReturnValue(undefined);
      mockInteraction.customId = 'vc_control_waitingroom_channel-id_owner-id';

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockManagerInstance.createWaitingRoom).toHaveBeenCalledWith(
        mockChannel,
        'owner-id',
      );
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Waiting room') }),
      );
    });

    it('should remove waiting room when one exists', async () => {
      mockManagerInstance.getWaitingRoom.mockReturnValue('existing-waiting-room-id');
      mockInteraction.customId = 'vc_control_waitingroom_channel-id_owner-id';

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockManagerInstance.removeWaitingRoom).toHaveBeenCalledWith('channel-id');
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('removed') }),
      );
    });
  });

  describe('Let In action', () => {
    it('should reject non-owner let-in attempt', async () => {
      mockInteraction.customId = 'vc_control_letin_channel-id_waiting-user-id_owner-id';
      mockInteraction.user = { id: 'someone-else', displayName: 'Other' } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Only the channel owner') }),
      );
    });

    it('should handle let-in action as owner', async () => {
      mockManagerInstance.getWaitingRoom.mockReturnValue('waiting-room-id');
      mockInteraction.customId = 'vc_control_letin_channel-id_waiting-user-id_owner-id';
      mockInteraction.user = { id: 'owner-id', displayName: 'Owner' } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      // Should try to fetch the main channel and move the user
      expect(mockGuild!.channels!.fetch).toHaveBeenCalledWith('channel-id');
    });
  });
});
