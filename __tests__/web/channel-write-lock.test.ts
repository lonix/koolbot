/**
 * The one per-server lock for creating channels (#1714): shared by the Channel
 * Manager's writes and `applyChannelPlan`. Serialises per server, waits a
 * bounded time, and is always released.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";

const {
  withChannelLock,
  channelWriteLock,
  CHANNEL_LOCK_WAIT_MS,
  CHANNEL_LOCK_BUSY_MESSAGE,
} = await import("../../src/web/channel-write-lock.js");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function gate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

afterEach(() => {
  jest.useRealTimers();
});

describe("withChannelLock", () => {
  it("runs one holder at a time for the same server, in order", async () => {
    const log: string[] = [];
    const first = gate();
    const a = withChannelLock("g1", async () => {
      log.push("a start");
      await first.wait;
      log.push("a end");
      return "a";
    });
    const b = withChannelLock("g1", async () => {
      log.push("b start");
      return "b";
    });
    await flush();
    expect(log).toEqual(["a start"]);
    first.open();
    expect(await a).toEqual({ ok: true, value: "a" });
    expect(await b).toEqual({ ok: true, value: "b" });
    expect(log).toEqual(["a start", "a end", "b start"]);
  });

  it("does not block another server", async () => {
    const held = gate();
    const a = withChannelLock("g1", async () => {
      await held.wait;
    });
    const other = await withChannelLock("g2", async () => "free");
    expect(other).toEqual({ ok: true, value: "free" });
    held.open();
    await a;
  });

  it("is released after the work throws, and passes the error on", async () => {
    await expect(
      withChannelLock("g1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withChannelLock("g1", async () => 1)).toEqual({
      ok: true,
      value: 1,
    });
    expect(channelWriteLock.size).toBe(0);
  });

  it("gives up after the bounded wait, says so, and never runs the abandoned work", async () => {
    jest.useFakeTimers();
    const held = gate();
    const holder = withChannelLock("g1", async () => {
      await held.wait;
      return "held";
    });
    const abandoned = jest.fn(async () => "late");
    const waiting = withChannelLock("g1", abandoned);
    await jest.advanceTimersByTimeAsync(CHANNEL_LOCK_WAIT_MS);
    expect(await waiting).toEqual({ ok: false, reason: "busy" });
    expect(CHANNEL_LOCK_BUSY_MESSAGE).toMatch(/nothing was changed/);
    held.open();
    expect(await holder).toEqual({ ok: true, value: "held" });
    await flush();
    expect(abandoned).not.toHaveBeenCalled();
    // The slot is free again, and the map is empty.
    expect(await withChannelLock("g1", async () => "next")).toEqual({
      ok: true,
      value: "next",
    });
    expect(channelWriteLock.size).toBe(0);
  });

  it("a caller cancelled while it waits never runs its work", async () => {
    const held = gate();
    const holder = withChannelLock("g1", async () => {
      await held.wait;
      return "held";
    });
    const abort = new AbortController();
    const work = jest.fn(async () => "late");
    const waiting = withChannelLock("g1", work, abort.signal);
    abort.abort();
    expect(await waiting).toEqual({ ok: false, reason: "cancelled" });
    held.open();
    expect(await holder).toEqual({ ok: true, value: "held" });
    await flush();
    expect(work).not.toHaveBeenCalled();
    expect(channelWriteLock.size).toBe(0);
  });

  it("an already aborted signal never runs the work, even on a free lock", async () => {
    const abort = new AbortController();
    abort.abort();
    const work = jest.fn(async () => 1);
    expect(await withChannelLock("g1", work, abort.signal)).toEqual({
      ok: false,
      reason: "cancelled",
    });
    await flush();
    expect(work).not.toHaveBeenCalled();
  });

  it("a signal that aborts once the work has started does not cut it off", async () => {
    const held = gate();
    const abort = new AbortController();
    const running = withChannelLock(
      "g1",
      async () => {
        await held.wait;
        return "done";
      },
      abort.signal,
    );
    await flush();
    abort.abort();
    held.open();
    expect(await running).toEqual({ ok: true, value: "done" });
  });

  it("does not time a holder out: only the wait is bounded", async () => {
    jest.useFakeTimers();
    const held = gate();
    const holder = withChannelLock("g1", async () => {
      await held.wait;
      return "done";
    });
    await jest.advanceTimersByTimeAsync(CHANNEL_LOCK_WAIT_MS * 3);
    held.open();
    expect(await holder).toEqual({ ok: true, value: "done" });
  });

  it("leaves no timer behind once the work has started", async () => {
    jest.useFakeTimers();
    await withChannelLock("g1", async () => 1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
