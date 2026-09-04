import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { stubMongoGuard } from "../test-utils.js";
import type { Client, PollAnswer, User } from "discord.js";

jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

// The global mongoose mock in __tests__/setup.ts hands every `mongoose.model`
// call the *same* stub object, so the two collections this tracker writes
// would be indistinguishable. Mock the model modules themselves to keep the
// participation counters and the per-poll turnout rows apart.
const PollParticipationTracking = {
  updateOne: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
  bulkWrite: jest.fn(),
};
const PollTurnout = {
  updateOne: jest.fn(),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
  deleteMany: jest.fn(),
};

jest.unstable_mockModule(
  "../../src/models/poll-participation-tracking.js",
  () => ({ PollParticipationTracking }),
);
jest.unstable_mockModule("../../src/models/poll-turnout.js", () => ({
  PollTurnout,
}));

const { PollParticipationTracker } =
  await import("../../src/services/poll-participation-tracker.js");
const { getIsoWeekKey } = await import("../../src/utils/time.js");

// Mirror the model's `findOne(...).lean()` chain used by
// `getParticipationSummary`.
function lean<T>(value: T): { lean: () => Promise<T> } {
  return { lean: jest.fn(async () => value) };
}

function createTracker(voter: { username: string; bot: boolean } | null) {
  const usersFetch = jest
    .fn<(id: string) => Promise<User>>()
    .mockResolvedValue(
      (voter
        ? { id: "voter1", username: voter.username, bot: voter.bot }
        : { id: "voter1", username: "Voter", bot: false }) as User,
    );
  const mockClient = {
    users: { fetch: usersFetch, cache: new Map<string, User>() },
  } as unknown as Client;
  const tracker = PollParticipationTracker.getInstance(mockClient);

  const mockConfigService = {
    getString: jest.fn().mockResolvedValue("mongodb://localhost/test"),
    getBoolean: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue(null),
    getNumber: jest.fn().mockResolvedValue(0),
  };
  (tracker as never)["configService"] = mockConfigService;
  stubMongoGuard(tracker);
  (tracker as never)["client"] = mockClient;

  return { tracker, mockConfigService, usersFetch };
}

function makePollAnswer(
  guildId: string | null = "guild1",
  message: Record<string, unknown> = {},
): PollAnswer {
  return {
    poll: {
      message: {
        guild: guildId ? { id: guildId } : null,
        guildId: guildId ?? null,
        id: "msg1",
        channelId: "chan1",
        createdAt: new Date("2026-08-10T09:00:00Z"),
        ...message,
      },
    },
  } as unknown as PollAnswer;
}

