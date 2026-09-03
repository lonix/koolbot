import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";
import { waitForClientReady } from "../../src/utils/discord.js";
import logger from "../../src/utils/logger.js";

/**
 * Minimal gateway-client stub: `isReady()` reads a flag the test flips, and
 * `once`/`off` record listeners so the "resolves on ready" path can be driven
 * without a real Discord connection.
 */
function createClientStub(): {
  client: Client;
  becomeReady: () => void;
  listenerCount: () => number;
} {
  let ready = false;
  const listeners = new Set<() => void>();

  const client = {
    isReady: (): boolean => ready,
    once: (event: string, fn: () => void): void => {
      if (event === "ready") listeners.add(fn);
    },
    off: (event: string, fn: () => void): void => {
      if (event === "ready") listeners.delete(fn);
    },
  } as unknown as Client;

  return {
    client,
    becomeReady: (): void => {
      ready = true;
      for (const fn of [...listeners]) fn();
    },
    listenerCount: (): number => listeners.size,
  };
}

describe("waitForClientReady", () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  it("returns immediately when the client is already ready", async () => {
    const { client, becomeReady } = createClientStub();
    becomeReady();
    await expect(
      waitForClientReady(client, "TestService"),
    ).resolves.toBeUndefined();
  });

  it("resolves when the ready event fires, and removes its listener", async () => {
    const { client, becomeReady, listenerCount } = createClientStub();
    const pending = waitForClientReady(client, "TestService");

    // Let the promise executor attach its listener before firing.
    await Promise.resolve();
    becomeReady();

    await expect(pending).resolves.toBeUndefined();
    expect(listenerCount()).toBe(0);
  });

  it("gives up after maxWaitMs and warns instead of waiting forever", async () => {
    jest.useFakeTimers();
    const warnSpy = jest
      .spyOn(logger, "warn")
      .mockImplementation((() => logger) as never);
    warnSpy.mockClear();

    const { client, listenerCount } = createClientStub();
    const pending = waitForClientReady(client, "TestService", 1000);

    await jest.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeUndefined();

    expect(String(warnSpy.mock.calls[0][0])).toContain(
      "TestService: client did not become ready",
    );
    expect(listenerCount()).toBe(0);
    jest.useRealTimers();
  });

  it("resolves from the poll when readiness is reached without a ready event", async () => {
    jest.useFakeTimers();
    const { client } = createClientStub();
    let ready = false;
    (client as unknown as { isReady: () => boolean }).isReady = () => ready;

    const pending = waitForClientReady(client, "TestService", 10_000);
    ready = true;
    await jest.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toBeUndefined();
    jest.useRealTimers();
  });
});
