import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  ChannelType,
  type Client,
  type VoiceChannel,
  type GuildMember,
  type VoiceState,
} from "discord.js";

jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");

import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;

// #1673: a temporary room stays alive while anyone is in its waiting room,
// so a waiting member is never moved into a room that is deleted straight
// after (and so never disconnected).
describe("VoiceChannelManager - waiting room keeps its room alive (#1673)", () => {
  let manager: VoiceChannelManager;
  let channelCache: Map<string, any>;
  let main: any;
  let waiting: any;
  let waiter: any;

  function makeMembers(list: any[]): any {
    const map = new Map<string, any>(list.map((m) => [m.id, m]));
    return map;
  }

  function setup(waitingOccupied: boolean): void {
    waiter = {
      id: "waiter-id",
      displayName: "Waiter",
      voice: {
        setChannel: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
      },
    };
    waiting = {
      id: "waiting-id",
      name: "Waiting",
      type: ChannelType.GuildVoice,
      members: makeMembers(waitingOccupied ? [waiter] : []),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    main = {
      id: "main-id",
      name: "Room",
      type: ChannelType.GuildVoice,
      members: makeMembers([]),
      delete: jest.fn().mockResolvedValue(undefined),
      guild: { channels: { cache: channelCache } },
    };
    channelCache.set(main.id, main);
    channelCache.set(waiting.id, waiting);
    (manager as any).client.channels.cache = channelCache;
    (manager as any).userChannels.set("owner-id", main);
    (manager as any).waitingRooms.set(main.id, waiting.id);
    (manager as any).waitingRoomToMain.set(waiting.id, main.id);
    // Links restored at startup (the default after a healthy start).
    (manager as any).waitingRoomLinksRestored = true;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;
    mockConfigService.getBoolean = jest
      .fn()
      .mockImplementation((key: unknown, def: unknown) =>
        Promise.resolve(key === "voicechannels.enabled" ? true : def),
      ) as any;
    mockConfigService.getString = jest.fn().mockResolvedValue("Lobby") as any;
    channelCache = new Map();
    manager = VoiceChannelManager.getInstance({
      user: { id: "bot" },
      channels: { cache: channelCache },
    } as unknown as Client);
  });

  describe("cleanupUserChannel", () => {
    it("keeps an empty room while its waiting room is occupied", async () => {
      setup(true);
      await (manager as any).cleanupUserChannel("owner-id");
      expect(main.delete).not.toHaveBeenCalled();
      expect(waiting.delete).not.toHaveBeenCalled();
      expect(waiter.voice.setChannel).not.toHaveBeenCalled();
      expect(waiter.voice.disconnect).not.toHaveBeenCalled();
      expect((manager as any).userChannels.has("owner-id")).toBe(true);
      expect((manager as any).waitingRooms.get("main-id")).toBe("waiting-id");
    });

    it("control: cleans up an empty room and its empty waiting room together", async () => {
      setup(false);
      await (manager as any).cleanupUserChannel("owner-id");
      expect(main.delete).toHaveBeenCalledTimes(1);
      expect(waiting.delete).toHaveBeenCalledTimes(1);
      expect((manager as any).userChannels.has("owner-id")).toBe(false);
    });
  });

  describe("cleanupEmptyChannel", () => {
    it("keeps an empty room while its waiting room is occupied", async () => {
      setup(true);
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(main.delete).not.toHaveBeenCalled();
      expect(waiting.delete).not.toHaveBeenCalled();
      expect(waiter.voice.disconnect).not.toHaveBeenCalled();
      expect((manager as any).userChannels.has("owner-id")).toBe(true);
    });

    it("control: cleans up an empty room and its empty waiting room together", async () => {
      setup(false);
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(main.delete).toHaveBeenCalledTimes(1);
      expect(waiting.delete).toHaveBeenCalledTimes(1);
      expect((manager as any).userChannels.has("owner-id")).toBe(false);
    });
  });

  describe("when the last waiting member goes (the room must not leak)", () => {
    it("the next cleanup pass deletes the room and its waiting room", async () => {
      setup(true);
      const owner = { id: "owner-id", displayName: "Owner" } as GuildMember;
      // The owner leaves the (now empty) room: it is kept for the waiter.
      await manager.handleVoiceStateUpdate(
        { channel: main, member: owner } as unknown as VoiceState,
        { channel: null, member: owner } as unknown as VoiceState,
      );
      expect(main.delete).not.toHaveBeenCalled();
      // The waiter disconnects. Nothing runs at once: the room waits for the
      // next pass (the 5-minute sweep) and is not touched by the live event.
      waiting.members = makeMembers([]);
      await manager.handleVoiceStateUpdate(
        { channel: waiting, member: waiter } as unknown as VoiceState,
        { channel: null, member: waiter } as unknown as VoiceState,
      );
      expect(main.delete).not.toHaveBeenCalled();
      // The pass finds the room empty with an empty waiting room.
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(main.delete).toHaveBeenCalledTimes(1);
      expect(waiting.delete).toHaveBeenCalledTimes(1);
      expect((manager as any).userChannels.has("owner-id")).toBe(false);
      expect((manager as any).waitingRooms.has("main-id")).toBe(false);
    });

    it("keeps the room while another waiter is still waiting", async () => {
      setup(true);
      waiting.members = makeMembers([{ id: "second-id" }]);
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(main.delete).not.toHaveBeenCalled();
    });
  });

  describe("through handleVoiceStateUpdate", () => {
    it("the owner leaving keeps the room and leaves the waiter alone", async () => {
      setup(true);
      const owner = { id: "owner-id", displayName: "Owner" } as GuildMember;
      await manager.handleVoiceStateUpdate(
        { channel: main, member: owner } as unknown as VoiceState,
        { channel: null, member: owner } as unknown as VoiceState,
      );
      expect(main.delete).not.toHaveBeenCalled();
      expect(waiting.delete).not.toHaveBeenCalled();
      expect(waiter.voice.setChannel).not.toHaveBeenCalled();
      expect(waiter.voice.disconnect).not.toHaveBeenCalled();
    });

    it("the last member of a custom-named room leaving keeps the room", async () => {
      setup(true);
      // No owner entry: the room is managed through its custom name only.
      (manager as any).userChannels.clear();
      manager.setCustomChannelName(main.id, "Custom name");
      const member = { id: "other-id", displayName: "Other" } as GuildMember;
      await manager.handleVoiceStateUpdate(
        { channel: main, member } as unknown as VoiceState,
        { channel: null, member } as unknown as VoiceState,
      );
      expect(main.delete).not.toHaveBeenCalled();
      expect(waiting.delete).not.toHaveBeenCalled();
      expect(waiter.voice.disconnect).not.toHaveBeenCalled();
    });
  });

  function deferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  describe("races during a cleanup (review of #1682)", () => {
    it("a late cleanup of the old room leaves the owner's new room alone (cleanupEmptyChannel)", async () => {
      setup(false);
      const slow = deferred();
      main.delete = jest.fn().mockReturnValue(slow.promise);
      const run = (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      await flush();
      const newRoom = { id: "new-room", members: makeMembers([]) };
      (manager as any).userChannels.set("owner-id", newRoom);
      slow.resolve();
      await run;
      expect((manager as any).userChannels.get("owner-id")).toBe(newRoom);
    });

    it("a late cleanup of the old room leaves the owner's new room alone (cleanupUserChannel)", async () => {
      setup(false);
      const slow = deferred();
      main.delete = jest.fn().mockReturnValue(slow.promise);
      const run = (manager as any).cleanupUserChannel("owner-id");
      await flush();
      const newRoom = { id: "new-room", members: makeMembers([]) };
      (manager as any).userChannels.set("owner-id", newRoom);
      slow.resolve();
      await run;
      expect((manager as any).userChannels.get("owner-id")).toBe(newRoom);
    });

    it("skips at once while the links are unknown, restores in the background, then applies the guard", async () => {
      setup(true);
      (manager as any).waitingRoomLinksRestored = false;
      (manager as any).waitingRooms.clear();
      const restore = deferred<boolean>();
      const ensure = jest
        .spyOn(manager as any, "ensureWaitingRoomLinks")
        .mockImplementation((() => restore.promise) as never);
      // Both calls return although the restore never finishes, delete
      // nothing, and start ONE restore between them.
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      await (manager as any).cleanupUserChannel("owner-id");
      expect(main.delete).not.toHaveBeenCalled();
      expect(ensure).toHaveBeenCalledTimes(1);

      // The restore completes: links are back and the guard applies.
      (manager as any).waitingRooms.set(main.id, waiting.id);
      (manager as any).waitingRoomLinksRestored = true;
      restore.resolve(true);
      await flush();
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(main.delete).not.toHaveBeenCalled(); // the waiter is still waiting
      waiting.members = makeMembers([]);
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(main.delete).toHaveBeenCalledTimes(1);
    });

    it("a failed background restore is logged and a later call retries it", async () => {
      setup(false);
      (manager as any).waitingRoomLinksRestored = false;
      const ensure = jest
        .spyOn(manager as any, "ensureWaitingRoomLinks")
        .mockRejectedValueOnce(new Error("mongo down") as never)
        .mockResolvedValue(false as never);
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      await flush();
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      await flush();
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(main.delete).not.toHaveBeenCalled();
    });

    it("keeps a replacement waiting room's links when the old one's cleanup finishes", async () => {
      setup(false);
      const slow = deferred();
      waiting.delete = jest.fn().mockReturnValue(slow.promise);
      const run = (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      await flush();
      // The owner removed the old waiting room and made a new one meanwhile.
      (manager as any).waitingRoomToMain.delete("waiting-id");
      (manager as any).waitingRooms.set("main-id", "replacement-id");
      (manager as any).waitingRoomToMain.set("replacement-id", "main-id");
      slow.resolve();
      await run;
      expect((manager as any).waitingRooms.get("main-id")).toBe(
        "replacement-id",
      );
      expect((manager as any).waitingRoomToMain.get("replacement-id")).toBe(
        "main-id",
      );
    });

    it("keeps the room when someone joins it while the waiting room is deleted (cleanupEmptyChannel)", async () => {
      setup(false);
      const slow = deferred();
      waiting.delete = jest.fn().mockReturnValue(slow.promise);
      const run = (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      await flush();
      main.members = makeMembers([waiter]);
      slow.resolve();
      await run;
      expect(main.delete).not.toHaveBeenCalled();
      expect((manager as any).userChannels.has("owner-id")).toBe(true);
      expect((manager as any).channelsBeingDeleted.has(main.id)).toBe(false);
    });

    it("keeps the room when someone joins it while the waiting room is deleted (cleanupUserChannel)", async () => {
      setup(false);
      const slow = deferred();
      waiting.delete = jest.fn().mockReturnValue(slow.promise);
      const run = (manager as any).cleanupUserChannel("owner-id");
      await flush();
      main.members = makeMembers([waiter]);
      slow.resolve();
      await run;
      expect(main.delete).not.toHaveBeenCalled();
      expect((manager as any).userChannels.has("owner-id")).toBe(true);
    });
  });

  describe("a failed waiting-room delete (review of #1682)", () => {
    it("keeps the room and every link when the waiting room cannot be deleted (cleanupEmptyChannel)", async () => {
      setup(false);
      waiting.delete = jest.fn().mockRejectedValue(new Error("rate limited"));
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(main.delete).not.toHaveBeenCalled();
      expect((manager as any).waitingRooms.get("main-id")).toBe("waiting-id");
      expect((manager as any).waitingRoomToMain.get("waiting-id")).toBe(
        "main-id",
      );
      expect((manager as any).userChannels.has("owner-id")).toBe(true);
      expect((manager as any).channelsBeingDeleted.has("main-id")).toBe(false);
    });

    it("keeps the room and every link when the waiting room cannot be deleted (cleanupUserChannel)", async () => {
      setup(false);
      waiting.delete = jest.fn().mockRejectedValue(new Error("rate limited"));
      await (manager as any).cleanupUserChannel("owner-id");
      expect(main.delete).not.toHaveBeenCalled();
      expect((manager as any).waitingRooms.get("main-id")).toBe("waiting-id");
      expect((manager as any).waitingRoomToMain.get("waiting-id")).toBe(
        "main-id",
      );
      expect((manager as any).userChannels.has("owner-id")).toBe(true);
    });

    it("deletes both and clears the links when the waiting-room delete succeeds", async () => {
      setup(false);
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(waiting.delete).toHaveBeenCalledTimes(1);
      expect(main.delete).toHaveBeenCalledTimes(1);
      expect((manager as any).waitingRooms.size).toBe(0);
      expect((manager as any).waitingRoomToMain.size).toBe(0);
    });
  });

  describe("shutdown sweep (review of #1682)", () => {
    function categoryOf(...channels: any[]): any {
      return {
        children: {
          cache: new Map(channels.map((c) => [c.id, c])),
        },
      };
    }
    const lobby = (): any => ({
      id: "lobby-id",
      name: "Lobby",
      type: ChannelType.GuildVoice,
      members: makeMembers([]),
      delete: jest.fn().mockResolvedValue(undefined),
    });

    it("deletes neither an empty room nor its occupied waiting room", async () => {
      setup(true);
      const l = lobby();
      await manager.deleteEmptyChannelsOnShutdown(
        main.guild,
        categoryOf(main, waiting, l),
        "Lobby",
      );
      expect(main.delete).not.toHaveBeenCalled();
      expect(waiting.delete).not.toHaveBeenCalled();
      expect(l.delete).not.toHaveBeenCalled();
    });

    it("deletes nothing while the waiting-room links are unknown", async () => {
      setup(false);
      (manager as any).waitingRoomLinksRestored = false;
      await manager.deleteEmptyChannelsOnShutdown(
        main.guild,
        categoryOf(main, waiting),
        "Lobby",
      );
      expect(main.delete).not.toHaveBeenCalled();
      expect(waiting.delete).not.toHaveBeenCalled();
    });

    it("stops when the links are cleared mid-sweep (destroy during the shutdown timeout)", async () => {
      setup(false);
      // Deleting the first channel is when destroy() clears the links.
      main.delete = jest.fn().mockImplementation(async () => {
        (manager as any).waitingRoomLinksRestored = false;
      });
      await manager.deleteEmptyChannelsOnShutdown(
        main.guild,
        categoryOf(main, waiting),
        "Lobby",
      );
      expect(main.delete).toHaveBeenCalledTimes(1);
      expect(waiting.delete).not.toHaveBeenCalled();
    });

    it("control: deletes an empty room and an empty waiting room, never the lobby", async () => {
      setup(false);
      const l = lobby();
      await manager.deleteEmptyChannelsOnShutdown(
        main.guild,
        categoryOf(main, waiting, l),
        "Lobby",
      );
      expect(main.delete).toHaveBeenCalledTimes(1);
      expect(waiting.delete).toHaveBeenCalledTimes(1);
      expect(l.delete).not.toHaveBeenCalled();
    });
  });
});
