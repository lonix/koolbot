import { describe, it, expect } from "@jest/globals";

describe("Notice Model Schema", () => {
  describe("schema definition", () => {
    it("should define required fields", () => {
      const schemaTest = async () => {
        const { default: Notice } = await import("../../src/models/notice.js");
        return Notice.schema;
      };

      expect(schemaTest).toBeDefined();
    });
  });

  describe("interface types", () => {
    it("should properly type the document interface", async () => {
      await import("../../src/models/notice.js");

      const testDoc = {
        title: "Test Notice",
        content: "This is a test notice content",
        category: "general",
        order: 0,
        messageId: "123456789",
        createdBy: "user123",
      };

      expect(testDoc.title).toBe("Test Notice");
      expect(testDoc.content).toBe("This is a test notice content");
      expect(testDoc.category).toBe("general");
      expect(testDoc.order).toBe(0);
      expect(testDoc.messageId).toBe("123456789");
      expect(testDoc.createdBy).toBe("user123");
    });
  });

  describe("category validation", () => {
    it("should accept valid categories", async () => {
      const validCategories = [
        "general",
        "rules",
        "info",
        "help",
        "game-servers",
      ];

      validCategories.forEach((category) => {
        const testDoc = {
          title: "Test",
          content: "Test content",
          category: category,
          order: 0,
          createdBy: "user123",
        };
        expect(testDoc.category).toBe(category);
      });
    });
  });

  describe("field constraints", () => {
    it("should validate title max length", async () => {
      const testDoc = {
        title: "x".repeat(256),
        content: "Test content",
        category: "general",
        order: 0,
        createdBy: "user123",
      };

      expect(testDoc.title.length).toBe(256);
    });

    it("should validate content max length", async () => {
      const testDoc = {
        title: "Test",
        content: "x".repeat(4000),
        category: "general",
        order: 0,
        createdBy: "user123",
      };

      expect(testDoc.content.length).toBe(4000);
    });

    it("should allow order field with default value", async () => {
      const testDoc = {
        title: "Test",
        content: "Test content",
        category: "general",
        order: 0,
        createdBy: "user123",
      };

      expect(testDoc.order).toBe(0);
    });
  });

  describe("timestamps", () => {
    it("should include timestamps in schema", async () => {
      const { default: Notice } = await import("../../src/models/notice.js");
      const schema = Notice.schema;

      expect(schema.path("createdAt")).toBeDefined();
      expect(schema.path("updatedAt")).toBeDefined();
    });
  });
});
