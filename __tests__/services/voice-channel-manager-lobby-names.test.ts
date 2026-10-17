/**
 * The shared lobby-name resolution (#1065): the voice service and the Channel
 * Manager's delete protection both call these, so a quoted setting or a legacy
 * key can't make them disagree about which channel is the lobby.
 */

import { describe, it, expect, jest } from "@jest/globals";

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getNumber: jest.fn(async () => 0),
      getString: jest.fn(async (_k: string, fallback = "") => fallback),
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

const {
  resolveLobbyChannelName,
  resolveOfflineLobbyNames,
  isNewChannelTriggerName,
  VoiceChannelManager,
} = await import("../../src/services/voice-channel-manager.js");

const reader =
  (values: Record<string, string>) =>
  async (key: string, fallback = ""): Promise<string> =>
    key in values ? values[key] : fallback;

describe("resolveLobbyChannelName", () => {
  it("uses the current key", async () => {
    expect(
      await resolveLobbyChannelName(
        reader({ "voicechannels.lobby.name": "Hangar" }),
      ),
    ).toBe("Hangar");
  });

  it("removes one pair of surrounding quotes", async () => {
    expect(
      await resolveLobbyChannelName(
        reader({ "voicechannels.lobby.name": '"Lobby"' }),
      ),
    ).toBe("Lobby");
    expect(
      await resolveLobbyChannelName(
        reader({ "voicechannels.lobby.name": "'Lobby'" }),
      ),
    ).toBe("Lobby");
  });

  it("falls back to the legacy keys when the primary is empty", async () => {
    expect(
      await resolveLobbyChannelName(
        reader({
          "voicechannels.lobby.name": "",
          "voice_channel.lobby_channel_name": "Old Lobby",
        }),
      ),
    ).toBe("Old Lobby");
    expect(
      await resolveLobbyChannelName(
        reader({ "voicechannels.lobby.name": "", LOBBY_CHANNEL_NAME: "Env" }),
      ),
    ).toBe("Env");
  });

  it("defaults to Lobby when nothing is set", async () => {
    expect(await resolveLobbyChannelName(reader({}))).toBe("Lobby");
  });
});

describe("resolveOfflineLobbyNames", () => {
  it("returns every name the service may use, raw and unquoted", async () => {
    const names = await resolveOfflineLobbyNames(
      reader({
        "voicechannels.lobby.offlinename": '"Closed"',
        "voice_channel.lobby_channel_name_offline": "Legacy Closed",
      }),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        '"Closed"',
        "Closed",
        "Legacy Closed",
        "🔴 Lobby",
      ]),
    );
  });

  it("includes the legacy name when the primary is empty", async () => {
    const names = await resolveOfflineLobbyNames(
      reader({
        "voicechannels.lobby.offlinename": "",
        "voice_channel.lobby_channel_name_offline": "Legacy Closed",
      }),
    );
    expect(names).toContain("Legacy Closed");
    expect(names).not.toContain("");
  });
});

describe("isNewChannelTriggerName", () => {
  it("matches the legacy trigger name exactly", () => {
    expect(isNewChannelTriggerName("➕ New Channel")).toBe(true);
    expect(isNewChannelTriggerName("New Channel")).toBe(false);
    expect(isNewChannelTriggerName("➕ new channel")).toBe(false);
  });
});

describe("getInMemoryManagedChannels", () => {
  it("lists rooms, waiting rooms, pending writes and per-room state", () => {
    VoiceChannelManager.reset();
    const manager: any = VoiceChannelManager.getInstance({
      user: { id: "bot" },
      channels: { cache: new Map() },
    } as never);
    manager.userChannels.set("m1", { id: "room1" });
    manager.waitingRoomToMain.set("wait1", "room2");
    manager.waitingRooms.set("room3", "wait3");
    manager.pendingManagedChannels.set("pend1", {
      guildId: "g",
      kind: "channel",
    });
    manager.controlPanels.set("panel1", {
      channelId: "panel1",
      messageId: "x",
    });
    manager.customChannelNames.set("named1", "x");
    manager.ownershipQueue.set("queued1", ["u"]);
    manager.liveChannels.add("live1");
    const ids = manager
      .getInMemoryManagedChannels()
      .map((c: { channelId: string }) => c.channelId);
    for (const id of [
      "room1",
      "wait1",
      "room2",
      "room3",
      "wait3",
      "pend1",
      "panel1",
      "named1",
      "queued1",
      "live1",
    ]) {
      expect(ids).toContain(id);
    }
    VoiceChannelManager.reset();
  });
});
