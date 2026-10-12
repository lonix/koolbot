import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { PermissionFlagsBits, type Client, type Guild } from "discord.js";

const mockGetString =
  jest.fn<(key: string, fallback?: string) => Promise<string>>();
const mockGetBoolean =
  jest.fn<(key: string, fallback?: boolean) => Promise<boolean>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getString: mockGetString,
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

  function transferFixture(opts: {
    oldAllowsStatus: boolean;
    channelHolds?: boolean;
  }) {
    const create = jest.fn(async () => undefined);
    const holds = opts.channelHolds ?? true;
    const channel = {
      id: "c",
      name: "Room",
      guild: guildHolding(true),
      members: { get: () => ({ id: "new", displayName: "New" }) },
      permissionOverwrites: {
        create,
        cache: new Map([
          [
            "old",
            {
              allow: {
                has: (f: bigint) =>
                  opts.oldAllowsStatus &&
                  f === PermissionFlagsBits.SetVoiceChannelStatus,
              },
            },
          ],
        ]),
      },
      permissionsFor: () => ({
        has: (f: bigint) =>
          f === PermissionFlagsBits.SetVoiceChannelStatus ? holds : true,
      }),
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
    return { create };
  }

  it("moves the grant to the new owner on transfer and neutralises the old owner's", async () => {
    const { create } = transferFixture({ oldAllowsStatus: true });

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
        SetVoiceChannelStatus: null,
      }),
    );
  });

  it("still revokes the old owner's grant after grant_status is turned off", async () => {
    mockGetBoolean.mockResolvedValue(false);
    const { create } = transferFixture({ oldAllowsStatus: true });

    await manager.transferOwnership("c", "old", "new");

    const newCall = (create.mock.calls as unknown[][]).find(
      (c) => c[0] === "new",
    )![1] as Record<string, unknown>;
    expect(newCall.SetVoiceChannelStatus).toBeUndefined();
    expect(create).toHaveBeenCalledWith(
      "old",
      expect.objectContaining({ SetVoiceChannelStatus: null }),
    );
  });

  it("leaves the old owner alone when they never had the grant", async () => {
    const { create } = transferFixture({ oldAllowsStatus: false });

    await manager.transferOwnership("c", "old", "new");

    const oldCall = (create.mock.calls as unknown[][]).find(
      (c) => c[0] === "old",
    )![1] as Record<string, unknown>;
    expect("SetVoiceChannelStatus" in oldCall).toBe(false);
  });

  it("does not touch the status permission when the room denies it to the bot", async () => {
    const { create } = transferFixture({
      oldAllowsStatus: true,
      channelHolds: false,
    });

    await manager.transferOwnership("c", "old", "new");

    for (const call of create.mock.calls as unknown[][]) {
      expect("SetVoiceChannelStatus" in (call[1] as object)).toBe(false);
    }
  });

  it("respects a category that denies the permission to the bot", async () => {
    const category = {
      permissionsFor: () => ({ has: () => false }),
    };
    expect(
      (await (manager as any).ownerStatusGrant(guildHolding(true), category))
        .allow,
    ).toEqual([]);
  });

  describe("lobby join (createUserChannel)", () => {
    function lobbyFixture(holds: boolean) {
      const created = {
        id: "room",
        name: "Room",
        delete: jest.fn(),
      };
      const create = jest.fn(async () => created);
      const category = {
        id: "cat",
        type: 4,
        permissionsFor: () => ({ has: () => holds }),
        permissionOverwrites: {
          cache: new Map([
            ["everyone", { id: "everyone", type: 0, allow: 1n, deny: 2n }],
          ]),
        },
      };
      const member = {
        id: "u1",
        displayName: "Ann",
        guild: {
          id: "g",
          members: {
            me: {
              permissions: { has: () => holds },
            },
          },
          channels: {
            cache: new Map([["cat", category]]),
            create,
          },
        },
        voice: { setChannel: jest.fn(async () => undefined) },
      };
      mockGetBoolean.mockImplementation(async (_k, f) => f ?? false);
      mockGetString.mockImplementation(async (key, fb) =>
        key === "voicechannels.category_id" ? "cat" : (fb ?? ""),
      );
      return { create, member };
    }

    beforeEach(() => {
      (manager as any).persistOwnership = jest.fn(async () => undefined);
      (manager as any).recordManagedChannel = jest.fn(async () => undefined);
      (manager as any).sendControlPanel = jest.fn(async () => undefined);
    });

    it("grants the owner the status permission and keeps the category's overwrites", async () => {
      const { create, member } = lobbyFixture(true);
      const { ConfigService } =
        await import("../../src/services/config-service.js");
      (ConfigService.getInstance() as any).getString = jest.fn(
        async (key: string, fb?: string) =>
          key === "voicechannels.category_id" ? "cat" : (fb ?? ""),
      );

      await (manager as any).createUserChannelUnlocked(member);

      const arg = (create.mock.calls[0] as unknown[])[0] as {
        permissionOverwrites: Array<{ id: string; allow: unknown }>;
      };
      expect(arg.permissionOverwrites).toEqual(
        expect.arrayContaining([
          { id: "everyone", type: 0, allow: 1n, deny: 2n },
          { id: "u1", allow: ["SetVoiceChannelStatus"] },
        ]),
      );
    });

    it("creates the room exactly as before when the bot lacks the permission", async () => {
      const { create, member } = lobbyFixture(false);
      const { ConfigService } =
        await import("../../src/services/config-service.js");
      (ConfigService.getInstance() as any).getString = jest.fn(
        async (key: string, fb?: string) =>
          key === "voicechannels.category_id" ? "cat" : (fb ?? ""),
      );

      await (manager as any).createUserChannelUnlocked(member);

      expect(
        "permissionOverwrites" in
          ((create.mock.calls[0] as unknown[])[0] as object),
      ).toBe(false);
    });
  });
});
