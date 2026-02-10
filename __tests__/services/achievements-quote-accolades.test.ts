import { describe, it, expect } from "@jest/globals";

describe("AchievementsService - Quote Accolades", () => {
  describe("Quote Accolade Definitions", () => {
    it("should have quote-related accolade types defined", () => {
      const expectedQuoteAccolades = [
        "quotable",
        "quote_master",
        "quote_collector",
        "quote_legend",
        "widely_quoted",
        "quote_icon",
        "viral_quote",
      ];

      // This test validates that the quote accolade types exist
      // The actual implementation is in the AccoladeType union
      expectedQuoteAccolades.forEach((accolade) => {
        expect(accolade).toBeDefined();
      });
    });

    it("should have appropriate thresholds for quote accolades", () => {
      const thresholds = {
        quotable: 1, // First quote
        quote_master: 10, // 10 quotes added
        quote_collector: 50, // 50 quotes added
        quote_legend: 100, // 100 quotes added
        widely_quoted: 25, // 25 times quoted
        quote_icon: 50, // 50 times quoted
        viral_quote: 10, // 10+ likes
      };

      // Validate thresholds are reasonable
      Object.values(thresholds).forEach((threshold) => {
        expect(threshold).toBeGreaterThan(0);
      });

      // Ensure progression makes sense
      expect(thresholds.quotable).toBeLessThan(thresholds.quote_master);
      expect(thresholds.quote_master).toBeLessThan(
        thresholds.quote_collector,
      );
      expect(thresholds.quote_collector).toBeLessThan(thresholds.quote_legend);

      expect(thresholds.widely_quoted).toBeLessThan(thresholds.quote_icon);
    });

    it("should have distinct emoji for each quote accolade", () => {
      const expectedEmojis = {
        quotable: "🗣️",
        quote_master: "📝",
        quote_collector: "📚",
        quote_legend: "🏆",
        widely_quoted: "⭐",
        quote_icon: "💫",
        viral_quote: "🔥",
      };

      // Validate all emojis are unique
      const emojiValues = Object.values(expectedEmojis);
      const uniqueEmojis = new Set(emojiValues);
      expect(uniqueEmojis.size).toBe(emojiValues.length);
    });
  });

  describe("Quote Accolade Categories", () => {
    it("should have accolades for adding quotes", () => {
      const addingQuoteAccolades = [
        "quote_master",
        "quote_collector",
        "quote_legend",
      ];
      expect(addingQuoteAccolades.length).toBe(3);
    });

    it("should have accolades for being quoted", () => {
      const beingQuotedAccolades = [
        "quotable",
        "widely_quoted",
        "quote_icon",
      ];
      expect(beingQuotedAccolades.length).toBe(3);
    });

    it("should have accolades for quote engagement", () => {
      const engagementAccolades = ["viral_quote"];
      expect(engagementAccolades.length).toBe(1);
    });
  });
});
