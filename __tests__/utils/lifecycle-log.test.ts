import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { postStartupLog, postShutdownLog } =
  await import("../../src/utils/lifecycle-log.js");

describe("lifecycle log posts (#1556)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("postStartupLog", () => {
    it("posts once", async () => {
      const logBotStartup = jest.fn(async () => undefined);

      postStartupLog({ logBotStartup });

      expect(logBotStartup).toHaveBeenCalledTimes(1);
    });

    it("does nothing before the logger exists", () => {
      expect(postStartupLog(undefined)).toBeUndefined();
    });

    it("hands back at once without waiting for Discord, so readiness never waits on a log post", () => {
      const logBotStartup = jest.fn(() => new Promise<void>(() => undefined));

      const result = postStartupLog({ logBotStartup });

      expect(result).toBeUndefined();
      expect(logBotStartup).toHaveBeenCalledTimes(1);
    });

    it("survives a post that throws synchronously", () => {
      const logBotStartup = jest.fn(() => {
        throw new Error("boom");
      });

      expect(() => postStartupLog({ logBotStartup })).not.toThrow();
    });

    it("never throws, so a failed post cannot break startup", async () => {
      const logBotStartup = jest.fn(async () => {
        throw new Error("discord down");
      });

      expect(() => postStartupLog({ logBotStartup })).not.toThrow();
      await Promise.resolve();
    });
  });

  describe("postShutdownLog", () => {
    it("posts once", async () => {
      const logBotShutdown = jest.fn(async () => undefined);

      await postShutdownLog({ logBotShutdown });

      expect(logBotShutdown).toHaveBeenCalledTimes(1);
    });

    it("does nothing when a signal arrives before the logger exists", async () => {
      await expect(postShutdownLog(undefined)).resolves.toBeUndefined();
    });

    it("never throws, so a failed post cannot stop the shutdown", async () => {
      const logBotShutdown = jest.fn(async () => {
        throw new Error("discord down");
      });

      await expect(
        postShutdownLog({ logBotShutdown }),
      ).resolves.toBeUndefined();
    });

    it("stops waiting after the bound when Discord hangs", async () => {
      jest.useFakeTimers();
      try {
        const logBotShutdown = jest.fn(
          () => new Promise<void>(() => undefined),
        );
        let done = false;
        const pending = postShutdownLog({ logBotShutdown }, 2000).then(() => {
          done = true;
        });

        await jest.advanceTimersByTimeAsync(1999);
        expect(done).toBe(false);
        await jest.advanceTimersByTimeAsync(2);
        await pending;

        expect(done).toBe(true);
        expect(logBotShutdown).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
