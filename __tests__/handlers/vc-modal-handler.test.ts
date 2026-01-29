import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ModalSubmitInteraction, Guild, VoiceChannel, Client } from 'discord.js';
import { ChannelType } from 'discord.js';

// Mock dependencies before importing
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/voice-channel-manager.js');

// Import after mocks
import { VoiceChannelManager } from '../../src/services/voice-channel-manager.js';
import { handleVCModal } from '../../src/handlers/vc-modal-handler.js';

const mockVoiceChannelManager = VoiceChannelManager as jest.Mocked<typeof VoiceChannelManager>;

describe('VCModalHandler - Custom Name Tracking', () => {
  let mockInteraction: Partial<ModalSubmitInteraction>;
  let mockGuild: Partial<Guild>;
  let mockChannel: Partial<VoiceChannel>;
  let mockSetCustomChannelName: jest.Mock;
  let mockGetInstance: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSetCustomChannelName = jest.fn();

    mockGetInstance = jest.fn(() => ({
      setCustomChannelName: mockSetCustomChannelName,
    }));

    (mockVoiceChannelManager.getInstance as unknown as jest.Mock) = mockGetInstance;

    mockChannel = {
      id: 'test-channel-id',
      name: 'Old Channel Name',
      type: ChannelType.GuildVoice,
      setName: jest.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    mockGuild = {
      id: 'test-guild-id',
      name: 'Test Guild',
      channels: {
        fetch: jest.fn().mockResolvedValue(mockChannel),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    mockInteraction = {
      customId: 'vc_modal_name_test-channel-id_test-user-id',
      user: {
        id: 'test-user-id',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      fields: {
        getTextInputValue: jest.fn().mockReturnValue('New Custom Name'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      reply: jest.fn().mockResolvedValue(undefined),
      guild: mockGuild as Guild,
      client: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });

  describe('Custom name tracking on rename', () => {
    it('should mark channel as having custom name after successful rename', async () => {
      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockChannel.setName).toHaveBeenCalledWith('New Custom Name');
      expect(mockSetCustomChannelName).toHaveBeenCalledWith(
        'test-channel-id',
        'New Custom Name'
      );
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '✅ Channel renamed to: **New Custom Name**',
        ephemeral: true,
      });
    });

    it('should not mark channel as custom if rename fails', async () => {
      mockChannel.setName = jest.fn().mockRejectedValue(new Error('Rename failed'));

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockSetCustomChannelName).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '❌ Failed to rename channel. Please try again.',
        ephemeral: true,
      });
    });

    it('should reject names longer than 100 characters', async () => {
      const longName = 'a'.repeat(101);
      mockInteraction.fields = {
        getTextInputValue: jest.fn().mockReturnValue(longName),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockChannel.setName).not.toHaveBeenCalled();
      expect(mockSetCustomChannelName).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '❌ Channel name must be 100 characters or less.',
        ephemeral: true,
      });
    });

    it('should reject empty names', async () => {
      mockInteraction.fields = {
        getTextInputValue: jest.fn().mockReturnValue(''),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockChannel.setName).not.toHaveBeenCalled();
      expect(mockSetCustomChannelName).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '❌ Channel name cannot be empty.',
        ephemeral: true,
      });
    });
  });
});
