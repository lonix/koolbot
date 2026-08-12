import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { setImmediate } from "node:timers";
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
(MessageActivityTracking as unknown as { updateOne: jest.Mock }).updateOne =
  jest.fn();

// Mimics the streaming `find({}).lean(false).cursor()` chain the cleanup
// service uses, yielding each doc one at a time.
function findCursor(docs: unknown[]) {
  return {
    lean: () => ({
      cursor: () => ({
        async *[Symbol.asyncIterator]() {
          for (const doc of docs) {
            yield doc;
          }
        },
      }),
    }),
  };
}

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
  let updateOne: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    find = (MessageActivityTracking as unknown as { find: jest.Mock }).find;
    updateOne = (MessageActivityTracking as unknown as { updateOne: jest.Mock })
      .updateOne;
    updateOne.mockResolvedValue({ matchedCount: 1 });
    (
      MessageActivityCleanupService as unknown as { instance: unknown }
    ).instance = undefined;
  });

  it("is a singleton", () => {
    const a = MessageActivityCleanupService.getInstance({} as Client);
    const b = MessageActivityCleanupService.getInstance({} as Client);
    expect(a).toBe(b);
  });

  it("prunes recentMessages older than retention and preserves totals", async () => {
    const { service } = createService();

    const now = Date.now();
    const oldEntry = { sentAt: new Date(now - 500 * DAY_MS), channelId: "c1" };
    const recentEntry = {
      sentAt: new Date(now - 10 * DAY_MS),
      channelId: "c1",
    };

    const userDoc = {
      _id: "id1",
      username: "User1",
      totalCount: 42,
      channels: [{ channelId: "c1", count: 42 }],
      recentMessages: [oldEntry, recentEntry],
    };

    find.mockReturnValue(findCursor([userDoc]));

    const stats = await service.runCleanup();

    expect(stats.messagesPruned).toBe(1);
    expect(stats.usersProcessed).toBe(1);

    // The update only rewrites recentMessages — it must not touch
    // channels[] or totalCount.
    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "id1" });
    expect(update.$set.recentMessages).toEqual([recentEntry]);
    expect(update.$set.recentMessages).toHaveLength(1);
    expect(update.$set).not.toHaveProperty("channels");
    expect(update.$set).not.toHaveProperty("totalCount");
  });

  it("does not write when nothing is beyond retention", async () => {
    const { service } = createService();

    const recentEntry = {
      sentAt: new Date(Date.now() - 5 * DAY_MS),
      channelId: "c1",
    };
    find.mockReturnValue(
      findCursor([
        {
          _id: "id1",
          username: "User1",
          totalCount: 1,
          channels: [{ channelId: "c1", count: 1 }],
          recentMessages: [recentEntry],
        },
      ]),
    );

    const stats = await service.runCleanup();

    expect(stats.messagesPruned).toBe(0);
    expect(stats.usersProcessed).toBe(0);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("streams via a cursor and never materialises the whole collection", async () => {
    const { service } = createService();

    const cursor = jest.fn(() => ({
      async *[Symbol.asyncIterator]() {},
    }));
    const lean = jest.fn(() => ({ cursor }));
    find.mockReturnValue({ lean });

    await service.runCleanup();

    // The cleanup must page through the collection with a cursor rather than
    // awaiting an unbounded `.find({}).exec()` that loads every document.
    expect(find).toHaveBeenCalledTimes(1);
    expect(cursor).toHaveBeenCalledTimes(1);
    expect(find.mock.results[0].value).not.toHaveProperty("exec");
  });

  it("keeps the mutual-exclusion guard intact when destroy() fires mid-run (issue #779)", async () => {
    const { service } = createService();

    let releaseCursor!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCursor = resolve;
    });

    // A cursor whose iteration blocks until the test releases it, holding
    // performCleanup() in flight.
    find.mockReturnValue({
      lean: () => ({
        cursor: () => ({
          async *[Symbol.asyncIterator]() {
            await gate;
            yield* [];
          },
        }),
      }),
    });

    const firstRun = service.runCleanup();
    // Let runCleanup() pass its guard and enter performCleanup().
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.getStatus().isRunning).toBe(true);

    // The config-reload callback tears the schedule down while the pass is
    // still executing — it must not reset the in-flight flag.
    service.destroy();
    expect(service.getStatus().isRunning).toBe(true);
    expect(service.getStatus().isScheduled).toBe(false);

    // A second run (next cron tick, or a web UI "run now") stays blocked.
    await expect(service.runCleanup()).rejects.toThrow(
      "Message cleanup is already running",
    );

    releaseCursor();
    await firstRun;
    // The finally block in runCleanup() — not destroy() — clears the flag.
    expect(service.getStatus().isRunning).toBe(false);
  });

  it("skips when the cleanup job is disabled", async () => {
    const { service, mockConfigService } = createService();
    mockConfigService.getBoolean.mockResolvedValue(false);

    const stats = await service.runCleanup();
    expect(stats.errors.length).toBeGreaterThan(0);
    expect(find).not.toHaveBeenCalled();
  });
});
