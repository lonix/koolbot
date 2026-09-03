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

const LOBBY_NAME = "🟢 Lobby";
const OFFLINE_LOBBY_NAME = "🔴 Lobby";

/**
 * Regression coverage for issue #843: when the startup rename from the
 * offline lobby name to the online name fails (unresolvable category, missing
 * Manage Channels), the lobby is still named `voicechannels.lobby.offlinename`
 * when the 5-minute sweep runs. The sweep used to treat that name as
 * "unmanaged" and delete the channel — members included. The lobby must be
 * protected in both states, no occupied channel may ever be deleted by the
 * sweep, and a failed startup rename must pause the sweep (and be retried)
 * rather than silently proceed.
 */
describe("VoiceChannelManager - offline lobby survives the unmanaged sweep (issue #843)", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;
  let offlineLobby: Partial<VoiceChannel>;
  let occupiedForeign: Partial<VoiceChannel>;
  let emptyForeign: Partial<VoiceChannel>;
  let channels: Collection<string, VoiceChannel>;
  let categoryId: string;
  let guild: Partial<Guild>;

  const makeMember = (id: string, bot = false) =>
    ({
      id,
      user: { bot, tag: `${id}#0001` },
      displayName: id,
      voice: { setChannel: jest.fn<any>().mockResolvedValue(undefined) },
    }) as any;

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;
    categoryId = "category-id";

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
            return Promise.resolve(LOBBY_NAME);
          case "voicechannels.lobby.offlinename":
            return Promise.resolve(OFFLINE_LOBBY_NAME);
          case "voicechannels.category_id":
            return Promise.resolve(categoryId);
          case "voicechannels.channel.prefix":
            return Promise.resolve("🎮");
          default:
            return Promise.resolve(defaultValue ?? "");
        }
      });

    // The lobby, still carrying its offline name because the startup rename
    // never happened. Somebody is sitting in it.
    offlineLobby = {
      id: "lobby-id",
      name: OFFLINE_LOBBY_NAME,
      type: ChannelType.GuildVoice,
      members: new Collection([["alice-id", makeMember("alice-id")]]),
      delete: jest.fn<any>().mockResolvedValue(undefined),
      // Like the real thing, a successful rename changes the channel's name.
      setName: jest.fn<any>().mockImplementation(async (name: string) => {
        (offlineLobby as any).name = name;
      }),
    } as any;

    // A foreign channel the bot does not manage, with someone inside.
    occupiedForeign = {
      id: "occupied-foreign-id",
      name: "Somebody's Hangout",
      type: ChannelType.GuildVoice,
      members: new Collection([["bob-id", makeMember("bob-id")]]),
      delete: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    // A foreign channel the bot does not manage, empty.
    emptyForeign = {
      id: "empty-foreign-id",
      name: "Leftover Channel",
      type: ChannelType.GuildVoice,
      members: new Collection(),
      delete: jest.fn<any>().mockResolvedValue(undefined),
    } as any;

    channels = new Collection<string, VoiceChannel>();
    channels.set(offlineLobby.id as string, offlineLobby as VoiceChannel);
    channels.set(occupiedForeign.id as string, occupiedForeign as VoiceChannel);
    channels.set(emptyForeign.id as string, emptyForeign as VoiceChannel);

    const category = {
      id: "category-id",
      type: ChannelType.GuildCategory,
      children: { cache: channels },
    };

    guild = {
      id: "guild-id",
      channels: {
        cache: new Collection([["category-id", category]]),
        create: jest
          .fn<any>()
          .mockImplementation(async (options: { name: string }) => ({
            id: `created-${options.name}`,
            name: options.name,
          })),
      } as any,
      members: {
        fetch: jest
          .fn<any>()
          .mockImplementation(async (id: string) =>
            [offlineLobby, occupiedForeign]
              .flatMap((c) => Array.from((c.members as any).values()))
              .find((m: any) => m.id === id),
          ),
      } as any,
      roles: { everyone: { id: "everyone-id" } } as any,
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

  describe("cleanupEmptyChannels", () => {
    it("never deletes the occupied offline-named lobby", async () => {
      await manager.cleanupEmptyChannels();

      expect(offlineLobby.delete).not.toHaveBeenCalled();
      // With no online lobby present, the sweep's ensureLobbyChannelExists()
      // step brings the surviving offline lobby back online instead.
      expect(offlineLobby.setName).toHaveBeenCalledWith(
        LOBBY_NAME,
        expect.any(String),
      );
      expect((guild.channels as any).create).not.toHaveBeenCalled();
    });

    it("never deletes the empty offline-named lobby either", async () => {
      Object.defineProperty(offlineLobby, "members", {
        value: new Collection(),
        writable: true,
      });

      await manager.cleanupEmptyChannels();

      expect(offlineLobby.delete).not.toHaveBeenCalled();
      expect(offlineLobby.setName).toHaveBeenCalledWith(
        LOBBY_NAME,
        expect.any(String),
      );
    });

    it("keeps an occupied unmanaged channel and only removes empty ones", async () => {
      await expect(manager.cleanupEmptyChannels()).resolves.toBe(true);

      expect(occupiedForeign.delete).not.toHaveBeenCalled();
      expect(emptyForeign.delete).toHaveBeenCalledWith(
        "Bot cleanup - unmanaged channel",
      );
    });

    it("removes an unmanaged channel on a later sweep once it has emptied", async () => {
      await manager.cleanupEmptyChannels();
      expect(occupiedForeign.delete).not.toHaveBeenCalled();

      Object.defineProperty(occupiedForeign, "members", {
        value: new Collection(),
        writable: true,
      });
      await manager.cleanupEmptyChannels();

      expect(occupiedForeign.delete).toHaveBeenCalled();
    });
  });

  describe("renameLobbyToOnline", () => {
    it("returns true when the offline lobby is renamed", async () => {
      await expect(manager.renameLobbyToOnline(guild as Guild)).resolves.toBe(
        true,
      );
      expect(offlineLobby.setName).toHaveBeenCalledWith(
        LOBBY_NAME,
        "Bot starting up",
      );
    });

    it("returns false when the rename fails (e.g. missing Manage Channels)", async () => {
      (offlineLobby.setName as jest.Mock<any>).mockRejectedValue(
        new Error("Missing Permissions"),
      );

      await expect(manager.renameLobbyToOnline(guild as Guild)).resolves.toBe(
        false,
      );
    });

    it("returns false when there is no offline lobby and the lobby cannot be created", async () => {
      // No lobby of either name in the category, and creating one fails
      // (e.g. missing Manage Channels). ensureLobbyChannelExists() swallows
      // that error, so the rename must key off its result, not off "no throw".
      channels.delete(offlineLobby.id as string);
      ((guild.channels as any).create as jest.Mock<any>).mockRejectedValue(
        new Error("Missing Permissions"),
      );

      await expect(manager.renameLobbyToOnline(guild as Guild)).resolves.toBe(
        false,
      );
      // ...and the sweep stays paused as a result.
      await expect(manager.cleanupEmptyChannels()).resolves.toBe(false);
      expect(emptyForeign.delete).not.toHaveBeenCalled();
    });

    it("returns false when the managed category does not resolve", async () => {
      categoryId = "does-not-exist";

      await expect(manager.renameLobbyToOnline(guild as Guild)).resolves.toBe(
        false,
      );
      expect(offlineLobby.setName).not.toHaveBeenCalled();
    });
  });

  describe("members found in the offline lobby", () => {
    // Persisting ownership hits Mongo; not under test here.
    beforeEach(() => {
      jest
        .spyOn(manager as any, "persistOwnership")
        .mockResolvedValue(undefined);
      jest
        .spyOn(manager as any, "sendControlPanel")
        .mockResolvedValue(undefined);
    });

    it("moves everyone into one shared channel owned by a random member", async () => {
      const alice = (offlineLobby.members as any).get("alice-id");
      const bob = makeMember("bob-id");
      const carol = makeMember("carol-id");
      const bot = makeMember("bot-id", true);
      Object.defineProperty(offlineLobby, "members", {
        value: new Collection([
          ["alice-id", alice],
          ["bob-id", bob],
          ["carol-id", carol],
          ["bot-id", bot],
        ]),
        writable: true,
      });

      await expect(manager.renameLobbyToOnline(guild as Guild)).resolves.toBe(
        true,
      );

      // Exactly one dynamic channel is created (no lobby is created because
      // the offline lobby is renamed instead).
      const create = (guild.channels as any).create as jest.Mock<any>;
      expect(create).toHaveBeenCalledTimes(1);
      const createdName = create.mock.calls[0][0].name as string;
      const sharedId = `created-${createdName}`;

      // It belongs to one of the humans, and that human is the tracked owner.
      const owner = [alice, bob, carol].find((m) =>
        createdName.includes(m.displayName),
      );
      expect(owner).toBeDefined();
      expect((manager as any).userChannels.get(owner.id)?.id).toBe(sharedId);

      // All three humans end up in that same channel; the bot is left alone.
      for (const member of [alice, bob, carol]) {
        expect(member.voice.setChannel).toHaveBeenCalledWith(sharedId);
      }
      expect(bot.voice.setChannel).not.toHaveBeenCalled();
    });

    it("moves the owner into the channel first", async () => {
      const alice = (offlineLobby.members as any).get("alice-id");
      const bob = makeMember("bob-id");
      Object.defineProperty(offlineLobby, "members", {
        value: new Collection([
          ["alice-id", alice],
          ["bob-id", bob],
        ]),
        writable: true,
      });
      // Force bob (index 1) to be picked as the host.
      jest.spyOn(manager as any, "pickRandomIndex").mockReturnValue(1);

      await manager.renameLobbyToOnline(guild as Guild);

      const create = (guild.channels as any).create as jest.Mock<any>;
      expect(create.mock.calls[0][0].name).toContain("bob-id");
      expect(bob.voice.setChannel.mock.invocationCallOrder[0]).toBeLessThan(
        alice.voice.setChannel.mock.invocationCallOrder[0],
      );
    });

    it("keeps going when one member cannot be moved", async () => {
      const alice = (offlineLobby.members as any).get("alice-id");
      const bob = makeMember("bob-id");
      bob.voice.setChannel.mockRejectedValue(new Error("stale voice state"));
      Object.defineProperty(offlineLobby, "members", {
        value: new Collection([
          ["alice-id", alice],
          ["bob-id", bob],
        ]),
        writable: true,
      });

      await expect(manager.renameLobbyToOnline(guild as Guild)).resolves.toBe(
        true,
      );

      expect(alice.voice.setChannel).toHaveBeenCalled();
      expect(offlineLobby.setName).toHaveBeenCalledWith(
        LOBBY_NAME,
        "Bot starting up",
      );
    });

    it("leaves members in place when the shared channel cannot be created", async () => {
      const alice = (offlineLobby.members as any).get("alice-id");
      ((guild.channels as any).create as jest.Mock<any>).mockRejectedValue(
        new Error("Missing Permissions"),
      );

      await manager.renameLobbyToOnline(guild as Guild);

      expect(alice.voice.setChannel).not.toHaveBeenCalled();
    });
  });

  describe("health check", () => {
    beforeEach(() => {
      jest
        .spyOn(manager as any, "persistOwnership")
        .mockResolvedValue(undefined);
      jest
        .spyOn(manager as any, "sendControlPanel")
        .mockResolvedValue(undefined);
    });

    it("deletes the offline lobby only once everyone has been moved out", async () => {
      const alice = (offlineLobby.members as any).get("alice-id");
      // A successful move empties the channel, as Discord would.
      alice.voice.setChannel.mockImplementation(async () => {
        Object.defineProperty(offlineLobby, "members", {
          value: new Collection(),
          writable: true,
        });
      });

      await (manager as any).checkLobbyHealth();

      expect(alice.voice.setChannel).toHaveBeenCalled();
      expect(offlineLobby.delete).toHaveBeenCalledWith("Health check cleanup");
    });

    it("leaves the offline lobby in place when a member could not be moved", async () => {
      const alice = (offlineLobby.members as any).get("alice-id");
      alice.voice.setChannel.mockRejectedValue(new Error("stale voice state"));

      await (manager as any).checkLobbyHealth();

      // Deleting it here would disconnect alice, so it must survive.
      expect(offlineLobby.delete).not.toHaveBeenCalled();
    });

    it("leaves the offline lobby in place when the shared channel cannot be created", async () => {
      ((guild.channels as any).create as jest.Mock<any>).mockRejectedValue(
        new Error("Missing Permissions"),
      );

      await (manager as any).checkLobbyHealth();

      expect(offlineLobby.delete).not.toHaveBeenCalled();
    });

    it("deletes an offline lobby that only ever held bots", async () => {
      Object.defineProperty(offlineLobby, "members", {
        value: new Collection([["bot-id", makeMember("bot-id", true)]]),
        writable: true,
      });

      await (manager as any).checkLobbyHealth();

      expect(offlineLobby.delete).toHaveBeenCalledWith("Health check cleanup");
    });
  });

  describe("sweep after a failed startup rename", () => {
    it("retries the rename and skips the sweep while it still fails", async () => {
      (offlineLobby.setName as jest.Mock<any>).mockRejectedValue(
        new Error("Missing Permissions"),
      );
      await expect(manager.renameLobbyToOnline(guild as Guild)).resolves.toBe(
        false,
      );

      // The sweep reports that it was skipped (the Web UI surfaces this).
      await expect(manager.cleanupEmptyChannels()).resolves.toBe(false);

      // The rename was retried by the sweep...
      expect(offlineLobby.setName).toHaveBeenCalledTimes(2);
      // ...and, because it still failed, nothing at all was deleted.
      expect(offlineLobby.delete).not.toHaveBeenCalled();
      expect(occupiedForeign.delete).not.toHaveBeenCalled();
      expect(emptyForeign.delete).not.toHaveBeenCalled();
    });

    it("resumes sweeping once the retried rename succeeds", async () => {
      // Fails once (startup), then falls back to the renaming default.
      (offlineLobby.setName as jest.Mock<any>).mockRejectedValueOnce(
        new Error("Missing Permissions"),
      );
      await expect(manager.renameLobbyToOnline(guild as Guild)).resolves.toBe(
        false,
      );

      await manager.cleanupEmptyChannels();

      expect(offlineLobby.setName).toHaveBeenCalledTimes(2);
      expect(offlineLobby.delete).not.toHaveBeenCalled();
      expect(emptyForeign.delete).toHaveBeenCalled();

      // A subsequent sweep no longer needs to retry the rename.
      await manager.cleanupEmptyChannels();
      expect(offlineLobby.setName).toHaveBeenCalledTimes(2);
    });

    it("pauses when the lobby cannot be ensured at the end of a sweep", async () => {
      // Startup was fine, but by sweep time the offline lobby can no longer
      // be renamed and no lobby can be created (e.g. Manage Channels was
      // revoked). The sweep must report failure and pause itself.
      (offlineLobby.setName as jest.Mock<any>).mockRejectedValue(
        new Error("Missing Permissions"),
      );
      ((guild.channels as any).create as jest.Mock<any>).mockRejectedValue(
        new Error("Missing Permissions"),
      );

      await expect(manager.cleanupEmptyChannels()).resolves.toBe(false);
      expect((manager as any).lobbyOnlineRenameFailed).toBe(true);

      // The next sweep retries the rename first and stays paused while it
      // still fails: nothing else is touched.
      emptyForeign.delete = jest.fn<any>().mockResolvedValue(undefined);
      await expect(manager.cleanupEmptyChannels()).resolves.toBe(false);
      expect(emptyForeign.delete).not.toHaveBeenCalled();
    });

    it("keeps sweeping normally when the startup rename succeeded", async () => {
      await expect(manager.renameLobbyToOnline(guild as Guild)).resolves.toBe(
        true,
      );
      (offlineLobby.setName as jest.Mock<any>).mockClear();

      await manager.cleanupEmptyChannels();

      expect(emptyForeign.delete).toHaveBeenCalled();
    });
  });
});
