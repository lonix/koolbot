/**
 * The write helper together with the real `CommandManager.makeDiscordApiCall`
 * (no pass-through mock): a deliberate rate-limit rejection from the write
 * client must reach the page at once and unchanged, not be waited on and
 * retried by the shared retry wrapper.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { RateLimitError } from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  isDebugMode: () => false,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getNumber: jest.fn(async () => 0),
      getString: jest.fn(async (_k: string, d = "") => d),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const { CommandManager } =
  await import("../../src/services/command-manager.js");
const { cancellableCall, describeWriteFailure } =
  await import("../../src/web/channel-write-rest.js");

// The retry wrapper doesn't use instance state; skip the heavy constructor.
const manager = Object.create(CommandManager.prototype) as InstanceType<
  typeof CommandManager
>;

const rateLimit = (retryAfter: number): RateLimitError =>
  new RateLimitError({
    timeToReset: 0,
    retryAfter,
    sublimitTimeout: 0,
    limit: 2,
    method: "PATCH",
    hash: "h",
    url: "https://discord.com/api/v10/channels/1",
    route: "/channels/:id",
    majorParameter: "1",
    global: false,
    scope: "user",
  });

describe("cancellableCall with the real makeDiscordApiCall", () => {
  it("passes a deliberate RateLimitError through at once, unchanged, with one attempt", async () => {
    const error = rateLimit(540_000);
    const fn = jest.fn(async (): Promise<never> => {
      throw error;
    });
    const started = Date.now();
    // A retry would sleep 5 s per attempt and wrap the error.
    const caught = await cancellableCall(
      manager,
      fn,
      "edit channel",
      false,
    ).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(caught).toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(describeWriteFailure(caught)).toContain("minutes");
  }, 10_000);
});
