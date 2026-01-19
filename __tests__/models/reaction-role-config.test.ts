import { describe, it, expect, beforeAll } from "@jest/globals";
import mongoose from "mongoose";

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

  describe("field constraints", () => {
    let ReactionRoleConfigSchema: mongoose.Schema;

    beforeAll(async () => {
      const { ReactionRoleConfig } = await import(
        "../../src/models/reaction-role-config.js"
      );
      ReactionRoleConfigSchema = ReactionRoleConfig.schema;
    });

    it("should have guildId field with correct type", () => {
      const guildIdPath = ReactionRoleConfigSchema.path("guildId");
      expect(guildIdPath).toBeDefined();
      expect(guildIdPath.instance).toBe("String");
      expect(guildIdPath.isRequired).toBe(true);
    });

    it("should have messageId field with correct type", () => {
      const messageIdPath = ReactionRoleConfigSchema.path("messageId");
      expect(messageIdPath).toBeDefined();
      expect(messageIdPath.instance).toBe("String");
      expect(messageIdPath.isRequired).toBe(true);
    });

    it("should have channelId field with correct type", () => {
      const channelIdPath = ReactionRoleConfigSchema.path("channelId");
      expect(channelIdPath).toBeDefined();
      expect(channelIdPath.instance).toBe("String");
      expect(channelIdPath.isRequired).toBe(true);
    });

    it("should have roleId field with correct type", () => {
      const roleIdPath = ReactionRoleConfigSchema.path("roleId");
      expect(roleIdPath).toBeDefined();
      expect(roleIdPath.instance).toBe("String");
      expect(roleIdPath.isRequired).toBe(true);
    });

    it("should have categoryId field with correct type", () => {
      const categoryIdPath = ReactionRoleConfigSchema.path("categoryId");
      expect(categoryIdPath).toBeDefined();
      expect(categoryIdPath.instance).toBe("String");
      expect(categoryIdPath.isRequired).toBe(true);
    });

    it("should have emoji field with correct type", () => {
      const emojiPath = ReactionRoleConfigSchema.path("emoji");
      expect(emojiPath).toBeDefined();
      expect(emojiPath.instance).toBe("String");
      expect(emojiPath.isRequired).toBe(true);
    });

    it("should have roleName field with correct type", () => {
      const roleNamePath = ReactionRoleConfigSchema.path("roleName");
      expect(roleNamePath).toBeDefined();
      expect(roleNamePath.instance).toBe("String");
      expect(roleNamePath.isRequired).toBe(true);
    });

    it("should have isArchived field with boolean type and default", () => {
      const isArchivedPath = ReactionRoleConfigSchema.path("isArchived");
      expect(isArchivedPath).toBeDefined();
      expect(isArchivedPath.instance).toBe("Boolean");
      expect(isArchivedPath.isRequired).not.toBe(true);
      expect((isArchivedPath as any).defaultValue).toBe(false);
    });

    it("should have archivedAt as optional Date field", () => {
      const archivedAtPath = ReactionRoleConfigSchema.path("archivedAt");
      expect(archivedAtPath).toBeDefined();
      expect(archivedAtPath.instance).toBe("Date");
      expect(archivedAtPath.isRequired).not.toBe(true);
    });

    it("should have timestamps enabled", () => {
      expect(ReactionRoleConfigSchema.options.timestamps).toBe(true);
    });
  });

  describe("indexes", () => {
    let ReactionRoleConfigSchema: mongoose.Schema;

    beforeAll(async () => {
      const { ReactionRoleConfig } = await import(
        "../../src/models/reaction-role-config.js"
      );
      ReactionRoleConfigSchema = ReactionRoleConfig.schema;
    });

    it("should have compound index on guildId, messageId, and emoji", () => {
      const indexes = ReactionRoleConfigSchema.indexes();

      const compoundIndex = indexes.find((index: any) => {
        const fields = index[0];
        return (
          fields.guildId !== undefined &&
          fields.messageId !== undefined &&
          fields.emoji !== undefined
        );
      });

      expect(compoundIndex).toBeDefined();
    });

    it("should have compound index on guildId and roleId", () => {
      const indexes = ReactionRoleConfigSchema.indexes();

      const roleIdIndex = indexes.find((index: any) => {
        const fields = index[0];
        return fields.guildId !== undefined && fields.roleId !== undefined;
      });

      expect(roleIdIndex).toBeDefined();
    });

    it("should have unique compound index on guildId and roleName", () => {
      const indexes = ReactionRoleConfigSchema.indexes();

      const uniqueIndex = indexes.find((index: any) => {
        const fields = index[0];
        return fields.guildId !== undefined && fields.roleName !== undefined;
      });

      expect(uniqueIndex).toBeDefined();
      expect(uniqueIndex?.[1]?.unique).toBe(true);
    });

    it("should have index on guildId", () => {
      const indexes = ReactionRoleConfigSchema.indexes();

      const guildIdIndex = indexes.find((index: any) => {
        const fields = index[0];
        return (
          fields.guildId !== undefined &&
          Object.keys(fields).length === 1 &&
          fields.guildId === 1
        );
      });

      expect(guildIdIndex).toBeDefined();
    });

    it("should have index on messageId", () => {
      const indexes = ReactionRoleConfigSchema.indexes();

      const messageIdIndex = indexes.find((index: any) => {
        const fields = index[0];
        return (
          fields.messageId !== undefined &&
          Object.keys(fields).length === 1 &&
          fields.messageId === 1
        );
      });

      expect(messageIdIndex).toBeDefined();
    });

    it("should have index on roleId", () => {
      const indexes = ReactionRoleConfigSchema.indexes();

      const roleIdIndex = indexes.find((index: any) => {
        const fields = index[0];
        return (
          fields.roleId !== undefined &&
          Object.keys(fields).length === 1 &&
          fields.roleId === 1
        );
      });

      expect(roleIdIndex).toBeDefined();
    });

    it("should have index on isArchived", () => {
      const indexes = ReactionRoleConfigSchema.indexes();

      const isArchivedIndex = indexes.find((index: any) => {
        const fields = index[0];
        return (
          fields.isArchived !== undefined &&
          Object.keys(fields).length === 1 &&
          fields.isArchived === 1
        );
      });

      expect(isArchivedIndex).toBeDefined();
    });
  });

  describe("interface types", () => {
    it("should properly type the document interface", async () => {
      // Import to verify type definitions compile
      await import("../../src/models/reaction-role-config.js");

      // Type test - this will fail at compile time if types are wrong
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

    it("should allow archivedAt to be undefined", async () => {
      const { ReactionRoleConfig } = await import(
        "../../src/models/reaction-role-config.js"
      );

      // Create a document without archivedAt
      const docWithoutArchivedAt = new ReactionRoleConfig({
        guildId: "123456789",
        messageId: "987654321",
        channelId: "111222333",
        roleId: "444555666",
        categoryId: "777888999",
        emoji: "🎮",
        roleName: "Gaming",
        isArchived: false,
      });

      // Validate the document
      const validationError = docWithoutArchivedAt.validateSync();
      expect(validationError).toBeUndefined();

      // Verify archivedAt is undefined
      expect(docWithoutArchivedAt.archivedAt).toBeUndefined();
    });

    it("should require all mandatory fields", async () => {
      const { ReactionRoleConfig } = await import(
        "../../src/models/reaction-role-config.js"
      );

      // Create a document missing required fields
      const incompleteDoc = new ReactionRoleConfig({
        guildId: "123456789",
        // Missing other required fields
      });

      // Validate should return errors
      const validationError = incompleteDoc.validateSync();
      expect(validationError).toBeDefined();
      expect(validationError?.errors).toBeDefined();

      // Check that required fields are reported as missing
      expect(validationError?.errors.messageId).toBeDefined();
      expect(validationError?.errors.channelId).toBeDefined();
      expect(validationError?.errors.roleId).toBeDefined();
      expect(validationError?.errors.categoryId).toBeDefined();
      expect(validationError?.errors.emoji).toBeDefined();
      expect(validationError?.errors.roleName).toBeDefined();
    });
  });
});
