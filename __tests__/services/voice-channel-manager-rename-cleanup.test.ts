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

// Import after mocks
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;

/**
 * Regression coverage for issue #542: after an ownership transfer the channel
 * is renamed from "🎮 X's Room" to "Y's Channel", dropping the managed prefix.
 * The unmanaged-channel scanner must still recognise it as managed (by channel
 * ID) so it isn't deleted out from under the members still inside.
 */
describe("VoiceChannelManager - rename-safe unmanaged cleanup (issue #542)", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let renamedChannel: Partial<VoiceChannel>;
  let foreignChannel: Partial<VoiceChannel>;
  let category: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;

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

    // A channel that has been renamed by an ownership transfer. It no longer
    // matches the "🎮" prefix but is still owned (tracked in userChannels) and
    // still has a member inside.
    renamedChannel = {
      id: "renamed-channel-id",
      name: "lonix's Channel",
      type: ChannelType.GuildVoice,
      members: new Collection([["lonix-id", {} as any]]),
      delete: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    // A genuinely foreign channel that the bot does not manage.
    foreignChannel = {
      id: "foreign-channel-id",
      name: "Some Random Channel",
      type: ChannelType.GuildVoice,
      members: new Collection(),
      delete: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    const channels = new Collection<string, VoiceChannel>();
    channels.set(renamedChannel.id as string, renamedChannel as VoiceChannel);
    channels.set(foreignChannel.id as string, foreignChannel as VoiceChannel);

    category = {
      id: "category-id",
      type: ChannelType.GuildCategory,
      children: { cache: channels },
    };

    const guild: Partial<Guild> = {
      channels: {
        cache: new Collection([["category-id", category]]),
      } as any,
    };

    mockClient = {
      guilds: {
        fetch: jest.fn<any>().mockResolvedValue(guild),
      } as any,
    } as any;

    manager = VoiceChannelManager.getInstance(mockClient as Client);
  });

  afterEach(() => {
    (VoiceChannelManager as any).instance = undefined;
  });

  it("does not delete a renamed, occupied channel that is still owned", async () => {
    // Owner registry tracks the renamed channel by its stable ID.
    (manager as any).userChannels.set("lonix-id", renamedChannel);

    await manager.cleanupEmptyChannels();

    expect(renamedChannel.delete).not.toHaveBeenCalled();
    // The foreign channel should still be cleaned up.
    expect(foreignChannel.delete).toHaveBeenCalled();
  });

  it("deletes a renamed channel that is no longer tracked as owned", async () => {
    // Nothing in userChannels: the renamed channel is now indistinguishable
    // from a foreign channel and should be removed.
    await manager.cleanupEmptyChannels();

    expect(renamedChannel.delete).toHaveBeenCalled();
  });

  it("removes the ownership entry when an empty owned channel is cleaned up", async () => {
    // Owned but empty renamed channel: it should be deleted as an empty
    // managed channel and its ownership entry cleared.
    Object.defineProperty(renamedChannel, "members", {
      value: new Collection(),
      writable: true,
    });
    (manager as any).userChannels.set("lonix-id", renamedChannel);

    await manager.cleanupEmptyChannels();

    expect(renamedChannel.delete).toHaveBeenCalled();
    expect((manager as any).userChannels.has("lonix-id")).toBe(false);
  });
});
