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
  type VoiceChannel,
} from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");

// Import after mocks
import {
  VoiceChannelManager,
  isLobbyByIdentity,
} from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";
import { applyPresetToChannel } from "../../src/handlers/vc-preset-handler.js";

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;

/**
 * #1148: the lobby, and the legacy "New Channel" trigger, must not be
 * identifiable by a name a room owner controls. #1143: the control-panel
 * refresh edits the exact message KoolBot posted.
 */
describe("VoiceChannelManager - name spoofing and control-panel tracking (#1148, #1143)", () => {
  let manager: VoiceChannelManager;
  let guild: any;
  let category: any;
  let channels: Collection<string, any>;
  let createMock: jest.Mock<any>;

  const voice = (id: string, name: string, extra: object = {}): any => ({
    id,
    name,
    type: ChannelType.GuildVoice,
    parentId: "category-id",
    members: new Collection(),
    setName: jest.fn<any>().mockResolvedValue(undefined),
    delete: jest.fn<any>().mockResolvedValue(undefined),
    ...extra,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;

    mockConfigService.getBoolean = jest
      .fn<any>()
      .mockImplementation((_key: string, def?: boolean) =>
        Promise.resolve(def ?? false),
      );
    mockConfigService.getString = jest
      .fn<any>()
      .mockImplementation((key: string, def?: string) => {
        switch (key) {
          case "voicechannels.lobby.name":
            return Promise.resolve("Lobby");
          case "voicechannels.lobby.offlinename":
            return Promise.resolve("🔴 Lobby");
          case "voicechannels.category_id":
            return Promise.resolve("category-id");
          default:
            return Promise.resolve(def ?? "");
        }
      });

    channels = new Collection();
    category = {
      id: "category-id",
      type: ChannelType.GuildCategory,
      children: { cache: channels },
    };
    createMock = jest
      .fn<any>()
      .mockImplementation((o: any) =>
        Promise.resolve(voice("new-lobby-id", o.name)),
      );
    guild = {
      id: "guild-id",
      roles: { everyone: { id: "everyone-id" } },
      channels: {
        cache: new Collection<string, any>([["category-id", category]]),
        create: createMock,
      },
    };

    manager = VoiceChannelManager.getInstance({
      user: { id: "bot" },
    } as unknown as Client);
    (manager as any).recordManagedChannel = jest.fn(async () => undefined);
  });

  afterEach(() => {
    (VoiceChannelManager as any).instance = undefined;
  });

  describe("isReservedChannelName", () => {
    it("reserves the lobby, the offline lobby and the New Channel trigger", async () => {
      expect(await manager.isReservedChannelName("Lobby")).toBe(true);
      expect(await manager.isReservedChannelName("  lobby ")).toBe(true);
      expect(await manager.isReservedChannelName("🔴 Lobby")).toBe(true);
      expect(await manager.isReservedChannelName("➕ New Channel")).toBe(true);
    });

    it("allows ordinary names", async () => {
      expect(await manager.isReservedChannelName("Lobby party")).toBe(false);
      expect(await manager.isReservedChannelName("Gaming")).toBe(false);
      expect(await manager.isReservedChannelName("   ")).toBe(false);
    });
  });

  describe("isLobbyByIdentity without a registry row (#1420)", () => {
    const configureLobbyId = (id: string): void => {
      const base = mockConfigService.getString as jest.Mock<any>;
      const previous = base.getMockImplementation() as (
        key: string,
        def?: string,
      ) => Promise<string>;
      mockConfigService.getString = jest
        .fn<any>()
        .mockImplementation((key: string, def?: string) =>
          key === "voicechannels.lobby.channel_id"
            ? Promise.resolve(id)
            : previous(key, def),
        );
    };

    it("recognises a name-matched lobby that was reused and never recorded", async () => {
      const lobby = voice("lobby-1", "Lobby", { guild });
      guild.channels.cache.set("lobby-1", lobby);
      expect(await isLobbyByIdentity(lobby)).toBe(true);
      expect(await isLobbyByIdentity(voice("other", "Gaming", { guild }))).toBe(
        false,
      );
    });

    it("recognises a lobby configured by ID whatever it is named", async () => {
      const lobby = voice("lobby-2", "Join to create", { guild });
      guild.channels.cache.set("lobby-2", lobby);
      configureLobbyId("lobby-2");
      expect(await isLobbyByIdentity(lobby)).toBe(true);
    });

    it("with a lobby ID configured, a channel merely named like the lobby is not it", async () => {
      const lobby = voice("lobby-2", "Join to create", { guild });
      const lookalike = voice("fake", "Lobby", { guild });
      guild.channels.cache.set("lobby-2", lobby);
      guild.channels.cache.set("fake", lookalike);
      configureLobbyId("lobby-2");
      expect(await isLobbyByIdentity(lookalike)).toBe(false);
    });

    it("skips a tracked member room renamed to the lobby name", async () => {
      const room = voice("room-1", "Lobby", { guild });
      expect(await isLobbyByIdentity(room, (id) => id === "room-1")).toBe(
        false,
      );
    });
  });

  describe("lobby detection by name", () => {
    it("never treats a member's room as the lobby, even when renamed to the lobby name", async () => {
      const room = voice("room-1", "Lobby", { guild });
      (manager as any).userChannels.set("owner-1", room);

      expect(await (manager as any).isLobbyChannel(room)).toBe(false);
    });

    it("still recognises the real (untracked) lobby by name when no ID is configured", async () => {
      const lobby = voice("lobby-1", "Lobby", { guild });
      expect(await (manager as any).isLobbyChannel(lobby)).toBe(true);
    });

    it("does not spawn a room when joining a room renamed to the lobby name", async () => {
      const room = voice("room-1", "Lobby", { guild });
      (manager as any).userChannels.set("owner-1", room);
      const createUserChannel = jest.fn(async () => undefined);
      (manager as any).createUserChannel = createUserChannel;

      const member = {
        id: "joiner",
        displayName: "Joiner",
        user: { bot: false },
      };
      await manager.handleVoiceStateUpdate(
        { channel: null, member } as any,
        { channel: room, member, guild } as any,
      );

      expect(createUserChannel).not.toHaveBeenCalled();
    });

    it("does not treat a room renamed to the New Channel trigger as the trigger", async () => {
      const room = voice("room-1", "➕ New Channel", { guild });
      (manager as any).userChannels.set("owner-1", room);
      const createUserChannel = jest.fn(async () => undefined);
      (manager as any).createUserChannel = createUserChannel;

      const member = {
        id: "joiner",
        displayName: "Joiner",
        user: { bot: false },
      };
      await manager.handleVoiceStateUpdate(
        { channel: null, member } as any,
        { channel: room, member, guild } as any,
      );

      expect(createUserChannel).not.toHaveBeenCalled();
    });
  });

  describe("name-based lobby lookups skip member rooms", () => {
    it("ensureLobbyChannelExists creates a real lobby instead of adopting a room named like it", async () => {
      const room = voice("room-1", "Lobby");
      channels.set(room.id, room);
      (manager as any).userChannels.set("owner-1", room);

      const ok = await manager.ensureLobbyChannelExists(guild);

      expect(ok).toBe(true);
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Lobby" }),
      );
    });

    it("ensureLobbyChannelExists does not rename a room carrying the offline lobby name", async () => {
      const room = voice("room-1", "🔴 Lobby");
      channels.set(room.id, room);
      (manager as any).userChannels.set("owner-1", room);

      await manager.ensureLobbyChannelExists(guild);

      expect(room.setName).not.toHaveBeenCalled();
      expect(createMock).toHaveBeenCalled();
    });

    it("ensureLobbyChannels (force cleanup) matches exact lobby names, not a 'Lobby' substring, and spares rooms", async () => {
      const party = voice("party", "Lobby party");
      const spoof = voice("spoof", "Lobby");
      const realOffline = voice("offline", "🔴 Lobby");
      channels.set(party.id, party);
      channels.set(spoof.id, spoof);
      channels.set(realOffline.id, realOffline);
      (manager as any).userChannels.set("owner-1", spoof);

      await manager.ensureLobbyChannels(guild);

      expect(party.delete).not.toHaveBeenCalled();
      expect(spoof.delete).not.toHaveBeenCalled();
      // the genuine offline lobby is brought back online instead
      expect(realOffline.setName).toHaveBeenCalledWith(
        "Lobby",
        expect.any(String),
      );
    });
  });

  describe("control panel", () => {
    it("does not post the panel into a text channel merely sharing the room's name", async () => {
      const textSend = jest.fn(async () => undefined);
      const room = voice("room-1", "Squad", {
        parent: {
          children: {
            cache: {
              find: (fn: (c: any) => boolean) =>
                [
                  {
                    type: ChannelType.GuildText,
                    name: "Squad",
                    send: textSend,
                  },
                ].find(fn),
            },
          },
        },
        send: jest.fn<any>().mockRejectedValue(new Error("no text chat")),
      });

      await (manager as any).sendControlPanel(room, "owner-1");

      expect(textSend).not.toHaveBeenCalled();
    });

    it("records the posted panel and edits that exact message on transfer", async () => {
      const room = voice("room-1", "Squad", {
        send: jest.fn<any>().mockResolvedValue({ id: "panel-msg" }),
      });
      await (manager as any).sendControlPanel(room, "owner-1");
      expect((manager as any).controlPanels.get("room-1")).toEqual({
        channelId: "room-1",
        messageId: "panel-msg",
      });

      const panel = { id: "panel-msg" };
      const fetch = jest.fn<any>().mockResolvedValue(panel);
      room.messages = { fetch };
      const rebuild = jest.fn(async () => undefined);
      (manager as any).rebuildControlPanel = rebuild;

      await (manager as any).updateControlPanelOwnership(room, "new-owner");

      // fetched by id, not by scanning the newest 50 messages
      expect(fetch).toHaveBeenCalledWith("panel-msg");
      expect(fetch).not.toHaveBeenCalledWith({ limit: 50 });
      expect(rebuild).toHaveBeenCalledWith(room, "new-owner", panel);
    });
  });

  describe("final room name on both creation paths", () => {
    // The configured lobby name equals what the default naming scheme would
    // generate for a member whose display name is "Lobby".
    const RESERVED = "🎮 Lobby's Room";
    const reservedPrefixConfig = (): void => {
      mockConfigService.getString = jest
        .fn<any>()
        .mockImplementation((key: string, def?: string) => {
          switch (key) {
            case "voicechannels.lobby.name":
              return Promise.resolve(RESERVED);
            case "voicechannels.lobby.offlinename":
              return Promise.resolve("🔴 Lobby");
            case "voicechannels.category_id":
              return Promise.resolve("category-id");
            default:
              return Promise.resolve(def ?? "");
          }
        });
    };

    beforeEach(() => {
      reservedPrefixConfig();
      (manager as any).persistOwnership = jest.fn(async () => undefined);
      (manager as any).sendControlPanel = jest.fn(async () => undefined);
    });

    it("lobby-join path never creates a room named exactly like the lobby", async () => {
      const member: any = {
        id: "u1",
        displayName: "Lobby",
        guild,
        voice: { setChannel: jest.fn(async () => undefined) },
      };

      await (manager as any).createUserChannelUnlocked(member);

      const name = (createMock.mock.calls[0][0] as { name: string }).name;
      expect(await manager.isReservedChannelName(name)).toBe(false);
    });

    it("dynamic-channel path never creates a room named exactly like the lobby", async () => {
      guild.members = {
        fetch: jest.fn(async () => ({ id: "u1", displayName: "Lobby" })),
      };

      await (manager as any).createDynamicChannelUnlocked(guild, "u1");

      const name = (createMock.mock.calls[0][0] as { name: string }).name;
      expect(await manager.isReservedChannelName(name)).toBe(false);
    });

    it("dynamic-channel path replaces a reserved explicit name with a safe one", async () => {
      guild.members = {
        fetch: jest.fn(async () => ({ id: "u1", displayName: "Ann" })),
      };

      await (manager as any).createDynamicChannelUnlocked(guild, "u1", "Lobby");

      const name = (createMock.mock.calls[0][0] as { name: string }).name;
      expect(await manager.isReservedChannelName(name)).toBe(false);
    });
  });

  describe("safeRoomName length", () => {
    it("keeps a name derived from a 100-character reserved name within 100 characters", async () => {
      const long = "L".repeat(100);
      mockConfigService.getString = jest
        .fn<any>()
        .mockImplementation((key: string, def?: string) =>
          Promise.resolve(
            key === "voicechannels.lobby.name" ? long : (def ?? ""),
          ),
        );

      const name: string = await (manager as any).safeRoomName(long, "u1");

      expect(name.length).toBeLessThanOrEqual(100);
      expect(await manager.isReservedChannelName(name)).toBe(false);
    });
  });

  describe("presets", () => {
    it("skips a preset channel name that is reserved but still applies the rest", async () => {
      const room: any = {
        id: "room-1",
        name: "Squad",
        setName: jest.fn<any>().mockResolvedValue(undefined),
        setUserLimit: jest.fn<any>().mockResolvedValue(undefined),
        setBitrate: jest.fn<any>().mockResolvedValue(undefined),
      };

      await applyPresetToChannel(
        room as VoiceChannel,
        { name: "p", channelName: "Lobby", userLimit: 5 } as any,
        (n) => manager.isReservedChannelName(n),
      );

      expect(room.setName).not.toHaveBeenCalled();
      expect(room.setUserLimit).toHaveBeenCalledWith(5);
    });
  });

  describe("isRoomOwner", () => {
    it("is true only for the live owner of that exact room", () => {
      const room = voice("room-1", "Squad");
      (manager as any).userChannels.set("owner-1", room);

      expect(manager.isRoomOwner("owner-1", "room-1")).toBe(true);
      expect(manager.isRoomOwner("owner-1", "room-2")).toBe(false);
      expect(manager.isRoomOwner("former-owner", "room-1")).toBe(false);
    });
  });
});
