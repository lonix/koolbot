import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { ChannelType, Collection, type Client } from "discord.js";

jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");

import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { VoiceChannelTracker } from "../../src/services/voice-channel-tracker.js";
import { ConfigService } from "../../src/services/config-service.js";

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;

/**
 * #1778: the automatic ownership transfer never hands a room to a bot (for
 * example a music bot summoned by the owner), whether it is the only one left
 * or ties with humans at zero voice time.
 */
describe("VoiceChannelManager - ownership transfer skips bots (#1778)", () => {
  let manager: VoiceChannelManager;
  let room: any;
  let weekSeconds: Record<string, number>;

  const member = (id: string, bot = false): any => ({
    id,
    displayName: id,
    user: { bot },
  });
  const setMembers = (...ms: any[]): void => {
    room.members = new Collection<string, any>(ms.map((m) => [m.id, m]));
  };
  const runTimer = async (): Promise<void> => {
    await (manager as any).handleChannelOwnershipChange(room);
    await jest.advanceTimersByTimeAsync(31_000);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;

    mockConfigService.getBoolean = jest
      .fn<any>()
      .mockImplementation((_k: string, d?: boolean) =>
        Promise.resolve(d ?? false),
      );
    mockConfigService.getString = jest
      .fn<any>()
      .mockImplementation((_k: string, d?: string) => Promise.resolve(d ?? ""));

    weekSeconds = {};
    (VoiceChannelTracker as any).getInstance = jest.fn(() => ({
      getUserStats: jest.fn<any>(async (id: string) => ({
        totalTime: weekSeconds[id] ?? 0,
      })),
    }));

    room = {
      id: "room",
      name: "Room",
      type: ChannelType.GuildVoice,
      guild: { id: "guild" },
      members: new Collection<string, any>(),
      permissionOverwrites: {
        cache: new Map(),
        create: jest.fn<any>().mockResolvedValue(undefined),
        delete: jest.fn<any>().mockResolvedValue(undefined),
      },
      setName: jest.fn<any>().mockResolvedValue(undefined),
      send: jest.fn<any>().mockResolvedValue(undefined),
    };

    manager = VoiceChannelManager.getInstance({
      user: { id: "koolbot" },
      channels: {
        cache: { get: () => room },
        fetch: jest.fn<any>(async () => room),
      },
    } as unknown as Client);
    (manager as any).userChannels.set("owner", room);
    (manager as any).customChannelNames.set("room", "custom");
    (manager as any).persistOwnership = jest.fn(async () => undefined);
    (manager as any).updateControlPanelOwnership = jest.fn(async () => {});
  });

  afterEach(() => {
    (manager as any).cancelOwnershipTransfer("room");
    jest.useRealTimers();
    (VoiceChannelManager as any).instance = undefined;
  });

  it("does not transfer to a bot that is the only one left", async () => {
    setMembers(member("music", true));

    await runTimer();

    expect(room.permissionOverwrites.create).not.toHaveBeenCalled();
    expect(manager.isRoomOwner("owner", "room")).toBe(true);
    expect(manager.isRoomOwner("music", "room")).toBe(false);
    // The timer entry is cleared so a later change can schedule again
    expect((manager as any).ownershipTransferTimers.has("room")).toBe(false);
  });

  it("picks the human when a bot ties with it at 0 s and comes first", async () => {
    setMembers(member("music", true), member("newbie"));

    await runTimer();

    expect(manager.isRoomOwner("newbie", "room")).toBe(true);
    expect(manager.isRoomOwner("music", "room")).toBe(false);
    expect(room.permissionOverwrites.create).toHaveBeenCalledTimes(1);
    expect(room.permissionOverwrites.create.mock.calls[0][0]).toBe("newbie");
  });

  it("still ranks humans by weekly voice time", async () => {
    weekSeconds = { low: 10, high: 500 };
    setMembers(member("music", true), member("low"), member("high"));

    await runTimer();

    expect(manager.isRoomOwner("high", "room")).toBe(true);
  });

  it("refuses a bot new owner in updateChannelOwnershipLocked", async () => {
    setMembers(member("music", true));

    const result = await (manager as any).updateChannelOwnershipLocked(
      room,
      member("music", true),
    );

    expect(result).toBe(false);
    expect(room.permissionOverwrites.create).not.toHaveBeenCalled();
    expect(manager.isRoomOwner("owner", "room")).toBe(true);
  });

  it("still transfers to a human in updateChannelOwnershipLocked", async () => {
    setMembers(member("human"));

    const result = await (manager as any).updateChannelOwnershipLocked(
      room,
      member("human"),
    );

    expect(result).toBe(true);
    expect(manager.isRoomOwner("human", "room")).toBe(true);
  });
  describe("through handleVoiceStateUpdate", () => {
    const state = (m: any, channel: any): any => ({
      member: m,
      channel,
      guild: { id: "guild" },
    });
    const update = (m: any, from: any, to: any): Promise<void> =>
      manager.handleVoiceStateUpdate(state(m, from), state(m, to));
    const timers = (): Map<string, unknown> =>
      (manager as any).ownershipTransferTimers;
    const GRACE_MS = 31_000;

    beforeEach(() => {
      mockConfigService.getBoolean = jest
        .fn<any>()
        .mockImplementation((k: string, d?: boolean) =>
          Promise.resolve(k === "voicechannels.enabled" ? true : (d ?? false)),
        );
      (manager as any).isLobbyChannel = jest.fn(async () => false);
      (manager as any).cleanupUserChannel = jest.fn(async () => {});
      (manager as any).cleanupEmptyChannel = jest.fn(async () => {});
    });

    it("hands the room to a human who joins after a bot-only transfer was dropped", async () => {
      const owner = member("owner");
      const music = member("music", true);
      setMembers(music);

      await update(owner, room, null);
      expect(timers().has("room")).toBe(true);
      await jest.advanceTimersByTimeAsync(GRACE_MS);
      expect(manager.isRoomOwner("owner", "room")).toBe(true);
      expect(timers().has("room")).toBe(false);

      const human = member("human");
      setMembers(music, human);
      await update(human, null, room);
      expect(timers().has("room")).toBe(true);
      await jest.advanceTimersByTimeAsync(GRACE_MS);

      expect(manager.isRoomOwner("human", "room")).toBe(true);
      expect(manager.isRoomOwner("music", "room")).toBe(false);
    });

    it("also handles a human switching into the owner-less room", async () => {
      const human = member("human");
      setMembers(human);

      await update(human, { id: "other", name: "Other", type: 2 }, room);
      expect(timers().has("room")).toBe(true);
      await jest.advanceTimersByTimeAsync(GRACE_MS);

      expect(manager.isRoomOwner("human", "room")).toBe(true);
    });

    it("schedules nothing when a bot joins an owner-less room", async () => {
      const music = member("music", true);
      setMembers(music);

      await update(music, null, room);

      expect(timers().has("room")).toBe(false);
    });

    it("schedules nothing when the owner is present", async () => {
      const owner = member("owner");
      const human = member("human");
      setMembers(owner, human);

      await update(human, null, room);

      expect(timers().has("room")).toBe(false);
    });

    it("does not duplicate a pending timer", async () => {
      const human = member("human");
      const second = member("second");
      setMembers(human);
      await update(human, null, room);
      const first = timers().get("room");
      expect(first).toBeDefined();

      setMembers(human, second);
      await update(second, null, room);

      expect(timers().get("room")).toBe(first);
    });

    it("schedules nothing for a room with no recorded owner", async () => {
      const human = member("human");
      (manager as any).userChannels.clear();
      setMembers(human);

      await update(human, null, room);

      expect(timers().size).toBe(0);
    });
  });
});
