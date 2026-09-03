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

function makeClient(channels: Record<string, { send: jest.Mock }>): Client {
  return {
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
        "startup",
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
});
