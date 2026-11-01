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

  // The release step is not awaited by the event handler (see #1682 review).
  const settleReleases = (): Promise<unknown> =>
    Promise.all([...(manager as any).pendingReleases]);

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
    function voiceUpdate(newChannel: unknown): [VoiceState, VoiceState] {
      const member = waiter as GuildMember;
      return [
        { channel: waiting, member } as unknown as VoiceState,
        { channel: newChannel, member } as unknown as VoiceState,
      ];
    }

    it("deletes the room and waiting room when the last waiter disconnects", async () => {
      setup(true);
      const owner = { id: "owner-id", displayName: "Owner" } as GuildMember;
      // The owner leaves the (now empty) room: it is kept for the waiter.
      await manager.handleVoiceStateUpdate(
        { channel: main, member: owner } as unknown as VoiceState,
        { channel: null, member: owner } as unknown as VoiceState,
      );
      expect(main.delete).not.toHaveBeenCalled();
      expect(waiter.voice.disconnect).not.toHaveBeenCalled();
      waiting.members = makeMembers([]); // the waiter disconnects
      await manager.handleVoiceStateUpdate(...voiceUpdate(null));
      await settleReleases();
      expect(main.delete).toHaveBeenCalledTimes(1);
      expect(waiting.delete).toHaveBeenCalledTimes(1);
      expect((manager as any).userChannels.has("owner-id")).toBe(false);
      expect((manager as any).waitingRooms.has("main-id")).toBe(false);
    });

    it("deletes the room when the last waiter moves to another channel", async () => {
      setup(true);
      waiting.members = makeMembers([]);
      const other = {
        id: "other-id",
        name: "Elsewhere",
        type: ChannelType.GuildVoice,
      };
      await manager.handleVoiceStateUpdate(...voiceUpdate(other));
      await settleReleases();
      expect(main.delete).toHaveBeenCalledTimes(1);
    });

    it("keeps the room while another waiter is still waiting", async () => {
      setup(true);
      const second = { id: "second-id" };
      waiting.members = makeMembers([second]);
      await manager.handleVoiceStateUpdate(...voiceUpdate(null));
      await settleReleases();
      expect(main.delete).not.toHaveBeenCalled();
    });

    it("does not delete an occupied room when a waiter is admitted into it", async () => {
      setup(true);
      const owner = { id: "owner-id" };
      main.members = makeMembers([owner, waiter]);
      waiting.members = makeMembers([]);
      await manager.handleVoiceStateUpdate(...voiceUpdate(main));
      await settleReleases();
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

    it("does nothing when voice channel management is off", async () => {
      setup(true);
      mockConfigService.getBoolean = jest.fn().mockResolvedValue(false) as any;
      waiting.members = makeMembers([]);
      await manager.handleVoiceStateUpdate(
        { channel: waiting, member: waiter } as unknown as VoiceState,
        { channel: null, member: waiter } as unknown as VoiceState,
      );
      expect(main.delete).not.toHaveBeenCalled();
      expect(waiting.delete).not.toHaveBeenCalled();
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

  describe("ordering and concurrency (review of #1682)", () => {
    it("does not make the voice tracker wait for a slow cleanup", async () => {
      setup(true);
      waiting.members = makeMembers([]); // the last waiter leaves
      const slow = deferred();
      main.delete = jest.fn().mockReturnValue(slow.promise);
      let settled = false;
      const update = manager
        .handleVoiceStateUpdate(
          { channel: waiting, member: waiter } as unknown as VoiceState,
          { channel: null, member: waiter } as unknown as VoiceState,
        )
        .then(() => {
          settled = true;
        });
      await flush();
      expect(main.delete).toHaveBeenCalled(); // cleanup is under way ...
      expect(settled).toBe(true); // ... and the event handler already returned
      slow.resolve();
      await update;
      await Promise.all([...(manager as any).pendingReleases]);
      expect((manager as any).userChannels.has("owner-id")).toBe(false);
    });

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

    it("runs the two cleanup paths for one room one after the other", async () => {
      setup(false);
      const slow = deferred();
      main.delete = jest.fn().mockReturnValue(slow.promise);
      const first = (manager as any).cleanupUserChannel("owner-id");
      const second = (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      await flush();
      expect(main.delete).toHaveBeenCalledTimes(1);
      slow.resolve();
      await Promise.all([first, second]);
      expect(main.delete).toHaveBeenCalledTimes(1);
    });

    it("does not delete while the waiting-room links are unknown, and retries", async () => {
      setup(true);
      (manager as any).waitingRoomLinksRestored = false;
      // The links are not in memory (the startup read failed): the waiting
      // room cannot be seen from the main room.
      (manager as any).waitingRooms.clear();
      const ensure = jest
        .spyOn(manager as any, "ensureWaitingRoomLinks")
        .mockResolvedValue(false as never);
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      await (manager as any).cleanupUserChannel("owner-id");
      expect(ensure).toHaveBeenCalled();
      expect(main.delete).not.toHaveBeenCalled();

      // The retry succeeds: links are back, the guard applies.
      ensure.mockImplementation((async () => {
        (manager as any).waitingRooms.set(main.id, waiting.id);
        return true;
      }) as never);
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(main.delete).not.toHaveBeenCalled(); // waiter is still waiting
      waiting.members = makeMembers([]);
      await (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      expect(main.delete).toHaveBeenCalledTimes(1);
    });

    it("keeps everything when someone joins the waiting room during the links check", async () => {
      setup(false);
      const gate = deferred<boolean>();
      jest
        .spyOn(manager as any, "ensureWaitingRoomLinks")
        .mockReturnValue(gate.promise as never);
      const run = (manager as any).cleanupEmptyChannel(main as VoiceChannel);
      await flush();
      waiting.members = makeMembers([waiter]); // arrives during the await
      gate.resolve(true);
      await run;
      expect(main.delete).not.toHaveBeenCalled();
      expect(waiting.delete).not.toHaveBeenCalled();
      expect(waiter.voice.disconnect).not.toHaveBeenCalled();
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
});
