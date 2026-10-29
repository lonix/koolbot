import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type VoiceChannel,
  type GuildMember,
  type Collection,
  type Message,
  type Guild,
  type Role,
} from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");

// Import after mocks
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";

describe("VoiceChannelManager - Control Panel Update", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let mockChannel: Partial<VoiceChannel>;
  let mockGuild: Partial<Guild>;
  let mockNewOwner: Partial<GuildMember>;
  let mockOldOwner: Partial<GuildMember>;
  let mockPermissionOverwrites: {
    create: jest.Mock;
    delete: jest.Mock;
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
    (VoiceChannelManager as any).instance = undefined;

    // Mock everyone role
    mockEveryoneRole = {
      id: "everyone-role-id",
      name: "@everyone",
    } as any;

    // Mock guild
    mockGuild = {
      roles: {
        everyone: mockEveryoneRole as Role,
      } as any,
    } as any;

    // Mock control panel message
    mockControlPanelMessage = {
      id: "control-panel-message-id",
      author: {
        id: "bot-user-id",
      } as any,
      embeds: [
        {
          title: "🎮 Voice Channel Controls", // old title: still found (#1519)
        } as any,
      ],
      edit: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Mock messages fetch
    const messagesCollection = new Map([
      ["control-panel-message-id", mockControlPanelMessage as Message],
    ]);
    // Add find method to the map to simulate Collection behavior
    (messagesCollection as any).find = function (
      predicate: (msg: Message) => boolean,
    ) {
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
      id: "new-owner-id",
      displayName: "NewOwner",
    } as any;

    // Mock old owner
    mockOldOwner = {
      id: "old-owner-id",
      displayName: "OldOwner",
    } as any;

    // Mock members collection
    mockMembers = {
      get: jest.fn((id: string) => {
        if (id === "new-owner-id") {
          return mockNewOwner as GuildMember;
        }
        if (id === "old-owner-id") {
          return mockOldOwner as GuildMember;
        }
        return undefined;
      }),
      has: jest.fn(
        (id: string) => id === "new-owner-id" || id === "old-owner-id",
      ),
    } as any;

    // Mock permission overwrites
    mockPermissionOverwrites = {
      create: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      cache: new Map(),
    };

    // Mock channel
    mockChannel = {
      id: "channel-id",
      name: "Test Channel",
      type: ChannelType.GuildVoice,
      permissionOverwrites: mockPermissionOverwrites,
      members: mockMembers as Collection<string, GuildMember>,
      setName: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      messages: mockMessages,
      guild: mockGuild as Guild,
    } as any;

    // Mock client
    mockClient = {
      user: {
        id: "bot-user-id",
      } as any,
      channels: {
        cache: {
          get: jest.fn().mockReturnValue(mockChannel),
        } as any,
        fetch: jest.fn().mockResolvedValue(mockChannel),
      } as any,
    } as any;

    // Mock ConfigService
    const mockConfigService =
      ConfigService.getInstance() as jest.Mocked<ConfigService>;
    mockConfigService.getBoolean = jest.fn().mockResolvedValue(true);
    mockConfigService.getNumber = jest.fn().mockResolvedValue(30);

    // Create manager instance
    manager = VoiceChannelManager.getInstance(mockClient as Client);

    // Set up the channel ownership
    (manager as any).userChannels.set("old-owner-id", mockChannel);
  });

  afterEach(() => {
    // Clean up singleton instance
    (VoiceChannelManager as any).instance = undefined;
  });

  describe("Control Panel Update on Ownership Transfer", () => {
    it("should update control panel message when transferring ownership", async () => {
      // Manually trigger ownership update (simulating automatic transfer)
      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember,
      );

      // Verify messages were fetched
      expect(mockMessages.fetch).toHaveBeenCalledWith({ limit: 50 });

      // Verify control panel message was updated
      expect(mockControlPanelMessage.edit).toHaveBeenCalled();

      // Verify the edit call had the new owner ID in the content and buttons
      const editCall = (mockControlPanelMessage.edit as jest.Mock).mock
        .calls[0][0];
      expect(editCall.content).toBe("<@new-owner-id>");

      // Verify buttons have new owner ID
      const buttons = editCall.components[0].components;
      expect(buttons[0].data.custom_id).toContain("new-owner-id");
      expect(buttons[1].data.custom_id).toContain("new-owner-id");
      expect(buttons[2].data.custom_id).toContain("new-owner-id");
      expect(buttons[3].data.custom_id).toContain("new-owner-id");
    });

    it("should update permissions when transferring ownership", async () => {
      // The previous owner has an overwrite on the room
      mockPermissionOverwrites.cache.set("old-owner-id", {
        allow: { has: () => false },
      });
      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember,
      );

      // Verify new owner got ManageChannels permission
      expect(mockPermissionOverwrites.create).toHaveBeenCalledWith(
        "new-owner-id",
        expect.objectContaining({
          ManageChannels: true,
        }),
      );

      // Verify the old owner's overwrite was removed (#1143), not rewritten
      expect(mockPermissionOverwrites.delete).toHaveBeenCalledWith(
        "old-owner-id",
        expect.any(String),
      );
      expect(mockPermissionOverwrites.create).not.toHaveBeenCalledWith(
        "old-owner-id",
        expect.anything(),
      );
    });

    it("should send notification message after ownership transfer", async () => {
      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember,
      );

      // Verify notification was sent
      expect(mockChannel.send).toHaveBeenCalledWith({
        content: expect.stringContaining("NewOwner"),
        allowedMentions: { parse: [] },
      });
    });

    it("neutralises a hostile display name in the automatic transfer notice (#1146)", async () => {
      mockNewOwner.displayName =
        "<@555> @everyone [free](https://evil.example) **b**";

      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember,
      );

      const payload = (mockChannel.send as jest.Mock).mock.calls[0][0] as {
        content: string;
        allowedMentions: unknown;
      };
      expect(payload.allowedMentions).toEqual({ parse: [] });
      expect(payload.content).not.toContain("<@555>");
      expect(payload.content).not.toContain("@everyone");
      expect(payload.content).not.toContain("[free](");
      expect(payload.content).toContain("\\<@555\\>");
      expect(payload.content).toContain("\\*\\*b\\*\\*");
    });

    it("should reflect privacy state in updated control panel", async () => {
      // Make channel private
      const everyonePermissions = {
        deny: {
          has: jest.fn((perm: bigint) => perm === PermissionFlagsBits.Connect),
        },
      };
      mockPermissionOverwrites.cache.set(
        "everyone-role-id",
        everyonePermissions,
      );

      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember,
      );

      // Verify control panel was updated
      expect(mockControlPanelMessage.edit).toHaveBeenCalled();

      const editCall = (mockControlPanelMessage.edit as jest.Mock).mock
        .calls[0][0];

      // Verify privacy is reflected in description
      expect(editCall.embeds[0].data.fields).toContainEqual({
        name: "Privacy",
        value: "Invite only",
        inline: true,
      });

      // Verify privacy button label
      const privacyButton = editCall.components[0].components[1];
      expect(privacyButton.data.label).toBe("Make public");
    });

    it("finds and rebuilds a post that already has the new title (#1519)", async () => {
      (mockControlPanelMessage as any).embeds = [{ title: "🔊 Room controls" }];

      await (manager as any).updateChannelOwnership(
        mockChannel as VoiceChannel,
        mockNewOwner as GuildMember,
      );

      expect(mockControlPanelMessage.edit).toHaveBeenCalledTimes(1);
      const editCall = (mockControlPanelMessage.edit as jest.Mock).mock
        .calls[0][0];
      expect(editCall.embeds[0].data.title).toBe("🔊 Room controls");
      expect(editCall.embeds[0].data.footer.text).toBe(
        "KoolBot · Voice channels",
      );
    });

    it("sendControlPanel and rebuildControlPanel build the same post for the same state (#1519)", async () => {
      const states = [
        { priv: false, live: false, waiting: false },
        { priv: true, live: false, waiting: true },
        { priv: true, live: true, waiting: false },
        { priv: false, live: true, waiting: true },
      ];
      for (const s of states) {
        mockPermissionOverwrites.cache.clear();
        if (s.priv) {
          mockPermissionOverwrites.cache.set("everyone-role-id", {
            deny: { has: (p: bigint) => p === PermissionFlagsBits.Connect },
          });
        }
        (manager as any).liveChannels.clear();
        (manager as any).waitingRooms.clear();
        if (s.live) (manager as any).liveChannels.add("channel-id");
        if (s.waiting) {
          (manager as any).waitingRooms.set("channel-id", "wr");
        }
        (mockChannel.send as jest.Mock).mockClear();
        (mockControlPanelMessage.edit as jest.Mock).mockClear();

        await (manager as any).sendControlPanel(
          mockChannel as VoiceChannel,
          "new-owner-id",
        );
        await manager.rebuildControlPanel(
          mockChannel as VoiceChannel,
          "new-owner-id",
          mockControlPanelMessage as Message,
        );

        const sent = (mockChannel.send as jest.Mock).mock.calls[0][0];
        const edited = (mockControlPanelMessage.edit as jest.Mock).mock
          .calls[0][0];
        expect(JSON.parse(JSON.stringify(sent))).toEqual(
          JSON.parse(JSON.stringify(edited)),
        );
        // The real privacy state, not an assumed "public"
        const privacy = sent.components[0].components[1].data;
        expect(privacy.label).toBe(s.priv ? "Make public" : "Make private");
      }
    });

    it("should handle missing control panel gracefully", async () => {
      // Mock no control panel message found
      mockMessages.fetch = jest.fn().mockResolvedValue(new Map());

      // This should not throw
      await expect(
        (manager as any).updateChannelOwnership(
          mockChannel as VoiceChannel,
          mockNewOwner as GuildMember,
        ),
      ).resolves.not.toThrow();
    });
  });
});
