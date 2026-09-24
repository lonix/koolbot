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

    await expect(service.optIn("u1", "g1")).resolves.toEqual({
      removed: true,
      settled: true,
    });

    expect(deleteOne).toHaveBeenCalledWith({ userId: "u1", guildId: "g1" });
    expect(service.isOptedOut("u1", "g1")).toBe(false);
  });

  it("reports an opt-in with no row to remove", async () => {
    findReturns([]);
    deleteOne.mockResolvedValue({ deletedCount: 0 } as never);
    const service = TrackingOptOutService.getInstance();
    await service.initialize();
    await expect(service.optIn("u1", "g1")).resolves.toEqual({
      removed: false,
      settled: true,
    });
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

  it("retries a failed load on a timer, with no tracker traffic at all", async () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
    });
    try {
      findRejects(new Error("mongo down"));
      const service = TrackingOptOutService.getInstance();
      await expect(service.initialize()).rejects.toThrow();
      expect(service.isLoaded()).toBe(false);

      // Mongo recovers; nobody calls isOptedOut.
      findReturns([{ userId: "u1", guildId: "g1" }]);
      jest.advanceTimersByTime(TrackingOptOutService.RETRY_INTERVAL_MS);
      await flush();

      expect(find).toHaveBeenCalledTimes(2);
      expect(service.isLoaded()).toBe(true);
      expect(service.isOptedOut("u1", "g1")).toBe(true);
    } finally {
      jest.useRealTimers();
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

  describe("in-flight writes and serialisation", () => {
    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it("runs a tracker write for a tracked member", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();
      const write = jest.fn(async () => undefined);

      await expect(service.trackWrite("u1", "g1", write)).resolves.toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
    });

    it("never starts a tracker write for an opted-out member", async () => {
      findReturns([{ userId: "u1", guildId: "g1" }]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();
      const write = jest.fn(async () => undefined);

      await expect(service.trackWrite("u1", "g1", write)).resolves.toBe(false);
      expect(write).not.toHaveBeenCalled();
    });

    it("does not return from an opt-out until a write it was too late to stop has settled", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();

      const gate = deferred();
      let written = false;
      const writing = service.trackWrite("u1", "g1", async () => {
        await gate.promise;
        written = true;
      });

      let optedOut = false;
      const optingOut = service.optOut("u1", "g1").then(() => {
        optedOut = true;
      });
      await flush();
      // The cache already blocks new writes, but the old one is still open.
      expect(service.isOptedOut("u1", "g1")).toBe(true);
      expect(optedOut).toBe(false);

      gate.resolve();
      await writing;
      await optingOut;
      expect(written).toBe(true);
      expect(optedOut).toBe(true);
    });

    it("runs opt-out hooks after the cache knows, and survives one that throws", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();
      const seen: boolean[] = [];
      service.onOptOut(async () => {
        throw new Error("hook broke");
      });
      service.onOptOut(async (userId, guildId) => {
        seen.push(service.isOptedOut(userId, guildId));
      });

      // Stored and applied, but a failed hook means it is not settled.
      await expect(service.optOut("u1", "g1")).resolves.toEqual({
        settled: false,
      });
      expect(seen).toEqual([true]);
      expect(service.isOptedOut("u1", "g1")).toBe(true);
    });

    it("serialises overlapping opt-out and opt-in so the cache matches the last write", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();

      // The opt-out's Mongo write is slow; the opt-in's is instant. Without
      // serialisation the opt-out's cache add would land last.
      const slow = deferred();
      updateOne.mockImplementationOnce(async () => {
        await slow.promise;
        return { upsertedCount: 1 };
      });
      const optingOut = service.optOut("u1", "g1");
      const optingIn = service.optIn("u1", "g1");
      await flush();
      expect(deleteOne).not.toHaveBeenCalled();

      slow.resolve();
      await optingOut;
      await optingIn;
      expect(deleteOne).toHaveBeenCalledTimes(1);
      expect(service.isOptedOut("u1", "g1")).toBe(false);
    });

    it("holds an opt-in back until the opt-out's drain and hooks have finished", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();
      const hookGate = deferred();
      service.onOptOut(() => hookGate.promise);

      const optingOut = service.optOut("u1", "g1");
      await flush();
      const optingIn = service.optIn("u1", "g1");
      await flush();
      // The opt-out's hook is still running, so the opt-in must not start.
      expect(deleteOne).not.toHaveBeenCalled();
      expect(service.isOptedOut("u1", "g1")).toBe(true);

      hookGate.resolve();
      await optingOut;
      await optingIn;
      expect(deleteOne).toHaveBeenCalledTimes(1);
      expect(service.isOptedOut("u1", "g1")).toBe(false);
    });

    it("reports a clean opt-out as settled", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();
      service.onOptOut(async () => true);
      await expect(service.optOut("u1", "g1")).resolves.toEqual({
        settled: true,
      });
    });

    it("reports an opt-out whose hook could not drain as unsettled", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();
      service.onOptOut(async () => false);
      await expect(service.optOut("u1", "g1")).resolves.toEqual({
        settled: false,
      });
    });

    it("pauses tracking for a reset: waits out writes in flight and admits no new ones", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();

      const gate = deferred();
      const writing = service.trackWrite("u1", "g1", () => gate.promise);

      const resetGate = deferred();
      let quiesced: unknown = null;
      const resetting = service.withTrackingPaused("u1", "g1", async (q) => {
        quiesced = q;
        await resetGate.promise;
        return "done";
      });
      await flush();
      // Paused already, though the old write is still open.
      expect(service.isOptedOut("u1", "g1")).toBe(true);
      expect(quiesced).toBeNull();

      gate.resolve();
      await writing;
      await flush();
      expect(quiesced).toEqual({ pending: 1, settled: true });

      // A handler that passed an early check cannot write mid-reset.
      const late = jest.fn(async () => undefined);
      await expect(service.trackWrite("u1", "g1", late)).resolves.toBe(false);
      expect(late).not.toHaveBeenCalled();

      resetGate.resolve();
      await expect(resetting).resolves.toBe("done");
      // Tracked again once the reset is over.
      expect(service.isOptedOut("u1", "g1")).toBe(false);
    });

    it("holds an opt-in back until a running reset has finished", async () => {
      findReturns([{ userId: "u1", guildId: "g1" }]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();

      const resetGate = deferred();
      const resetting = service.withTrackingPaused(
        "u1",
        "g1",
        () => resetGate.promise,
      );
      await flush();
      const optingIn = service.optIn("u1", "g1");
      await flush();
      expect(deleteOne).not.toHaveBeenCalled();

      resetGate.resolve();
      await resetting;
      await optingIn;
      expect(deleteOne).toHaveBeenCalledTimes(1);
    });

    it("refuses to opt back in while work from the opt-out has not settled", async () => {
      findReturns([{ userId: "u1", guildId: "g1" }]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();
      service.onOptOut(async () => false);

      await expect(service.optIn("u1", "g1")).resolves.toEqual({
        removed: false,
        settled: false,
      });
      expect(deleteOne).not.toHaveBeenCalled();
      expect(service.isOptedOut("u1", "g1")).toBe(true);
    });

    it("does not quiesce, or run the hooks, on an opt-in from a member who is tracked", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();
      const hook = jest.fn(async () => true);
      service.onOptOut(hook);
      deleteOne.mockResolvedValue({ deletedCount: 0 } as never);

      await expect(service.optIn("u1", "g1")).resolves.toEqual({
        removed: false,
        settled: true,
      });
      // Their live voice session must not be evicted by a duplicate POST.
      expect(hook).not.toHaveBeenCalled();
    });

    it("refuses a write whose ticket predates an opt-out, even after opting back in", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();

      const ticket = service.admission();
      await service.optOut("u1", "g1");
      await service.optIn("u1", "g1");
      expect(service.isOptedOut("u1", "g1")).toBe(false);

      const stale = jest.fn(async () => undefined);
      await expect(service.trackWrite("u1", "g1", stale, ticket)).resolves.toBe(
        false,
      );
      expect(stale).not.toHaveBeenCalled();

      // A handler that starts after the opt-in writes normally.
      const fresh = jest.fn(async () => undefined);
      await expect(
        service.trackWrite("u1", "g1", fresh, service.admission()),
      ).resolves.toBe(true);
      expect(fresh).toHaveBeenCalled();
    });

    it("refuses a write whose ticket predates a reset that has since finished", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();

      const ticket = service.admission();
      await service.withTrackingPaused("u1", "g1", async () => undefined);

      const stale = jest.fn(async () => undefined);
      await expect(service.trackWrite("u1", "g1", stale, ticket)).resolves.toBe(
        false,
      );
      expect(stale).not.toHaveBeenCalled();
      // Other members' tickets are unaffected.
      const other = jest.fn(async () => undefined);
      await expect(service.trackWrite("u2", "g1", other, ticket)).resolves.toBe(
        true,
      );
    });

    it("refuses a write whose ticket was taken while the reset was still running", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();

      const resetGate = deferred();
      let ticket = -1;
      const resetting = service.withTrackingPaused("u1", "g1", async () => {
        // An event arrives mid-reset and its handler takes a ticket.
        ticket = service.admission();
        await resetGate.promise;
      });
      await flush();
      resetGate.resolve();
      await resetting;
      expect(service.isOptedOut("u1", "g1")).toBe(false);

      const stale = jest.fn(async () => undefined);
      await expect(service.trackWrite("u1", "g1", stale, ticket)).resolves.toBe(
        false,
      );
      expect(stale).not.toHaveBeenCalled();
    });

    it("refuses a write whose ticket was taken while the member was opted out", async () => {
      findReturns([{ userId: "u1", guildId: "g1" }]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();

      const ticket = service.admission();
      await service.optIn("u1", "g1");

      const stale = jest.fn(async () => undefined);
      await expect(service.trackWrite("u1", "g1", stale, ticket)).resolves.toBe(
        false,
      );
      expect(stale).not.toHaveBeenCalled();
    });

    it("keeps serving later mutations after one fails", async () => {
      findReturns([]);
      const service = TrackingOptOutService.getInstance();
      await service.initialize();

      updateOne.mockRejectedValueOnce(new Error("write failed") as never);
      await expect(service.optOut("u1", "g1")).rejects.toThrow("write failed");
      await service.optOut("u1", "g1");
      expect(service.isOptedOut("u1", "g1")).toBe(true);
    });
  });
});
