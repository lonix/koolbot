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
    const del = jest.fn(async () => undefined);
    const holds = opts.channelHolds ?? true;
    const channel = {
      id: "c",
      name: "Room",
      guild: guildHolding(true),
      members: { get: () => ({ id: "new", displayName: "New" }) },
      permissionOverwrites: {
        create,
        delete: del,
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
    return { create, del };
  }

  it("moves the grant to the new owner on transfer and deletes the old owner's overwrite", async () => {
    const { create, del } = transferFixture({ oldAllowsStatus: true });

    await manager.transferOwnership("c", "old", "new");

    expect(create).toHaveBeenCalledWith(
      "new",
      expect.objectContaining({
        ManageChannels: true,
        SetVoiceChannelStatus: true,
      }),
    );
    // #1143: the old owner's overwrite is removed, not rewritten as an allow
    expect(del).toHaveBeenCalledWith("old", expect.any(String));
    expect((create.mock.calls as unknown[][]).some((c) => c[0] === "old")).toBe(
      false,
    );
  });

  it("still removes the old owner's overwrite after grant_status is turned off", async () => {
    mockGetBoolean.mockResolvedValue(false);
    const { create, del } = transferFixture({ oldAllowsStatus: true });

    await manager.transferOwnership("c", "old", "new");

    const newCall = (create.mock.calls as unknown[][]).find(
      (c) => c[0] === "new",
    )![1] as Record<string, unknown>;
    expect(newCall.SetVoiceChannelStatus).toBeUndefined();
    expect(del).toHaveBeenCalledWith("old", expect.any(String));
  });

  it("removes the old owner's overwrite even when they never had the grant", async () => {
    const { create, del } = transferFixture({ oldAllowsStatus: false });

    await manager.transferOwnership("c", "old", "new");

    expect(del).toHaveBeenCalledWith("old", expect.any(String));
    expect((create.mock.calls as unknown[][]).some((c) => c[0] === "old")).toBe(
      false,
    );
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
          {
            id: "u1",
            type: 1,
            allow: PermissionFlagsBits.SetVoiceChannelStatus,
            deny: 0n,
          },
        ]),
      );
    });

    it("merges the status bit into an existing category overwrite for the owner", async () => {
      const { create, member } = lobbyFixture(true);
      const cat = member.guild.channels.cache.get("cat") as any;
      const connect = PermissionFlagsBits.Connect;
      const status = PermissionFlagsBits.SetVoiceChannelStatus;
      cat.permissionOverwrites.cache.set("u1", {
        id: "u1",
        type: 1,
        allow: { bitfield: connect },
        deny: { bitfield: status | PermissionFlagsBits.Speak },
      });

      await (manager as any).createUserChannelUnlocked(member);

      const arg = (create.mock.calls[0] as unknown[])[0] as {
        permissionOverwrites: Array<{
          id: string;
          allow: bigint;
          deny: bigint;
        }>;
      };
      const own = arg.permissionOverwrites.filter((o) => o.id === "u1");
      expect(own).toHaveLength(1);
      expect(own[0].allow).toBe(connect | status); // Connect kept, status added
      expect(own[0].deny).toBe(PermissionFlagsBits.Speak); // status un-denied, Speak kept
    });

    it("createDynamicChannel (LFG/events) includes the grant when eligible", async () => {
      const { create, member } = lobbyFixture(true);
      const guild = {
        ...member.guild,
        roles: { everyone: { id: "everyone" } },
        members: {
          me: { permissions: { has: () => true } },
          fetch: jest.fn(async () => ({ id: "u1", displayName: "Ann" })),
        },
      };

      await (manager as any).createDynamicChannelUnlocked(guild, "u1");

      const arg = (create.mock.calls[0] as unknown[])[0] as {
        permissionOverwrites: Array<{ id: string; allow: unknown[] }>;
      };
      const own = arg.permissionOverwrites.find((o) => o.id === "u1")!;
      expect(own.allow).toEqual(
        expect.arrayContaining(["ManageChannels", "SetVoiceChannelStatus"]),
      );
    });

    it("createDynamicChannel omits the grant when the bot lacks it", async () => {
      const { create, member } = lobbyFixture(false);
      const guild = {
        ...member.guild,
        roles: { everyone: { id: "everyone" } },
        members: {
          me: { permissions: { has: () => false } },
          fetch: jest.fn(async () => ({ id: "u1", displayName: "Ann" })),
        },
      };

      await (manager as any).createDynamicChannelUnlocked(guild, "u1");

      const arg = (create.mock.calls[0] as unknown[])[0] as {
        permissionOverwrites: Array<{ id: string; allow: unknown[] }>;
      };
      expect(
        arg.permissionOverwrites.find((o) => o.id === "u1")!.allow,
      ).not.toContain("SetVoiceChannelStatus");
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
  it("automatic transfer (updateChannelOwnership) grants the new owner and deletes the old owner's overwrite", async () => {
    const create = jest.fn(async () => undefined);
    const del = jest.fn(async () => undefined);
    const channel: any = {
      id: "c",
      name: "Room",
      guild: guildHolding(true),
      permissionOverwrites: {
        create,
        delete: del,
        cache: new Map([
          [
            "old",
            {
              allow: {
                has: (f: bigint) =>
                  f === PermissionFlagsBits.SetVoiceChannelStatus,
              },
            },
          ],
        ]),
      },
      permissionsFor: () => ({ has: () => true }),
      setName: jest.fn(async () => undefined),
      send: jest.fn(async () => undefined),
    };
    (manager as any).userChannels.set("old", channel);
    (manager as any).customChannelNames.set("c", "custom");
    (manager as any).updateControlPanelOwnership = jest.fn(
      async () => undefined,
    );
    (manager as any).persistOwnership = jest.fn(async () => undefined);

    await (manager as any).updateChannelOwnership(channel, {
      id: "new",
      displayName: "New",
    });

    expect(create).toHaveBeenCalledWith(
      "new",
      expect.objectContaining({
        ManageChannels: true,
        SetVoiceChannelStatus: true,
      }),
    );
    expect(del).toHaveBeenCalledWith("old", expect.any(String));
    expect((create.mock.calls as unknown[][]).some((c) => c[0] === "old")).toBe(
      false,
    );
  });
});
