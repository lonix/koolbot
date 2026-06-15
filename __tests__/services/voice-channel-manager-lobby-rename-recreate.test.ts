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
 * Regression coverage for issue #631: when the lobby name is changed via
 * /config, the periodic cleanup deletes the old channel (whose name no longer
 * matches the configured name) as "unmanaged". The cleanup must then
 * immediately re-create the lobby with the new name so the guild is never left
 * without a lobby until the next (much slower) health check notices it.
 */
describe("VoiceChannelManager - lobby re-created after rename cleanup (issue #631)", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let staleLobby: Partial<VoiceChannel>;
  let createdName: string | undefined;
  let createMock: ReturnType<typeof jest.fn>;

  const NEW_LOBBY_NAME = "🟢 Lobby";

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;
    createdName = undefined;

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
            return Promise.resolve(NEW_LOBBY_NAME);
          case "voicechannels.lobby.offlinename":
            return Promise.resolve("🔴 Lobby");
          case "voicechannels.category_id":
            return Promise.resolve("category-id");
          case "voicechannels.channel.prefix":
            return Promise.resolve("🎮");
          default:
            return Promise.resolve(defaultValue ?? "");
        }
      });

    // The old lobby, left over after the name was changed via /config. Its name
    // no longer matches the configured "🟢 Lobby", so cleanup deletes it.
    staleLobby = {
      id: "stale-lobby-id",
      name: "Lobby",
      type: ChannelType.GuildVoice,
      members: new Collection(),
      delete: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    const channels = new Collection<string, VoiceChannel>();
    channels.set(staleLobby.id as string, staleLobby as VoiceChannel);

    const category = {
      id: "category-id",
      type: ChannelType.GuildCategory,
      children: { cache: channels },
    };

    createMock = jest.fn<any>().mockImplementation((options: any) => {
      createdName = options?.name;
      return Promise.resolve({ id: "new-lobby-id", name: options?.name });
    });

    const guild: Partial<Guild> = {
      roles: { everyone: { id: "everyone-id" } } as any,
      channels: {
        cache: new Collection([["category-id", category]]),
        create: createMock,
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

  it("deletes the stale-named lobby and immediately re-creates it with the new name", async () => {
    await manager.cleanupEmptyChannels();

    // Old lobby removed because it no longer matches the configured name.
    expect(staleLobby.delete).toHaveBeenCalled();

    // A replacement lobby is created right away with the new configured name,
    // rather than waiting for the periodic health check.
    expect(createMock).toHaveBeenCalled();
    expect(createdName).toBe(NEW_LOBBY_NAME);
  });
});
