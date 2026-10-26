import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Client } from "discord.js";

const mockRegisterReloadCallback = jest.fn();
const mockGetBoolean = jest.fn();
const mockGetString = jest.fn();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: mockRegisterReloadCallback,
      getBoolean: mockGetBoolean,
      getString: mockGetString,
    })),
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("../../src/config/env.js", () => ({
  env: { nodeEnv: "test", guildId: "guild-1" },
}));

const { DiscordLogger, DISCORD_LOG_TYPES } =
  await import("../../src/services/discord-logger.js");
const { defaultConfig, settingsMetadata } =
  await import("../../src/services/config-schema.js");

type ConfigValues = Record<string, string | boolean>;

function stubConfig(values: ConfigValues): void {
  mockGetBoolean.mockImplementation(async (key: unknown, fallback: unknown) =>
    key in values ? values[key as string] : fallback,
  );
  mockGetString.mockImplementation(async (key: unknown, fallback: unknown) =>
    key in values ? values[key as string] : fallback,
  );
}

function makeClient(
  channels: Record<string, { send: jest.Mock }>,
  guilds: Record<string, string> = {},
): Client {
  return {
    guilds: {
      cache: new Map(
        Object.entries(guilds).map(([id, name]) => [id, { id, name }]),
      ),
    },
    channels: {
      cache: new Map(
        Object.entries(channels).map(([id, ch]) => [
          id,
          { id, name: `chan-${id}`, ...ch },
        ]),
      ),
    },
  } as unknown as Client;
}

