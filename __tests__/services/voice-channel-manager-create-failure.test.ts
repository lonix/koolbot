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
  type Client,
  type Guild,
  type VoiceChannel,
  type CategoryChannel,
  type GuildMember,
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
 * Regression coverage for issue #339: an AFK→lobby transition could leave a
 * stale entry in `userChannels` when `member.voice.setChannel` failed mid-flight,
 * locking the user out of all future lobby joins until the bot restarted.
 */
describe("VoiceChannelManager.createUserChannel - setChannel failure", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let mockMember: Partial<GuildMember>;
  let mockGuild: Partial<Guild>;
  let mockCategory: Partial<CategoryChannel>;
  let createdChannel: Partial<VoiceChannel>;
  let setChannelMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    (VoiceChannelManager as any).instance = undefined;

    mockConfigService.getBoolean = jest
      .fn()
      .mockImplementation((_key: string, defaultValue: boolean) =>
        Promise.resolve(defaultValue),
      );
    mockConfigService.getString = jest
      .fn()
      .mockImplementation((key: string, defaultValue?: string) => {
        if (key === "voicechannels.category_id")
          return Promise.resolve("category-id");
        if (key === "voicechannels.channel.suffix")
          return Promise.resolve("'s Room");
        if (key === "voicechannels.channel.prefix")
          return Promise.resolve("🎮");
        return Promise.resolve(defaultValue ?? "");
      });

    createdChannel = {
      id: "new-channel-id",
      name: "🎮 Tester's Room",
      type: ChannelType.GuildVoice,
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockCategory = {
      id: "category-id",
      name: "Dynamic Voice Channels",
      type: ChannelType.GuildCategory,
    } as any;

    mockGuild = {
      channels: {
        cache: {
          // resolveManagedCategory uses cache.get(id); the mock category
          // stands in for the category at "category-id".
          get: jest.fn().mockReturnValue(mockCategory),
          find: jest.fn().mockReturnValue(mockCategory),
        } as any,
        create: jest.fn().mockResolvedValue(createdChannel),
      } as any,
    } as any;

    setChannelMock = jest.fn();
    mockMember = {
      id: "member-id",
      displayName: "Tester",
      guild: mockGuild as Guild,
      voice: {
        setChannel: setChannelMock,
      } as any,
    } as any;

    mockClient = {} as Partial<Client>;
    manager = VoiceChannelManager.getInstance(mockClient as Client);
  });

  afterEach(() => {
    (VoiceChannelManager as any).instance = undefined;
  });

  it("does not record a userChannels entry when setChannel fails, and deletes the orphan channel", async () => {
    setChannelMock.mockRejectedValueOnce(new Error("Stale voice state"));

    await (manager as any).createUserChannel(mockMember as GuildMember);

    const userChannels = (manager as any).userChannels as Map<
      string,
      VoiceChannel
    >;

    expect(userChannels.has("member-id")).toBe(false);
    expect(createdChannel.delete).toHaveBeenCalled();
  });

  it("allows a subsequent createUserChannel to succeed after a prior setChannel failure", async () => {
    setChannelMock
      .mockRejectedValueOnce(new Error("Stale voice state"))
      .mockResolvedValueOnce(undefined);

    // First attempt fails — must not lock the user out.
    await (manager as any).createUserChannel(mockMember as GuildMember);

    // Second attempt: guild.channels.create returns a fresh channel.
    const secondChannel: Partial<VoiceChannel> = {
      id: "second-channel-id",
      name: "🎮 Tester's Room",
      type: ChannelType.GuildVoice,
      delete: jest.fn().mockResolvedValue(undefined),
    } as any;
    (mockGuild.channels!.create as jest.Mock).mockResolvedValueOnce(
      secondChannel,
    );

    await (manager as any).createUserChannel(mockMember as GuildMember);

    const userChannels = (manager as any).userChannels as Map<
      string,
      VoiceChannel
    >;

    expect(userChannels.get("member-id")).toBe(secondChannel);
    expect(setChannelMock).toHaveBeenCalledTimes(2);
  });
});
