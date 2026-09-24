import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  NoticesChannelManager,
  formatFeatureLine,
  getFeatureEnabledKeys,
} from "../../src/services/notices-channel-manager.js";
import { defaultConfig } from "../../src/services/config-schema.js";
import { getBotVersion } from "../../src/utils/version.js";

// Mock dependencies
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/utils/logger.js");
jest.mock("cron");
jest.mock("../../src/models/notice.js");

describe("NoticesChannelManager", () => {
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    NoticesChannelManager.reset();

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

  describe("bot info notice content (#1007)", () => {
    let manager: NoticesChannelManager;

    const withEnabled = (keys: string[]) => {
      const enabled = new Set(keys);
      (manager as any).configService = {
        getBoolean: jest.fn(async (key: string) => enabled.has(key)),
      };
    };
    const generate = (): Promise<string> =>
      (manager as any).generateBotInfoContent();

    beforeEach(() => {
      manager = NoticesChannelManager.getInstance(mockClient);
    });

    it("lists every top-level feature gate and no sub-feature toggles", () => {
      const keys = getFeatureEnabledKeys();
      expect(keys).toEqual(
        expect.arrayContaining([
          "quotes.enabled",
          "polls.enabled",
          "events.enabled",
          "moderation.enabled",
          "digest.enabled",
          "leaderboard_roles.enabled",
          "birthdays.enabled",
          "reminders.enabled",
          "notices.enabled",
          "celebrations.enabled",
          "messagetracking.enabled",
          "reactiontracking.enabled",
        ]),
      );
      expect(keys).not.toContain("voicetracking.seen.enabled");
      expect(keys).not.toContain("core.errors.enabled");
    });

    it("includes the running version", async () => {
      withEnabled([]);
      const content = await generate();
      expect(getBotVersion()).toMatch(/^\d+\.\d+\.\d+/);
      expect(content).toContain(`KoolBot v${getBotVersion()}`);
    });

    it("shows only the enabled features", async () => {
      withEnabled(["polls.enabled", "moderation.enabled"]);
      const content = await generate();
      expect(content).toContain("Polls");
      expect(content).toContain("Moderation");
      expect(content).not.toContain("Quotes");
      expect(content).not.toContain("More features can be enabled");
    });

    it("falls back to the placeholder when nothing is enabled", async () => {
      withEnabled([]);
      const content = await generate();
      expect(content).toContain("More features can be enabled");
    });

    it("picks up a newly added feature flag without generator changes", async () => {
      const config = defaultConfig as unknown as Record<string, unknown>;
      config["shinyfeature.enabled"] = false;
      try {
        withEnabled(["shinyfeature.enabled"]);
        const content = await generate();
        expect(content).toContain("Shinyfeature");
      } finally {
        delete config["shinyfeature.enabled"];
      }
    });

    it("builds a readable label for an undecorated feature", () => {
      expect(formatFeatureLine("some_new_thing.enabled")).toBe(
        "**✅ Some New Thing**",
      );
    });

    it("stays within the Notice content limit with everything enabled", async () => {
      withEnabled(getFeatureEnabledKeys());
      const content = await generate();
      expect(content.length).toBeLessThanOrEqual(4000);
    });
  });

  describe("config reload (#1007)", () => {
    it("regenerates the features notice only when initialized and enabled", async () => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      const ensure = jest
        .spyOn(manager, "ensureBotInfoNotice")
        .mockResolvedValue(undefined as never);
      let noticesEnabled = true;
      manager.configService = {
        getBoolean: jest.fn(async () => noticesEnabled),
      };

      await manager.onConfigReload();
      expect(ensure).not.toHaveBeenCalled();

      manager.isInitialized = true;
      await manager.onConfigReload();
      expect(ensure).toHaveBeenCalledTimes(1);

      noticesEnabled = false;
      await manager.onConfigReload();
      expect(ensure).toHaveBeenCalledTimes(1);
    });
  });
});
