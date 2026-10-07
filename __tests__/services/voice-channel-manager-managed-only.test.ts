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
import { VoiceChannelOwnership } from "../../src/models/voice-channel-ownership.js";
import {
  ManagedVoiceChannel,
  ManagedVoiceMigration,
} from "../../src/models/managed-voice-channel.js";

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;

type Row = {
  guildId: string;
  channelId: string;
  kind?: string;
  source?: string;
};

/**
 * Issue #1032: with `voicechannels.cleanup.managed_only` on, startup and
 * periodic cleanup delete only channels KoolBot created (tracked by ID, in the
 * database), so an existing shared category can be adopted safely. With it off
 * the legacy "delete every empty channel" behaviour is unchanged.
 */
describe("VoiceChannelManager - managed-only cleanup (issue #1032)", () => {
  const GUILD_ID = "guild-id";
  const CATEGORY_ID = "category-id";

  let settings: Record<string, string | boolean>;
  let managedStore: Map<string, Row>;
  let ownershipStore: Map<string, Row>;
  let migrationStore: Map<string, { guildId: string; adoptedCount: number }>;
  let channelSeq: number;

  let manager: VoiceChannelManager;
  let guild: Guild;
  let category: { id: string; children: { cache: Collection<string, any> } };
  let guildChannels: Collection<string, any>;
  let mockClient: Partial<Client>;

  function makeChannel(
    id: string,
    name: string,
    memberCount = 0,
  ): VoiceChannel {
    const members = new Collection<string, any>();
    for (let i = 0; i < memberCount; i++) {
      members.set(`m-${id}-${i}`, { user: { bot: false } });
    }
    const channel: any = {
      id,
      name,
      type: ChannelType.GuildVoice,
      members,
      guild: undefined,
      setName: jest.fn<any>().mockImplementation(async (n: string) => {
        channel.name = n;
      }),
      delete: jest.fn<any>().mockImplementation(async () => {
        guildChannels.delete(id);
        category.children.cache.delete(id);
      }),
    };
    return channel as VoiceChannel;
  }

  /** Add a channel to the guild and the managed category. */
  function addChannel(id: string, name: string, memberCount = 0): any {
    const channel: any = makeChannel(id, name, memberCount);
    channel.guild = guild;
    guildChannels.set(id, channel);
    category.children.cache.set(id, channel);
    return channel;
  }

  /** Pretend this guild's naming-pattern migration already ran. */
  function markMigrated(): void {
    migrationStore.set(GUILD_ID, { guildId: GUILD_ID, adoptedCount: 0 });
  }

  function trackAsManaged(channelId: string): void {
    managedStore.set(channelId, {
      guildId: GUILD_ID,
      channelId,
      kind: "channel",
      source: "created",
    });
  }

  function newManager(): VoiceChannelManager {
    (VoiceChannelManager as any).instance = undefined;
    const m = VoiceChannelManager.getInstance(mockClient as Client);
    jest.spyOn(m as any, "isDbReady").mockReturnValue(true);
    return m;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;
    channelSeq = 0;

    settings = {
      "voicechannels.enabled": true,
      "voicechannels.cleanup.managed_only": false,
      GUILD_ID,
      "voicechannels.category_id": CATEGORY_ID,
      "voicechannels.lobby.name": "Lobby",
      "voicechannels.lobby.offlinename": "Lobby (Offline)",
      "voicechannels.lobby.channel_id": "",
      "voicechannels.channel.prefix": "🎮",
      "voicechannels.channel.suffix": "'s Room",
    };
    mockConfigService.getBoolean = jest
      .fn<any>()
      .mockImplementation((key: string, def?: boolean) =>
        Promise.resolve(
          typeof settings[key] === "boolean"
            ? (settings[key] as boolean)
            : (def ?? false),
        ),
      );
    mockConfigService.getString = jest
      .fn<any>()
      .mockImplementation((key: string, def?: string) =>
        Promise.resolve(
          typeof settings[key] === "string"
            ? (settings[key] as string)
            : (def ?? ""),
        ),
      );

    // In-memory fakes for the three collections, so state survives a
    // simulated restart (a new manager instance over the same stores).
    managedStore = new Map();
    ownershipStore = new Map();
    migrationStore = new Map();
    // The global mongoose mock (__tests__/setup.ts) hands every model the SAME
    // stub object, so one set of methods serves all three collections. Route
    // each call to the right in-memory store by its shape:
    //  - find(): a projection with `ownerId` is the ownership lookup used by
    //    the managed-set loader; a projection without it is the managed set;
    //    no projection is restoreOwnership's ownership read.
    //  - updateOne(): `$setOnInsert.kind` = managed row, `.adoptedCount` =
    //    migration marker, `$set` = ownership custom-name update (ignored).
    //  - findOne() is only used for the migration marker.
    //  - deleteOne() runs against both stores (the code calls it per model).
    const stub = ManagedVoiceChannel as unknown as Record<string, jest.Mock>;
    expect(VoiceChannelOwnership as unknown).toBe(ManagedVoiceChannel);
    expect(ManagedVoiceMigration as unknown).toBe(ManagedVoiceChannel);
    stub.find = jest
      .fn<any>()
      .mockImplementation(async (filter: any, projection?: any) => {
        const store =
          projection && !projection.ownerId ? managedStore : ownershipStore;
        return [...store.values()].filter((r) => r.guildId === filter.guildId);
      });
    stub.updateOne = jest
      .fn<any>()
      .mockImplementation(async (filter: any, update: any) => {
        const insert = update.$setOnInsert;
        if (insert?.adoptedCount !== undefined) {
          if (!migrationStore.has(filter.guildId)) {
            migrationStore.set(filter.guildId, { ...insert });
          }
        } else if (insert?.kind !== undefined) {
          if (!managedStore.has(filter.channelId)) {
            managedStore.set(filter.channelId, { ...insert });
          }
        }
      });
    stub.findOne = jest
      .fn<any>()
      .mockImplementation(
        async (filter: any) => migrationStore.get(filter.guildId) ?? null,
      );
    stub.findOneAndUpdate = jest
      .fn<any>()
      .mockImplementation(async (filter: any, update: any) => {
        ownershipStore.set(filter.channelId, {
          ...update.$setOnInsert,
        } as Row);
      });
    stub.deleteOne = jest.fn<any>().mockImplementation(async (filter: any) => {
      managedStore.delete(filter.channelId);
      ownershipStore.delete(filter.channelId);
    });

    guildChannels = new Collection();
    category = { id: CATEGORY_ID, children: { cache: new Collection() } };
    Object.assign(category, {
      type: ChannelType.GuildCategory,
      name: "Voice Chat",
    });
    guildChannels.set(CATEGORY_ID, category);

    guild = {
      id: GUILD_ID,
      channels: {
        cache: guildChannels,
        create: jest.fn<any>().mockImplementation(async (opts: any) => {
          const channel = addChannel(`created-${++channelSeq}`, opts.name);
          return channel;
        }),
      },
      members: {
        fetch: jest.fn<any>().mockImplementation(async (id: string) => ({
          id,
          displayName: "Alice",
        })),
      },
      roles: { everyone: { id: "everyone" } },
    } as unknown as Guild;

    mockClient = {
      guilds: { fetch: jest.fn<any>().mockResolvedValue(guild) } as any,
      channels: { cache: new Collection(), fetch: jest.fn() } as any,
    } as any;

    manager = newManager();
  });

  afterEach(() => {
    (VoiceChannelManager as any).instance = undefined;
    jest.restoreAllMocks();
  });

  describe("toggle OFF (legacy behaviour unchanged)", () => {
    it("startup deletes every empty non-lobby channel in the category", async () => {
      const lobby = addChannel("lobby-id", "Lobby");
      const foreign = addChannel("foreign-id", "➕ Click To Create VC");
      const permanent = addChannel("perm-id", "Permanent Room");
      const occupied = addChannel("occ-id", "Busy Room", 2);

      await manager.initialize(GUILD_ID);

      expect(foreign.delete).toHaveBeenCalled();
      expect(permanent.delete).toHaveBeenCalled();
      expect(lobby.delete).not.toHaveBeenCalled();
      expect(occupied.delete).not.toHaveBeenCalled();
      // The managed-set loader (projected find) and the migration are never
      // consulted for the legacy sweep.
      const stub = ManagedVoiceChannel as unknown as { find: jest.Mock };
      expect(
        stub.find.mock.calls.filter((call) => call[1] !== undefined),
      ).toHaveLength(0);
      expect(ManagedVoiceMigration.findOne).not.toHaveBeenCalled();
    });

    it("periodic cleanup still deletes empty unmanaged channels", async () => {
      addChannel("lobby-id", "Lobby");
      const foreign = addChannel("foreign-id", "Permanent Room");

      expect(await manager.cleanupEmptyChannels()).toBe(true);

      expect(foreign.delete).toHaveBeenCalled();
    });

    it("periodic cleanup treats prefix-named channels as managed", async () => {
      addChannel("lobby-id", "Lobby");
      const prefixed = addChannel("p-id", "🎮 Bob's Room");

      await manager.cleanupEmptyChannels();

      expect(prefixed.delete).toHaveBeenCalledWith(
        "Bot cleanup - empty managed channel",
      );
    });
  });

  describe("toggle ON", () => {
    beforeEach(() => {
      settings["voicechannels.cleanup.managed_only"] = true;
      markMigrated();
    });

    it("startup deletes only empty channels KoolBot created", async () => {
      const lobby = addChannel("lobby-id", "Lobby");
      const joinToCreate = addChannel("foreign-id", "➕ Click To Create VC");
      const permanent = addChannel("perm-id", "Permanent Room");
      const lookalike = addChannel("look-id", "🎮 Permanent Gaming");
      const mine = addChannel("mine-id", "🎮 Alice's Room");
      const busyMine = addChannel("busy-id", "🎮 Carol's Room", 1);
      trackAsManaged("mine-id");
      trackAsManaged("busy-id");

      await manager.initialize(GUILD_ID);

      expect(mine.delete).toHaveBeenCalled();
      expect(joinToCreate.delete).not.toHaveBeenCalled();
      expect(permanent.delete).not.toHaveBeenCalled();
      expect(lookalike.delete).not.toHaveBeenCalled();
      expect(lobby.delete).not.toHaveBeenCalled();
      expect(busyMine.delete).not.toHaveBeenCalled();
      // The deleted channel leaves the persisted set.
      expect(managedStore.has("mine-id")).toBe(false);
      expect(managedStore.has("busy-id")).toBe(true);
    });

    it("periodic cleanup deletes only channels KoolBot created", async () => {
      addChannel("lobby-id", "Lobby");
      const foreign = addChannel("foreign-id", "➕ Click To Create VC");
      const lookalike = addChannel("look-id", "🎮 Permanent Gaming");
      const mine = addChannel("mine-id", "Bob's Channel");
      trackAsManaged("mine-id");

      expect(await manager.cleanupEmptyChannels()).toBe(true);

      expect(mine.delete).toHaveBeenCalled();
      expect(foreign.delete).not.toHaveBeenCalled();
      expect(lookalike.delete).not.toHaveBeenCalled();
      expect(managedStore.has("mine-id")).toBe(false);
    });

    it("counts persisted ownership rows (renamed channels) as KoolBot-created", async () => {
      addChannel("lobby-id", "Lobby");
      const renamed = addChannel("owned-id", "Totally Custom Name");
      ownershipStore.set("owned-id", {
        guildId: GUILD_ID,
        channelId: "owned-id",
      });

      await manager.cleanupEmptyChannels();

      expect(renamed.delete).toHaveBeenCalled();
    });

    it("never deletes an occupied KoolBot channel", async () => {
      addChannel("lobby-id", "Lobby");
      const busy = addChannel("busy-id", "🎮 Dan's Room", 3);
      trackAsManaged("busy-id");

      await manager.cleanupEmptyChannels();

      expect(busy.delete).not.toHaveBeenCalled();
    });

    it("does not delete an active waiting room whose main channel lives", async () => {
      addChannel("lobby-id", "Lobby");
      const main = addChannel("main-id", "🎮 Eve's Room", 1);
      trackAsManaged("main-id");
      const waiting: any = await manager.createWaitingRoom(main, "owner-id");
      expect(waiting).not.toBeNull();
      expect(managedStore.get(waiting.id)?.kind).toBe("waiting_room");

      await manager.cleanupEmptyChannels();

      expect(waiting.delete).not.toHaveBeenCalled();
    });

    it("skips cleanup entirely when the database is unavailable", async () => {
      addChannel("lobby-id", "Lobby");
      const mine = addChannel("mine-id", "🎮 Alice's Room");
      trackAsManaged("mine-id");
      const foreign = addChannel("foreign-id", "Permanent Room");
      (manager as any).isDbReady.mockReturnValue(false);

      expect(await manager.cleanupEmptyChannels()).toBe(false);
      await manager.initialize(GUILD_ID);

      expect(mine.delete).not.toHaveBeenCalled();
      expect(foreign.delete).not.toHaveBeenCalled();
    });

    it("also applies when the toggle is flipped at runtime", async () => {
      settings["voicechannels.cleanup.managed_only"] = false;
      addChannel("lobby-id", "Lobby");
      const foreign = addChannel("foreign-id", "Permanent Room");
      await manager.cleanupEmptyChannels();
      expect(foreign.delete).toHaveBeenCalledTimes(1);

      const foreign2 = addChannel("foreign2-id", "Another Room");
      settings["voicechannels.cleanup.managed_only"] = true;
      await manager.cleanupEmptyChannels();
      expect(foreign2.delete).not.toHaveBeenCalled();
    });
  });

  describe("tracking KoolBot-created channels by ID", () => {
    it("records channels it creates, regardless of the toggle", async () => {
      const created: any = await manager.createDynamicChannel(guild, "user-1");

      expect(created).not.toBeNull();
      expect(managedStore.get(created.id)).toEqual(
        expect.objectContaining({
          guildId: GUILD_ID,
          channelId: created.id,
          kind: "channel",
          source: "created",
        }),
      );
    });

    it("survives a restart: a fresh manager still cleans up exactly its own channels", async () => {
      settings["voicechannels.cleanup.managed_only"] = true;
      markMigrated();
      addChannel("lobby-id", "Lobby");
      const foreign = addChannel("foreign-id", "➕ Click To Create VC");
      const created: any = await manager.createDynamicChannel(guild, "user-1");
      // Ownership row would normally be removed with the channel; the user left
      // while the bot was down, so the channel is simply empty on restart.

      // Simulated restart: new manager, empty memory, same database.
      manager = newManager();
      expect(manager.getUserChannel("user-1")).toBeUndefined();
      await manager.initialize(GUILD_ID);

      expect(created.delete).toHaveBeenCalled();
      expect(foreign.delete).not.toHaveBeenCalled();
    });

    it("forgets a channel once it is cleaned up", async () => {
      settings["voicechannels.cleanup.managed_only"] = true;
      markMigrated();
      addChannel("lobby-id", "Lobby");
      const created: any = await manager.createDynamicChannel(guild, "user-1");
      expect(managedStore.has(created.id)).toBe(true);

      await manager.cleanupEmptyChannels();

      expect(created.delete).toHaveBeenCalled();
      expect(managedStore.has(created.id)).toBe(false);
    });

    it("records a lobby it has to create", async () => {
      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      const lobbyRow = [...managedStore.values()].find(
        (r) => r.kind === "lobby",
      );
      expect(lobbyRow).toBeDefined();
    });

    it("prunes persisted rows for channels deleted outside the bot", async () => {
      settings["voicechannels.cleanup.managed_only"] = true;
      markMigrated();
      addChannel("lobby-id", "Lobby");
      trackAsManaged("long-gone-id");

      await manager.cleanupEmptyChannels();

      expect(managedStore.has("long-gone-id")).toBe(false);
    });
  });

  describe("one-time migration when the toggle is first enabled", () => {
    beforeEach(() => {
      settings["voicechannels.cleanup.managed_only"] = true;
    });

    it("adopts channels matching the KoolBot prefix/suffix, and only those", async () => {
      addChannel("lobby-id", "Lobby");
      const legacyRoom = addChannel("legacy-id", "🎮 Frank's Room");
      const foreign = addChannel("foreign-id", "➕ Click To Create VC");
      const wrongSuffix = addChannel("wrong-id", "🎮 Staff Meeting");
      const noPrefix = addChannel("nopre-id", "Frank's Room");

      await manager.initialize(GUILD_ID);

      expect(legacyRoom.delete).toHaveBeenCalled();
      expect(foreign.delete).not.toHaveBeenCalled();
      expect(wrongSuffix.delete).not.toHaveBeenCalled();
      expect(noPrefix.delete).not.toHaveBeenCalled();
      expect(migrationStore.get(GUILD_ID)?.adoptedCount).toBe(1);
    });

    it("marks adopted rows as adopted, not created", async () => {
      addChannel("lobby-id", "Lobby");
      addChannel("legacy-id", "🎮 Gina's Room", 1); // occupied: kept, row stays

      await manager.cleanupEmptyChannels();

      expect(managedStore.get("legacy-id")?.source).toBe("adopted");
    });

    it("runs once: a lookalike that appears later is never adopted", async () => {
      addChannel("lobby-id", "Lobby");
      await manager.initialize(GUILD_ID); // migration runs, adopts nothing
      expect(migrationStore.has(GUILD_ID)).toBe(true);

      const later = addChannel("later-id", "🎮 Someone Else's Room");
      manager = newManager(); // restart; marker is in the database
      await manager.cleanupEmptyChannels();

      expect(later.delete).not.toHaveBeenCalled();
      expect(managedStore.has("later-id")).toBe(false);
    });

    it("does not run at all while the toggle is off", async () => {
      settings["voicechannels.cleanup.managed_only"] = false;
      addChannel("lobby-id", "Lobby");
      addChannel("legacy-id", "🎮 Frank's Room", 1);

      await manager.cleanupEmptyChannels();

      expect(migrationStore.has(GUILD_ID)).toBe(false);
      expect(managedStore.size).toBe(0);
    });

    it("never adopts the lobby", async () => {
      settings["voicechannels.channel.prefix"] = "";
      settings["voicechannels.channel.suffix"] = "Lobby";
      const lobby = addChannel("lobby-id", "Lobby");

      await manager.cleanupEmptyChannels();

      expect(lobby.delete).not.toHaveBeenCalled();
      expect(managedStore.has("lobby-id")).toBe(false);
    });

    it("adopts nothing when neither prefix nor suffix is configured", async () => {
      settings["voicechannels.channel.prefix"] = "";
      settings["voicechannels.channel.suffix"] = "";
      addChannel("lobby-id", "Lobby");
      const room = addChannel("room-id", "Some Room");

      await manager.cleanupEmptyChannels();

      expect(room.delete).not.toHaveBeenCalled();
      expect(migrationStore.get(GUILD_ID)?.adoptedCount).toBe(0);
    });
  });

  describe("lobby identified by ID (voicechannels.lobby.channel_id)", () => {
    function voiceStateJoin(channel: any): any {
      const member = {
        id: "user-1",
        displayName: "Alice",
        guild,
        voice: { setChannel: jest.fn<any>().mockResolvedValue(undefined) },
      };
      return [
        { channel: null, member },
        { channel, member },
      ];
    }

    it("spawns a channel when a member joins the lobby by ID, whatever its name", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = addChannel("lobby-id", "Renamed Hangout");
      const spy = jest
        .spyOn(manager as any, "createUserChannel")
        .mockResolvedValue(undefined);

      const [oldState, newState] = voiceStateJoin(lobby);
      await manager.handleVoiceStateUpdate(oldState, newState);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("ignores a channel that merely shares the lobby name when the ID resolves", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      addChannel("lobby-id", "Renamed Hangout");
      const impostor = addChannel("impostor-id", "Lobby");
      const spy = jest
        .spyOn(manager as any, "createUserChannel")
        .mockResolvedValue(undefined);

      const [oldState, newState] = voiceStateJoin(impostor);
      await manager.handleVoiceStateUpdate(oldState, newState);

      expect(spy).not.toHaveBeenCalled();
    });

    it("falls back to the name when no ID is configured", async () => {
      const lobby = addChannel("lobby-id", "Lobby");
      const spy = jest
        .spyOn(manager as any, "createUserChannel")
        .mockResolvedValue(undefined);

      const [oldState, newState] = voiceStateJoin(lobby);
      await manager.handleVoiceStateUpdate(oldState, newState);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("falls back to the name when the configured ID no longer exists", async () => {
      settings["voicechannels.lobby.channel_id"] = "deleted-channel-id";
      const lobby = addChannel("lobby-id", "Lobby");
      const spy = jest
        .spyOn(manager as any, "createUserChannel")
        .mockResolvedValue(undefined);

      const [oldState, newState] = voiceStateJoin(lobby);
      await manager.handleVoiceStateUpdate(oldState, newState);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("keeps using the legacy lobby-name keys for the fallback", async () => {
      settings["voicechannels.lobby.name"] = "";
      settings["voice_channel.lobby_channel_name"] = "Old Lobby";
      const lobby = addChannel("lobby-id", "Old Lobby");
      const spy = jest
        .spyOn(manager as any, "createUserChannel")
        .mockResolvedValue(undefined);

      const [oldState, newState] = voiceStateJoin(lobby);
      await manager.handleVoiceStateUpdate(oldState, newState);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("never sweeps the lobby, even when renamed (legacy mode)", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = addChannel("lobby-id", "Totally Different Name");

      await manager.initialize(GUILD_ID);
      await manager.cleanupEmptyChannels();

      expect(lobby.delete).not.toHaveBeenCalled();
    });

    it("never sweeps the lobby, even when renamed (managed-only mode)", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      settings["voicechannels.cleanup.managed_only"] = true;
      markMigrated();
      const lobby = addChannel("lobby-id", "Totally Different Name");
      trackAsManaged("lobby-id"); // even if it were recorded as ours

      await manager.initialize(GUILD_ID);
      await manager.cleanupEmptyChannels();

      expect(lobby.delete).not.toHaveBeenCalled();
    });

    it("renames the ID-configured lobby offline and back online, keeping its ID", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      settings["voicechannels.lobby.name"] = "Hangout";
      const lobby = addChannel("lobby-id", "Hangout");

      await manager.renameLobbyToOffline(guild);
      expect(lobby.name).toBe("Lobby (Offline)");

      expect(await manager.renameLobbyToOnline(guild)).toBe(true);
      expect(lobby.name).toBe("Hangout");
      expect(guild.channels.create).not.toHaveBeenCalled();
    });

    it("ensureLobbyChannelExists renames the ID lobby instead of creating a second one", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = addChannel("lobby-id", "Lobby (Offline)");

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(lobby.name).toBe("Lobby");
      expect(guild.channels.create).not.toHaveBeenCalled();
    });

    it("force lobby ensure keeps an existing ID lobby rather than re-creating it", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = addChannel("lobby-id", "Lobby");

      expect(await manager.ensureLobbyChannels(guild)).toBe(true);

      expect(lobby.delete).not.toHaveBeenCalled();
      expect(guild.channels.create).not.toHaveBeenCalled();
    });

    it("force lobby ensure leaves lobby-like foreign channels alone in managed-only mode", async () => {
      settings["voicechannels.cleanup.managed_only"] = true;
      const foreign = addChannel("foreign-id", "Gaming Lobby (other bot)");

      expect(await manager.ensureLobbyChannels(guild)).toBe(true);

      expect(foreign.delete).not.toHaveBeenCalled();
      expect(guild.channels.create).toHaveBeenCalled();
    });
  });
});
