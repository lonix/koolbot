import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { REST, RESTEvents } from "discord.js";
import { CommandManager } from "../../src/services/command-manager.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import logger from "../../src/utils/logger.js";
import {
  getSharedRest,
  resetSharedRest,
} from "../../src/utils/discord-rest.js";

jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/monitoring-service.js");
jest.mock("../../src/services/cooldown-manager.js");
jest.mock("../../src/services/permissions-service.js");

describe("CommandManager.registerCommands (#1293)", () => {
  let manager: CommandManager;
  let putSpy: jest.SpiedFunction<typeof REST.prototype.put>;
  let getSpy: jest.SpiedFunction<typeof REST.prototype.get>;
  let restInstances: REST[];
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;

  beforeEach(() => {
    jest.clearAllMocks();
    CommandManager.reset();
    PermissionsService.reset();
    resetSharedRest();
    restInstances = [];
    // Default: Discord has nothing registered, so a PUT is needed.
    getSpy = jest.spyOn(REST.prototype, "get").mockResolvedValue([]);
    warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
    putSpy = jest
      .spyOn(REST.prototype, "put")
      .mockImplementation(async function (this: REST) {
        restInstances.push(this);
        return [];
      });
    manager = CommandManager.getInstance({ user: { id: "1" } } as never);
    const values: Record<string, string> = {
      GUILD_ID: "guild-1",
      CLIENT_ID: "client-1",
      DISCORD_TOKEN: "secret-token-value",
    };
    (manager as unknown as { configService: unknown }).configService = {
      getString: async (key: string) => values[key] ?? "",
      getBoolean: async () => false,
    };
    (manager as unknown as { getEnabledCommands: unknown }).getEnabledCommands =
      async () => [{ name: "ping" }, { name: "quote" }];
  });

  afterEach(() => {
    putSpy.mockRestore();
    getSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("sends exactly one bulk overwrite and no empty-list clear", async () => {
    await manager.registerCommands();

    expect(putSpy).toHaveBeenCalledTimes(1);
    const [route, options] = putSpy.mock.calls[0] as [
      string,
      { body: unknown[] },
    ];
    expect(route).toBe("/applications/client-1/guilds/guild-1/commands");
    expect(options.body).toEqual([{ name: "ping" }, { name: "quote" }]);
    const emptyClears = putSpy.mock.calls.filter(
      (call) => (call[1] as { body: unknown[] }).body.length === 0,
    );
    expect(emptyClears).toHaveLength(0);
  });

  it("removes every command with a single overwrite when none is enabled", async () => {
    (manager as unknown as { getEnabledCommands: unknown }).getEnabledCommands =
      async () => [];
    // Discord still has one command, so the list is not unchanged.
    getSpy.mockResolvedValue([{ id: "1", name: "ping", description: "" }]);
    await manager.registerCommands();

    // Removing every command is one overwrite too, not a clear plus a register.
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it("logs a REST rate limit at warn level without secrets", async () => {
    await manager.registerCommands();
    const rest = restInstances[0];

    rest.emit(RESTEvents.RateLimited, {
      method: "PUT",
      route: "/applications/:id/guilds/:id/commands\nforged",
      scope: "user",
      global: false,
      limit: 2,
      retryAfter: 25000,
      timeToReset: 25000,
      hash: "bucket-hash",
      majorParameter: "guild-1",
      sublimitTimeout: 0,
      url: "https://discord.com/api/v10/x?token=secret-token-value",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain("PUT");
    expect(message).toContain("retryAfter=25000ms");
    expect(message).toContain("timeToReset=25000ms");
    expect(message).not.toContain("\n");
    expect(message).not.toContain("secret-token-value");
    expect(message).not.toContain("bucket-hash");
  });

  describe("skip the overwrite when unchanged (#1307)", () => {
    // What Discord returns for the same two commands: ids, defaults filled in,
    // null localisations, a different order.
    const registered = [
      {
        id: "2",
        application_id: "client-1",
        version: "9",
        type: 1,
        name: "quote",
        description: "",
        name_localizations: null,
        description_localizations: null,
        default_member_permissions: null,
        dm_permission: true,
        nsfw: false,
        guild_id: "guild-1",
      },
      {
        id: "1",
        application_id: "client-1",
        version: "8",
        type: 1,
        name: "ping",
        description: "",
        default_member_permissions: null,
        dm_permission: true,
        nsfw: false,
        guild_id: "guild-1",
      },
    ];

    it("sends no PUT when the registered list matches", async () => {
      getSpy.mockResolvedValue(registered);
      await manager.registerCommands();

      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(getSpy.mock.calls[0][0]).toBe(
        "/applications/client-1/guilds/guild-1/commands",
      );
      expect(putSpy).not.toHaveBeenCalled();
    });

    it("sends one PUT when a command was added", async () => {
      getSpy.mockResolvedValue(registered.slice(0, 1));
      await manager.registerCommands();
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it("sends one PUT when a command was removed", async () => {
      getSpy.mockResolvedValue([
        ...registered,
        { ...registered[0], id: "3", name: "old" },
      ]);
      await manager.registerCommands();
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it("sends one PUT when a command was edited", async () => {
      getSpy.mockResolvedValue([
        { ...registered[0], description: "changed" },
        registered[1],
      ]);
      await manager.registerCommands();
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to the PUT when the GET fails", async () => {
      getSpy.mockRejectedValue(new Error("boom"));
      await manager.registerCommands();
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it("falls back to the PUT when the GET returns an unexpected shape", async () => {
      getSpy.mockResolvedValue({ message: "nope" });
      await manager.registerCommands();
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it("reuses one REST instance across calls", async () => {
      await manager.registerCommands();
      await manager.registerCommands();
      expect(putSpy).toHaveBeenCalledTimes(2);
      expect(new Set(restInstances).size).toBe(1);
    });
  });
});

describe("shared REST instance (#1307)", () => {
  it("constructs one REST per token and sits the rate-limit listener on it", () => {
    resetSharedRest();
    const a = getSharedRest("token-a");
    expect(getSharedRest("token-a")).toBe(a);
    expect(a.listenerCount(RESTEvents.RateLimited)).toBe(1);
    expect(getSharedRest("token-b")).not.toBe(a);
    resetSharedRest();
  });
});
