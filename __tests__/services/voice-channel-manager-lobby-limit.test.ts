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
 * Per-member burst limit on lobby room creation (#1147). A member who joins
 * and leaves the lobby in a loop made the bot create and delete a room each
 * time. Over the limit the member is left in the lobby (not moved, no room is
 * made) and told once per window, in the lobby's text chat, to rejoin later.
 */
describe("VoiceChannelManager lobby room limit (#1147)", () => {
  let manager: VoiceChannelManager;
  let mockMember: Partial<GuildMember>;
  let mockGuild: Partial<Guild>;
  let createMock: jest.Mock;
  let setChannelMock: jest.Mock;
  let lobbySend: jest.Mock;
  let limits: { max: number; windowSeconds: number };

  const newRoom = (n: number): Partial<VoiceChannel> =>
    ({
      id: `room-${n}`,
      name: "🎮 Tester's Room",
      type: ChannelType.GuildVoice,
      delete: jest.fn().mockResolvedValue(undefined),
    }) as any;

  /** One lobby visit: join (creates a room) then leave (forgets the room). */
  const visit = async (): Promise<void> => {
    await (manager as any).createUserChannel(mockMember as GuildMember);
    (manager as any).userChannels.delete("member-id");
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;
    limits = { max: 3, windowSeconds: 60 };

    mockConfigService.getBoolean = jest
      .fn()
      .mockImplementation((_key: string, defaultValue: boolean) =>
        Promise.resolve(defaultValue),
      );
    mockConfigService.getNumber = jest
      .fn()
      .mockImplementation((key: string, defaultValue: number) => {
        if (key === "voicechannels.lobby.max_rooms")
          return Promise.resolve(limits.max);
        if (key === "voicechannels.lobby.room_window_seconds")
          return Promise.resolve(limits.windowSeconds);
        return Promise.resolve(defaultValue);
      });
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

    const mockCategory = {
      id: "category-id",
      name: "Dynamic Voice Channels",
      type: ChannelType.GuildCategory,
    } as any;
    let n = 0;
    createMock = jest
      .fn()
      .mockImplementation(() => Promise.resolve(newRoom(++n)));
    mockGuild = {
      channels: {
        cache: {
          get: jest.fn().mockReturnValue(mockCategory),
          find: jest.fn().mockReturnValue(mockCategory),
        } as any,
        create: createMock,
      } as any,
    } as any;

    setChannelMock = jest.fn().mockResolvedValue(undefined);
    lobbySend = jest.fn().mockResolvedValue(undefined);
    mockMember = {
      id: "member-id",
      displayName: "@everyone",
      guild: mockGuild as Guild,
      voice: {
        setChannel: setChannelMock,
        channel: { id: "lobby-id", send: lobbySend },
      } as any,
    } as any;

    manager = VoiceChannelManager.getInstance({} as Client);
  });

  afterEach(() => {
    jest.useRealTimers();
    (VoiceChannelManager as any).instance = undefined;
  });

  it("allows up to the limit, then makes no room and does not move the member", async () => {
    for (let i = 0; i < 3; i++) await visit();
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(setChannelMock).toHaveBeenCalledTimes(3);

    await visit();

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(setChannelMock).toHaveBeenCalledTimes(3);
    expect((manager as any).userChannels.has("member-id")).toBe(false);
  });

  it("tells the member once per window, by id only, in the lobby chat", async () => {
    for (let i = 0; i < 3; i++) await visit();
    await visit();
    await visit();
    await visit();

    expect(lobbySend).toHaveBeenCalledTimes(1);
    const payload = lobbySend.mock.calls[0][0] as {
      content: string;
      allowedMentions: { users: string[] };
    };
    expect(payload.content).toContain("<@member-id>");
    expect(payload.content).toContain("Leave and rejoin the lobby");
    expect(payload.content).not.toContain("@everyone");
    expect(payload.allowedMentions).toEqual({ users: ["member-id"] });
  });

  it("still holds the room back when the notice cannot be sent", async () => {
    lobbySend.mockRejectedValue(new Error("Missing Access"));
    for (let i = 0; i < 3; i++) await visit();
    await visit();
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("limits each member separately", async () => {
    for (let i = 0; i < 3; i++) await visit();
    const other = {
      ...mockMember,
      id: "other-id",
      displayName: "Other",
    } as GuildMember;
    await (manager as any).createUserChannel(other);
    expect((manager as any).userChannels.get("other-id")).toBeDefined();
  });

  it("lets the member back in once the window has passed", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    for (let i = 0; i < 3; i++) await visit();
    await visit();
    expect(createMock).toHaveBeenCalledTimes(3);

    jest.setSystemTime(Date.now() + 61_000);
    await visit();
    expect(createMock).toHaveBeenCalledTimes(4);
  });

  it("is off when the limit is 0", async () => {
    limits.max = 0;
    for (let i = 0; i < 8; i++) await visit();
    expect(createMock).toHaveBeenCalledTimes(8);
    expect(lobbySend).not.toHaveBeenCalled();
  });

  it("does not count a member who already has a room", async () => {
    await (manager as any).createUserChannel(mockMember as GuildMember);
    for (let i = 0; i < 5; i++) {
      await (manager as any).createUserChannel(mockMember as GuildMember);
    }
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(lobbySend).not.toHaveBeenCalled();
  });
});
