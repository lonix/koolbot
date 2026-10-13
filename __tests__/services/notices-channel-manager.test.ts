import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  NoticesChannelManager,
  formatFeatureLine,
  getFeatureEnabledKeys,
} from "../../src/services/notices-channel-manager.js";
import {
  defaultConfig,
  settingsMetadata,
} from "../../src/services/config-schema.js";
import { getBotVersion } from "../../src/utils/version.js";
import { BOT_FEATURES } from "../../src/content/bot-features.js";

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
      const meta = settingsMetadata as unknown as Record<string, unknown>;
      config["shinyfeature.enabled"] = false;
      meta["shinyfeature.enabled"] = {
        label: "Shiny",
        description: "Shiny",
        category: "shinyfeature",
        type: "boolean",
      };
      try {
        withEnabled(["shinyfeature.enabled"]);
        const content = await generate();
        expect(content).toContain("Shinyfeature");
      } finally {
        delete config["shinyfeature.enabled"];
        delete meta["shinyfeature.enabled"];
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

  describe("feature list accuracy (#1119)", () => {
    const withEnabled = (manager: any, keys: string[]) => {
      const enabled = new Set(keys);
      manager.configService = {
        getBoolean: jest.fn(async (key: string) => enabled.has(key)),
      };
    };

    it("does not promote a foreign-prefix toggle (aka.enabled) to a feature", () => {
      const keys = getFeatureEnabledKeys();
      expect(keys).toContain("namehistory.enabled");
      expect(keys).not.toContain("aka.enabled");
    });

    it("only lists keys whose category is their own prefix", () => {
      const meta = settingsMetadata as Record<string, { category?: string }>;
      for (const key of getFeatureEnabledKeys()) {
        expect(meta[key]?.category).toBe(key.replace(/\.enabled$/, ""));
      }
    });

    it("lists Name History exactly once with member-facing copy", async () => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      withEnabled(manager, ["namehistory.enabled", "aka.enabled"]);
      const content: string = await manager.generateBotInfoContent();
      expect(content.match(/Name History/g)).toHaveLength(1);
      expect(content).not.toContain("Namehistory");
      expect(content).not.toContain("Aka");
      expect(content).not.toContain("✅");
      expect(content).not.toContain("GuildMembers");
    });

    it("has member-facing copy for every feature the notice can list", () => {
      for (const key of getFeatureEnabledKeys()) {
        const feature = key.replace(/\.enabled$/, "");
        expect(BOT_FEATURES).toHaveProperty(feature);
      }
    });
  });

  describe("refresh on settings change (#1120)", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const setup = () => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      const ensure = jest
        .spyOn(manager, "ensureBotInfoNotice")
        .mockResolvedValue(undefined as never);
      manager.configService = { getBoolean: jest.fn(async () => true) };
      manager.isInitialized = true;
      return { manager, ensure };
    };

    it("refreshes the notice when a feature gate changes without a reload", async () => {
      const { manager, ensure } = setup();
      manager.onConfigChange("polls.enabled");
      expect(ensure).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(5000);
      expect(ensure).toHaveBeenCalledTimes(1);
    });

    it("coalesces a burst of changes into one refresh", async () => {
      const { manager, ensure } = setup();
      manager.onConfigChange("polls.enabled");
      manager.onConfigChange("quotes.enabled");
      manager.onConfigChange("events.enabled");
      await jest.advanceTimersByTimeAsync(5000);
      expect(ensure).toHaveBeenCalledTimes(1);
    });

    it("ignores keys that cannot change the feature list", async () => {
      const { manager, ensure } = setup();
      manager.onConfigChange("polls.channel_id");
      manager.onConfigChange("voicetracking.seen.enabled");
      manager.onConfigChange("aka.enabled");
      await jest.advanceTimersByTimeAsync(5000);
      expect(ensure).not.toHaveBeenCalled();
    });

    it("does not refresh after stop()", async () => {
      const { manager, ensure } = setup();
      manager.configService.removeChangeListener = jest.fn();
      manager.changeListenerRegistered = true;
      manager.onConfigChange("polls.enabled");
      await manager.stop();
      await jest.advanceTimersByTimeAsync(5000);
      expect(ensure).not.toHaveBeenCalled();
    });
  });

  describe("starting with notices disabled (#1120)", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const setup = (enabled: { value: boolean }) => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      const addChangeListener = jest.fn();
      const removeChangeListener = jest.fn();
      manager.configService = {
        getBoolean: jest.fn(async () => enabled.value),
        getString: jest.fn(async () => "channel123"),
        registerReloadCallback: jest.fn(),
        removeReloadCallback: jest.fn(),
        addChangeListener,
        removeChangeListener,
      };
      for (const method of [
        "setupChannelPermissions",
        "ensureHeaderPost",
        "ensureBotInfoNotice",
        "syncNotices",
        "startCleanupJob",
      ]) {
        jest.spyOn(manager, method).mockResolvedValue(undefined as never);
      }
      jest
        .spyOn(manager, "getNoticesChannel")
        .mockResolvedValue({ name: "notices" } as never);
      return { manager, addChangeListener, removeChangeListener };
    };

    it("subscribes while disabled and initializes when notices.enabled turns on", async () => {
      const enabled = { value: false };
      const { manager, addChangeListener } = setup(enabled);

      await manager.initialize();
      expect(addChangeListener).toHaveBeenCalledWith(manager.onConfigChange);
      expect(manager.isInitialized).toBe(false);

      enabled.value = true;
      manager.onConfigChange("notices.enabled");
      await jest.advanceTimersByTimeAsync(5000);

      expect(manager.isInitialized).toBe(true);
      expect(manager.ensureBotInfoNotice).toHaveBeenCalledTimes(1);
    });

    it("ignores unrelated keys while not running", async () => {
      const enabled = { value: true };
      const { manager } = setup(enabled);
      manager.onConfigChange("polls.enabled");
      await jest.advanceTimersByTimeAsync(5000);
      expect(manager.isInitialized).toBe(false);
    });

    it("does not register the change listener twice on repeated start", async () => {
      const enabled = { value: false };
      const { manager, addChangeListener } = setup(enabled);
      await manager.initialize();
      await manager.initialize();
      expect(addChangeListener).toHaveBeenCalledTimes(1);

      enabled.value = true;
      await manager.initialize();
      await manager.initialize();
      expect(addChangeListener).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes on stop() even if it never became enabled", async () => {
      const enabled = { value: false };
      const { manager, removeChangeListener } = setup(enabled);
      await manager.initialize();
      await manager.stop();
      expect(removeChangeListener).toHaveBeenCalledWith(manager.onConfigChange);
      await manager.stop();
      expect(removeChangeListener).toHaveBeenCalledTimes(1);
    });

    it("stops refreshing when notices.enabled turns off", async () => {
      const enabled = { value: true };
      const { manager } = setup(enabled);
      await manager.initialize();
      (manager.ensureBotInfoNotice as jest.Mock).mockClear();
      enabled.value = false;
      manager.onConfigChange("notices.enabled");
      await jest.advanceTimersByTimeAsync(5000);
      expect(manager.ensureBotInfoNotice).not.toHaveBeenCalled();
    });
  });

  describe("reload callback lifecycle (#1007)", () => {
    it("initialize() registers the reload callback and stop() removes it", async () => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      const registerReloadCallback = jest.fn();
      const removeReloadCallback = jest.fn();
      const addChangeListener = jest.fn();
      const removeChangeListener = jest.fn();
      manager.configService = {
        getBoolean: jest.fn(async () => true),
        getString: jest.fn(async () => "channel123"),
        registerReloadCallback,
        removeReloadCallback,
        addChangeListener,
        removeChangeListener,
      };
      for (const method of [
        "getNoticesChannel",
        "setupChannelPermissions",
        "ensureHeaderPost",
        "ensureBotInfoNotice",
        "syncNotices",
        "startCleanupJob",
      ]) {
        jest
          .spyOn(manager, method)
          .mockResolvedValue(
            (method === "getNoticesChannel"
              ? { name: "notices" }
              : undefined) as never,
          );
      }

      await manager.initialize();
      expect(registerReloadCallback).toHaveBeenCalledTimes(1);
      expect(registerReloadCallback).toHaveBeenCalledWith(
        manager.onConfigReload,
      );
      expect(addChangeListener).toHaveBeenCalledWith(manager.onConfigChange);

      await manager.stop();
      expect(removeReloadCallback).toHaveBeenCalledWith(manager.onConfigReload);
      expect(removeChangeListener).toHaveBeenCalledWith(manager.onConfigChange);

      // A second stop() must not try to unregister again.
      await manager.stop();
      expect(removeReloadCallback).toHaveBeenCalledTimes(1);
      expect(removeChangeListener).toHaveBeenCalledTimes(1);
    });

    it("does not register the reload callback when notices are disabled", async () => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      const registerReloadCallback = jest.fn();
      manager.configService = {
        getBoolean: jest.fn(async () => false),
        registerReloadCallback,
        addChangeListener: jest.fn(),
      };

      await manager.initialize();
      expect(registerReloadCallback).not.toHaveBeenCalled();
    });
  });
});
