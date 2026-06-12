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
  Collection,
  type Client,
  type Guild,
  type VoiceChannel,
} from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/models/voice-channel-ownership.js");

// Import after mocks
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";
import { VoiceChannelOwnership } from "../../src/models/voice-channel-ownership.js";

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;
const mockOwnershipModel = VoiceChannelOwnership as unknown as {
  find: jest.Mock;
  findOneAndUpdate: jest.Mock;
  updateOne: jest.Mock;
  deleteOne: jest.Mock;
};

/**
 * Regression coverage for issue #615: ownership was tracked only in memory, so
 * a restart orphaned every dynamic channel the bot created beforehand. The
 * manager now persists ownership and rebuilds it on `initialize()`.
 */
describe("VoiceChannelManager - ownership persistence (issue #615)", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;

    mockOwnershipModel.find = jest.fn<any>().mockResolvedValue([]);
    mockOwnershipModel.findOneAndUpdate = jest
      .fn<any>()
      .mockResolvedValue(undefined);
    mockOwnershipModel.updateOne = jest.fn<any>().mockResolvedValue(undefined);
    mockOwnershipModel.deleteOne = jest.fn<any>().mockResolvedValue(undefined);

    mockConfigService.getBoolean = jest
      .fn()
      .mockImplementation((key: string, defaultValue?: boolean) => {
        if (key === "voicechannels.enabled") return Promise.resolve(true);
        return Promise.resolve(defaultValue ?? false);
      });
    mockConfigService.getString = jest
      .fn()
      .mockImplementation((key: string, defaultValue?: string) => {
        switch (key) {
          case "GUILD_ID":
            return Promise.resolve("guild-id");
          case "voicechannels.lobby.name":
            return Promise.resolve("Lobby");
          case "voicechannels.lobby.offlinename":
            return Promise.resolve("Lobby (Offline)");
          case "voicechannels.category_id":
            return Promise.resolve("category-id");
          case "voicechannels.channel.prefix":
            return Promise.resolve("🎮");
          default:
            return Promise.resolve(defaultValue ?? "");
        }
      });

    mockClient = {
      guilds: { fetch: jest.fn() } as any,
      channels: { fetch: jest.fn() } as any,
    } as any;

    manager = VoiceChannelManager.getInstance(mockClient as Client);
    // Pretend Mongo is connected so the persistence helpers run against the
    // mocked model rather than short-circuiting.
    jest.spyOn(manager as any, "isDbReady").mockReturnValue(true);
  });

  afterEach(() => {
    (VoiceChannelManager as any).instance = undefined;
    jest.restoreAllMocks();
  });

  function buildGuild(channels: Collection<string, VoiceChannel>): Guild {
    return {
      id: "guild-id",
      channels: { cache: channels },
    } as unknown as Guild;
  }

  it("restores managed state for channels that still exist after a restart", async () => {
    const existingChannel = {
      id: "channel-id",
      name: "lonix's Channel",
      type: ChannelType.GuildVoice,
      members: new Collection([["lonix-id", {} as any]]),
    } as unknown as VoiceChannel;

    const guild = buildGuild(new Collection([["channel-id", existingChannel]]));

    mockOwnershipModel.find.mockResolvedValue([
      {
        guildId: "guild-id",
        channelId: "channel-id",
        ownerId: "lonix-id",
        customName: "My Cool Room",
      },
    ]);

    await (manager as any).restoreOwnership(guild);

    // Ownership and custom name are rebuilt in memory.
    expect(manager.getUserChannel("lonix-id")).toBe(existingChannel);
    expect(manager.hasCustomName("channel-id")).toBe(true);
    // Nothing was pruned for a channel that still exists.
    expect(mockOwnershipModel.deleteOne).not.toHaveBeenCalled();
  });

  it("prunes ownership rows for channels deleted while the bot was down", async () => {
    // Guild no longer contains the persisted channel.
    const guild = buildGuild(new Collection());

    mockOwnershipModel.find.mockResolvedValue([
      { guildId: "guild-id", channelId: "gone-channel", ownerId: "lonix-id" },
    ]);

    await (manager as any).restoreOwnership(guild);

    expect(manager.getUserChannel("lonix-id")).toBeUndefined();
    expect(mockOwnershipModel.deleteOne).toHaveBeenCalledWith({
      channelId: "gone-channel",
    });
  });

  it("keeps a restored, occupied channel safe from the unmanaged cleanup", async () => {
    // A channel the bot created before the restart, still occupied, restored
    // from persistence. The periodic cleanup must treat it as managed.
    const restoredChannel = {
      id: "restored-id",
      name: "lonix's Channel",
      type: ChannelType.GuildVoice,
      members: new Collection([["lonix-id", {} as any]]),
      delete: jest.fn<any>().mockResolvedValue(undefined),
    } as unknown as VoiceChannel;
    const foreignChannel = {
      id: "foreign-id",
      name: "Some Random Channel",
      type: ChannelType.GuildVoice,
      members: new Collection(),
      delete: jest.fn<any>().mockResolvedValue(undefined),
    } as unknown as VoiceChannel;

    const channels = new Collection<string, VoiceChannel>([
      ["restored-id", restoredChannel],
      ["foreign-id", foreignChannel],
    ]);
    const category = {
      id: "category-id",
      type: ChannelType.GuildCategory,
      children: { cache: channels },
    };
    // The guild cache exposes every channel (incl. the category), mirroring
    // discord.js — restoreOwnership resolves channels via guild.channels.cache.
    const guild = {
      id: "guild-id",
      channels: {
        cache: new Collection<string, any>([
          ["category-id", category],
          ["restored-id", restoredChannel],
          ["foreign-id", foreignChannel],
        ]),
      },
    } as unknown as Guild;
    (mockClient.guilds as any).fetch = jest.fn<any>().mockResolvedValue(guild);

    mockOwnershipModel.find.mockResolvedValue([
      { guildId: "guild-id", channelId: "restored-id", ownerId: "lonix-id" },
    ]);

    // Rebuild ownership from persistence, then run the periodic cleanup.
    await (manager as any).restoreOwnership(guild);
    await manager.cleanupEmptyChannels();

    expect(restoredChannel.delete as jest.Mock).not.toHaveBeenCalled();
    // The genuinely foreign channel is still cleaned up.
    expect(foreignChannel.delete as jest.Mock).toHaveBeenCalled();
  });

  it("persists ownership when a dynamic channel is created", async () => {
    const createdChannel = {
      id: "new-channel-id",
      name: "🎮 lonix's Room",
      type: ChannelType.GuildVoice,
    } as unknown as VoiceChannel;
    const guild = {
      id: "guild-id",
      channels: {
        cache: new Collection([
          [
            "category-id",
            { id: "category-id", type: ChannelType.GuildCategory },
          ],
        ]),
        create: jest.fn<any>().mockResolvedValue(createdChannel),
      },
      members: {
        fetch: jest
          .fn<any>()
          .mockResolvedValue({ id: "lonix-id", displayName: "lonix" }),
      },
      roles: { everyone: { id: "everyone-id" } },
    } as unknown as Guild;

    await manager.createDynamicChannel(guild, "lonix-id");

    expect(mockOwnershipModel.findOneAndUpdate).toHaveBeenCalledWith(
      { channelId: "new-channel-id" },
      expect.objectContaining({ ownerId: "lonix-id" }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it("removes the persisted row when an owned channel is cleaned up", async () => {
    const emptyChannel = {
      id: "empty-id",
      name: "lonix's Channel",
      type: ChannelType.GuildVoice,
      members: new Collection(),
      delete: jest.fn<any>().mockResolvedValue(undefined),
    } as unknown as VoiceChannel;

    (manager as any).userChannels.set("lonix-id", emptyChannel);

    await (manager as any).cleanupUserChannel("lonix-id");

    expect(mockOwnershipModel.deleteOne).toHaveBeenCalledWith({
      channelId: "empty-id",
    });
  });
});
