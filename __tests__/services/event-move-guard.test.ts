import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  HOST_MOVE_MARK_TTL_MS,
  consumeHostMove,
  markHostMove,
  resetMoveGuardForTests,
  unmarkHostMove,
  withEventMoveLock,
} from "../../src/services/event-move-guard.js";

beforeEach(() => resetMoveGuardForTests());

describe("host-move marks", () => {
  it("match only their own channel, member and guild, and are used once", () => {
    markHostMove("g", "u", "c1", 1000);
    expect(consumeHostMove("g", "u", "c2", 1001)).toBe(false);
    expect(consumeHostMove("g", "x", "c1", 1001)).toBe(false);
    expect(consumeHostMove("h", "u", "c1", 1001)).toBe(false);
    expect(consumeHostMove("g", "u", "c1", 1001)).toBe(true);
    expect(consumeHostMove("g", "u", "c1", 1002)).toBe(false);
  });

  it("expire after the time to live, which outlasts the 30 s write timeout", () => {
    expect(HOST_MOVE_MARK_TTL_MS).toBeGreaterThan(30_000);
    markHostMove("g", "u", "c1", 0);
    expect(consumeHostMove("g", "u", "c1", HOST_MOVE_MARK_TTL_MS - 1)).toBe(
      true,
    );
    markHostMove("g", "u", "c1", 0);
    expect(consumeHostMove("g", "u", "c1", HOST_MOVE_MARK_TTL_MS + 1)).toBe(
      false,
    );
  });

  it("keeps independent marks per destination, each expiring on its own", () => {
    markHostMove("g", "u", "cA", 0);
    markHostMove("g", "u", "cB", 1000);
    // Consuming or clearing B leaves A's protection alone.
    expect(consumeHostMove("g", "u", "cB", 1001)).toBe(true);
    const b = markHostMove("g", "u", "cB", 1002);
    unmarkHostMove("g", "u", "cB", b);
    expect(consumeHostMove("g", "u", "cA", 1003)).toBe(true);
    // A expires without taking B with it.
    markHostMove("g", "u", "cA", 0);
    markHostMove("g", "u", "cB", HOST_MOVE_MARK_TTL_MS);
    expect(consumeHostMove("g", "u", "cA", HOST_MOVE_MARK_TTL_MS + 1)).toBe(
      false,
    );
    expect(consumeHostMove("g", "u", "cB", HOST_MOVE_MARK_TTL_MS + 1)).toBe(
      true,
    );
  });

  it("unmark removes only the mark for that channel", () => {
    const a = markHostMove("g", "u", "c1", 0);
    unmarkHostMove("g", "u", "c2", a);
    expect(consumeHostMove("g", "u", "c1", 1)).toBe(true);
    const b = markHostMove("g", "u", "c1", 0);
    unmarkHostMove("g", "u", "c1", b);
    expect(consumeHostMove("g", "u", "c1", 1)).toBe(false);
  });

  it("keeps attempts to the SAME channel apart: clearing a refused one leaves the earlier one", () => {
    const first = markHostMove("g", "u", "c1", 0); // unconfirmed, kept
    const second = markHostMove("g", "u", "c1", 1); // refused
    unmarkHostMove("g", "u", "c1", second);
    expect(consumeHostMove("g", "u", "c1", 2)).toBe(true);
    expect(consumeHostMove("g", "u", "c1", 3)).toBe(false);
    // Two kept attempts are two marks, each used once and expiring on its own.
    markHostMove("g", "u", "c1", 0);
    markHostMove("g", "u", "c1", HOST_MOVE_MARK_TTL_MS);
    expect(consumeHostMove("g", "u", "c1", HOST_MOVE_MARK_TTL_MS + 1)).toBe(
      true,
    );
    expect(consumeHostMove("g", "u", "c1", HOST_MOVE_MARK_TTL_MS + 2)).toBe(
      false,
    );
    // Clearing an id that is already gone changes nothing.
    unmarkHostMove("g", "u", "c1", first);
  });
});

describe("withEventMoveLock", () => {
  it("answers busy to a second caller and releases after success or failure", async () => {
    let release: () => void = () => undefined;
    const first = withEventMoveLock(
      "e",
      () => new Promise<string>((r) => (release = () => r("one"))),
    );
    expect(await withEventMoveLock("e", async () => "two")).toEqual({
      busy: true,
    });
    release();
    expect(await first).toEqual({ busy: false, value: "one" });
    await expect(
      withEventMoveLock("e", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withEventMoveLock("e", async () => "three")).toEqual({
      busy: false,
      value: "three",
    });
  });

  it("takes the lock in the same tick as the call", async () => {
    let started = false;
    const a = withEventMoveLock("e", async () => {
      started = true;
      await Promise.resolve();
    });
    // No await between the two calls: the second must already see the lock.
    const b = withEventMoveLock("e", async () => 1);
    expect(await b).toEqual({ busy: true });
    await a;
    expect(started).toBe(true);
  });
});
