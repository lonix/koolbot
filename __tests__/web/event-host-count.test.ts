/**
 * `countOpenHostEvents` (#1408): which events count toward a host's limit.
 * Only the query is checked here; the filter is what keeps ended and cancelled
 * events, adopted events and native-cleanup records out of the count.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockCountDocuments = jest.fn<(q: unknown) => Promise<number>>();
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: { countDocuments: mockCountDocuments, find: jest.fn() },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { countOpenHostEvents } = await import("../../src/web/event-host.js");

describe("countOpenHostEvents", () => {
  beforeEach(() => jest.clearAllMocks());

  it("counts only the host's scheduled and active events in the guild", async () => {
    mockCountDocuments.mockResolvedValue(4);
    expect(await countOpenHostEvents("g1", "u1")).toBe(4);
    expect(mockCountDocuments).toHaveBeenCalledWith({
      guildId: "g1",
      createdBy: "u1",
      state: { $in: ["scheduled", "active"] },
      nativeCleanupOnly: { $ne: true },
      nativeAdopted: { $ne: true },
    });
  });

  it("lets a failed read reach the caller", async () => {
    mockCountDocuments.mockRejectedValue(new Error("down"));
    await expect(countOpenHostEvents("g1", "u1")).rejects.toThrow("down");
  });
});
