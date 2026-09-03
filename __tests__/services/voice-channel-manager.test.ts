/**
 * `VoiceChannelManager` — ownership queue, lobby join, session accounting.
 *
 * This file used to be a single `expect(true).toBe(true)` squatting on the
 * obvious filename for one of the largest services in the repo, which made
 * the gap invisible when scanning the test directory (issue #849). The
 * lifecycle paths are covered by the focused `voice-channel-manager-*`
 * suites next to this one; what was left untested is the surface below —
 * the singleton contract, the ownership request queue, the lobby-join
 * hand-off, and the counters the `/admin` dashboard and the
 * `koolbot_voice_sessions_active` metric read.
 */

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
} from "discord.js";

/** Config values the manager reads, keyed by config key. */
let configValues: Record<string, string> = {};

// `voice-channel-manager.ts` captures a module-level
// `ConfigService.getInstance()` at import time (used by
// `resolveManagedCategory`), so the mock has to be registered *before* the
// module is evaluated — hence `unstable_mockModule` plus a dynamic import
// rather than a plain automock.
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getNumber: jest.fn(async () => 0),
      getString: jest.fn(async (key: string, fallback = "") =>
        key in configValues ? configValues[key] : fallback,
      ),
      registerReloadCallback: jest.fn(),
    }),
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
  VoiceChannelTracker: { getInstance: (): unknown => ({}) },
}));

const { VoiceChannelManager } =
  await import("../../src/services/voice-channel-manager.js");
type Manager = InstanceType<typeof VoiceChannelManager>;

function makeClient(overrides: Record<string, unknown> = {}): Client {
  return {
    user: { id: "bot-user-id" },
    channels: { cache: new Map() },
    guilds: { fetch: jest.fn() },
    ...overrides,
  } as unknown as Client;
}

