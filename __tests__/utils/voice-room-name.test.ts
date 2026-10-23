import { describe, it, expect } from "@jest/globals";
import { voiceRoomNameOf } from "../../src/utils/voice-room-name.js";

describe("voiceRoomNameOf", () => {
  it("names voice and stage rooms only", () => {
    expect(voiceRoomNameOf({ type: 2, name: "Lobby" })).toBe("Lobby");
    expect(voiceRoomNameOf({ type: 13, name: "Town hall" })).toBe("Town hall");
    expect(voiceRoomNameOf({ type: 0, name: "general" })).toBeNull();
    expect(voiceRoomNameOf({ type: 4, name: "Events" })).toBeNull();
  });

  it("returns null without a channel or a usable name", () => {
    expect(voiceRoomNameOf(null)).toBeNull();
    expect(voiceRoomNameOf(undefined)).toBeNull();
    expect(voiceRoomNameOf({ type: 2 })).toBeNull();
    expect(voiceRoomNameOf({ type: 2, name: "" })).toBeNull();
  });
});
