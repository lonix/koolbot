import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { QuoteService } from "../../src/services/quote-service.js";

// Mock mongoose and dependencies
jest.mock("mongoose");
jest.mock("../../src/database/schema.js");
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/cooldown-manager.js");

describe("QuoteService - Achievement Methods", () => {
  let quoteService: QuoteService;

  beforeEach(() => {
    jest.clearAllMocks();
    quoteService = new QuoteService();
  });

  describe("achievement-related methods", () => {
    it("should have getQuotesAddedByUser method", () => {
      expect(typeof quoteService.getQuotesAddedByUser).toBe("function");
      expect(quoteService.getQuotesAddedByUser.length).toBe(1);
    });

    it("should have getQuotesAuthoredByUser method", () => {
      expect(typeof quoteService.getQuotesAuthoredByUser).toBe("function");
      expect(quoteService.getQuotesAuthoredByUser.length).toBe(1);
    });

    it("should have getMostLikedQuoteByAuthor method", () => {
      expect(typeof quoteService.getMostLikedQuoteByAuthor).toBe("function");
      expect(quoteService.getMostLikedQuoteByAuthor.length).toBe(1);
    });

    it("should have hasQuoteWithLikes method", () => {
      expect(typeof quoteService.hasQuoteWithLikes).toBe("function");
      expect(quoteService.hasQuoteWithLikes.length).toBe(2);
    });
  });
});
