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
 * Regression coverage for issue #839: the graceful-shutdown handler used to
 * search the whole guild for any voice channel whose name contained a
 * hardcoded "🟢". With the shipped default lobby name ("Lobby") that never
 * matched, and it could rename an unrelated channel such as "🟢 Gaming"
 * instead. Shutdown now delegates to renameLobbyToOffline(), which resolves
 * the lobby by the configured name inside the managed category.
 */
describe("VoiceChannelManager.renameLobbyToOffline (issue #839)", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let lobby: Partial<VoiceChannel>;
  let unrelated: Partial<VoiceChannel>;
  let outsideCategory: Partial<VoiceChannel>;
  let guild: Guild;
  let categoryId: string;

  const LOBBY_NAME = "Lobby";
  const OFFLINE_LOBBY_NAME = "🔴 Lobby";

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;
    categoryId = "category-id";

    mockConfigService.getBoolean = jest
      .fn()
      .mockImplementation((_key: string, defaultValue?: boolean) =>
        Promise.resolve(defaultValue ?? false),
      );

    mockConfigService.getString = jest
      .fn()
      .mockImplementation((key: string, defaultValue?: string) => {
        switch (key) {
          case "voicechannels.lobby.name":
            return Promise.resolve(LOBBY_NAME);
          case "voicechannels.lobby.offlinename":
            return Promise.resolve(OFFLINE_LOBBY_NAME);
          case "voicechannels.category_id":
            return Promise.resolve(categoryId);
          default:
            return Promise.resolve(defaultValue ?? "");
        }
      });

    lobby = {
      id: "lobby-id",
      name: LOBBY_NAME,
      type: ChannelType.GuildVoice,
      members: new Collection(),
      setName: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    // A user-created channel that happens to contain the green circle the old
    // shutdown handler matched on. It must be left alone.
    unrelated = {
      id: "gaming-id",
      name: "🟢 Gaming",
      type: ChannelType.GuildVoice,
      members: new Collection(),
      setName: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    // Same name as the lobby, but outside the managed category.
    outsideCategory = {
      id: "decoy-id",
      name: LOBBY_NAME,
      type: ChannelType.GuildVoice,
      members: new Collection(),
      setName: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    const children = new Collection<string, VoiceChannel>();
    children.set(lobby.id as string, lobby as VoiceChannel);
    children.set(unrelated.id as string, unrelated as VoiceChannel);

    const category = {
      id: "category-id",
      type: ChannelType.GuildCategory,
      children: { cache: children },
    };

    guild = {
      channels: {
        cache: new Collection<string, any>([
          ["category-id", category],
          [outsideCategory.id as string, outsideCategory],
        ]),
      } as any,
    } as Guild;

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

  it("renames the configured lobby to its offline name", async () => {
    await manager.renameLobbyToOffline(guild);

    expect(lobby.setName).toHaveBeenCalledWith(
      OFFLINE_LOBBY_NAME,
      "Bot shutting down",
    );
  });

  it("leaves an unrelated channel containing 🟢 untouched", async () => {
    await manager.renameLobbyToOffline(guild);

    expect(unrelated.setName).not.toHaveBeenCalled();
  });

  it("ignores a same-named channel outside the managed category", async () => {
    await manager.renameLobbyToOffline(guild);

    expect(outsideCategory.setName).not.toHaveBeenCalled();
  });

  it("does nothing when the managed category is not configured", async () => {
    categoryId = "";

    await manager.renameLobbyToOffline(guild);

    expect(lobby.setName).not.toHaveBeenCalled();
    expect(unrelated.setName).not.toHaveBeenCalled();
  });
});
