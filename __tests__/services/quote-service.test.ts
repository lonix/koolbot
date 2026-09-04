import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  QuoteService,
  buildLikeEvents,
  sumLikeEventsSince,
  MAX_LIKE_EVENTS,
} from "../../src/services/quote-service.js";

// Mock mongoose and dependencies
jest.mock("mongoose");
jest.mock("../../src/database/schema.js");
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/cooldown-manager.js");

describe("QuoteService", () => {
  let quoteService: QuoteService;

  beforeEach(() => {
    jest.clearAllMocks();
    quoteService = new QuoteService();
  });

  describe("initialization", () => {
    it("should create a new instance", () => {
      expect(quoteService).toBeDefined();
      expect(quoteService).toBeInstanceOf(QuoteService);
    });

    it("should have required methods", () => {
      expect(typeof quoteService.addQuote).toBe("function");
      expect(typeof quoteService.getRandomQuote).toBe("function");
      expect(typeof quoteService.searchQuotes).toBe("function");
      expect(typeof quoteService.deleteQuote).toBe("function");
      expect(typeof quoteService.likeQuote).toBe("function");
      expect(typeof quoteService.dislikeQuote).toBe("function");
      expect(typeof quoteService.listQuotes).toBe("function");
      expect(typeof quoteService.getQuoteById).toBe("function");
      expect(typeof quoteService.updateQuoteMessageId).toBe("function");
      expect(typeof quoteService.getAllQuotes).toBe("function");
    });
  });

  describe("method signatures", () => {
    it("addQuote should accept correct parameters", () => {
      expect(quoteService.addQuote.length).toBe(5);
    });

    it("getRandomQuote should accept no parameters", () => {
      expect(quoteService.getRandomQuote.length).toBe(0);
    });

    it("searchQuotes should accept query parameter", () => {
      expect(quoteService.searchQuotes.length).toBe(1);
    });

    it("deleteQuote should accept quote ID, user ID, and roles", () => {
      expect(quoteService.deleteQuote.length).toBe(3);
    });

    it("likeQuote should accept quote ID", () => {
      expect(quoteService.likeQuote.length).toBe(1);
    });

    it("dislikeQuote should accept quote ID", () => {
      expect(quoteService.dislikeQuote.length).toBe(1);
    });

    it("listQuotes should have default parameters", () => {
      // TypeScript default parameters make .length return 0
      // Just verify the method exists
      expect(typeof quoteService.listQuotes).toBe("function");
    });

    it("getQuoteById should accept quote ID", () => {
      expect(quoteService.getQuoteById.length).toBe(1);
    });

    it("updateQuoteMessageId should accept quote ID and message ID", () => {
      expect(quoteService.updateQuoteMessageId.length).toBe(2);
    });

    it("getAllQuotes should accept no parameters", () => {
      expect(quoteService.getAllQuotes.length).toBe(0);
    });
  });

  describe("getTopQuoteSince (#777)", () => {
    it("queries most-liked quote added since the window, likes > 0", async () => {
      const sort = jest.fn().mockResolvedValue({ content: "hi", likes: 5 });
      const findOne = jest.fn().mockReturnValue({ sort });
      (quoteService as never)["model"] = { findOne };

      const since = new Date("2026-08-06T00:00:00Z");
      const result = await quoteService.getTopQuoteSince(since);

      expect(findOne).toHaveBeenCalledWith({
        createdAt: { $gte: since },
        likes: { $gt: 0 },
      });
      expect(sort).toHaveBeenCalledWith({ likes: -1 });
      expect(result).toEqual({ content: "hi", likes: 5 });
    });

    it("returns null when no qualifying quote exists", async () => {
      const sort = jest.fn().mockResolvedValue(null);
      const findOne = jest.fn().mockReturnValue({ sort });
      (quoteService as never)["model"] = { findOne };

      const result = await quoteService.getTopQuoteSince(new Date());
      expect(result).toBeNull();
    });
  });

  describe("getTopQuoteByVotesSince (#817)", () => {
    const since = new Date("2026-08-27T00:00:00Z");
    const inWindow = new Date("2026-08-28T00:00:00Z");
    const beforeWindow = new Date("2026-06-01T00:00:00Z");

    function stubFind(docs: unknown[]): jest.Mock {
      const find = jest.fn<any>().mockResolvedValue(docs);
      (quoteService as never)["model"] = { find };
      return find as unknown as jest.Mock;
    }

    it("queries only quotes with a positive like event inside the window", async () => {
      const find = stubFind([]);
      await quoteService.getTopQuoteByVotesSince(since);
      expect(find).toHaveBeenCalledWith({
        likeEvents: { $elemMatch: { at: { $gte: since }, delta: { $gt: 0 } } },
      });
    });

    it("ranks by likes gained in the window, not lifetime likes", async () => {
      // The old quote is far more liked overall but only picked up one like
      // this week; the newer one gained three. "Quote of the week" is the
      // latter -- this is the behaviour #817 asked for.
      stubFind([
        {
          content: "beloved classic",
          likes: 50,
          likeEvents: [
            { at: beforeWindow, delta: 49 },
            { at: inWindow, delta: 1 },
          ],
        },
        {
          content: "this week's hit",
          likes: 3,
          likeEvents: [
            { at: inWindow, delta: 2 },
            { at: inWindow, delta: 1 },
          ],
        },
      ]);

      const result = await quoteService.getTopQuoteByVotesSince(since);
      expect(result?.quote.content).toBe("this week's hit");
      expect(result?.likes).toBe(3);
    });

    it("surfaces an old quote that surged this week", async () => {
      stubFind([
        {
          content: "resurfaced oldie",
          likes: 12,
          likeEvents: [
            { at: beforeWindow, delta: 4 },
            { at: inWindow, delta: 8 },
          ],
        },
      ]);

      const result = await quoteService.getTopQuoteByVotesSince(since);
      expect(result?.quote.content).toBe("resurfaced oldie");
      expect(result?.likes).toBe(8);
    });

    it("nets out likes taken back inside the window", async () => {
      stubFind([
        {
          content: "briefly popular",
          likes: 1,
          likeEvents: [
            { at: inWindow, delta: 3 },
            { at: inWindow, delta: -3 },
          ],
        },
        {
          content: "steady",
          likes: 1,
          likeEvents: [{ at: inWindow, delta: 1 }],
        },
      ]);

      const result = await quoteService.getTopQuoteByVotesSince(since);
      expect(result?.quote.content).toBe("steady");
      expect(result?.likes).toBe(1);
    });

    it("breaks ties on the lifetime tally so the pick is stable", async () => {
      stubFind([
        {
          content: "newcomer",
          likes: 2,
          likeEvents: [{ at: inWindow, delta: 2 }],
        },
        {
          content: "established",
          likes: 30,
          likeEvents: [{ at: inWindow, delta: 2 }],
        },
      ]);

      const result = await quoteService.getTopQuoteByVotesSince(since);
      expect(result?.quote.content).toBe("established");
    });

    it("returns null when nothing gained likes in the window", async () => {
      stubFind([
        {
          content: "stale",
          likes: 9,
          likeEvents: [{ at: beforeWindow, delta: 9 }],
        },
        { content: "untimed", likes: 4 },
      ]);

      expect(await quoteService.getTopQuoteByVotesSince(since)).toBeNull();
    });
  });

  describe("buildLikeEvents (#817)", () => {
    const now = new Date("2026-09-01T12:00:00Z");

    it("appends the delta stamped at now", () => {
      const events = buildLikeEvents([], 2, now, 30);
      expect(events).toEqual([{ at: now, delta: 2 }]);
    });

    it("drops events older than the retention window", () => {
      const old = new Date("2026-07-01T00:00:00Z");
      const recent = new Date("2026-08-30T00:00:00Z");
      const events = buildLikeEvents(
        [
          { at: old, delta: 5 },
          { at: recent, delta: 1 },
        ],
        1,
        now,
        30,
      );
      expect(events).toEqual([
        { at: recent, delta: 1 },
        { at: now, delta: 1 },
      ]);
    });

    it("records nothing new when the delta is zero", () => {
      const recent = new Date("2026-08-30T00:00:00Z");
      expect(buildLikeEvents([{ at: recent, delta: 1 }], 0, now, 30)).toEqual([
        { at: recent, delta: 1 },
      ]);
    });

    it("caps stored events, keeping the newest", () => {
      const existing = Array.from({ length: MAX_LIKE_EVENTS + 5 }, () => ({
        at: new Date("2026-08-30T00:00:00Z"),
        delta: 1,
      }));
      const events = buildLikeEvents(existing, 1, now, 30);
      expect(events).toHaveLength(MAX_LIKE_EVENTS);
      expect(events[events.length - 1]).toEqual({ at: now, delta: 1 });
    });

    it("falls back to the default retention when misconfigured", () => {
      const old = new Date("2026-01-01T00:00:00Z");
      const recent = new Date("2026-08-30T00:00:00Z");
      const events = buildLikeEvents(
        [
          { at: old, delta: 5 },
          { at: recent, delta: 1 },
        ],
        0,
        now,
        Number.NaN,
      );
      expect(events).toEqual([{ at: recent, delta: 1 }]);
    });

    it("ignores malformed entries", () => {
      const events = buildLikeEvents(
        [
          { at: new Date("not a date"), delta: 3 },
          { at: new Date("2026-08-30T00:00:00Z"), delta: Number.NaN },
        ] as never,
        1,
        now,
        30,
      );
      expect(events).toEqual([{ at: now, delta: 1 }]);
    });
  });

  describe("sumLikeEventsSince (#817)", () => {
    it("counts only events at or after the window start", () => {
      const since = new Date("2026-08-27T00:00:00Z");
      expect(
        sumLikeEventsSince(
          [
            { at: new Date("2026-08-26T23:59:59Z"), delta: 10 },
            { at: since, delta: 1 },
            { at: new Date("2026-08-28T00:00:00Z"), delta: 2 },
          ],
          since,
        ),
      ).toBe(3);
    });

    it("treats missing history as zero", () => {
      expect(sumLikeEventsSince(undefined, new Date())).toBe(0);
    });
  });
});
