import { describe, it, expect, jest } from "@jest/globals";
import mongoose from "mongoose";

describe("VoiceChannelTracking model", () => {
  it("declares a multikey index on sessions.startTime (#842)", async () => {
    // Every time-windowed read (leaderboards, truncation, Rewind) filters on
    // `sessions.startTime`; without this index each one is a collection scan.
    const indexSpy = jest.spyOn(mongoose.Schema.prototype, "index");

    const mod = await import("../../src/models/voice-channel-tracking.js");

    expect(mod.VoiceChannelTracking).toBeDefined();
    expect(indexSpy).toHaveBeenCalledWith({ "sessions.startTime": 1 });
  });
});
