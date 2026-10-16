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

const { resolveLobbyChannelName, resolveOfflineLobbyNames } =
  await import("../../src/services/voice-channel-manager.js");

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