describe("DiscordLogger (#844)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the singleton between tests so each one gets a fresh client.
    (DiscordLogger as unknown as { instance?: unknown }).instance = undefined;
  });

  describe("DISCORD_LOG_TYPES", () => {
    it("is derived from the schema-declared core.<type>.enabled + channel_id pairs", () => {
      expect([...DISCORD_LOG_TYPES].sort()).toEqual([
        "cleanup",
        "config",
        "cron",
        "errors",
        "moderation",
        "moderation_review",
        "role_groups",
        "startup",
        "updates",
      ]);
      for (const type of DISCORD_LOG_TYPES) {
        expect(`core.${type}.enabled` in defaultConfig).toBe(true);
        expect(`core.${type}.channel_id` in defaultConfig).toBe(true);
        expect(
          settingsMetadata[
            `core.${type}.channel_id` as keyof typeof settingsMetadata
          ].type,
        ).toBe("channel");
      }
    });

    it("excludes core keys that have no channel_id (e.g. command_audit)", () => {
      expect(DISCORD_LOG_TYPES).not.toContain("command_audit");
      expect(DISCORD_LOG_TYPES).not.toContain("web_audit");
    });
  });

  describe("initialize()", () => {
    it("loads every category through ConfigService typed getters, not raw DB rows", async () => {
      stubConfig({
        "core.startup.enabled": true,
        "core.startup.channel_id": "111",
      });
      const logger = DiscordLogger.getInstance(makeClient({}));

      await logger.initialize();

      expect(logger.isReady()).toBe(true);
      for (const type of DISCORD_LOG_TYPES) {
        expect(mockGetBoolean).toHaveBeenCalledWith(
          `core.${type}.enabled`,
          false,
        );
        expect(mockGetString).toHaveBeenCalledWith(
          `core.${type}.channel_id`,
          "",
        );
      }
    });

    it("registers a config-reload callback exactly once", async () => {
      stubConfig({});
      const logger = DiscordLogger.getInstance(makeClient({}));

      await logger.initialize();
      await logger.initialize();

      expect(mockRegisterReloadCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("isCategoryEnabled()", () => {
    it("is true only when the category is on and has a channel id", async () => {
      stubConfig({
        "core.moderation.enabled": true,
        "core.moderation.channel_id": "555",
        "core.errors.enabled": true,
        "core.cron.channel_id": "666",
      });
      const logger = DiscordLogger.getInstance(makeClient({}));
      await logger.initialize();

      await expect(logger.isCategoryEnabled("moderation")).resolves.toBe(true);
      // Enabled but no channel id.
      await expect(logger.isCategoryEnabled("errors")).resolves.toBe(false);
      // Channel id but disabled.
      await expect(logger.isCategoryEnabled("cron")).resolves.toBe(false);
    });

    it("is false for a category that is not schema-declared", async () => {
      stubConfig({ "core.nonsense.enabled": true });
      const logger = DiscordLogger.getInstance(makeClient({}));
      await logger.initialize();

      await expect(logger.isCategoryEnabled("nonsense")).resolves.toBe(false);
    });
  });

  describe("logToChannel()", () => {
    it("posts an embed to the configured channel when the category is enabled", async () => {
      const send = jest.fn(async () => undefined);
      stubConfig({
        "core.startup.enabled": true,
        "core.startup.channel_id": "111",
      });
      const logger = DiscordLogger.getInstance(makeClient({ "111": { send } }));
      await logger.initialize();

      await logger.logBotStartup();

      expect(send).toHaveBeenCalledTimes(1);
      const payload = (send.mock.calls[0] as unknown[])[0] as {
        embeds: unknown[];
      };
      expect(payload.embeds).toHaveLength(1);
    });

    // Copilot review on #944: log embeds carry untrusted text (a moderation
    // reason, an error message), so a log channel must never become a way to
    // ping @everyone.
    it("suppresses every mention on the messages it sends", async () => {
      const send = jest.fn(async () => undefined);
      stubConfig({
        "core.startup.enabled": true,
        "core.startup.channel_id": "111",
      });
      const logger = DiscordLogger.getInstance(makeClient({ "111": { send } }));
      await logger.initialize();

      await logger.logBotStartup();

      const payload = (send.mock.calls[0] as unknown[])[0] as {
        allowedMentions?: { parse?: string[] };
      };
      expect(payload.allowedMentions).toEqual({ parse: [] });
    });

    it("stays silent when the category is disabled", async () => {
      const send = jest.fn(async () => undefined);
      stubConfig({
        "core.errors.enabled": false,
        "core.errors.channel_id": "222",
      });
      const logger = DiscordLogger.getInstance(makeClient({ "222": { send } }));
      await logger.initialize();

      await logger.logError(new Error("boom"), "test");

      expect(send).not.toHaveBeenCalled();
    });

    it("stays silent when enabled but no channel id is set (schema default)", async () => {
      const send = jest.fn(async () => undefined);
      stubConfig({ "core.cron.enabled": true });
      const logger = DiscordLogger.getInstance(makeClient({ "333": { send } }));
      await logger.initialize();

      await logger.logCronSuccess("job");

      expect(send).not.toHaveBeenCalled();
    });

    it("does nothing before initialize() has run", async () => {
      const send = jest.fn(async () => undefined);
      stubConfig({
        "core.startup.enabled": true,
        "core.startup.channel_id": "111",
      });
      const logger = DiscordLogger.getInstance(makeClient({ "111": { send } }));

      await logger.logBotStartup();

      expect(logger.isReady()).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("live config reads", () => {
    it("picks up a Settings-page save on the next log call without restart or reload", async () => {
      const send = jest.fn(async () => undefined);
      stubConfig({});
      const logger = DiscordLogger.getInstance(makeClient({ "444": { send } }));
      await logger.initialize();

      await logger.logConfigReload({ success: true, message: "ok" });
      expect(send).not.toHaveBeenCalled();

      // Operator enables the category on the Settings page; the write goes
      // straight through ConfigService's cache.
      stubConfig({
        "core.config.enabled": true,
        "core.config.channel_id": "444",
      });

      await logger.logConfigReload({ success: true, message: "ok" });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("re-reads every category when the registered reload callback fires", async () => {
      stubConfig({});
      const logger = DiscordLogger.getInstance(makeClient({}));
      await logger.initialize();
      mockGetBoolean.mockClear();

      const reload = mockRegisterReloadCallback.mock
        .calls[0][0] as () => Promise<void>;
      await reload();

      for (const type of DISCORD_LOG_TYPES) {
        expect(mockGetBoolean).toHaveBeenCalledWith(
          `core.${type}.enabled`,
          false,
        );
      }
    });
  });

  // #1516: the posts follow docs/design/discord.md: sentence-case titles with
  // no status emoji, plain field names, no field that repeats the title.
  describe("copy (#1516)", () => {
    interface Posted {
      title?: string;
      description?: string;
      color?: number;
      footer?: { text: string };
      fields?: Array<{ name: string; value: string; inline?: boolean }>;
    }

    async function post(
      category: string,
      call: (l: InstanceType<typeof DiscordLogger>) => Promise<void>,
      guilds: Record<string, string> = {},
    ): Promise<Posted> {
      const send = jest.fn(async () => undefined);
      stubConfig({
        [`core.${category}.enabled`]: true,
        [`core.${category}.channel_id`]: "111",
      });
      const logger = DiscordLogger.getInstance(
        makeClient({ "111": { send } }, guilds),
      );
      await logger.initialize();
      await call(logger);
      expect(send).toHaveBeenCalledTimes(1);
      const payload = (send.mock.calls[0] as unknown[])[0] as {
        embeds: Array<{ toJSON(): Posted }>;
      };
      return payload.embeds[0].toJSON();
    }

    const EMOJI = /\p{Extended_Pictographic}/u;
    const TITLE_CASE = /^[A-Z][a-z]+( [A-Z][a-z]+)+$/;

    function expectPlain(p: Posted): void {
      expect(p.title).toBeTruthy();
      expect(p.title).not.toMatch(EMOJI);
      for (const f of p.fields ?? []) {
        expect(f.name).not.toMatch(EMOJI);
        expect(f.name).not.toMatch(TITLE_CASE);
        expect(f.name).not.toBe("Status");
        expect(f.value).not.toMatch(EMOJI);
      }
    }

    const cases: Array<{
      label: string;
      category: string;
      call: (l: InstanceType<typeof DiscordLogger>) => Promise<void>;
      title: string;
    }> = [
      {
        label: "startup",
        category: "startup",
        call: (l) => l.logBotStartup(),
        title: "KoolBot started",
      },
      {
        label: "shutdown",
        category: "startup",
        call: (l) => l.logBotShutdown(),
        title: "KoolBot is shutting down",
      },
      {
        label: "registration ok",
        category: "startup",
        call: (l) => l.logDiscordRegistrationSuccess(),
        title: "Commands registered with Discord",
      },
      {
        label: "registration failed",
        category: "startup",
        call: (l) => l.logDiscordRegistrationFailure("nope"),
        title: "Couldn't register commands with Discord",
      },
      {
        label: "reload ok",
        category: "config",
        call: (l) =>
          l.logConfigReload({
            success: true,
            message: "m",
            commandsUpdated: 3,
          }),
        title: "Settings reloaded",
      },
      {
        label: "reload failed",
        category: "config",
        call: (l) => l.logConfigReload({ success: false, message: "m" }),
        title: "Couldn't reload settings",
      },
      {
        label: "service ok",
        category: "startup",
        call: (l) => l.logServiceInit("Quotes", true),
        title: "Quotes started",
      },
      {
        label: "service failed",
        category: "startup",
        call: (l) => l.logServiceInit("Quotes", false),
        title: "Quotes failed to start",
      },
      {
        label: "cleanup ok",
        category: "cleanup",
        call: (l) =>
          l.logCleanupResults({
            sessionsRemoved: 1,
            dataAggregated: 2,
            executionTime: 120,
            errors: [],
          }),
        title: "Voice channel clean-up finished",
      },
      {
        label: "cleanup with errors",
        category: "cleanup",
        call: (l) =>
          l.logCleanupResults({
            sessionsRemoved: 1,
            dataAggregated: 2,
            executionTime: 120,
            errors: ["x"],
          }),
        title: "Voice channel clean-up finished",
      },
      {
        label: "database ok",
        category: "startup",
        call: (l) => l.logDatabaseStatus(true),
        title: "Connected to the database",
      },
      {
        label: "database failed",
        category: "startup",
        call: (l) => l.logDatabaseStatus(false),
        title: "Couldn't connect to the database",
      },
      {
        label: "error",
        category: "errors",
        call: (l) => l.logError(new TypeError("boom"), "voice cleanup"),
        title: "Error in voice cleanup",
      },
      {
        label: "cron ok",
        category: "cron",
        call: (l) => l.logCronSuccess("Weekly digest"),
        title: "Weekly digest ran",
      },
      {
        label: "cron failed",
        category: "cron",
        call: (l) => l.logCronFailure("Weekly digest", "bad"),
        title: "Weekly digest failed",
      },
    ];

    it.each(cases)(
      "$label: sentence-case title, no emoji, no Status field",
      async ({ category, call, title }) => {
        const p = await post(category, call);
        expect(p.title).toBe(title);
        expectPlain(p);
        expect(p.footer?.text).toMatch(/^KoolBot · Logs · /);
      },
    );

    it("never repeats the title as the description", async () => {
      for (const c of cases) {
        (DiscordLogger as unknown as { instance?: unknown }).instance =
          undefined;
        const p = await post(c.category, c.call);
        expect(p.description ?? "").not.toMatch(/successfully/i);
        expect(p.description ?? "").not.toMatch(/initialized/);
      }
    });

    it("uses plain field names and a spaced run time", async () => {
      const cleanup = await post("cleanup", (l) =>
        l.logCleanupResults({
          sessionsRemoved: 1,
          dataAggregated: 2,
          executionTime: 120,
          errors: [],
        }),
      );
      expect(cleanup.fields?.map((f) => f.name)).toEqual([
        "Sessions removed",
        "Data aggregated",
        "Run time",
      ]);
      expect(cleanup.fields?.find((f) => f.name === "Run time")?.value).toBe(
        "120 ms",
      );

      (DiscordLogger as unknown as { instance?: unknown }).instance = undefined;
      const reload = await post("config", (l) =>
        l.logConfigReload({ success: true, message: "m", commandsUpdated: 3 }),
      );
      expect(reload.fields?.map((f) => f.name)).toEqual(["Commands updated"]);

      (DiscordLogger as unknown as { instance?: unknown }).instance = undefined;
      const err = await post("errors", (l) =>
        l.logError(new TypeError("boom"), "ctx"),
      );
      expect(err.fields?.map((f) => f.name)).toEqual([
        "Context",
        "Error type",
        "Error message",
      ]);

      (DiscordLogger as unknown as { instance?: unknown }).instance = undefined;
      const cron = await post("cron", (l) => l.logCronSuccess("Birthdays"));
      expect(cron.fields?.map((f) => f.name)).toEqual(["Job"]);
    });

    it("tells the admin what to do when something failed", async () => {
      const err = await post("errors", (l) =>
        l.logError(new Error("boom"), "ctx"),
      );
      expect(err.description).toBe("Check the bot's log for the full error.");
    });

    it("shows the server name with the id in code, falling back to the id", async () => {
      const named = await post(
        "startup",
        (l) => l.logDiscordRegistrationSuccess(),
        { "guild-1": "Koolbot Dev" },
      );
      const server = named.fields?.find((f) => f.name === "Server");
      expect(server?.value).toBe("Koolbot Dev `guild-1`");
      expect(named.fields?.some((f) => f.name === "Guild")).toBe(false);

      (DiscordLogger as unknown as { instance?: unknown }).instance = undefined;
      const uncached = await post("startup", (l) =>
        l.logDiscordRegistrationSuccess(),
      );
      expect(uncached.fields?.find((f) => f.name === "Server")?.value).toBe(
        "`guild-1`",
      );
    });
  });
});
