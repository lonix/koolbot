/**
 * The page-side read of the slash-command check (#1638): bounded, and any
 * failure is null ("Not checked"), never a report that reads as in sync.
 */
import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { CommandManager } from "../../src/services/command-manager.js";
import {
  readCommandSync,
  rereadCommandSync,
} from "../../src/web/command-sync-read.js";

const stub = (manager: unknown): void => {
  jest.spyOn(CommandManager, "getInstance").mockReturnValue(manager as never);
};

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("readCommandSync", () => {
  it("passes the report through", async () => {
    const report = { state: "in-sync", checkedAt: 1 };
    stub({ checkCommandSync: async () => report });
    await expect(readCommandSync({} as never)).resolves.toBe(report);
  });

  it("is null when the check is slower than the limit", async () => {
    jest.useFakeTimers();
    stub({ checkCommandSync: () => new Promise(() => undefined) });
    const pending = readCommandSync({} as never, 2_500);
    await jest.advanceTimersByTimeAsync(2_501);
    await expect(pending).resolves.toBeNull();
  });

  it("is null when the check throws or the manager is unavailable", async () => {
    stub({
      checkCommandSync: async () => {
        throw new Error("boom");
      },
    });
    await expect(readCommandSync({} as never)).resolves.toBeNull();
    jest.spyOn(CommandManager, "getInstance").mockImplementation(() => {
      throw new Error("not initialised");
    });
    await expect(readCommandSync({} as never)).resolves.toBeNull();
  });
});

describe("rereadCommandSync", () => {
  it("drops the cache first, then reads", async () => {
    const order: string[] = [];
    stub({
      invalidateCommandSync: () => order.push("invalidate"),
      checkCommandSync: async () => {
        order.push("check");
        return { state: "in-sync", checkedAt: 1 };
      },
    });
    await rereadCommandSync({} as never);
    expect(order).toEqual(["invalidate", "check"]);
  });

  it("is null when the manager is unavailable", async () => {
    jest.spyOn(CommandManager, "getInstance").mockImplementation(() => {
      throw new Error("not initialised");
    });
    await expect(rereadCommandSync({} as never)).resolves.toBeNull();
  });
});
