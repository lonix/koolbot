import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ChannelType, PermissionFlagsBits, type Client, type VoiceChannel, type GuildMember, type Collection, type Message, type Guild, type Role } from 'discord.js';

// Mock dependencies before importing
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/voice-channel-tracker.js');
jest.mock('../../src/services/config-service.js');

// Import after mocks
import { VoiceChannelManager } from '../../src/services/voice-channel-manager.js';
import { ConfigService } from '../../src/services/config-service.js';

describe('VoiceChannelManager - Control Panel Update', () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let mockChannel: Partial<VoiceChannel>;
  let mockGuild: Partial<Guild>;
  let mockNewOwner: Partial<GuildMember>;
  let mockOldOwner: Partial<GuildMember>;
  let mockPermissionOverwrites: {
    create: jest.Mock;
    cache: Map<string, any>;
  };
  let mockMembers: Partial<Collection<string, GuildMember>>;
  let mockControlPanelMessage: Partial<Message>;
  let mockMessages: {
    fetch: jest.Mock;
  };
  let mockEveryoneRole: Partial<Role>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset the singleton instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (VoiceChannelManager as any).instance = undefined;

    // Mock everyone role
    mockEveryoneRole = {
      id: 'everyone-role-id',
      name: '@everyone',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock guild
    mockGuild = {
      roles: {
        everyone: mockEveryoneRole as Role,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock control panel message
    mockControlPanelMessage = {
      id: 'control-panel-message-id',
      author: {
        id: 'bot-user-id',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      embeds: [
        {
          title: '🎮 Voice Channel Controls',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      ],
      edit: jest.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock messages fetch
    const messagesCollection = new Map([
      ['control-panel-message-id', mockControlPanelMessage as Message],
    ]);
    // Add find method to the map to simulate Collection behavior
    (messagesCollection as any).find = function(predicate: (msg: Message) => boolean) {
      for (const msg of this.values()) {
        if (predicate(msg)) {
          return msg;
        }
      }
      return undefined;
    };

    mockMessages = {
      fetch: jest.fn().mockResolvedValue(messagesCollection),
    };

    // Mock new owner
    mockNewOwner = {
      id: 'new-owner-id',
      displayName: 'NewOwner',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock old owner
    mockOldOwner = {
      id: 'old-owner-id',
      displayName: 'OldOwner',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock members collection
    mockMembers = {
      get: jest.fn((id: string) => {
        if (id === 'new-owner-id') {
          return mockNewOwner as GuildMember;
        }
        if (id === 'old-owner-id') {
          return mockOldOwner as GuildMember;
        }
        return undefined;
      }),
      has: jest.fn((id: string) => id === 'new-owner-id' || id === 'old-owner-id'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock permission overwrites
    mockPermissionOverwrites = {
      create: jest.fn().mockResolvedValue(undefined),
      cache: new Map(),
    };

    // Mock channel
    mockChannel = {
      id: 'channel-id',
      name: 'Test Channel',
      type: ChannelType.GuildVoice,
      permissionOverwrites: mockPermissionOverwrites,
      members: mockMembers as Collection<string, GuildMember>,
      setName: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      messages: mockMessages,
      guild: mockGuild as Guild,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock client
    mockClient = {
      user: {
        id: 'bot-user-id',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      channels: {
        cache: {
          get: jest.fn().mockReturnValue(mockChannel),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        fetch: jest.fn().mockResolvedValue(mockChannel),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // Mock ConfigService
    const mockConfigService = ConfigService.getInstance() as jest.Mocked<ConfigService>;
    mockConfigService.getBoolean = jest.fn().mockResolvedValue(true);
    mockConfigService.getNumber = jest.fn().mockResolvedValue(30);

    // Create manager instance
    manager = VoiceChannelManager.getInstance(mockClient as Client);

    // Set up the channel ownership
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).userChannels.set('old-owner-id', mockChannel);
  });

  afterEach(() => {
    // Clean up singleton instance
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (VoiceChannelManager as any).instance = undefined;
  });

  describe('Control Panel Update on Ownership Transfer', () => {
    it('should update control panel message when transferring ownership', async () => {
      // Manually trigger ownership update (simulating automatic transfer)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember
      );

      // Verify messages were fetched
      expect(mockMessages.fetch).toHaveBeenCalledWith({ limit: 50 });

      // Verify control panel message was updated
      expect(mockControlPanelMessage.edit).toHaveBeenCalled();
      
      // Verify the edit call had the new owner ID in the content and buttons
      const editCall = (mockControlPanelMessage.edit as jest.Mock).mock.calls[0][0];
      expect(editCall.content).toBe('<@new-owner-id>');
      
      // Verify buttons have new owner ID
      const buttons = editCall.components[0].components;
      expect(buttons[0].data.custom_id).toContain('new-owner-id');
      expect(buttons[1].data.custom_id).toContain('new-owner-id');
      expect(buttons[2].data.custom_id).toContain('new-owner-id');
      expect(buttons[3].data.custom_id).toContain('new-owner-id');
    });

    it('should update permissions when transferring ownership', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember
      );

      // Verify new owner got ManageChannels permission
      expect(mockPermissionOverwrites.create).toHaveBeenCalledWith(
        'new-owner-id',
        expect.objectContaining({
          ManageChannels: true,
        })
      );

      // Verify old owner lost ManageChannels permission
      expect(mockPermissionOverwrites.create).toHaveBeenCalledWith(
        'old-owner-id',
        expect.objectContaining({
          ManageChannels: false,
        })
      );
    });

    it('should send notification message after ownership transfer', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember
      );

      // Verify notification was sent
      expect(mockChannel.send).toHaveBeenCalledWith(
        expect.stringContaining('NewOwner')
      );
    });

    it('should reflect privacy state in updated control panel', async () => {
      // Make channel private
      const everyonePermissions = {
        deny: {
          has: jest.fn((perm: bigint) => perm === PermissionFlagsBits.Connect),
        },
      };
      mockPermissionOverwrites.cache.set('everyone-role-id', everyonePermissions);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember
      );

      // Verify control panel was updated
      expect(mockControlPanelMessage.edit).toHaveBeenCalled();
      
      const editCall = (mockControlPanelMessage.edit as jest.Mock).mock.calls[0][0];
      
      // Verify privacy is reflected in description
      expect(editCall.embeds[0].data.description).toContain('🔒 Invite-Only');
      
      // Verify privacy button label
      const privacyButton = editCall.components[0].components[1];
      expect(privacyButton.data.label).toBe('Make Public');
    });

    it('should handle missing control panel gracefully', async () => {
      // Mock no control panel message found
      mockMessages.fetch = jest.fn().mockResolvedValue(new Map());

      // This should not throw
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember
      )).resolves.not.toThrow();
    });
  });
});
