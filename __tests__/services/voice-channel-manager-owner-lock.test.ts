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

jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");

import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;

/**
 * One channel per owner, even when two paths ask at once (#957).
 *
 * `createUserChannel` (the lobby join) and `createDynamicChannel` (used by
 * `/lfg` to attach a room to a post) both read `userChannels` and then create,
 * which is a check-then-act on a map the other one writes. Run together for
 * the same member — a lobby join landing while `/lfg` attaches a channel —
 * each saw no channel and each made one. The second write won the map and the
 * first room was left unowned for the empty-channel sweep, possibly out from
 * under the post that had just linked it.
 */
describe("VoiceChannelManager — one channel per owner under concurrency", () => {
  let manager: VoiceChannelManager;
  let mockGuild: Partial<Guild>;
  let mockMember: Partial<GuildMember>;
  let createCalls: number;
  let releaseCreate: (() => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as unknown as { instance?: unknown }).instance =
      undefined;
    createCalls = 0;
    releaseCreate = undefined;

    mockConfigService.getBoolean = jest
      .fn()
      .mockImplementation((_key: string, defaultValue: boolean) =>
        Promise.resolve(defaultValue),
      ) as never;
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
      }) as never;

    const mockCategory = {
      id: "category-id",
      name: "Dynamic Voice Channels",
      type: ChannelType.GuildCategory,
    } as unknown as CategoryChannel;

    mockGuild = {
      id: "guild-1",
      channels: {
        cache: {
          get: jest.fn().mockReturnValue(mockCategory),
          find: jest.fn().mockReturnValue(mockCategory),
        },
        // Creating is slow, which is what lets the two paths overlap.
        create: jest.fn(async () => {
          createCalls += 1;
          const id = `channel-${createCalls}`;
          await new Promise<void>((resolve) => {
            releaseCreate = resolve;
            setTimeout(resolve, 10);
          });
          return {
            id,
            name: "🎮 Tester's Room",
            type: ChannelType.GuildVoice,
            delete: jest.fn(),
          } as unknown as VoiceChannel;
        }),
      },
      members: { fetch: jest.fn(async () => mockMember as GuildMember) },
      roles: { everyone: { id: "everyone" } },
    } as unknown as Partial<Guild>;

    mockMember = {
      id: "member-id",
      displayName: "Tester",
      guild: mockGuild as Guild,
      voice: { setChannel: jest.fn() },
    } as unknown as Partial<GuildMember>;

    manager = VoiceChannelManager.getInstance({} as Client);
  });

  afterEach(() => {
    (VoiceChannelManager as unknown as { instance?: unknown }).instance =
      undefined;
    releaseCreate?.();
  });

  it("creates one channel when both paths run for the same member", async () => {
    await Promise.all([
      (
        manager as unknown as {
          createUserChannel(m: GuildMember): Promise<void>;
        }
      ).createUserChannel(mockMember as GuildMember),
      manager.createDynamicChannel(mockGuild as Guild, "member-id", "🎮 LFG"),
    ]);

    expect(createCalls).toBe(1);
  });

  it("hands the second caller the channel the first one made", async () => {
    const [, second] = await Promise.all([
      (
        manager as unknown as {
          createUserChannel(m: GuildMember): Promise<void>;
        }
      ).createUserChannel(mockMember as GuildMember),
      manager.createDynamicChannel(mockGuild as Guild, "member-id", "🎮 LFG"),
    ]);

    const owned = (
      manager as unknown as { userChannels: Map<string, VoiceChannel> }
    ).userChannels.get("member-id");
    expect(owned).toBeDefined();
    // Whichever ran second must return the owned room, not a doomed twin.
    if (second) expect(second.id).toBe(owned?.id);
  });

  it("still creates one for a member who has none", async () => {
    const channel = await manager.createDynamicChannel(
      mockGuild as Guild,
      "member-id",
      "🎮 LFG",
    );

    expect(channel).not.toBeNull();
    expect(createCalls).toBe(1);
  });
});
