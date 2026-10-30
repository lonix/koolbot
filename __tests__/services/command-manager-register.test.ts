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
import { DiscordLogger } from "../../src/services/discord-logger.js";
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

  describe("registration failure log (#1556)", () => {
    let logRegistrationFailure: jest.Mock;

    beforeEach(() => {
      logRegistrationFailure = jest.fn(async () => undefined);
      jest.spyOn(DiscordLogger, "getInstance").mockReturnValue({
        logDiscordRegistrationFailure: logRegistrationFailure,
      } as unknown as DiscordLogger);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("posts a failed registration once and still rejects with the original error", async () => {
      putSpy.mockRejectedValue(new Error("Discord said no"));
      jest
        .spyOn(
          manager as unknown as { makeDiscordApiCall: () => Promise<unknown> },
          "makeDiscordApiCall",
        )
        .mockRejectedValue(new Error("Discord said no"));

      await expect(manager.registerCommands()).rejects.toThrow(
        "Discord said no",
      );

      expect(logRegistrationFailure).toHaveBeenCalledTimes(1);
      expect(logRegistrationFailure).toHaveBeenCalledWith("Discord said no");
    });

    it("rejects with the original error at once even when the post never finishes", async () => {
      logRegistrationFailure.mockImplementation(
        () => new Promise<void>(() => undefined),
      );
      jest
        .spyOn(
          manager as unknown as { makeDiscordApiCall: () => Promise<unknown> },
          "makeDiscordApiCall",
        )
        .mockRejectedValue(new Error("Discord said no"));

      const outcome = await Promise.race([
        manager.registerCommands().then(
          () => "resolved",
          (error: Error) => error.message,
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("held up by the post"), 300),
        ),
      ]);

      expect(outcome).toBe("Discord said no");
      expect(logRegistrationFailure).toHaveBeenCalledTimes(1);
    });

    it("posts nothing when registration succeeds", async () => {
      await manager.registerCommands();

      expect(logRegistrationFailure).not.toHaveBeenCalled();
    });

    it("keeps the original error when the post itself fails", async () => {
      logRegistrationFailure.mockRejectedValue(new Error("log channel gone"));
      jest
        .spyOn(
          manager as unknown as { makeDiscordApiCall: () => Promise<unknown> },
          "makeDiscordApiCall",
        )
        .mockRejectedValue(new Error("Discord said no"));

      await expect(manager.registerCommands()).rejects.toThrow(
        "Discord said no",
      );
    });
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

    it("requests the localisation dictionaries in the GET", async () => {
      getSpy.mockResolvedValue(registered);
      await manager.registerCommands();
      const options = getSpy.mock.calls[0][1] as {
        query: { get(k: string): string | null };
      };
      expect(options.query.get("with_localizations")).toBe("true");
    });

    it("sends no PUT when translations are unchanged", async () => {
      const tr = { nb: "hei" };
      (
        manager as unknown as { getEnabledCommands: unknown }
      ).getEnabledCommands = async () => [
        { name: "ping", description_localizations: tr },
      ];
      getSpy.mockResolvedValue([
        { ...registered[1], description_localizations: { nb: "hei" } },
      ]);
      await manager.registerCommands();
      expect(putSpy).not.toHaveBeenCalled();
    });

    it("sends a PUT when translations were removed on our side", async () => {
      (
        manager as unknown as { getEnabledCommands: unknown }
      ).getEnabledCommands = async () => [{ name: "ping", description: "" }];
      getSpy.mockResolvedValue([
        { ...registered[1], description_localizations: { nb: "hei" } },
      ]);
      await manager.registerCommands();
      expect(putSpy).toHaveBeenCalledTimes(1);
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

describe("serialised registration (#1307)", () => {
  let manager: CommandManager;
  let putSpy: jest.SpiedFunction<typeof REST.prototype.put>;
  let getSpy: jest.SpiedFunction<typeof REST.prototype.get>;

  beforeEach(() => {
    jest.clearAllMocks();
    CommandManager.reset();
    PermissionsService.reset();
    resetSharedRest();
    manager = CommandManager.getInstance({ user: { id: "1" } } as never);
    const values: Record<string, string> = {
      GUILD_ID: "guild-1",
      CLIENT_ID: "client-1",
      DISCORD_TOKEN: "t",
    };
    (manager as unknown as { configService: unknown }).configService = {
      getString: async (key: string) => values[key] ?? "",
      getBoolean: async () => false,
    };
  });

  afterEach(() => {
    putSpy.mockRestore();
    getSpy.mockRestore();
  });

  const cmd = (name: string): { name: string; description: string } => ({
    name,
    description: "",
  });

  it("the later of two overlapping registrations wins", async () => {
    // Discord holds list A. Run 1 wants B, run 2 wants A again.
    let discord: unknown[] = [cmd("a")];
    const desired = [[cmd("b")], [cmd("a")]];
    let loads = 0;
    (manager as unknown as { getEnabledCommands: unknown }).getEnabledCommands =
      async () => desired[loads++];

    const releasePut: Array<() => void> = [];
    getSpy = jest.spyOn(REST.prototype, "get").mockImplementation(async () => {
      const snapshot = discord;
      // Let the other registration interleave between GET and PUT.
      await new Promise((r) => setTimeout(r, 0));
      return snapshot;
    });
    const puts: unknown[][] = [];
    putSpy = jest
      .spyOn(REST.prototype, "put")
      .mockImplementation(async (_route, options) => {
        const body = (options as { body: unknown[] }).body;
        puts.push(body);
        await new Promise<void>((r) => releasePut.push(r));
        discord = body;
        return body;
      });

    const first = manager.registerCommands();
    const second = manager.registerCommands();
    // Release every PUT as soon as it is issued.
    const pump = setInterval(() => releasePut.splice(0).forEach((r) => r()), 1);
    try {
      await Promise.all([first, second]);
    } finally {
      clearInterval(pump);
    }

    expect(discord).toEqual([cmd("a")]);
    expect(puts.at(-1)).toEqual([cmd("a")]);
  });

  it("a failed run does not block the next one", async () => {
    let loads = 0;
    (manager as unknown as { getEnabledCommands: unknown }).getEnabledCommands =
      async () => {
        if (loads++ === 0) throw new Error("load failed");
        return [cmd("a")];
      };
    getSpy = jest.spyOn(REST.prototype, "get").mockResolvedValue([]);
    putSpy = jest.spyOn(REST.prototype, "put").mockResolvedValue([]);

    const first = manager.registerCommands();
    const second = manager.registerCommands();
    await expect(first).rejects.toThrow("load failed");
    await expect(second).resolves.toBeUndefined();
    expect(putSpy).toHaveBeenCalledTimes(1);
  });
});