describe("PollParticipationTracker", () => {
  let updateOne: jest.Mock;
  let turnoutUpdateOne: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    updateOne = (
      PollParticipationTracking as unknown as { updateOne: jest.Mock }
    ).updateOne;
    updateOne.mockResolvedValue({ matchedCount: 1 });
    turnoutUpdateOne = (PollTurnout as unknown as { updateOne: jest.Mock })
      .updateOne;
    turnoutUpdateOne.mockResolvedValue({ matchedCount: 1 });
    (PollParticipationTracker as unknown as { instance: unknown }).instance =
      undefined;
  });

  describe("singleton pattern", () => {
    it("returns the same instance", () => {
      const a = PollParticipationTracker.getInstance({} as Client);
      const b = PollParticipationTracker.getInstance({} as Client);
      expect(a).toBe(b);
    });
  });

  describe("gating", () => {
    it("does not write when tracking is disabled", async () => {
      const { tracker, mockConfigService } = createTracker({
        username: "Voter",
        bot: false,
      });
      mockConfigService.getBoolean.mockResolvedValue(false);

      await tracker.handlePollVoteAdd(makePollAnswer(), "voter1");
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("ignores DM polls (no guild)", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      await tracker.handlePollVoteAdd(makePollAnswer(null), "voter1");
      expect(updateOne).not.toHaveBeenCalled();
    });

    it("ignores votes cast by bots", async () => {
      const { tracker } = createTracker({ username: "Botty", bot: true });
      await tracker.handlePollVoteAdd(makePollAnswer(), "voter1");
      expect(updateOne).not.toHaveBeenCalled();
    });
  });

  describe("recording", () => {
    it("records a vote with a per-year bucket", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      await tracker.handlePollVoteAdd(makePollAnswer(), "voter1");

      expect(updateOne).toHaveBeenCalledTimes(1);
      const [filter, update] = updateOne.mock.calls[0];
      expect(filter).toEqual({ userId: "voter1", guildId: "guild1" });
      expect(update.$inc.totalVotes).toBe(1);
      const year = String(new Date().getFullYear());
      expect(update.$inc[`yearlyVotes.${year}`]).toBe(1);
      expect(update.$set.username).toBe("Voter");
    });

    it("records a per-ISO-week bucket alongside the yearly one (#816)", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      await tracker.handlePollVoteAdd(makePollAnswer(), "voter1");

      const [, update] = updateOne.mock.calls[0];
      const week = getIsoWeekKey(update.$set.lastVoteAt as Date);
      expect(update.$inc[`weeklyVotes.${week}`]).toBe(1);
    });

    it("upserts the poll's turnout row, deduping the voter (#816)", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      await tracker.handlePollVoteAdd(
        makePollAnswer("guild1", { poll: { question: { text: "Best map?" } } }),
        "voter1",
      );

      expect(turnoutUpdateOne).toHaveBeenCalledTimes(1);
      const [filter, pipeline, options] = turnoutUpdateOne.mock.calls[0];
      expect(filter).toEqual({ guildId: "guild1", messageId: "msg1" });
      expect(options).toEqual({ upsert: true });

      // An update pipeline, not plain operators: `firstVoteAt` and
      // `question` must fill in on first sight even when `recordPollPosted`
      // already created the row, which `$setOnInsert` could never do.
      const set = pipeline[0].$set;
      expect(set).toMatchObject({
        guildId: "guild1",
        messageId: "msg1",
        channelId: { $ifNull: ["$channelId", "chan1"] },
        question: { $ifNull: ["$question", "Best map?"] },
        postedAt: { $ifNull: ["$postedAt", new Date("2026-08-10T09:00:00Z")] },
        votesCast: { $add: [{ $ifNull: ["$votesCast", 0] }, 1] },
        voterIds: { $setUnion: [{ $ifNull: ["$voterIds", []] }, ["voter1"]] },
      });
      // firstVoteAt keeps whatever is already stored, so a row pre-created by
      // recordPollPosted (firstVoteAt: null) gets stamped by its first vote.
      expect(set.firstVoteAt.$ifNull[0]).toBe("$firstVoteAt");
      expect(set.firstVoteAt.$ifNull[1]).toEqual(set.lastVoteAt);
    });

    it("offers a null question when the poll is not cached, keeping any stored one", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      await tracker.handlePollVoteAdd(makePollAnswer(), "voter1");

      const [, pipeline] = turnoutUpdateOne.mock.calls[0];
      expect(pipeline[0].$set.question).toEqual({
        $ifNull: ["$question", null],
      });
    });

    it("skips the turnout row when the message id is unknown", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      await tracker.handlePollVoteAdd(
        makePollAnswer("guild1", { id: undefined }),
        "voter1",
      );

      expect(updateOne).toHaveBeenCalledTimes(1);
      expect(turnoutUpdateOne).not.toHaveBeenCalled();
    });
  });

  describe("recordPollPosted (#816)", () => {
    const posted = {
      guildId: "guild1",
      messageId: "msg9",
      channelId: "chan1",
      question: "Pineapple on pizza?",
      postedAt: new Date("2026-08-12T10:00:00Z"),
    };

    it("does not write when participation capture is off", async () => {
      const { tracker, mockConfigService } = createTracker(null);
      mockConfigService.getBoolean.mockResolvedValue(false);

      await tracker.recordPollPosted(posted);
      expect(turnoutUpdateOne).not.toHaveBeenCalled();
    });

    it("upserts the row with the question and exact post time", async () => {
      const { tracker } = createTracker(null);

      await tracker.recordPollPosted(posted);

      const [filter, update, options] = turnoutUpdateOne.mock.calls[0];
      expect(filter).toEqual({ guildId: "guild1", messageId: "msg9" });
      // Posting is authoritative for these, so they overwrite whatever a
      // racing vote capture guessed.
      expect(update.$set).toEqual({
        channelId: "chan1",
        question: "Pineapple on pizza?",
        postedAt: posted.postedAt,
      });
      expect(update.$setOnInsert).toMatchObject({ votesCast: 0, voterIds: [] });
      expect(options).toEqual({ upsert: true });
    });

    it("swallows DB errors so poll posting never fails on bookkeeping", async () => {
      const { tracker } = createTracker(null);
      turnoutUpdateOne.mockRejectedValue(new Error("DB error"));

      await expect(tracker.recordPollPosted(posted)).resolves.toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("swallows DB errors", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      updateOne.mockRejectedValue(new Error("DB error"));

      await expect(
        tracker.handlePollVoteAdd(makePollAnswer(), "voter1"),
      ).resolves.not.toThrow();
    });
  });

  describe("getParticipationSummary (#655)", () => {
    let findOne: jest.Mock;

    beforeEach(() => {
      findOne = (PollParticipationTracking as unknown as { findOne: jest.Mock })
        .findOne;
    });

    it("returns lifetime, this-year, and last-voted from the row", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      const year = String(new Date().getFullYear());
      const lastVoteAt = new Date("2026-03-04T05:06:07Z");
      findOne.mockReturnValue(
        lean({
          totalVotes: 42,
          yearlyVotes: { [year]: 9, "2024": 5 },
          weeklyVotes: { "2024-W01": 5 },
          lastVoteAt,
        }),
      );

      const summary = await tracker.getParticipationSummary("voter1", "guild1");
      expect(summary).toEqual({
        totalVotes: 42,
        thisYearVotes: 9,
        thisWeekVotes: 0,
        lastVoteAt,
      });
    });

    it("reads this-year votes from a Map-shaped bucket", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      const year = String(new Date().getFullYear());
      findOne.mockReturnValue(
        lean({
          totalVotes: 3,
          yearlyVotes: new Map([[year, 3]]),
          lastVoteAt: null,
        }),
      );

      const summary = await tracker.getParticipationSummary("voter1", "guild1");
      expect(summary?.thisYearVotes).toBe(3);
    });

    it("reads 0 this-year when the current year has no bucket entry", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      findOne.mockReturnValue(
        lean({ totalVotes: 5, yearlyVotes: { "2024": 5 }, lastVoteAt: null }),
      );

      const summary = await tracker.getParticipationSummary("voter1", "guild1");
      expect(summary?.totalVotes).toBe(5);
      expect(summary?.thisYearVotes).toBe(0);
    });

    it("returns null when the member has no tracking row", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      findOne.mockReturnValue(lean(null));

      const summary = await tracker.getParticipationSummary("voter1", "guild1");
      expect(summary).toBeNull();
    });

    it("degrades to null on a DB error", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      findOne.mockReturnValue({
        lean: jest.fn().mockRejectedValue(new Error("DB error")),
      });

      const summary = await tracker.getParticipationSummary("voter1", "guild1");
      expect(summary).toBeNull();
    });
  });

  describe("getRecentVoterCount (#777)", () => {
    let countDocuments: jest.Mock;

    beforeEach(() => {
      countDocuments = (
        PollParticipationTracking as unknown as { countDocuments: jest.Mock }
      ).countDocuments;
    });

    it("counts members whose last vote falls within the window", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      countDocuments.mockResolvedValue(4);
      const since = new Date("2026-08-06T00:00:00Z");

      const count = await tracker.getRecentVoterCount("guild1", since);

      expect(countDocuments).toHaveBeenCalledWith({
        guildId: "guild1",
        lastVoteAt: { $gte: since },
      });
      expect(count).toBe(4);
    });

    it("degrades to 0 on a DB error", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      countDocuments.mockRejectedValue(new Error("DB error"));

      const count = await tracker.getRecentVoterCount("guild1", new Date());
      expect(count).toBe(0);
    });
  });
  describe("weekly participation (#816)", () => {
    let findOne: jest.Mock;

    beforeEach(() => {
      findOne = (PollParticipationTracking as unknown as { findOne: jest.Mock })
        .findOne;
    });

    it("reads this-week votes from the current ISO-week bucket", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      const week = getIsoWeekKey(new Date());
      findOne.mockReturnValue(
        lean({
          totalVotes: 12,
          yearlyVotes: {},
          weeklyVotes: { [week]: 4, "2024-W01": 99 },
          lastVoteAt: null,
        }),
      );

      const summary = await tracker.getParticipationSummary("voter1", "guild1");
      expect(summary?.thisWeekVotes).toBe(4);
    });

    it("reads 0 for rows written before weekly buckets existed", async () => {
      const { tracker } = createTracker({ username: "Voter", bot: false });
      findOne.mockReturnValue(
        lean({ totalVotes: 12, yearlyVotes: {}, lastVoteAt: null }),
      );

      const summary = await tracker.getParticipationSummary("voter1", "guild1");
      expect(summary?.thisWeekVotes).toBe(0);
    });
  });

  describe("getRecentPollCount (#816)", () => {
    let turnoutCount: jest.Mock;

    beforeEach(() => {
      turnoutCount = (PollTurnout as unknown as { countDocuments: jest.Mock })
        .countDocuments;
    });

    it("counts polls that drew a vote inside the window", async () => {
      const { tracker } = createTracker(null);
      turnoutCount.mockResolvedValue(3);
      const since = new Date("2026-08-06T00:00:00Z");

      const count = await tracker.getRecentPollCount("guild1", since);

      expect(turnoutCount).toHaveBeenCalledWith({
        guildId: "guild1",
        lastVoteAt: { $gte: since },
      });
      expect(count).toBe(3);
    });

    it("degrades to 0 on a DB error", async () => {
      const { tracker } = createTracker(null);
      turnoutCount.mockRejectedValue(new Error("DB error"));

      expect(await tracker.getRecentPollCount("guild1", new Date())).toBe(0);
    });
  });

  describe("getTopPollTurnout (#816)", () => {
    let aggregate: jest.Mock;

    beforeEach(() => {
      aggregate = (PollTurnout as unknown as { aggregate: jest.Mock })
        .aggregate;
    });

    it("ranks every matching poll in Mongo, not a page of them", async () => {
      const { tracker } = createTracker(null);
      const since = new Date("2026-08-06T00:00:00Z");
      aggregate.mockResolvedValue([
        {
          messageId: "msg1",
          question: "Best map?",
          postedAt: new Date("2026-08-11T12:00:00Z"),
          voterCount: 6,
          votesCast: 9,
        },
      ]);

      const top = await tracker.getTopPollTurnout("guild1", since);

      const [pipeline] = aggregate.mock.calls[0];
      expect(pipeline[0]).toEqual({
        $match: { guildId: "guild1", lastVoteAt: { $gte: since } },
      });
      // Distinct voters are derived from the id set, and the winner is chosen
      // by the database over the whole window — no client-side limit to
      // silently crown a runner-up in a busy week.
      expect(pipeline[1].$addFields.voterCount).toEqual({
        $size: { $ifNull: ["$voterIds", []] },
      });
      expect(pipeline[2]).toEqual({ $sort: { voterCount: -1, postedAt: -1 } });
      expect(pipeline[3]).toEqual({ $limit: 1 });
      expect(top?.voterCount).toBe(6);
      expect(top?.question).toBe("Best map?");
    });

    it("returns null when no poll drew a vote in the window", async () => {
      const { tracker } = createTracker(null);
      aggregate.mockResolvedValue([]);

      expect(await tracker.getTopPollTurnout("guild1", new Date())).toBeNull();
    });

    it("normalises a winner with no stored question", async () => {
      const { tracker } = createTracker(null);
      const postedAt = new Date("2026-08-11T12:00:00Z");
      aggregate.mockResolvedValue([
        { messageId: "msg2", postedAt, voterCount: 9 },
      ]);

      expect(await tracker.getTopPollTurnout("guild1", postedAt)).toEqual({
        messageId: "msg2",
        question: null,
        postedAt,
        voterCount: 9,
        votesCast: 0,
      });
    });

    it("degrades to null on a DB error", async () => {
      const { tracker } = createTracker(null);
      aggregate.mockRejectedValue(new Error("DB error"));

      expect(await tracker.getTopPollTurnout("guild1", new Date())).toBeNull();
    });
  });

  describe("pruneExpiredData (#816)", () => {
    let aggregate: jest.Mock;
    let bulkWrite: jest.Mock;
    let deleteMany: jest.Mock;

    // Mirrors `aggregate(...).cursor()`, which the prune iterates so neither
    // side of the sweep materialises the whole collection.
    function cursorOf(docs: unknown[] | Error) {
      return {
        cursor: jest.fn(() => ({
          async *[Symbol.asyncIterator]() {
            if (docs instanceof Error) throw docs;
            for (const doc of docs) yield doc;
          },
        })),
      };
    }

    beforeEach(() => {
      aggregate = (
        PollParticipationTracking as unknown as { aggregate: jest.Mock }
      ).aggregate;
      bulkWrite = (
        PollParticipationTracking as unknown as { bulkWrite: jest.Mock }
      ).bulkWrite;
      deleteMany = (PollTurnout as unknown as { deleteMany: jest.Mock })
        .deleteMany;
      aggregate.mockReturnValue(cursorOf([]));
      bulkWrite.mockResolvedValue({});
      deleteMany.mockResolvedValue({ deletedCount: 0 });
    });

    // Retention windows come from config; route each key to a fixed number.
    function setRetention(
      tracker: { configService?: unknown },
      weeks: number,
      days: number,
    ): void {
      (
        tracker as unknown as {
          configService: { getNumber: jest.Mock };
        }
      ).configService.getNumber = jest.fn(async (key: string) =>
        key === "polls.participation.weekly_retention_weeks" ? weeks : days,
      ) as unknown as jest.Mock;
    }

    it("asks Mongo for stale keys only, then unsets exactly those", async () => {
      const { tracker } = createTracker(null);
      setRetention(tracker, 12, 90);
      aggregate.mockReturnValue(
        cursorOf([{ _id: "doc1", staleKeys: ["2020-W01", "2020-W02"] }]),
      );

      const result = await tracker.pruneExpiredData();

      // The filtering happens in the pipeline, so documents with nothing to
      // prune are never transferred at all.
      const [pipeline] = aggregate.mock.calls[0];
      const cutoffKey = getIsoWeekKey(
        new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000),
      );
      expect(JSON.stringify(pipeline[0].$project.staleKeys)).toContain(
        cutoffKey,
      );
      expect(pipeline[1]).toEqual({
        $match: { "staleKeys.0": { $exists: true } },
      });

      expect(result.weekBucketsPruned).toBe(2);
      const [ops] = bulkWrite.mock.calls[0];
      expect(ops).toHaveLength(1);
      expect(ops[0].updateOne.filter).toEqual({ _id: "doc1" });
      expect(ops[0].updateOne.update.$unset).toEqual({
        "weeklyVotes.2020-W01": "",
        "weeklyVotes.2020-W02": "",
      });
    });

    it("does not touch Mongo when nothing is stale", async () => {
      const { tracker } = createTracker(null);
      setRetention(tracker, 12, 90);
      aggregate.mockReturnValue(cursorOf([]));

      const result = await tracker.pruneExpiredData();

      expect(bulkWrite).not.toHaveBeenCalled();
      expect(result.weekBucketsPruned).toBe(0);
    });

    it("deletes turnout rows posted before the retention cutoff", async () => {
      const { tracker } = createTracker(null);
      setRetention(tracker, 12, 90);
      deleteMany.mockResolvedValue({ deletedCount: 7 });

      const result = await tracker.pruneExpiredData();

      const [filter] = deleteMany.mock.calls[0];
      const cutoff = filter.postedAt.$lt as Date;
      const days = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
      expect(days).toBeCloseTo(90, 1);
      expect(result.turnoutRowsDeleted).toBe(7);
    });

    it("treats 0 as keep-forever for both windows", async () => {
      const { tracker } = createTracker(null);
      setRetention(tracker, 0, 0);
      aggregate.mockReturnValue(
        cursorOf([{ _id: "doc1", staleKeys: ["2020-W01"] }]),
      );

      const result = await tracker.pruneExpiredData();

      expect(aggregate).not.toHaveBeenCalled();
      expect(bulkWrite).not.toHaveBeenCalled();
      expect(deleteMany).not.toHaveBeenCalled();
      expect(result).toEqual({ weekBucketsPruned: 0, turnoutRowsDeleted: 0 });
    });

    it("swallows DB errors so the daily interval survives a bad sweep", async () => {
      const { tracker } = createTracker(null);
      setRetention(tracker, 12, 90);
      aggregate.mockReturnValue(cursorOf(new Error("DB error")));

      await expect(tracker.pruneExpiredData()).resolves.toEqual({
        weekBucketsPruned: 0,
        turnoutRowsDeleted: 0,
      });
    });
  });
});
