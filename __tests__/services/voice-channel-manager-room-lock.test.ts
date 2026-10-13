import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { ChannelType, Collection, type Client } from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");

// Import after mocks
import {
  VoiceChannelManager,
  NotRoomOwnerError,
} from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";

const mockConfigService =
  ConfigService.getInstance() as jest.Mocked<ConfigService>;

/**
 * #1143: ownership transfers and owner-only room mutations are serialised per
 * room, and ownership is re-checked inside the lock.
 */
describe("VoiceChannelManager - room lock (#1143)", () => {
  let manager: VoiceChannelManager;
  let room: any;
  let releaseCreate: () => void;
  let createStarted: Promise<void>;

  const member = (id: string): any => ({ id, displayName: id });

  beforeEach(() => {
    jest.clearAllMocks();
    (VoiceChannelManager as any).instance = undefined;

    mockConfigService.getBoolean = jest
      .fn<any>()
      .mockImplementation((_k: string, d?: boolean) =>
        Promise.resolve(d ?? false),
      );
    mockConfigService.getString = jest
      .fn<any>()
      .mockImplementation((_k: string, d?: string) => Promise.resolve(d ?? ""));

    // The first overwrite write (granting the new owner) blocks until released,
    // holding the transfer "in flight" across Discord awaits.
    let signalStarted!: () => void;
    createStarted = new Promise<void>((r) => (signalStarted = r));
    const gate = new Promise<void>((r) => (releaseCreate = r));

    room = {
      id: "room",
      name: "Room",
      type: ChannelType.GuildVoice,
      members: new Collection<string, any>([
        ["b", member("b")],
        ["c", member("c")],
      ]),
      permissionOverwrites: {
        cache: new Map([["a", { allow: { has: () => false } }]]),
        create: jest.fn<any>().mockImplementation(async () => {
          signalStarted();
          await gate;
        }),
        delete: jest.fn<any>().mockResolvedValue(undefined),
      },
      setName: jest.fn<any>().mockResolvedValue(undefined),
      send: jest.fn<any>().mockResolvedValue(undefined),
    };

    manager = VoiceChannelManager.getInstance({
      user: { id: "bot" },
      channels: { cache: { get: () => room } },
    } as unknown as Client);
    (manager as any).userChannels.set("a", room);
    (manager as any).customChannelNames.set("room", "custom");
    (manager as any).persistOwnership = jest.fn(async () => undefined);
    (manager as any).updateControlPanelOwnership = jest.fn(async () => {});
  });

  afterEach(() => {
    (VoiceChannelManager as any).instance = undefined;
  });

  it("rejects a transfer requested by someone who is not the current owner", async () => {
    await expect(
      manager.transferOwnership("room", "b", "c"),
    ).rejects.toBeInstanceOf(NotRoomOwnerError);

    expect(room.permissionOverwrites.create).not.toHaveBeenCalled();
    expect(room.permissionOverwrites.delete).not.toHaveBeenCalled();
    expect(manager.isRoomOwner("a", "room")).toBe(true);
  });

  it("refuses a former owner's mutation that was waiting behind an in-flight transfer", async () => {
    const transfer = manager.transferOwnership("room", "a", "b");
    await createStarted; // transfer is mid-flight, map not yet updated

    const work = jest.fn(async () => undefined);
    // Preflight would still say "a owns it"; the locked re-check must not
    expect(manager.isRoomOwner("a", "room")).toBe(true);
    const ran = manager.runAsRoomOwner("a", "room", work);

    releaseCreate();
    await transfer;

    expect(await ran).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(manager.isRoomOwner("b", "room")).toBe(true);
  });

  it("rejects a second, stale transfer queued behind the first and revokes only the real former owner", async () => {
    const first = manager.transferOwnership("room", "a", "b");
    await createStarted;
    const stale = manager.transferOwnership("room", "a", "c");
    const staleResult = stale.then(
      () => "ok",
      (e: unknown) => e,
    );

    releaseCreate();
    await first;

    expect(await staleResult).toBeInstanceOf(NotRoomOwnerError);
    // only the actual former owner "a" was ever revoked, once
    expect(room.permissionOverwrites.delete).toHaveBeenCalledTimes(1);
    expect(room.permissionOverwrites.delete).toHaveBeenCalledWith(
      "a",
      expect.any(String),
    );
    expect(manager.isRoomOwner("b", "room")).toBe(true);
    expect(manager.isRoomOwner("c", "room")).toBe(false);
  });

  it("runs an owner's mutation when they still own the room", async () => {
    const work = jest.fn(async () => undefined);
    expect(await manager.runAsRoomOwner("a", "room", work)).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
  });

  describe("controlPanels cleanup on normal deletion paths", () => {
    beforeEach(() => {
      (manager as any).controlPanels.set("room", {
        channelId: "room",
        messageId: "m",
      });
      (manager as any).removeOwnershipRecord = jest.fn(async () => undefined);
      room.members = new Collection();
      room.delete = jest.fn<any>().mockResolvedValue(undefined);
    });

    it("cleanupUserChannel drops the entry", async () => {
      await (manager as any).cleanupUserChannel("a");
      expect(room.delete).toHaveBeenCalled();
      expect((manager as any).controlPanels.has("room")).toBe(false);
    });

    it("cleanupEmptyChannel drops the entry", async () => {
      await (manager as any).cleanupEmptyChannel(room);
      expect(room.delete).toHaveBeenCalled();
      expect((manager as any).controlPanels.has("room")).toBe(false);
    });
  });
});
