import { describe, it, expect } from "@jest/globals";
import { createKeyedLock } from "../../src/utils/keyed-lock.js";

/**
 * The ordering primitive behind two LFG guarantees: clicks on one post are
 * handled in order, and one member's concurrent `/lfg` runs resolve their
 * voice channel one at a time (#957).
 */
describe("createKeyedLock", () => {
  function deferred(): {
    promise: Promise<void>;
    resolve: () => void;
  } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("runs work for the same key one at a time, in call order", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    const first = deferred();

    const a = lock.run("k", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = lock.run("k", async () => {
      order.push("b:start");
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("does not make different keys wait for each other", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    const held = deferred();

    const a = lock.run("one", async () => {
      await held.promise;
      order.push("one");
    });
    await lock.run("two", async () => {
      order.push("two");
    });

    // "two" finished while "one" was still held.
    expect(order).toEqual(["two"]);
    held.resolve();
    await a;
    expect(order).toEqual(["two", "one"]);
  });

  it("returns each caller its own result", async () => {
    const lock = createKeyedLock();
    const [a, b] = await Promise.all([
      lock.run("k", async () => "first"),
      lock.run("k", async () => "second"),
    ]);
    expect([a, b]).toEqual(["first", "second"]);
  });

  it("rejects the caller that failed, without blocking the next", async () => {
    const lock = createKeyedLock();
    const failed = lock.run("k", async () => {
      throw new Error("boom");
    });

    await expect(failed).rejects.toThrow("boom");
    await expect(lock.run("k", async () => "still works")).resolves.toBe(
      "still works",
    );
  });

  it("forgets a key once its chain has drained", async () => {
    const lock = createKeyedLock();
    await lock.run("k", async () => undefined);
    // The entry is cleared from the chain's own continuation, which settles a
    // turn after the caller's, so flush before asserting. Otherwise the map
    // would grow with every post or member ever seen.
    await new Promise((r) => setTimeout(r, 0));
    expect(lock.size).toBe(0);
  });

  it("keeps a key while work is still queued behind it", async () => {
    const lock = createKeyedLock();
    const held = deferred();
    const a = lock.run("k", () => held.promise);
    const b = lock.run("k", async () => undefined);

    expect(lock.size).toBe(1);
    held.resolve();
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 0));
    expect(lock.size).toBe(0);
  });
});
