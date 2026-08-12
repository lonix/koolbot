import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

jest.mock("../../src/services/discord-logger.js", () => ({
  DiscordLogger: {
    getInstance: jest.fn(() => ({
      logError: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

import { MessageActivityCleanupService } from "../../src/services/message-activity-cleanup.js";
import { MessageActivityTracking } from "../../src/models/message-activity-tracking.js";

// Attach methods the global mongoose mock doesn't provide.
(MessageActivityTracking as unknown as { find: jest.Mock }).find = jest.fn();
(MessageActivityTracking as unknown as { updateMany: jest.Mock }).updateMany =
  jest.fn();

function createService() {
  const service = MessageActivityCleanupService.getInstance({} as Client);

  const mockConfigService = {
    getString: jest.fn().mockResolvedValue(""),
    getBoolean: jest.fn().mockResolvedValue(true),
    getNumber: jest.fn().mockResolvedValue(400),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  (service as never)["configService"] = mockConfigService;
  // No minimum-interval guard for these tests.
  (service as never)["lastCleanupDate"] = null;

  return { service, mockConfigService };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("MessageActivityCleanupService", () => {
  let find: jest.Mock;
  let updateMany: jest.Mock;
  let aggregate: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    find = (MessageActivityTracking as unknown as { find: jest.Mock }).find;
    updateMany = (
      MessageActivityTracking as unknown as { updateMany: jest.Mock }
    ).updateMany;
    aggregate = (MessageActivityTracking as unknown as { aggregate: jest.Mock })
      .aggregate;
    aggregate.mockResolvedValue([]);
    updateMany.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    (
      MessageActivityCleanupService as unknown as { instance: unknown }
    ).instance = undefined;
  });

  it("is a singleton", () => {
    const a = MessageActivityCleanupService.getInstance({} as Client);
    const b = MessageActivityCleanupService.getInstance({} as Client);
    expect(a).toBe(b);
  });

  it("prunes old recentMessages with a scoped atomic $pull and preserves totals", async () => {
    const { service } = createService();

    aggregate.mockResolvedValue([{ _id: null, messages: 3 }]);
    updateMany.mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });

    const stats = await service.runCleanup();

    expect(stats.messagesPruned).toBe(3);
    expect(stats.usersProcessed).toBe(2);

    // A single collection-wide update, scoped to expired entries. Rewriting
    // the whole array from an in-memory snapshot would race with the
    // tracker's concurrent $push appends (#755).
    expect(updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = updateMany.mock.calls[0] as [
      Record<string, unknown>,
      { $pull: Record<string, unknown>; $set: Record<string, unknown> },
    ];
    expect(filter).toEqual({
      "recentMessages.sentAt": { $lt: expect.any(Date) },
    });
    expect(update.$pull).toEqual({
      recentMessages: { sentAt: { $lt: expect.any(Date) } },
    });
    // The update must only pull expired entries and stamp the cleanup date —
    // it must not rewrite recentMessages wholesale or touch the all-time
    // channels[] / totalCount fields.
    expect(update.$set).toEqual({ lastCleanupDate: expect.any(Date) });

    // The cutoff honours the configured retention window (400 days).
    const cutoff = (
      update.$pull.recentMessages as { sentAt: { $lt: Date } }
    ).sentAt.$lt;
    const expectedCutoff = Date.now() - 400 * DAY_MS;
    expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(60_000);

    // No read-then-write snapshot of user documents.
    expect(find).not.toHaveBeenCalled();
  });

  it("reports zeros when nothing is beyond retention", async () => {
    const { service } = createService();

    aggregate.mockResolvedValue([]);
    updateMany.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    const stats = await service.runCleanup();

    expect(stats.messagesPruned).toBe(0);
    expect(stats.usersProcessed).toBe(0);
    expect(stats.errors).toEqual([]);
  });

  it("skips when the cleanup job is disabled", async () => {
    const { service, mockConfigService } = createService();
    mockConfigService.getBoolean.mockResolvedValue(false);

    const stats = await service.runCleanup();
    expect(stats.errors.length).toBeGreaterThan(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
