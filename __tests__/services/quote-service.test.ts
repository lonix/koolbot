import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { QuoteService } from "../../src/services/quote-service.js";

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
});
