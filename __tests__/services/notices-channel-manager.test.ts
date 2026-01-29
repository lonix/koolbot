import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { NoticesChannelManager } from "../../src/services/notices-channel-manager.js";

// Mock dependencies
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/utils/logger.js");
jest.mock("cron");
jest.mock("../../src/models/notice.js");

describe("NoticesChannelManager", () => {
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Discord client
    mockClient = {
      isReady: jest.fn().mockReturnValue(true),
      user: { id: "bot123", tag: "TestBot#1234" },
      channels: {
        fetch: jest.fn(),
      },
      guilds: {
        fetch: jest.fn(),
      },
      on: jest.fn(),
    };
  });

  describe("initialization", () => {
    it("should create a singleton instance", () => {
      const instance1 = NoticesChannelManager.getInstance(mockClient);
      const instance2 = NoticesChannelManager.getInstance(mockClient);

      expect(instance1).toBeDefined();
      expect(instance1).toBe(instance2);
    });

    it("should have required methods", () => {
      const manager = NoticesChannelManager.getInstance(mockClient);

      expect(typeof manager.initialize).toBe("function");
      expect(typeof manager.postNotice).toBe("function");
      expect(typeof manager.deleteNoticeMessage).toBe("function");
      expect(typeof manager.syncNotices).toBe("function");
      expect(typeof manager.stop).toBe("function");
    });
  });

  describe("method signatures", () => {
    let manager: NoticesChannelManager;

    beforeEach(() => {
      manager = NoticesChannelManager.getInstance(mockClient);
    });

    it("initialize should accept no parameters", () => {
      expect(manager.initialize.length).toBe(0);
    });

    it("postNotice should accept 1 parameter (notice)", () => {
      expect(manager.postNotice.length).toBe(1);
    });

    it("deleteNoticeMessage should accept message ID", () => {
      expect(manager.deleteNoticeMessage.length).toBe(1);
    });

    it("syncNotices should accept no parameters", () => {
      expect(manager.syncNotices.length).toBe(0);
    });

    it("stop should accept no parameters", () => {
      expect(manager.stop.length).toBe(0);
    });
  });
});
