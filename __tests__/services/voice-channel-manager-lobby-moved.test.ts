import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { ChannelType, Collection, type Client, type Guild } from "discord.js";

jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/discord-logger.js");

import {
  VoiceChannelManager,
  isLobbyByIdentity,
  LOBBY_MOVE_BACK_BACKOFF_MS,
} from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";
import { DiscordLogger } from "../../src/services/discord-logger.js";
import logger from "../../src/utils/logger.js";
import { mockModel, usePerModelStubs } from "../test-utils.js";

usePerModelStubs();

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;

/**
 * Issue #1636: a lobby moved out of the managed category.
 *
 * Before the fix: the moved lobby configured by id no longer resolved, so
 * ensureLobbyChannelExists and checkLobbyHealth created a second lobby in the
 * category; a moved temporary room fell outside category.children and the
 * cleanup never saw it. These tests pin the fixed behaviour.
 */
describe("VoiceChannelManager - lobby moved out of its category (issue #1636)", () => {
  const GUILD_ID = "guild-id";
  const CATEGORY_ID = "category-id";
  const OTHER_CATEGORY_ID = "other-category-id";
  const LOBBY_NAME = "Lobby";
  const OFFLINE_NAME = "Lobby (Offline)";

  let settings: Record<string, string | boolean>;
  let manager: VoiceChannelManager;
  let guild: Guild;
  let category: {
    id: string;
    type: ChannelType;
    children: { cache: Collection<string, any> };
  };
  let guildChannels: Collection<string, any>;
  let createMock: ReturnType<typeof jest.fn>;
  let recordedRows: Array<{ guildId: string; channelId: string; kind: string }>;
  let logToChannel: ReturnType<typeof jest.fn>;
  let now: number;

  function makeChannel(id: string, name: string, parentId: string): any {
    const channel: any = {
      id,
      name,
      type: ChannelType.GuildVoice,
      parentId,
      members: new Collection<string, any>(),
      guild: undefined as unknown,
      setName: jest.fn<any>().mockImplementation(async (n: string) => {
        channel.name = n;
      }),
      setParent: jest.fn<any>().mockImplementation(async (p: string) => {
        channel.parentId = p;
        if (p === CATEGORY_ID) category.children.cache.set(id, channel);
        else category.children.cache.delete(id);
        return channel;
      }),
      delete: jest.fn<any>().mockImplementation(async () => {
        guildChannels.delete(id);
        category.children.cache.delete(id);
      }),
    };
    channel.guild = guild;
    return channel;
  }

  /** A channel that lives in the guild, inside or outside the category. */
  function add(id: string, name: string, inCategory: boolean): any {
    const channel = makeChannel(
      id,
      name,
      inCategory ? CATEGORY_ID : OTHER_CATEGORY_ID,
    );
    guildChannels.set(id, channel);
    if (inCategory) category.children.cache.set(id, channel);
    return channel;
  }

  /** What the gateway delivers on a move: the channel before and after. */
  function moveOut(channel: any): { before: any; after: any } {
    const before = { ...channel, parentId: CATEGORY_ID };
    channel.parentId = OTHER_CATEGORY_ID;
    category.children.cache.delete(channel.id);
    return { before, after: channel };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    for (const level of ["info", "warn", "error", "debug"] as const) {
      jest.spyOn(logger, level).mockImplementation((() => logger) as never);
    }

    settings = {
      "voicechannels.enabled": true,
      "voicechannels.cleanup.managed_only": false,
      GUILD_ID,
      "voicechannels.category_id": CATEGORY_ID,
      "voicechannels.lobby.name": LOBBY_NAME,
      "voicechannels.lobby.offlinename": OFFLINE_NAME,
      "voicechannels.lobby.channel_id": "",
      "voicechannels.channel.prefix": "🎮",
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

    recordedRows = [];
    const managedModel = mockModel("ManagedVoiceChannel");
    managedModel.find = jest
      .fn<any>()
      .mockImplementation(async (filter: any) =>
        recordedRows.filter(
          (r) =>
            r.guildId === filter.guildId &&
            (filter.kind === undefined || r.kind === filter.kind),
        ),
      );
    managedModel.updateOne = jest.fn<any>().mockResolvedValue({});
    managedModel.deleteOne = jest.fn<any>().mockResolvedValue({});
    mockModel("ManagedVoiceMigration").findOne = jest
      .fn<any>()
      .mockResolvedValue({ guildId: GUILD_ID });
    const ownershipModel = mockModel("VoiceChannelOwnership");
    ownershipModel.find = jest.fn<any>().mockResolvedValue([]);
    ownershipModel.deleteOne = jest.fn<any>().mockResolvedValue({});
    mockModel("Event").find = jest.fn<any>().mockResolvedValue([]);

    guildChannels = new Collection<string, any>();
    category = {
      id: CATEGORY_ID,
      type: ChannelType.GuildCategory,
      children: { cache: new Collection<string, any>() },
    };
    guildChannels.set(CATEGORY_ID, category);
    createMock = jest.fn<any>().mockImplementation(async (options: any) => {
      const created = makeChannel("created-id", options.name, CATEGORY_ID);
      guildChannels.set(created.id, created);
      category.children.cache.set(created.id, created);
      return created;
    });
    guild = {
      id: GUILD_ID,
      roles: { everyone: { id: "everyone-id" } },
      channels: { cache: guildChannels, create: createMock },
    } as unknown as Guild;

    logToChannel = jest.fn<any>().mockResolvedValue(true);
    (DiscordLogger.getInstance as jest.Mock) = jest
      .fn<any>()
      .mockReturnValue({ logToChannel });

    const mockClient = {
      guilds: { fetch: jest.fn<any>().mockResolvedValue(guild) },
    } as unknown as Client;
    manager = VoiceChannelManager.getInstance(mockClient);
    jest.spyOn(manager as any, "isDbReady").mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (VoiceChannelManager as any).instance = undefined;
  });

  describe("no second lobby while the real one exists", () => {
    it("ensureLobbyChannelExists moves a lobby configured by id back instead of creating another", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, false);

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).not.toHaveBeenCalled();
      expect(lobby.setParent).toHaveBeenCalledWith(
        CATEGORY_ID,
        expect.objectContaining({ lockPermissions: false }),
      );
      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("ensureLobbyChannelExists renames a moved lobby that also carries the offline name", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", OFFLINE_NAME, false);

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).not.toHaveBeenCalled();
      expect(lobby.parentId).toBe(CATEGORY_ID);
      expect(lobby.name).toBe(LOBBY_NAME);
    });

    it("ensureLobbyChannelExists finds a recorded name-only lobby outside the category", async () => {
      const lobby = add("recorded-lobby", LOBBY_NAME, false);
      recordedRows.push({
        guildId: GUILD_ID,
        channelId: "recorded-lobby",
        kind: "lobby",
      });

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).not.toHaveBeenCalled();
      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("does not touch a channel outside the category that merely has the lobby's name", async () => {
      const stranger = add("stranger", LOBBY_NAME, false);

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(stranger.setParent).not.toHaveBeenCalled();
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it("never creates a lobby when the move back fails, and says so", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, false);
      lobby.setParent.mockRejectedValue(new Error("Missing Permissions"));

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(false);

      expect(createMock).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });

    it("checkLobbyHealth moves the lobby back and creates nothing", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, false);

      await (manager as any).checkLobbyHealth();

      expect(createMock).not.toHaveBeenCalled();
      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("checkLobbyHealth creates nothing when the move back fails", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, false);
      lobby.setParent.mockRejectedValue(new Error("Missing Permissions"));

      await (manager as any).checkLobbyHealth();

      expect(createMock).not.toHaveBeenCalled();
    });

    it("keeps a lobby already in the category as it is", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(lobby.setParent).not.toHaveBeenCalled();
      expect(createMock).not.toHaveBeenCalled();
    });

    it("says which channel is used when two carry the lobby's name", async () => {
      const first = add("first", LOBBY_NAME, true);
      add("second", LOBBY_NAME, true);

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).not.toHaveBeenCalled();
      const said = (logger.warn as jest.Mock).mock.calls
        .map((c) => String(c[0]))
        .join("\n");
      expect(said).toContain(first.id);
      expect(said).toMatch(/2 channels/);
    });
  });

  describe("handleChannelMoved (the ChannelUpdate path)", () => {
    it("puts a lobby configured by id back and logs who moved it", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      const { before, after } = moveOut(lobby);

      await manager.handleChannelMoved(before, after, {
        id: "admin-1",
        name: "Admin One",
      });

      expect(lobby.setParent).toHaveBeenCalledTimes(1);
      expect(lobby.parentId).toBe(CATEGORY_ID);
      const said = (logger.info as jest.Mock).mock.calls
        .map((c) => String(c[0]))
        .join("\n");
      expect(said).toContain("Admin One");
      expect(said).toContain("admin-1");
    });

    it("puts a name-only lobby back", async () => {
      const lobby = add("name-lobby", LOBBY_NAME, true);
      const { before, after } = moveOut(lobby);

      await manager.handleChannelMoved(before, after, null);

      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("puts the offline lobby back", async () => {
      const lobby = add("offline-lobby", OFFLINE_NAME, true);
      const { before, after } = moveOut(lobby);

      await manager.handleChannelMoved(before, after, null);

      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("does not disconnect members: the move changes the parent only", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      lobby.members.set("m1", { user: { bot: false } });
      const { before, after } = moveOut(lobby);

      await manager.handleChannelMoved(before, after, null);

      expect(lobby.parentId).toBe(CATEGORY_ID);
      expect(lobby.delete).not.toHaveBeenCalled();
      expect(lobby.members.size).toBe(1);
      expect(lobby.setParent).toHaveBeenCalledWith(
        CATEGORY_ID,
        expect.objectContaining({ lockPermissions: false }),
      );
    });

    it("ignores an unrelated channel moved out of the category", async () => {
      const other = add("other", "Some other room", true);
      const { before, after } = moveOut(other);

      await manager.handleChannelMoved(before, after, null);

      expect(other.setParent).not.toHaveBeenCalled();
    });

    it("ignores a lobby moved INTO the category (including the bot's own move back)", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, false);
      const before = { ...lobby, parentId: OTHER_CATEGORY_ID };
      lobby.parentId = CATEGORY_ID;

      await manager.handleChannelMoved(before, lobby, null);

      expect(lobby.setParent).not.toHaveBeenCalled();
    });

    it("does nothing when the voice feature is off", async () => {
      settings["voicechannels.enabled"] = false;
      const lobby = add("name-lobby", LOBBY_NAME, true);
      const { before, after } = moveOut(lobby);

      await manager.handleChannelMoved(before, after, null);

      expect(lobby.setParent).not.toHaveBeenCalled();
    });

    it("leaves a name-matching channel alone in managed-only mode unless KoolBot made it", async () => {
      settings["voicechannels.cleanup.managed_only"] = true;
      const lobby = add("name-lobby", LOBBY_NAME, true);
      const { before, after } = moveOut(lobby);

      await manager.handleChannelMoved(before, after, null);

      expect(lobby.setParent).not.toHaveBeenCalled();
    });

    it("puts a name-matching lobby back in managed-only mode when KoolBot recorded it", async () => {
      settings["voicechannels.cleanup.managed_only"] = true;
      const lobby = add("name-lobby", LOBBY_NAME, true);
      recordedRows.push({
        guildId: GUILD_ID,
        channelId: "name-lobby",
        kind: "lobby",
      });
      const { before, after } = moveOut(lobby);

      await manager.handleChannelMoved(before, after, null);

      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("does not fight: a second move out inside the back-off is warned about, not undone", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);

      let move = moveOut(lobby);
      await manager.handleChannelMoved(move.before, move.after, null);
      expect(lobby.setParent).toHaveBeenCalledTimes(1);

      now += 1000;
      move = moveOut(lobby);
      await manager.handleChannelMoved(move.before, move.after, {
        id: "admin-1",
        name: "Admin One",
      });

      expect(lobby.setParent).toHaveBeenCalledTimes(1);
      const warned = (logger.warn as jest.Mock).mock.calls
        .map((c) => String(c[0]))
        .join("\n");
      expect(warned).toContain("Admin One");
      expect(warned).toContain("admin-1");
    });

    it("puts it back again once the back-off has passed", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);

      let move = moveOut(lobby);
      await manager.handleChannelMoved(move.before, move.after, null);
      now += LOBBY_MOVE_BACK_BACKOFF_MS + 1;
      move = moveOut(lobby);
      await manager.handleChannelMoved(move.before, move.after, null);

      expect(lobby.setParent).toHaveBeenCalledTimes(2);
    });

    it("the health check also respects the back-off after a move back", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      const move = moveOut(lobby);
      await manager.handleChannelMoved(move.before, move.after, null);
      moveOut(lobby);

      await (manager as any).checkLobbyHealth();

      expect(lobby.setParent).toHaveBeenCalledTimes(1);
      expect(createMock).not.toHaveBeenCalled();
    });

    it("a failed move back posts ONE log message, however often it is retried", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      lobby.setParent.mockRejectedValue(new Error("Missing Permissions"));

      for (let i = 0; i < 3; i++) {
        const move = moveOut(lobby);
        await manager.handleChannelMoved(move.before, move.after, null);
        now += LOBBY_MOVE_BACK_BACKOFF_MS + 1;
      }

      expect(logToChannel).toHaveBeenCalledTimes(1);
      expect(logToChannel).toHaveBeenCalledWith("errors", expect.anything());
      expect(createMock).not.toHaveBeenCalled();
    });

    it("a successful move back posts nothing to the log channel", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      const move = moveOut(lobby);

      await manager.handleChannelMoved(move.before, move.after, null);

      expect(logToChannel).not.toHaveBeenCalled();
    });
  });

  describe("a registry that cannot be read is not an empty registry (review 1)", () => {
    function recordedLobbyOutside(): any {
      const lobby = add("recorded-lobby", LOBBY_NAME, false);
      recordedRows.push({
        guildId: GUILD_ID,
        channelId: "recorded-lobby",
        kind: "lobby",
      });
      return lobby;
    }

    it("ensureLobbyChannelExists creates nothing when the registry read fails", async () => {
      recordedLobbyOutside();
      (
        mockModel("ManagedVoiceChannel").find as jest.Mock<any>
      ).mockRejectedValue(new Error("db down"));

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(false);

      expect(createMock).not.toHaveBeenCalled();
    });

    it("ensureLobbyChannelExists creates nothing while the database is not ready", async () => {
      recordedLobbyOutside();
      (manager as any).isDbReady.mockReturnValue(false);

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(false);

      expect(createMock).not.toHaveBeenCalled();
    });

    it("checkLobbyHealth creates nothing when the registry read fails", async () => {
      recordedLobbyOutside();
      (
        mockModel("ManagedVoiceChannel").find as jest.Mock<any>
      ).mockRejectedValue(new Error("db down"));

      await (manager as any).checkLobbyHealth();

      expect(createMock).not.toHaveBeenCalled();
    });

    it("a verified empty registry still lets the lobby be created", async () => {
      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it("a lobby already in the category needs no registry read", async () => {
      add("lobby-in", LOBBY_NAME, true);
      (manager as any).isDbReady.mockReturnValue(false);

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).not.toHaveBeenCalled();
    });
  });

  describe("Force VC cleanup (ensureLobbyChannels) follows the same rule", () => {
    it("moves a lobby configured by id back instead of re-creating the lobby", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, false);

      expect(await manager.ensureLobbyChannels(guild)).toBe(true);

      expect(createMock).not.toHaveBeenCalled();
      expect(lobby.delete).not.toHaveBeenCalled();
      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("moves a recorded name-only lobby back instead of re-creating the lobby", async () => {
      const lobby = add("recorded-lobby", LOBBY_NAME, false);
      recordedRows.push({
        guildId: GUILD_ID,
        channelId: "recorded-lobby",
        kind: "lobby",
      });

      expect(await manager.ensureLobbyChannels(guild)).toBe(true);

      expect(createMock).not.toHaveBeenCalled();
      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("creates nothing when the lobby record cannot be read", async () => {
      add("recorded-lobby", LOBBY_NAME, false);
      (
        mockModel("ManagedVoiceChannel").find as jest.Mock<any>
      ).mockRejectedValue(new Error("db down"));

      expect(await manager.ensureLobbyChannels(guild)).toBe(false);

      expect(createMock).not.toHaveBeenCalled();
    });
  });

  describe("one repair per move, even with concurrent triggers (review round 2, finding 1)", () => {
    function deferredSetParent(lobby: any): { release: () => void } {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      lobby.setParent.mockImplementation(async (p: string) => {
        await gate;
        lobby.parentId = p;
        category.children.cache.set(lobby.id, lobby);
        return lobby;
      });
      return { release };
    }
    const flush = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 0));

    it("the move event and ensureLobbyChannelExists send ONE setParent", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      const gate = deferredSetParent(lobby);
      const move = moveOut(lobby);

      const first = manager.handleChannelMoved(move.before, move.after, null);
      const second = manager.ensureLobbyChannelExists(guild);
      await flush();
      gate.release();
      await Promise.all([first, second]);

      expect(lobby.setParent).toHaveBeenCalledTimes(1);
      expect(createMock).not.toHaveBeenCalled();
    });

    it("the move event and checkLobbyHealth send ONE setParent", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      const gate = deferredSetParent(lobby);
      const move = moveOut(lobby);

      const first = manager.handleChannelMoved(move.before, move.after, null);
      const second = (manager as any).checkLobbyHealth();
      await flush();
      gate.release();
      await Promise.all([first, second]);

      expect(lobby.setParent).toHaveBeenCalledTimes(1);
    });

    it("a failed first attempt still counts toward the back-off", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      lobby.setParent.mockRejectedValue(new Error("Missing Permissions"));
      const move = moveOut(lobby);

      await manager.handleChannelMoved(move.before, move.after, null);
      await manager.ensureLobbyChannelExists(guild);

      expect(lobby.setParent).toHaveBeenCalledTimes(1);
    });

    it("does not send a request when the channel is already back in the category", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      const move = moveOut(lobby);
      // An admin moved it back before the repair started.
      lobby.parentId = CATEGORY_ID;
      category.children.cache.set(lobby.id, lobby);

      await manager.handleChannelMoved(move.before, move.after, null);

      expect(lobby.setParent).not.toHaveBeenCalled();
    });

    it("two concurrent ensureLobbyChannelExists calls create ONE lobby", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realCreate = createMock.getMockImplementation() as (
        o: any,
      ) => Promise<any>;
      createMock.mockImplementation(async (o: any) => {
        await gate;
        return realCreate(o);
      });

      const first = manager.ensureLobbyChannelExists(guild);
      const second = manager.ensureLobbyChannelExists(guild);
      await flush();
      release();
      await Promise.all([first, second]);

      expect(createMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("Force VC cleanup racing the ensure path", () => {
    it("ends with exactly one lobby in the category", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realCreate = createMock.getMockImplementation() as (
        o: any,
      ) => Promise<any>;
      createMock.mockImplementation(async (o: any) => {
        await gate;
        return realCreate(o);
      });

      const forced = manager.ensureLobbyChannels(guild);
      const ensured = manager.ensureLobbyChannelExists(guild);
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await Promise.all([forced, ensured]);

      const lobbies = [...category.children.cache.values()].filter(
        (c: any) => c.name === LOBBY_NAME,
      );
      expect(lobbies).toHaveLength(1);
    });
  });

  describe("a lobby whose record is still being saved (review round 2, finding 2)", () => {
    it("is not duplicated when the registry reads empty before the write is flushed", async () => {
      const lobby = add("pending-lobby", LOBBY_NAME, false);
      (manager as any).pendingManagedChannels.set("pending-lobby", {
        guildId: GUILD_ID,
        kind: "lobby",
      });

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).not.toHaveBeenCalled();
      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("is found even while the database is not ready", async () => {
      const lobby = add("pending-lobby", LOBBY_NAME, false);
      (manager as any).pendingManagedChannels.set("pending-lobby", {
        guildId: GUILD_ID,
        kind: "lobby",
      });
      (manager as any).isDbReady.mockReturnValue(false);

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).not.toHaveBeenCalled();
      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("is put back in managed-only mode during a database outage", async () => {
      settings["voicechannels.cleanup.managed_only"] = true;
      const lobby = add("pending-lobby", LOBBY_NAME, true);
      (manager as any).pendingManagedChannels.set("pending-lobby", {
        guildId: GUILD_ID,
        kind: "lobby",
      });
      (manager as any).isDbReady.mockReturnValue(false);
      const { before, after } = moveOut(lobby);

      await manager.handleChannelMoved(before, after, null);

      expect(lobby.parentId).toBe(CATEGORY_ID);
    });

    it("ignores a pending entry of another guild or another kind", async () => {
      add("other-guild-lobby", LOBBY_NAME, false);
      add("pending-room", LOBBY_NAME, false);
      (manager as any).pendingManagedChannels.set("other-guild-lobby", {
        guildId: "someone-else",
        kind: "lobby",
      });
      (manager as any).pendingManagedChannels.set("pending-room", {
        guildId: GUILD_ID,
        kind: "channel",
      });

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("a lobby recognised during a live move is remembered (review 3)", () => {
    it("keeps the chip and creates nothing after a failed move back, with no registry row", async () => {
      const lobby = add("name-lobby", LOBBY_NAME, true);
      lobby.setParent.mockRejectedValue(new Error("Missing Permissions"));
      const { before, after } = moveOut(lobby);
      await manager.handleChannelMoved(before, after, null);

      expect(
        (await manager.getMisplacedLobbies(guild)).map((c) => c.id),
      ).toEqual(["name-lobby"]);
      await (manager as any).checkLobbyHealth();
      expect(createMock).not.toHaveBeenCalled();
    });

    it("keeps it after a second move hits the back-off", async () => {
      const lobby = add("name-lobby", LOBBY_NAME, true);
      let move = moveOut(lobby);
      await manager.handleChannelMoved(move.before, move.after, null);
      now += 1000;
      move = moveOut(lobby);
      await manager.handleChannelMoved(move.before, move.after, null);

      expect(
        (await manager.getMisplacedLobbies(guild)).map((c) => c.id),
      ).toEqual(["name-lobby"]);
      await (manager as any).checkLobbyHealth();
      expect(createMock).not.toHaveBeenCalled();
    });

    it("forgets it once it is back in the category", async () => {
      const lobby = add("name-lobby", LOBBY_NAME, true);
      const { before, after } = moveOut(lobby);
      await manager.handleChannelMoved(before, after, null);

      expect(lobby.parentId).toBe(CATEGORY_ID);
      expect(await manager.getMisplacedLobbies(guild)).toEqual([]);
    });

    it("forgets it when the channel is gone, so the lobby can be created again", async () => {
      const lobby = add("name-lobby", LOBBY_NAME, true);
      lobby.setParent.mockRejectedValue(new Error("Missing Permissions"));
      const { before, after } = moveOut(lobby);
      await manager.handleChannelMoved(before, after, null);
      guildChannels.delete("name-lobby");

      expect(await manager.ensureLobbyChannelExists(guild)).toBe(true);

      expect(createMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("the failure post and its marker (reviews 2 and 5)", () => {
    it("retries the post after the logger returned false", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      lobby.setParent.mockRejectedValue(new Error("Missing Permissions"));
      logToChannel.mockResolvedValue(false);

      for (let i = 0; i < 2; i++) {
        const move = moveOut(lobby);
        await manager.handleChannelMoved(move.before, move.after, null);
        now += LOBBY_MOVE_BACK_BACKOFF_MS + 1;
      }

      expect(logToChannel).toHaveBeenCalledTimes(2);
    });

    it("retries the post after the logger threw", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      lobby.setParent.mockRejectedValue(new Error("Missing Permissions"));
      logToChannel.mockRejectedValue(new Error("send failed"));

      for (let i = 0; i < 2; i++) {
        const move = moveOut(lobby);
        await manager.handleChannelMoved(move.before, move.after, null);
        now += LOBBY_MOVE_BACK_BACKOFF_MS + 1;
      }

      expect(logToChannel).toHaveBeenCalledTimes(2);
    });

    it("posts again after someone moved the lobby back by hand and then out again", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, true);
      lobby.setParent.mockRejectedValue(new Error("Missing Permissions"));

      let move = moveOut(lobby);
      await manager.handleChannelMoved(move.before, move.after, null);
      expect(logToChannel).toHaveBeenCalledTimes(1);

      // An admin puts it back by hand: a move INTO the category.
      const outside = { ...lobby, parentId: OTHER_CATEGORY_ID };
      lobby.parentId = CATEGORY_ID;
      category.children.cache.set(lobby.id, lobby);
      await manager.handleChannelMoved(outside, lobby, null);
      expect(lobby.setParent).toHaveBeenCalledTimes(1);

      now += LOBBY_MOVE_BACK_BACKOFF_MS + 1;
      move = moveOut(lobby);
      await manager.handleChannelMoved(move.before, move.after, null);

      expect(logToChannel).toHaveBeenCalledTimes(2);
    });
  });

  describe("what a moved lobby still does as a trigger", () => {
    it("a moved lobby configured by id still triggers by its name (unchanged, listed for the owner)", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, false);

      expect(
        await isLobbyByIdentity({ id: lobby.id, name: lobby.name, guild }),
      ).toBe(true);
    });
  });

  describe("temporary rooms moved out of the category", () => {
    function ownRoom(id: string, inCategory: boolean): any {
      const room = add(id, "🎮 Someone's Room", inCategory);
      (manager as any).userChannels.set("owner-1", room);
      return room;
    }

    it("deletes an empty owned room that now lives outside the category", async () => {
      add("lobby-id", LOBBY_NAME, true);
      const room = ownRoom("room-1", false);

      await manager.cleanupEmptyChannels();

      expect(room.delete).toHaveBeenCalled();
    });

    it("keeps an occupied owned room outside the category", async () => {
      add("lobby-id", LOBBY_NAME, true);
      const room = ownRoom("room-1", false);
      room.members.set("m1", { user: { bot: false } });

      await manager.cleanupEmptyChannels();

      expect(room.delete).not.toHaveBeenCalled();
    });

    it.each([
      ["the online lobby name", LOBBY_NAME],
      ["the offline lobby name", OFFLINE_NAME],
    ])(
      "an owned room renamed to %s is still a room and is cleaned up when empty outside the category",
      async (_label, name) => {
        add("lobby-id", LOBBY_NAME, true);
        const room = ownRoom("room-1", false);
        room.name = name;

        await manager.cleanupEmptyChannels();

        expect(room.delete).toHaveBeenCalled();
      },
    );

    it("never deletes the configured lobby by id, wherever it is", async () => {
      settings["voicechannels.lobby.channel_id"] = "lobby-id";
      const lobby = add("lobby-id", LOBBY_NAME, false);
      (manager as any).userChannels.set("owner-1", lobby);

      await manager.cleanupEmptyChannels();

      expect(lobby.delete).not.toHaveBeenCalled();
    });

    it("deletes an empty room known only from the persisted ownership rows (restoration failed at startup)", async () => {
      add("lobby-id", LOBBY_NAME, true);
      const room = add("room-9", "🎮 Persisted room", false);
      (
        mockModel("VoiceChannelOwnership").find as jest.Mock<any>
      ).mockResolvedValue([{ channelId: "room-9", ownerId: "owner-9" }]);

      await manager.cleanupEmptyChannels();

      expect(room.delete).toHaveBeenCalled();
    });

    it("deletes an empty room known only from a recorded temporary-channel row", async () => {
      add("lobby-id", LOBBY_NAME, true);
      const room = add("room-8", "🎮 Recorded room", false);
      recordedRows.push({
        guildId: GUILD_ID,
        channelId: "room-8",
        kind: "channel",
      });

      await manager.cleanupEmptyChannels();

      expect(room.delete).toHaveBeenCalled();
    });

    it("keeps a persisted room that has members, and never deletes a recorded lobby outside the category", async () => {
      add("lobby-id", LOBBY_NAME, true);
      const busy = add("room-7", "🎮 Busy", false);
      busy.members.set("m1", { user: { bot: false } });
      const lobby = add("recorded-lobby", LOBBY_NAME, false);
      recordedRows.push(
        { guildId: GUILD_ID, channelId: "room-7", kind: "channel" },
        { guildId: GUILD_ID, channelId: "recorded-lobby", kind: "lobby" },
      );

      await manager.cleanupEmptyChannels();

      expect(busy.delete).not.toHaveBeenCalled();
      expect(lobby.delete).not.toHaveBeenCalled();
    });

    it("never deletes a channel outside the category that is not a tracked room", async () => {
      add("lobby-id", LOBBY_NAME, true);
      const stranger = add("stranger", "🎮 Not ours", false);

      await manager.cleanupEmptyChannels();

      expect(stranger.delete).not.toHaveBeenCalled();
    });
  });
});
