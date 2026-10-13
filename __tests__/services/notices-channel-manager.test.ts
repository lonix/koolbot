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
  getFeatureEnabledKeys,
} from "../../src/services/notices-channel-manager.js";
import {
  defaultConfig,
  settingsMetadata,
} from "../../src/services/config-schema.js";
import { getBotVersion } from "../../src/utils/version.js";
import { BOT_FEATURES } from "../../src/content/bot-features.js";
import Notice from "../../src/models/notice.js";

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
      withEnabled(["quotes.enabled", "events.enabled"]);
      const content = await generate();
      expect(content).toContain("Quotes");
      expect(content).toContain("Events");
      expect(content).not.toContain("Reminders");
      expect(content).not.toContain("More features can be enabled");
    });

    it("falls back to the placeholder when nothing is enabled", async () => {
      withEnabled([]);
      const content = await generate();
      expect(content).toContain("More features can be enabled");
    });

    it("keeps a newly added, unclassified feature out of the notice (#1131)", async () => {
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
        expect(getFeatureEnabledKeys()).toContain("shinyfeature.enabled");
        withEnabled(["shinyfeature.enabled"]);
        const content = await generate();
        expect(content).not.toContain("Shiny");
      } finally {
        delete config["shinyfeature.enabled"];
        delete meta["shinyfeature.enabled"];
      }
    });

    it("hides a classified-but-unlisted feature even while it is enabled (#1131)", async () => {
      withEnabled(["messagetracking.enabled", "leaderboard_roles.enabled"]);
      const content = await generate();
      expect(content).not.toContain("Message Tracking");
      expect(content).not.toContain("Leaderboard Roles");
      expect(content).toContain("More features can be enabled");
    });

    it("lists a listed feature only while its gate is enabled (#1131)", async () => {
      withEnabled(["reminders.enabled"]);
      expect(await generate()).toContain("Reminders");
      withEnabled([]);
      expect(await generate()).not.toContain("Reminders");
    });

    it("lists exactly the listed features when everything is enabled (#1131)", async () => {
      withEnabled(getFeatureEnabledKeys());
      const content = await generate();
      for (const info of Object.values(BOT_FEATURES)) {
        const line = `**${info.emoji} ${info.label}**`;
        if (info.listed) expect(content).toContain(line);
        else expect(content).not.toContain(line);
      }
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

  describe("serialised refresh and shutdown (#1120)", () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    it("runs one notice sync at a time and exactly one extra pass for changes mid-flight", async () => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      const gates = [deferred(), deferred(), deferred()];
      let started = 0;
      let active = 0;
      let maxActive = 0;
      jest.spyOn(manager, "syncBotInfoNotice").mockImplementation((async () => {
        const gate = gates[started++];
        active++;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active--;
      }) as never);

      const first = manager.ensureBotInfoNotice();
      // Three more requests while the first is running coalesce to one rerun.
      const second = manager.ensureBotInfoNotice();
      const third = manager.ensureBotInfoNotice();
      const fourth = manager.ensureBotInfoNotice();
      expect(started).toBe(1);

      gates[0].resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(started).toBe(2);
      gates[1].resolve();
      await Promise.all([first, second, third, fourth]);

      expect(started).toBe(2);
      expect(maxActive).toBe(1);

      // A later request starts a fresh run.
      const fifth = manager.ensureBotInfoNotice();
      expect(started).toBe(3);
      gates[2].resolve();
      await fifth;
    });

    it("stop() during a sync cancels the pending rerun", async () => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      const gate = deferred();
      const sync = jest
        .spyOn(manager, "syncBotInfoNotice")
        .mockImplementation((async () => gate.promise) as never);
      manager.configService = {
        removeReloadCallback: jest.fn(),
        removeChangeListener: jest.fn(),
      };

      const run = manager.ensureBotInfoNotice();
      void manager.ensureBotInfoNotice();
      const stopping = manager.stop();
      gate.resolve();
      await Promise.all([run, stopping]);

      expect(sync).toHaveBeenCalledTimes(1);
      expect(manager.noticeRun).toBeNull();
    });

    it("stop() during initialize registers no jobs and posts nothing afterwards", async () => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      const gate = deferred();
      const registerReloadCallback = jest.fn();
      manager.configService = {
        getBoolean: jest.fn(async () => true),
        getString: jest.fn(async () => {
          await gate.promise;
          return "channel123";
        }),
        registerReloadCallback,
        removeReloadCallback: jest.fn(),
        addChangeListener: jest.fn(),
        removeChangeListener: jest.fn(),
      };
      const spies = [
        "setupChannelPermissions",
        "ensureHeaderPost",
        "ensureBotInfoNotice",
        "syncNotices",
        "startCleanupJob",
      ].map((m) =>
        jest.spyOn(manager, m).mockResolvedValue(undefined as never),
      );
      jest
        .spyOn(manager, "getNoticesChannel")
        .mockResolvedValue({ name: "notices" } as never);

      const init = manager.initialize();
      await new Promise((r) => setTimeout(r, 0));
      const stopping = manager.stop();
      gate.resolve();
      await Promise.all([init, stopping]);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(registerReloadCallback).not.toHaveBeenCalled();
      expect(manager.initPromise).toBeNull();
    });
  });

  describe("stop() inside a single refresh pass (#1133)", () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));

    // A fake notices channel: `messages` is the channel's final state and
    // `events` records every call in order. `gates` can hold one operation.
    const setup = () => {
      const manager = NoticesChannelManager.getInstance(mockClient) as any;
      const messages = new Set<string>(["old-msg"]);
      const events: string[] = [];
      const gates: Record<string, ReturnType<typeof deferred> | undefined> = {};
      const fetchErrors: Record<string, unknown> = {};
      const deleteErrors: Record<string, unknown> = {};
      let nextId = 1;
      const channel = {
        send: jest.fn(async (): Promise<{ id: string }> => {
          events.push("send");
          await gates.send?.promise;
          const id = `new-msg-${nextId++}`;
          messages.add(id);
          events.push(`posted:${id}`);
          return { id };
        }),
        messages: {
          fetch: jest.fn(async (id: string) => {
            if (fetchErrors[id]) throw fetchErrors[id];
            return {
              id,
              delete: jest.fn(async () => {
                if (deleteErrors[id]) throw deleteErrors[id];
                events.push(`delete:${id}`);
                await gates.delete?.promise;
                messages.delete(id);
                events.push(`deleted:${id}`);
              }),
            };
          }),
        },
      };
      const notice: any = {
        _id: "notice1",
        title: "KoolBot Features & Commands",
        category: "help",
        content: "stale",
        messageId: "old-msg",
        createdAt: new Date(),
        updatedAt: new Date(),
        save: jest.fn(async () => {
          events.push("save");
          await gates.save?.promise;
        }),
      };
      (Notice.findOne as any).mockResolvedValue(notice);
      jest
        .spyOn(manager, "generateBotInfoContent")
        .mockImplementation((async () => {
          await gates.generate?.promise;
          return "fresh";
        }) as never);
      jest.spyOn(manager, "getNoticesChannel").mockResolvedValue(channel);
      manager.configService = {
        removeReloadCallback: jest.fn(),
        removeChangeListener: jest.fn(),
      };
      return {
        manager,
        messages,
        events,
        gates,
        channel,
        notice,
        fetchErrors,
        deleteErrors,
      };
    };

    it("posts the new message before deleting the old one", async () => {
      const { manager, messages, events, notice } = setup();
      await manager.ensureBotInfoNotice();

      expect(events.indexOf("send")).toBeLessThan(
        events.indexOf("delete:old-msg"),
      );
      expect([...messages]).toEqual(["new-msg-1"]);
      expect(notice.messageId).toBe("new-msg-1");
    });

    it("keeps the old message and the old stored content when the new post fails, and a later refresh retries", async () => {
      const { manager, messages, channel, notice } = setup();
      channel.send.mockRejectedValueOnce(new Error("discord down") as never);
      await manager.ensureBotInfoNotice();

      expect([...messages]).toEqual(["old-msg"]);
      expect(notice.messageId).toBe("old-msg");
      // Nothing was stored, so the next refresh still sees a difference.
      expect(notice.content).toBe("stale");
      expect(notice.save).not.toHaveBeenCalled();

      await manager.ensureBotInfoNotice();
      expect([...messages]).toEqual(["new-msg-1"]);
      expect(notice.messageId).toBe("new-msg-1");
      expect(notice.content).toBe("fresh");
    });

    it("stores the content and the new message id together after a successful post", async () => {
      const { manager, notice, events } = setup();
      await manager.ensureBotInfoNotice();

      expect(notice.save).toHaveBeenCalledTimes(1);
      expect(events.indexOf("posted:new-msg-1")).toBeLessThan(
        events.indexOf("save"),
      );
      expect(notice.content).toBe("fresh");
      expect(notice.messageId).toBe("new-msg-1");
    });

    it("takes the new message back down when storing it fails, keeping the old one", async () => {
      const { manager, messages, notice } = setup();
      notice.save.mockRejectedValueOnce(new Error("mongo down") as never);
      await manager.ensureBotInfoNotice();

      expect([...messages]).toEqual(["old-msg"]);
      expect(notice.messageId).toBe("old-msg");
      expect(notice.content).toBe("stale");
    });

    it("remembers a post it could not take down and removes it on the next refresh", async () => {
      const { manager, messages, notice, deleteErrors } = setup();
      notice.save.mockRejectedValueOnce(new Error("mongo down") as never);
      deleteErrors["new-msg-1"] = new Error("discord down");
      await manager.ensureBotInfoNotice();

      expect([...messages].sort()).toEqual(["new-msg-1", "old-msg"]);
      expect([...manager.orphanedMessageIds]).toEqual(["new-msg-1"]);

      delete deleteErrors["new-msg-1"];
      await manager.ensureBotInfoNotice();

      expect([...messages]).toEqual(["new-msg-2"]);
      expect(notice.messageId).toBe("new-msg-2");
      expect(manager.orphanedMessageIds.size).toBe(0);
    });

    it("remembers an old message it could not delete after a successful swap", async () => {
      const { manager, messages, deleteErrors } = setup();
      deleteErrors["old-msg"] = new Error("discord down");
      await manager.ensureBotInfoNotice();
      expect([...manager.orphanedMessageIds]).toEqual(["old-msg"]);

      delete deleteErrors["old-msg"];
      await manager.ensureBotInfoNotice();
      expect([...messages]).toEqual(["new-msg-1"]);
      expect(manager.orphanedMessageIds.size).toBe(0);
    });

    it("forgets an orphan Discord says no longer exists, without looping", async () => {
      const { manager, channel, fetchErrors } = setup();
      manager.orphanedMessageIds.add("ghost");
      fetchErrors["ghost"] = { code: 10008, message: "Unknown Message" };

      await manager.ensureBotInfoNotice();
      expect(manager.orphanedMessageIds.size).toBe(0);
      const ghostFetches = () =>
        channel.messages.fetch.mock.calls.filter(([id]) => id === "ghost")
          .length;
      expect(ghostFetches()).toBe(1);

      await manager.ensureBotInfoNotice();
      expect(ghostFetches()).toBe(1);
    });

    it("keeps retrying an orphan while the delete keeps failing, and clears the set on stop()", async () => {
      const { manager, deleteErrors } = setup();
      manager.orphanedMessageIds.add("stuck");
      deleteErrors["stuck"] = new Error("discord down");
      await manager.ensureBotInfoNotice();
      expect([...manager.orphanedMessageIds]).toEqual(["stuck"]);

      await manager.stop();
      expect(manager.orphanedMessageIds.size).toBe(0);
    });

    it("stop() while the delete is in flight posts nothing after stop() and leaves one message", async () => {
      const { manager, messages, events, gates, channel } = setup();
      gates.delete = deferred();

      const run = manager.ensureBotInfoNotice();
      await tick();
      expect(events).toContain("delete:old-msg");
      const sendsBeforeStop = channel.send.mock.calls.length;

      const stopping = manager.stop();
      gates.delete.resolve();
      await Promise.all([run, stopping]);

      expect(channel.send.mock.calls.length).toBe(sendsBeforeStop);
      expect([...messages]).toEqual(["new-msg-1"]);
    });

    it("stop() before the repost leaves the old message and posts nothing", async () => {
      const { manager, messages, events, gates, channel } = setup();
      gates.generate = deferred();

      const run = manager.ensureBotInfoNotice();
      await tick();
      const stopping = manager.stop();
      gates.generate.resolve();
      await Promise.all([run, stopping]);

      expect(channel.send).not.toHaveBeenCalled();
      expect(events.some((e) => e.startsWith("delete:"))).toBe(false);
      expect([...messages]).toEqual(["old-msg"]);
    });

    it("stop() while the post is in flight ends with one message, never a duplicate", async () => {
      const { manager, messages, gates, notice } = setup();
      gates.send = deferred();

      const run = manager.ensureBotInfoNotice();
      await tick();
      const stopping = manager.stop();
      gates.send.resolve();
      await Promise.all([run, stopping]);

      expect([...messages]).toEqual(["new-msg-1"]);
      expect(notice.messageId).toBe("new-msg-1");
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
