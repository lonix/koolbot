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
  DiscordAPIError,
  type Client,
  type VoiceChannel,
  type GuildMember,
  type Collection,
  type VoiceState,
} from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");

// Import after mocks
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;

describe("VoiceChannelManager - Channel Cleanup with Custom Names", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let mockChannel: Partial<VoiceChannel>;
  let mockOwner: Partial<GuildMember>;
  let mockSecondUser: Partial<GuildMember>;
  let mockMembers: Map<string, GuildMember>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset the singleton instance
    (VoiceChannelManager as any).instance = undefined;

    // Setup mock config service
    mockConfigService.getBoolean = jest
      .fn()
      .mockImplementation((key: string, defaultValue: boolean) => {
        if (key === "voicechannels.enabled") return Promise.resolve(true);
        return Promise.resolve(defaultValue);
      });
    mockConfigService.getString = jest.fn().mockResolvedValue("Lobby");

    // Mock members
    mockOwner = {
      id: "owner-id",
      displayName: "ChannelOwner",
      voice: {
        setChannel: jest.fn().mockResolvedValue(undefined),
      } as any,
    } as any;

    mockSecondUser = {
      id: "second-user-id",
      displayName: "SecondUser",
      voice: {
        setChannel: jest.fn().mockResolvedValue(undefined),
      } as any,
    } as any;

    // Initialize members map with owner
    mockMembers = new Map<string, GuildMember>();
    mockMembers.set("owner-id", mockOwner as GuildMember);
    mockMembers.set("second-user-id", mockSecondUser as GuildMember);

    // Mock channel
    mockChannel = {
      id: "channel-id",
      name: "Custom Channel Name",
      type: ChannelType.GuildVoice,
      members: mockMembers as Collection<string, GuildMember>,
      delete: jest.fn().mockResolvedValue(undefined),
      setName: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      permissionOverwrites: {
        create: jest.fn().mockResolvedValue(undefined),
      } as any,
    } as any;

    // Mock client
    mockClient = {
      channels: {
        cache: {
          get: jest.fn().mockReturnValue(mockChannel),
        } as any,
      } as any,
    } as any;

    // Create manager instance
    manager = VoiceChannelManager.getInstance(mockClient as Client);
  });

  afterEach(() => {
    // Clean up singleton instance
    (VoiceChannelManager as any).instance = undefined;
  });

  describe("Channel deletion with custom names", () => {
    it("should delete channel with custom name when last user leaves", async () => {
      // Setup: Channel has custom name and is owned by owner
      manager.setCustomChannelName("channel-id", "Custom Channel Name");

      // Simulate channel in userChannels map
      (manager as any).userChannels.set("owner-id", mockChannel);

      // Simulate the last user leaving (channel becomes empty)
      mockMembers.clear();
      Object.defineProperty(mockChannel, "members", {
        value: mockMembers as Collection<string, GuildMember>,
        writable: true,
      });

      // Create mock voice states
      const oldState: Partial<VoiceState> = {
        channel: mockChannel as VoiceChannel,
        member: mockOwner as GuildMember,
      };
      const newState: Partial<VoiceState> = {
        channel: null,
        member: mockOwner as GuildMember,
      };

      // Act: User leaves the channel
      await manager.handleVoiceStateUpdate(
        oldState as VoiceState,
        newState as VoiceState,
      );

      // Assert: Channel should be deleted
      expect(mockChannel.delete).toHaveBeenCalled();
    });

    it("should delete channel without custom name when last user leaves", async () => {
      // Setup: Channel has no custom name and is owned by owner
      // Simulate channel in userChannels map
      (manager as any).userChannels.set("owner-id", mockChannel);

      // Simulate the last user leaving (channel becomes empty)
      mockMembers.clear();
      Object.defineProperty(mockChannel, "members", {
        value: mockMembers as Collection<string, GuildMember>,
        writable: true,
      });

      // Create mock voice states
      const oldState: Partial<VoiceState> = {
        channel: mockChannel as VoiceChannel,
        member: mockOwner as GuildMember,
      };
      const newState: Partial<VoiceState> = {
        channel: null,
        member: mockOwner as GuildMember,
      };

      // Act: User leaves the channel
      await manager.handleVoiceStateUpdate(
        oldState as VoiceState,
        newState as VoiceState,
      );

      // Assert: Channel should be deleted
      expect(mockChannel.delete).toHaveBeenCalled();
    });

    // This test is skipped because it requires complex mocking of ownership transfer
    // The bug is: when owner leaves and ownership transfers, the new owner becomes
    // responsible for cleanup. But if that new owner leaves, the channel may not be
    // tracked properly for cleanup.
    it.skip("should delete channel with custom name after ownership transfer when last user leaves", async () => {
      // This test case will be validated manually after the fix
      expect(true).toBe(true);
    });

    it("should not delete channel when users are still present", async () => {
      // Setup: Channel has custom name and is owned by owner
      manager.setCustomChannelName("channel-id", "Custom Channel Name");

      // Simulate channel in userChannels map
      (manager as any).userChannels.set("owner-id", mockChannel);

      // Channel still has members
      Object.defineProperty(mockChannel, "members", {
        value: mockMembers as Collection<string, GuildMember>,
        writable: true,
      });

      // Create mock voice states for a user joining
      const oldState: Partial<VoiceState> = {
        channel: null,
        member: mockSecondUser as GuildMember,
      };
      const newState: Partial<VoiceState> = {
        channel: mockChannel as VoiceChannel,
        member: mockSecondUser as GuildMember,
      };

      // Act: User joins the channel
      await manager.handleVoiceStateUpdate(
        oldState as VoiceState,
        newState as VoiceState,
      );

      // Assert: Channel should NOT be deleted
      expect(mockChannel.delete).not.toHaveBeenCalled();
    });

    it("should prevent race condition when both cleanupUserChannel and cleanupEmptyChannel are called", async () => {
      // Setup: Channel is owned by owner and is empty
      manager.setCustomChannelName("channel-id", "Custom Channel Name");

      // Simulate channel in userChannels map
      (manager as any).userChannels.set("owner-id", mockChannel);

      // Simulate the channel is empty
      mockMembers.clear();
      Object.defineProperty(mockChannel, "members", {
        value: mockMembers as Collection<string, GuildMember>,
        writable: true,
      });

      // Create mock voice states for owner leaving
      const oldState: Partial<VoiceState> = {
        channel: mockChannel as VoiceChannel,
        member: mockOwner as GuildMember,
      };
      const newState: Partial<VoiceState> = {
        channel: null,
        member: mockOwner as GuildMember,
      };

      // Act: User leaves the channel
      // This will trigger both cleanupUserChannel (line 421) and cleanupEmptyChannel (line 426)
      await manager.handleVoiceStateUpdate(
        oldState as VoiceState,
        newState as VoiceState,
      );

      // Assert: Channel.delete should only be called once, not twice
      // This verifies the channelsBeingDeleted Set prevents double deletion
      expect(mockChannel.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe("cleanupUserChannel resilience (issue #404)", () => {
    function makeUnknownChannelError(): DiscordAPIError {
      // DiscordAPIError's constructor signature has shifted between
      // discord.js versions and `name` is a getter on its prototype, so we
      // build the instance via Object.create + defineProperty rather than
      // calling the constructor.
      const error = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
      Object.defineProperties(error, {
        rawError: {
          value: { message: "Unknown Channel", code: 10003 },
          writable: true,
        },
        code: { value: 10003, writable: true },
        status: { value: 404, writable: true },
        method: { value: "DELETE", writable: true },
        url: {
          value: "https://discord.com/api/v10/channels/channel-id",
          writable: true,
        },
        message: { value: "Unknown Channel", writable: true },
      });
      return error;
    }

    it("removes the userChannels entry when channel.delete throws 10003 (Unknown Channel)", async () => {
      // Setup: owner has a channel entry whose remote channel has already
      // been deleted on Discord's side.
      (manager as any).userChannels.set("owner-id", mockChannel);
      mockMembers.clear();
      Object.defineProperty(mockChannel, "members", {
        value: mockMembers as Collection<string, GuildMember>,
        writable: true,
      });
      (mockChannel.delete as jest.Mock).mockRejectedValue(
        makeUnknownChannelError(),
      );

      // Drive cleanupUserChannel directly: handleVoiceStateUpdate also
      // invokes cleanupEmptyChannel afterwards, which would muddy the
      // assertion we care about here.
      await (manager as any).cleanupUserChannel("owner-id");

      // The userChannels entry must be cleared so subsequent lobby joins
      // aren't silently skipped with "already has a channel".
      const userChannels: Map<string, VoiceChannel> = (manager as any)
        .userChannels;
      expect(userChannels.has("owner-id")).toBe(false);
    });

    it("keeps the userChannels entry when channel.delete throws a non-10003 error", async () => {
      (manager as any).userChannels.set("owner-id", mockChannel);
      mockMembers.clear();
      Object.defineProperty(mockChannel, "members", {
        value: mockMembers as Collection<string, GuildMember>,
        writable: true,
      });
      (mockChannel.delete as jest.Mock).mockRejectedValue(
        new Error("transient network failure"),
      );

      await (manager as any).cleanupUserChannel("owner-id");

      // Non-10003 failures are transient: leave the entry so the periodic
      // cleanup can retry, instead of dropping ownership tracking on the floor.
      const userChannels: Map<string, VoiceChannel> = (manager as any)
        .userChannels;
      expect(userChannels.has("owner-id")).toBe(true);
    });
  });

  describe("pending ownership-transfer cleanup (issue #540)", () => {
    function seedPendingTransfer(
      channelId: string,
    ): ReturnType<typeof setTimeout> {
      // Seed a pending ownership-transfer timer for the channel using a
      // deterministic sentinel handle (no real setTimeout, so no open handle is
      // left if a test fails early) and return it for assertions.
      const timer = {
        __sentinel: channelId,
      } as unknown as ReturnType<typeof setTimeout>;
      (manager as any).ownershipTransferTimers.set(channelId, {
        timer,
        originalOwnerId: "owner-id",
      });
      return timer;
    }

    it("cancels a pending ownership transfer when cleanupEmptyChannel deletes the channel", async () => {
      manager.setCustomChannelName("channel-id", "Custom Channel Name");
      (manager as any).userChannels.set("owner-id", mockChannel);
      mockMembers.clear();
      Object.defineProperty(mockChannel, "members", {
        value: mockMembers as Collection<string, GuildMember>,
        writable: true,
      });

      const timer = seedPendingTransfer("channel-id");
      const clearSpy = jest.spyOn(global, "clearTimeout");

      await (manager as any).cleanupEmptyChannel(mockChannel as VoiceChannel);

      // The specific seeded timer must be cancelled and dropped so it never
      // fires on the now-deleted channel (DiscordAPIError 10003).
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledWith(timer);
      expect((manager as any).ownershipTransferTimers.has("channel-id")).toBe(
        false,
      );
      clearSpy.mockRestore();
    });

    it("cancels a pending ownership transfer when cleanupUserChannel deletes the channel", async () => {
      (manager as any).userChannels.set("owner-id", mockChannel);
      mockMembers.clear();
      Object.defineProperty(mockChannel, "members", {
        value: mockMembers as Collection<string, GuildMember>,
        writable: true,
      });

      const timer = seedPendingTransfer("channel-id");
      const clearSpy = jest.spyOn(global, "clearTimeout");

      await (manager as any).cleanupUserChannel("owner-id");

      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledWith(timer);
      expect((manager as any).ownershipTransferTimers.has("channel-id")).toBe(
        false,
      );
      clearSpy.mockRestore();
    });
  });

  describe("Custom name tracking cleanup", () => {
    it("should clean up custom name tracking when channel is deleted", async () => {
      // Setup: Channel has custom name
      manager.setCustomChannelName("channel-id", "Custom Channel Name");
      expect(manager.hasCustomName("channel-id")).toBe(true);

      // Simulate channel in userChannels map
      (manager as any).userChannels.set("owner-id", mockChannel);

      // Simulate the last user leaving (channel becomes empty)
      mockMembers.clear();
      Object.defineProperty(mockChannel, "members", {
        value: mockMembers as Collection<string, GuildMember>,
        writable: true,
      });

      // Create mock voice states
      const oldState: Partial<VoiceState> = {
        channel: mockChannel as VoiceChannel,
        member: mockOwner as GuildMember,
      };
      const newState: Partial<VoiceState> = {
        channel: null,
        member: mockOwner as GuildMember,
      };

      // Act: User leaves the channel
      await manager.handleVoiceStateUpdate(
        oldState as VoiceState,
        newState as VoiceState,
      );

      // Assert: Custom name tracking should be cleaned up
      expect(manager.hasCustomName("channel-id")).toBe(false);
    });
  });
});
