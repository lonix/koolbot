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
    expect(await classifyVoiceRoom("g1", "c1")).toBe("dynamic");
    managedReturns({ kind: "waiting_room" });
    expect(await classifyVoiceRoom("g1", "c1")).toBe("dynamic");
  });

  it("calls the join-to-create lobby a lobby", async () => {
    managedReturns({ kind: "lobby" });
    expect(await classifyVoiceRoom("g1", "c1")).toBe("lobby");
  });

  it("calls an event main or group channel an event channel", async () => {
    managedReturns(null);
    mockEventExists.mockResolvedValue({ _id: "e1" } as never);
    expect(await classifyVoiceRoom("g1", "c1")).toBe("event");
    expect(mockEventExists).toHaveBeenCalledWith({
      guildId: "g1",
      $or: [{ "groups.channelId": "c1" }, { channelId: "c1" }],
    });
  });

  it("calls a channel the bot did not create permanent", async () => {
    managedReturns(null);
    mockEventExists.mockResolvedValue(null as never);
    expect(await classifyVoiceRoom("g1", "c1")).toBe("permanent");
  });

  it("returns undefined, not a guess, without a guild or when the lookup fails", async () => {
    expect(await classifyVoiceRoom(undefined, "c1")).toBeUndefined();
    mockManagedFindOne.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await classifyVoiceRoom("g1", "c1")).toBeUndefined();
  });
});
