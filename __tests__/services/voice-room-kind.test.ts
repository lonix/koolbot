import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockManagedFindOne = jest.fn();
const mockEventExists = jest.fn();

jest.unstable_mockModule("../../src/models/managed-voice-channel.js", () => ({
  ManagedVoiceChannel: { findOne: mockManagedFindOne },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: { exists: mockEventExists },
}));

const { classifyVoiceRoom } =
  await import("../../src/services/voice-room-kind.js");

const room = {
  guildId: "g1",
  channelId: "c1",
  channelName: "Somewhere",
};
const notLobby = (): Promise<boolean> => Promise.resolve(false);
const isLobby = (): Promise<boolean> => Promise.resolve(true);

function managedReturns(row: unknown): void {
  mockManagedFindOne.mockReturnValue({
    lean: () => Promise.resolve(row),
  } as never);
}

describe("classifyVoiceRoom (#1420)", () => {
  beforeEach(() => {
    mockManagedFindOne.mockReset();
    mockEventExists.mockReset();
  });

  it("calls a managed channel or waiting room dynamic", async () => {
    managedReturns({ kind: "channel" });
    expect(await classifyVoiceRoom(room, notLobby)).toBe("dynamic");
    managedReturns({ kind: "waiting_room" });
    expect(await classifyVoiceRoom(room, notLobby)).toBe("dynamic");
  });

  it("calls a recorded lobby a lobby", async () => {
    managedReturns({ kind: "lobby" });
    expect(await classifyVoiceRoom(room, notLobby)).toBe("lobby");
  });

  it("calls the lobby a lobby even with no registry row (reused or name-matched)", async () => {
    managedReturns(null);
    expect(await classifyVoiceRoom(room, isLobby)).toBe("lobby");
    expect(mockEventExists).not.toHaveBeenCalled();
  });

  it("does not let the lobby identity override a recorded member room", async () => {
    managedReturns({ kind: "channel" });
    expect(await classifyVoiceRoom(room, isLobby)).toBe("dynamic");
  });

  it("calls an event main or group channel an event channel", async () => {
    managedReturns(null);
    mockEventExists.mockResolvedValue({ _id: "e1" } as never);
    expect(await classifyVoiceRoom(room, notLobby)).toBe("event");
    expect(mockEventExists).toHaveBeenCalledWith({
      guildId: "g1",
      $or: [{ "groups.channelId": "c1" }, { channelId: "c1" }],
    });
  });

  it("calls a channel the bot did not create permanent", async () => {
    managedReturns(null);
    mockEventExists.mockResolvedValue(null as never);
    expect(await classifyVoiceRoom(room, notLobby)).toBe("permanent");
  });

  it("returns undefined, not a guess, without a guild or when the lookup fails", async () => {
    expect(
      await classifyVoiceRoom({ ...room, guildId: undefined }, notLobby),
    ).toBeUndefined();
    mockManagedFindOne.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await classifyVoiceRoom(room, notLobby)).toBeUndefined();
  });
});
