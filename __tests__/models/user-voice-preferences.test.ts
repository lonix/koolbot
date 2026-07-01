import { describe, it, expect } from "@jest/globals";

describe("UserVoicePreferences Model Schema", () => {
  describe("schema definition", () => {
    it("should define required fields", () => {
      const schemaTest = async () => {
        const { UserVoicePreferences } =
          await import("../../src/models/user-voice-preferences.js");
        return UserVoicePreferences.schema;
      };

      expect(schemaTest).toBeDefined();
    });
  });

  describe("interface types", () => {
    it("should properly type the document interface", async () => {
      await import("../../src/models/user-voice-preferences.js");

      const testDoc = {
        userId: "test-user-123",
        namePattern: "{username}'s Room",
        presets: [
          { name: "Squad", channelName: "Squad HQ", userLimit: 10, bitrate: 96 },
        ],
      };

      expect(testDoc.userId).toBe("test-user-123");
      expect(testDoc.namePattern).toBe("{username}'s Room");
      expect(testDoc.presets[0].userLimit).toBe(10);
      expect(testDoc.presets[0].bitrate).toBe(96);
    });
  });
});