describe("VoiceChannelManager", () => {
  let client: Client;
  let manager: Manager;

  beforeEach(() => {
    jest.clearAllMocks();
    configValues = { "voicechannels.lobby.name": "Lobby" };
    VoiceChannelManager.reset();
    client = makeClient();
    manager = VoiceChannelManager.getInstance(client);
  });

  afterEach(() => {
    VoiceChannelManager.reset();
  });

  describe("singleton contract", () => {
    it("returns the same instance for the same client", () => {
      expect(VoiceChannelManager.getInstance(client)).toBe(manager);
    });

    it("refuses to hand back an instance bound to a different client", () => {
      // Silently re-binding would leave the periodic sweeps talking to a
      // dead gateway connection.
      expect(() => VoiceChannelManager.getInstance(makeClient())).toThrow(
        /different client/,
      );
    });

    it("builds a fresh instance after reset()", () => {
      VoiceChannelManager.reset();
      const other = makeClient();
      expect(VoiceChannelManager.getInstance(other)).not.toBe(manager);
    });
  });

  describe("session accounting", () => {
    it("starts with no managed channels", () => {
      expect(manager.getActiveSessionCount()).toBe(0);
      expect(manager.getUserChannel("user-1")).toBeUndefined();
    });

    it("counts one active session per owned channel", () => {
      const owned = new Map<string, { id: string }>([
        ["user-1", { id: "channel-1" }],
        ["user-2", { id: "channel-2" }],
      ]);
      (manager as unknown as { userChannels: unknown }).userChannels = owned;

      expect(manager.getActiveSessionCount()).toBe(2);
      expect(manager.getUserChannel("user-1")).toMatchObject({
        id: "channel-1",
      });
    });

    it("clears its in-memory state on destroy()", () => {
      (
        manager as unknown as { userChannels: Map<string, unknown> }
      ).userChannels.set("user-1", { id: "channel-1" });
      manager.setCustomChannelName("channel-1", "Custom");
      manager.setLiveStatus("channel-1", true);

      manager.destroy();

      expect(manager.getActiveSessionCount()).toBe(0);
      expect(manager.hasCustomName("channel-1")).toBe(false);
    });
  });

  describe("custom names and live status", () => {
    it("remembers a custom name until it is cleared", () => {
      expect(manager.hasCustomName("channel-1")).toBe(false);
      manager.setCustomChannelName("channel-1", "Game Night");
      expect(manager.hasCustomName("channel-1")).toBe(true);
      expect(manager.getCustomChannelName("channel-1")).toBe("Game Night");
    });

    it("tracks live status per channel", () => {
      expect(manager.isLive("channel-1")).toBe(false);
      manager.setLiveStatus("channel-1", true);
      expect(manager.isLive("channel-1")).toBe(true);
      expect(manager.isLive("channel-2")).toBe(false);
      manager.setLiveStatus("channel-1", false);
      expect(manager.isLive("channel-1")).toBe(false);
    });
  });

  describe("requestOwnership", () => {
    function queueFor(channelId: string): string[] | undefined {
      return (
        manager as unknown as { ownershipQueue: Map<string, string[]> }
      ).ownershipQueue.get(channelId);
    }

    it("queues the requester and notifies the channel when the owner is present", async () => {
      const send = jest.fn(async () => undefined);
      const channel = {
        id: "channel-1",
        send,
        members: new Map([["owner-1", { id: "owner-1" }]]),
      };
      (client.channels.cache as Map<string, unknown>).set("channel-1", channel);
      (
        manager as unknown as { userChannels: Map<string, unknown> }
      ).userChannels.set("owner-1", channel);

      await manager.requestOwnership("channel-1", "user-2");

      expect(queueFor("channel-1")).toEqual(["user-2"]);
      expect(send).toHaveBeenCalledWith(
        expect.stringContaining("<@user-2> has requested ownership"),
      );
    });

    it("does not queue the same user twice or re-notify", async () => {
      const send = jest.fn(async () => undefined);
      const channel = {
        id: "channel-1",
        send,
        members: new Map([["owner-1", { id: "owner-1" }]]),
      };
      (client.channels.cache as Map<string, unknown>).set("channel-1", channel);
      (
        manager as unknown as { userChannels: Map<string, unknown> }
      ).userChannels.set("owner-1", channel);

      await manager.requestOwnership("channel-1", "user-2");
      await manager.requestOwnership("channel-1", "user-2");

      expect(queueFor("channel-1")).toEqual(["user-2"]);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("still queues the request when the channel isn't cached", async () => {
      await manager.requestOwnership("channel-unknown", "user-2");
      expect(queueFor("channel-unknown")).toEqual(["user-2"]);
    });

    it("swallows a failed notification rather than losing the request", async () => {
      const channel = {
        id: "channel-1",
        send: jest.fn(async () => {
          throw new Error("Missing Permissions");
        }),
        members: new Map([["owner-1", { id: "owner-1" }]]),
      };
      (client.channels.cache as Map<string, unknown>).set("channel-1", channel);
      (
        manager as unknown as { userChannels: Map<string, unknown> }
      ).userChannels.set("owner-1", channel);

      await expect(
        manager.requestOwnership("channel-1", "user-2"),
      ).resolves.toBeUndefined();
      expect(queueFor("channel-1")).toEqual(["user-2"]);
    });
  });

  describe("handleLobbyJoin", () => {
    function makeMember(): {
      id: string;
      user: { username: string };
      guild: Guild;
      voice: { setChannel: jest.Mock };
    } {
      return {
        id: "user-1",
        user: { username: "alice" },
        guild: { id: "guild-1" } as unknown as Guild,
        voice: { setChannel: jest.fn(async () => undefined) },
      };
    }

    it("ignores a join to a channel that isn't the configured lobby", async () => {
      const createSpy = jest
        .spyOn(manager, "createDynamicChannel")
        .mockResolvedValue(null);
      const member = makeMember();

      await manager.handleLobbyJoin(
        member as never,
        { name: "Offline Lobby" } as VoiceChannel,
      );

      expect(createSpy).not.toHaveBeenCalled();
      expect(member.voice.setChannel).not.toHaveBeenCalled();
    });

    it("creates a dynamic channel and moves the member into it", async () => {
      const created = { id: "channel-new", name: "alice's channel" };
      jest
        .spyOn(manager, "createDynamicChannel")
        .mockResolvedValue(created as unknown as VoiceChannel);
      const member = makeMember();

      await manager.handleLobbyJoin(
        member as never,
        { name: "Lobby" } as VoiceChannel,
      );

      expect(manager.createDynamicChannel).toHaveBeenCalledWith(
        member.guild,
        "user-1",
      );
      expect(member.voice.setChannel).toHaveBeenCalledWith("channel-new");
    });

    it("does not try to move the member when channel creation failed", async () => {
      jest.spyOn(manager, "createDynamicChannel").mockResolvedValue(null);
      const member = makeMember();

      await manager.handleLobbyJoin(
        member as never,
        { name: "Lobby" } as VoiceChannel,
      );

      expect(member.voice.setChannel).not.toHaveBeenCalled();
    });

    it("survives a move that Discord rejects", async () => {
      jest
        .spyOn(manager, "createDynamicChannel")
        .mockResolvedValue({ id: "channel-new" } as unknown as VoiceChannel);
      const member = makeMember();
      member.voice.setChannel.mockRejectedValue(new Error("Missing Access"));

      await expect(
        manager.handleLobbyJoin(
          member as never,
          {
            name: "Lobby",
          } as VoiceChannel,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("getTotalVcUserCount", () => {
    /** Wire the client so `getGuild` + `resolveManagedCategory` resolve. */
    function withCategory(children: unknown[]): void {
      configValues["GUILD_ID"] = "guild-1";
      configValues["voicechannels.category_id"] = "category-1";
      const guild = {
        id: "guild-1",
        channels: {
          cache: new Map<string, unknown>([
            [
              "category-1",
              {
                type: ChannelType.GuildCategory,
                children: {
                  cache: new Map(children.map((c, i) => [String(i), c])),
                },
              },
            ],
          ]),
        },
      };
      (client.guilds.fetch as jest.Mock).mockResolvedValue(guild as never);
    }

    it("returns 0 when GUILD_ID is unset", async () => {
      await expect(manager.getTotalVcUserCount()).resolves.toBe(0);
      expect(client.guilds.fetch).not.toHaveBeenCalled();
    });

    it("returns 0 when the guild cannot be fetched", async () => {
      configValues["GUILD_ID"] = "guild-1";
      (client.guilds.fetch as jest.Mock).mockRejectedValue(
        new Error("Missing Access") as never,
      );
      await expect(manager.getTotalVcUserCount()).resolves.toBe(0);
    });

    it("returns 0 when no managed category is configured", async () => {
      configValues["GUILD_ID"] = "guild-1";
      (client.guilds.fetch as jest.Mock).mockResolvedValue({
        id: "guild-1",
        channels: { cache: new Map() },
      } as never);
      await expect(manager.getTotalVcUserCount()).resolves.toBe(0);
    });

    it("sums the members of the category's voice channels only", async () => {
      withCategory([
        { type: ChannelType.GuildVoice, members: { size: 3 } },
        { type: ChannelType.GuildVoice, members: { size: 2 } },
        // A text channel in the same category must not be counted.
        { type: ChannelType.GuildText, members: { size: 99 } },
      ]);
      await expect(manager.getTotalVcUserCount()).resolves.toBe(5);
    });

    it("returns 0 rather than throwing when the category lookup blows up", async () => {
      configValues["GUILD_ID"] = "guild-1";
      configValues["voicechannels.category_id"] = "category-1";
      (client.guilds.fetch as jest.Mock).mockResolvedValue({
        id: "guild-1",
        get channels(): never {
          throw new Error("cache unavailable");
        },
      } as never);
      await expect(manager.getTotalVcUserCount()).resolves.toBe(0);
    });
  });
});
