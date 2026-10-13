import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { Client, VoiceChannel, GuildMember, Collection } from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");

// Import after mocks
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";

describe("VoiceChannelManager - Transfer Ownership", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let mockChannel: Partial<VoiceChannel>;
  let mockNewOwner: Partial<GuildMember>;
  let mockPermissionOverwrites: {
    create: jest.Mock;
  };
  let mockMembers: Partial<Collection<string, GuildMember>>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset the singleton instance by setting it to undefined
    (VoiceChannelManager as any).instance = undefined;

    // Mock permission overwrites
    mockPermissionOverwrites = {
      create: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    // Mock members collection
    mockMembers = {
      get: jest.fn((id: string) => {
        if (id === "new-owner-id") {
          return mockNewOwner as GuildMember;
        }
        return undefined;
      }),
    } as any;

    mockNewOwner = {
      id: "new-owner-id",
      displayName: "NewOwner",
    } as any;

    // Mock channel
    mockChannel = {
      id: "channel-id",
      name: "Custom Channel Name",
      permissionOverwrites: mockPermissionOverwrites,
      members: mockMembers as Collection<string, GuildMember>,
      setName: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Mock client
    mockClient = {
      channels: {
        cache: {
          get: jest.fn().mockReturnValue(mockChannel),
        },
      } as any,
    } as any;

    // Create manager instance
    manager = VoiceChannelManager.getInstance(mockClient as Client);
    // old-owner-id is the live owner (transfers verify this under the lock)
    (manager as any).userChannels.set("old-owner-id", mockChannel);
  });

  afterEach(() => {
    // Clean up singleton instance
    (VoiceChannelManager as any).instance = undefined;
  });

  describe("transferOwnership", () => {
    it("should grant ManageChannels permission to new owner", async () => {
      await manager.transferOwnership(
        "channel-id",
        "old-owner-id",
        "new-owner-id",
      );

      expect(mockPermissionOverwrites.create).toHaveBeenCalledWith(
        "new-owner-id",
        {
          ManageChannels: true,
          Connect: true,
          Speak: true,
          ViewChannel: true,
        },
      );
    });

    it("should delete the old owner's overwrite instead of leaving an explicit allow (#1143)", async () => {
      await manager.transferOwnership(
        "channel-id",
        "old-owner-id",
        "new-owner-id",
      );

      expect(mockPermissionOverwrites.delete).toHaveBeenCalledWith(
        "old-owner-id",
        expect.any(String),
      );
      // No Connect/Speak/ViewChannel allow may be (re)written for them
      expect(mockPermissionOverwrites.create).not.toHaveBeenCalledWith(
        "old-owner-id",
        expect.anything(),
      );
    });

    it("neutralises the old owner's overwrite in place when deleting it fails", async () => {
      mockPermissionOverwrites.delete.mockRejectedValue(new Error("boom"));

      await manager.transferOwnership(
        "channel-id",
        "old-owner-id",
        "new-owner-id",
      );

      // Not the old explicit allow: ManageChannels denied, the rest neutral
      expect(mockPermissionOverwrites.create).toHaveBeenCalledWith(
        "old-owner-id",
        {
          ManageChannels: false,
          Connect: null,
          Speak: null,
          ViewChannel: null,
          MoveMembers: null,
        },
      );
    });

    it("does nothing for the old owner when the room has no overwrite for them", async () => {
      // Lobby-join rooms inherit the category's overwrites: nothing to remove
      (mockPermissionOverwrites as any).cache = new Map();

      await manager.transferOwnership(
        "channel-id",
        "old-owner-id",
        "new-owner-id",
      );

      expect(mockPermissionOverwrites.delete).not.toHaveBeenCalled();
      expect(mockPermissionOverwrites.create).not.toHaveBeenCalledWith(
        "old-owner-id",
        expect.anything(),
      );
    });

    it("resets the old owner's overwrite to the category's instead of dropping a category-level deny", async () => {
      (mockPermissionOverwrites as any).cache = new Map([
        ["old-owner-id", { allow: { has: () => false } }],
      ]);
      (mockChannel as any).parent = {
        permissionOverwrites: {
          cache: new Map([
            [
              "old-owner-id",
              {
                allow: { toArray: () => ["ViewChannel"] },
                deny: { toArray: () => ["Connect"] },
              },
            ],
          ]),
        },
      };

      await manager.transferOwnership(
        "channel-id",
        "old-owner-id",
        "new-owner-id",
      );

      expect(mockPermissionOverwrites.delete).not.toHaveBeenCalled();
      expect(mockPermissionOverwrites.create).toHaveBeenCalledWith(
        "old-owner-id",
        { ViewChannel: true, Connect: false },
        expect.anything(),
      );
    });

    it("still completes the transfer when deleting the old overwrite fails", async () => {
      mockPermissionOverwrites.delete.mockRejectedValue(new Error("boom"));

      await expect(
        manager.transferOwnership("channel-id", "old-owner-id", "new-owner-id"),
      ).resolves.toBeUndefined();
      expect(manager.getUserChannel("new-owner-id")).toBe(mockChannel);
    });

    it("should not rename channel when it has a custom name", async () => {
      // Mark channel as having a custom name
      manager.setCustomChannelName("channel-id", "Custom Channel Name");

      await manager.transferOwnership(
        "channel-id",
        "old-owner-id",
        "new-owner-id",
      );

      expect(mockChannel.setName).not.toHaveBeenCalled();
    });

    it("should rename channel when it does not have a custom name", async () => {
      // Do not mark channel as having a custom name
      await manager.transferOwnership(
        "channel-id",
        "old-owner-id",
        "new-owner-id",
      );

      expect(mockChannel.setName).toHaveBeenCalledWith("NewOwner's Channel");
    });

    it("should send notification to channel", async () => {
      await manager.transferOwnership(
        "channel-id",
        "old-owner-id",
        "new-owner-id",
      );

      expect(mockChannel.send).toHaveBeenCalledWith({
        content: "Channel ownership has been transferred to NewOwner",
        allowedMentions: { parse: [] },
      });
    });

    it("neutralises a hostile display name in the transfer notice (#1146)", async () => {
      mockNewOwner.displayName =
        "<@555> @everyone [free](https://evil.example) **b**";

      await manager.transferOwnership(
        "channel-id",
        "old-owner-id",
        "new-owner-id",
      );

      const payload = mockChannel.send.mock.calls[0][0] as {
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

    it("should throw error when channel is not found", async () => {
      mockClient.channels = {
        cache: {
          get: jest.fn().mockReturnValue(undefined),
        },
      } as any;

      await expect(
        manager.transferOwnership("channel-id", "old-owner-id", "new-owner-id"),
      ).rejects.toThrow("Channel not found");
    });

    it("should throw error when new owner is not in channel", async () => {
      mockMembers.get = jest.fn().mockReturnValue(undefined);

      await expect(
        manager.transferOwnership("channel-id", "old-owner-id", "new-owner-id"),
      ).rejects.toThrow("New owner is not in the channel");
    });
  });

  describe("Custom name tracking", () => {
    it("should mark channel as having custom name", () => {
      manager.setCustomChannelName("channel-id", "Custom Name");

      expect(manager.hasCustomName("channel-id")).toBe(true);
      expect(manager.getCustomChannelName("channel-id")).toBe("Custom Name");
    });

    it("should return false for channel without custom name", () => {
      expect(manager.hasCustomName("non-existent-id")).toBe(false);
      expect(manager.getCustomChannelName("non-existent-id")).toBeUndefined();
    });
  });
});
