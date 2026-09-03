import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

// Mock dependencies
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/models/voice-channel-tracking.js", () => ({
  VoiceChannelTracking: {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
  },
}));

import { VoiceChannelTracking } from "../../src/models/voice-channel-tracking.js";

// Under ESM the jest.mock factory above is not hoisted, so the import
// actually resolves to the global mongoose mock from __tests__/setup.ts.
// Attach the methods that mock doesn't provide, and pin `aggregate`
// explicitly so this file doesn't silently depend on the global mock's
// method set.
(VoiceChannelTracking as unknown as { updateMany: jest.Mock }).updateMany =
  jest.fn();
(VoiceChannelTracking as unknown as { aggregate: jest.Mock }).aggregate =
  jest.fn();

describe("VoiceChannelTruncationService Methods", () => {
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      guilds: {
        cache: new Map(),
      } as any,
    } as Client;
  });

  it("should have getInstance method", async () => {
    const { VoiceChannelTruncationService } =
      await import("../../src/services/voice-channel-truncation.js");

    expect(typeof VoiceChannelTruncationService.getInstance).toBe("function");
  });

  it("should return singleton instance", async () => {
    const { VoiceChannelTruncationService } =
      await import("../../src/services/voice-channel-truncation.js");

    const instance1 = VoiceChannelTruncationService.getInstance(
      mockClient as Client,
    );
    const instance2 = VoiceChannelTruncationService.getInstance(
      mockClient as Client,
    );

    expect(instance1).toBe(instance2);
  });

  it("should have runCleanup method", async () => {
    const { VoiceChannelTruncationService } =
      await import("../../src/services/voice-channel-truncation.js");

    const instance = VoiceChannelTruncationService.getInstance(
      mockClient as Client,
    );

    expect(typeof instance.runCleanup).toBe("function");
  });

  it("should have getStatus method", async () => {
    const { VoiceChannelTruncationService } =
      await import("../../src/services/voice-channel-truncation.js");

    const instance = VoiceChannelTruncationService.getInstance(
      mockClient as Client,
    );

    expect(typeof instance.getStatus).toBe("function");
  });

  it("prunes expired sessions with a scoped atomic $pull, not a read-filter-$set sweep", async () => {
    const { VoiceChannelTruncationService } =
      await import("../../src/services/voice-channel-truncation.js");
    const instance = VoiceChannelTruncationService.getInstance(
      mockClient as Client,
    );

    const find = VoiceChannelTracking.find as jest.Mock;
    const updateMany = VoiceChannelTracking.updateMany as jest.Mock;
    const aggregate = VoiceChannelTracking.aggregate as jest.Mock;
    aggregate.mockResolvedValue([{ _id: null, sessions: 5 }]);
    updateMany.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });

    // performCleanup is the private worker that the cron tick invokes.
    const stats = await (
      instance as unknown as {
        performCleanup: () => Promise<{
          sessionsRemoved: number;
          dataAggregated: number;
        }>;
      }
    ).performCleanup();

    expect(stats.sessionsRemoved).toBe(5);
    expect(stats.dataAggregated).toBe(2);

    // A single collection-wide update, scoped to expired sessions. Rewriting
    // the whole array from an in-memory snapshot would race with the
    // tracker's concurrent $push appends (#755).
    expect(updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = updateMany.mock.calls[0] as [
      Record<string, unknown>,
      { $pull: Record<string, unknown>; $set: Record<string, unknown> },
    ];
    expect(filter).toEqual({
      "sessions.startTime": { $lt: expect.any(Date) },
    });
    expect(update.$pull).toEqual({
      sessions: { startTime: { $lt: expect.any(Date) } },
    });
    // Only expired entries are pulled and the cleanup date stamped — the
    // sessions array itself must never be rewritten wholesale.
    expect(update.$set).toEqual({ lastCleanupDate: expect.any(Date) });

    // No read-then-write snapshot of user documents.
    expect(find).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN])(
    "skips pruning entirely when the detailed-session retention is %p (0 = keep forever, #835)",
    async (retention) => {
      const { VoiceChannelTruncationService } =
        await import("../../src/services/voice-channel-truncation.js");
      const instance = VoiceChannelTruncationService.getInstance(
        mockClient as Client,
      );
      // A 0/negative window would put the cutoff at (or after) now and
      // $pull every session for every user. The guard sits on the consumed
      // value so a stray 0 stored before the write boundary refused blank
      // input is covered too.
      (instance as never)["configService"] = {
        getNumber: jest.fn().mockResolvedValue(retention),
      };
      const updateMany = VoiceChannelTracking.updateMany as jest.Mock;
      const aggregate = VoiceChannelTracking.aggregate as jest.Mock;

      const stats = await (
        instance as unknown as {
          performCleanup: () => Promise<{
            sessionsRemoved: number;
            dataAggregated: number;
            errors: string[];
          }>;
        }
      ).performCleanup();

      expect(stats).toMatchObject({
        sessionsRemoved: 0,
        dataAggregated: 0,
        errors: [],
      });
      expect(aggregate).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    },
  );
});
