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

jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/monitoring-service.js");
jest.mock("../../src/services/cooldown-manager.js");
jest.mock("../../src/services/permissions-service.js");

describe("CommandManager.registerCommands (#1293)", () => {
  let manager: CommandManager;
  let putSpy: jest.SpiedFunction<typeof REST.prototype.put>;
  let restInstances: REST[];
  let warnSpy: jest.SpiedFunction<typeof logger.warn>;

  beforeEach(() => {
    jest.clearAllMocks();
    CommandManager.reset();
    PermissionsService.reset();
    restInstances = [];
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
});
