/**
 * Unit tests for TrackingOptOutService (#918).
 *
 * Covers:
 *  - fails closed (everyone opted out) until the cache has loaded
 *  - loads the collection into the cache and answers from memory
 *  - optOut / optIn write Mongo first, then update the cache
 *  - a failed write leaves the cache untouched
 *  - a load racing a write cannot undo the write
 *  - a failed load is retried in the background, throttled
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import { TrackingOptOut } from "../../src/models/tracking-opt-out.js";
import { TrackingOptOutService } from "../../src/services/tracking-opt-out-service.js";

// The global mongoose mock (setup.ts) hands every model one shared stub;
// give it fresh methods for this suite.
Object.assign(TrackingOptOut, {
  find: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(),
  deleteOne: jest.fn(),
});

const find = TrackingOptOut.find as unknown as jest.Mock;
const findOne = TrackingOptOut.findOne as unknown as jest.Mock;
const updateOne = TrackingOptOut.updateOne as unknown as jest.Mock;
const deleteOne = TrackingOptOut.deleteOne as unknown as jest.Mock;

/** A `find(...).lean()` chain resolving to `rows`. */
function findReturns(rows: unknown): void {
  find.mockReturnValue({ lean: jest.fn(async () => rows) });
}

/** A `find(...).lean()` chain rejecting with `error`. */
function findRejects(error: Error): void {
  find.mockReturnValue({
    lean: jest.fn(async () => {
      throw error;
    }),
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("TrackingOptOutService", () => {
  beforeEach(() => {
    find.mockReset();
    findOne.mockReset();
    updateOne.mockReset().mockResolvedValue({ upsertedCount: 1 } as never);
    deleteOne.mockReset().mockResolvedValue({ deletedCount: 1 } as never);
    TrackingOptOutService.reset();
  });

  it("fails closed until the opt-outs have loaded", () => {
    findRejects(new Error("not yet"));
    const service = TrackingOptOutService.getInstance();
    expect(service.isLoaded()).toBe(false);
    expect(service.isOptedOut("anyone", "g1")).toBe(true);
  });

  it("answers from the loaded set, keyed per guild", async () => {
    findReturns([{ userId: "u1", guildId: "g1" }]);
    const service = TrackingOptOutService.getInstance();
    await service.initialize();

    expect(service.isLoaded()).toBe(true);
    expect(service.isOptedOut("u1", "g1")).toBe(true);
    expect(service.isOptedOut("u1", "g2")).toBe(false);
    expect(service.isOptedOut("u2", "g1")).toBe(false);
    // One query at startup, none per check.
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed initial load so startup can log it", async () => {
    findRejects(new Error("mongo down"));
    await expect(
      TrackingOptOutService.getInstance().initialize(),
    ).rejects.toThrow("mongo down");
  });

  it("opts a member out: upserts the row, then adds them to the cache", async () => {
    findReturns([]);
    const service = TrackingOptOutService.getInstance();
    await service.initialize();

    await service.optOut("u1", "g1");

    expect(updateOne).toHaveBeenCalledWith(
      { userId: "u1", guildId: "g1" },
      {
        $setOnInsert: expect.objectContaining({
          userId: "u1",
          guildId: "g1",
          optedOutAt: expect.any(Date),
        }),
      },
      { upsert: true },
    );
    expect(service.isOptedOut("u1", "g1")).toBe(true);
  });

  it("opts a member back in: deletes the row, then drops them from the cache", async () => {
    findReturns([{ userId: "u1", guildId: "g1" }]);
    const service = TrackingOptOutService.getInstance();
    await service.initialize();

    await expect(service.optIn("u1", "g1")).resolves.toBe(true);

    expect(deleteOne).toHaveBeenCalledWith({ userId: "u1", guildId: "g1" });
    expect(service.isOptedOut("u1", "g1")).toBe(false);
  });

  it("reports an opt-in with no row to remove", async () => {
    findReturns([]);
    deleteOne.mockResolvedValue({ deletedCount: 0 } as never);
    const service = TrackingOptOutService.getInstance();
    await service.initialize();
    await expect(service.optIn("u1", "g1")).resolves.toBe(false);
  });

  it("leaves the cache alone when the write fails", async () => {
    findReturns([{ userId: "u2", guildId: "g1" }]);
    const service = TrackingOptOutService.getInstance();
    await service.initialize();

    updateOne.mockRejectedValue(new Error("write failed") as never);
    await expect(service.optOut("u1", "g1")).rejects.toThrow("write failed");
    expect(service.isOptedOut("u1", "g1")).toBe(false);

    deleteOne.mockRejectedValue(new Error("write failed") as never);
    await expect(service.optIn("u2", "g1")).rejects.toThrow("write failed");
    // Still opted out: a failed opt-in keeps failing closed.
    expect(service.isOptedOut("u2", "g1")).toBe(true);
  });

  it("does not let a load that read before an opt-out undo it", async () => {
    // The load reads an empty collection, but only resolves after the
    // opt-out's write has landed.
    let resolveLoad: (rows: unknown[]) => void = () => undefined;
    find.mockReturnValue({
      lean: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveLoad = resolve;
          }),
      ),
    });
    const service = TrackingOptOutService.getInstance();
    const loading = service.initialize();

    const optingOut = service.optOut("u1", "g1");
    await flush();
    resolveLoad([]);
    await loading;
    await optingOut;

    expect(service.isOptedOut("u1", "g1")).toBe(true);
  });

  it("retries a failed load in the background, throttled", async () => {
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000_000);
      findRejects(new Error("mongo down"));
      const service = TrackingOptOutService.getInstance();
      await expect(service.initialize()).rejects.toThrow();
      expect(find).toHaveBeenCalledTimes(1);

      // Inside the retry window: still closed, and no new query.
      expect(service.isOptedOut("u1", "g1")).toBe(true);
      await flush();
      expect(find).toHaveBeenCalledTimes(1);

      // Past the window: the next check kicks off a reload.
      nowSpy.mockReturnValue(
        1_000_000 + TrackingOptOutService.RETRY_INTERVAL_MS,
      );
      findReturns([]);
      expect(service.isOptedOut("u1", "g1")).toBe(true);
      await flush();
      expect(find).toHaveBeenCalledTimes(2);
      expect(service.isLoaded()).toBe(true);
      expect(service.isOptedOut("u1", "g1")).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reads the page's opt-out state straight from Mongo", async () => {
    const at = new Date("2026-09-01T00:00:00Z");
    findOne.mockReturnValue({
      lean: jest.fn(async () => ({ optedOutAt: at })),
    });
    const service = TrackingOptOutService.getInstance();
    await expect(service.getOptedOutAt("u1", "g1")).resolves.toBe(at);
    expect(findOne).toHaveBeenCalledWith({ userId: "u1", guildId: "g1" });

    findOne.mockReturnValue({ lean: jest.fn(async () => null) });
    await expect(service.getOptedOutAt("u1", "g1")).resolves.toBeNull();
  });
});
