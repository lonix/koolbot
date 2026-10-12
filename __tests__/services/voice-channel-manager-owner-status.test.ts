import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { PermissionFlagsBits, type Client, type Guild } from "discord.js";

const mockGetBoolean =
  jest.fn<(key: string, fallback?: boolean) => Promise<boolean>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getString: jest.fn(),
      getNumber: jest.fn(),
    })),
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/voice-channel-tracker.js", () => ({
  VoiceChannelTracker: { getInstance: jest.fn(() => ({})) },
}));

const { VoiceChannelManager } =
  await import("../../src/services/voice-channel-manager.js");

function guildHolding(holds: boolean): Guild {
  return {
    members: {
      me: {
        permissions: {
          has: (flag: bigint) =>
            flag === PermissionFlagsBits.SetVoiceChannelStatus ? holds : true,
        },
      },
    },
  } as unknown as Guild;
}

describe("VoiceChannelManager owner Set Voice Channel Status grant", () => {
  let manager: InstanceType<typeof VoiceChannelManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as unknown as { instance: unknown }).instance =
      undefined;
    mockGetBoolean.mockImplementation(
      async (_k, fallback) => fallback ?? false,
    );
    manager = VoiceChannelManager.getInstance({
      user: { id: "bot" },
    } as unknown as Client);
  });

  const grant = (g: Guild): Promise<{ allow: string[] }> =>
    (manager as any).ownerStatusGrant(g);

  it("grants it when the setting is on and the bot holds the permission", async () => {
    expect((await grant(guildHolding(true))).allow).toEqual([
      "SetVoiceChannelStatus",
    ]);
  });

  it("skips it when the bot lacks it (Discord would reject the overwrite)", async () => {
    expect((await grant(guildHolding(false))).allow).toEqual([]);
  });

  it("skips it when the setting is off", async () => {
    mockGetBoolean.mockResolvedValue(false);
    expect((await grant(guildHolding(true))).allow).toEqual([]);
  });

  it("never throws on an odd guild", async () => {
    expect((await grant({} as Guild)).allow).toEqual([]);
  });

  it("moves the grant to the new owner on transfer and never touches the status", async () => {
    const create = jest.fn(async () => undefined);
    const channel = {
      id: "c",
      name: "Room",
      guild: guildHolding(true),
      members: { get: () => ({ id: "new", displayName: "New" }) },
      permissionOverwrites: { create },
      setName: jest.fn(async () => undefined),
      send: jest.fn(async () => undefined),
    };
    (manager as any).client = {
      user: { id: "bot" },
      channels: { cache: { get: () => channel } },
    };
    (manager as any).customChannelNames.set("c", "custom");
    (manager as any).updateControlPanelOwnership = jest.fn(
      async () => undefined,
    );
    (manager as any).persistOwnership = jest.fn(async () => undefined);

    await manager.transferOwnership("c", "old", "new");

    expect(create).toHaveBeenCalledWith(
      "new",
      expect.objectContaining({
        ManageChannels: true,
        SetVoiceChannelStatus: true,
      }),
    );
    expect(create).toHaveBeenCalledWith(
      "old",
      expect.objectContaining({
        ManageChannels: false,
        SetVoiceChannelStatus: false,
      }),
    );
  });
});
