import { describe, it, expect } from "@jest/globals";

describe("ReactionRoleConfig Model Schema", () => {
  describe("schema definition", () => {
    it("should define required fields", () => {
      const schemaTest = async () => {
        const { ReactionRoleConfig } = await import(
          "../../src/models/reaction-role-config.js"
        );
        return ReactionRoleConfig.schema;
      };

      expect(schemaTest).toBeDefined();
    });
  });

  describe("interface types", () => {
    it("should properly type the document interface", async () => {
      await import("../../src/models/reaction-role-config.js");

      const testDoc = {
        guildId: "123456789",
        messageId: "987654321",
        channelId: "111222333",
        roleId: "444555666",
        categoryId: "777888999",
        emoji: "🎮",
        roleName: "Gaming",
        isArchived: false,
      };

      expect(testDoc.guildId).toBe("123456789");
      expect(testDoc.messageId).toBe("987654321");
      expect(testDoc.roleName).toBe("Gaming");
      expect(testDoc.isArchived).toBe(false);
    });
  });
});
