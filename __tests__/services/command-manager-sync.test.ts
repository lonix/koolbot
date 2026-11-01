import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { REST } from "discord.js";
import {
  CommandManager,
  COMMAND_SYNC_TTL_MS,
  COMMAND_SYNC_UNKNOWN_TTL_MS,
} from "../../src/services/command-manager.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import { resetSharedRest } from "../../src/utils/discord-rest.js";

jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/monitoring-service.js");
jest.mock("../../src/services/cooldown-manager.js");
jest.mock("../../src/services/permissions-service.js");

type Cmd = Record<string, unknown>;
const echo = (name: string, description = "d"): Cmd => ({
  id: "1",
  type: 1,
  name,
  description,
  name_localizations: null,
  description_localizations: null,
  default_member_permissions: null,
  dm_permission: true,
  nsfw: false,
});

describe("CommandManager.checkCommandSync (#1638)", () => {
  let manager: CommandManager;
  let getSpy: jest.SpiedFunction<typeof REST.prototype.get>;
  let putSpy: jest.SpiedFunction<typeof REST.prototype.put>;
  let postSpy: jest.SpiedFunction<typeof REST.prototype.post>;
  let patchSpy: jest.SpiedFunction<typeof REST.prototype.patch>;
  let deleteSpy: jest.SpiedFunction<typeof REST.prototype.delete>;
  let populate: jest.Mock;
  let desired: Cmd[];
  let values: Record<string, string>;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    jest.clearAllMocks();
    CommandManager.reset();
    PermissionsService.reset();
    resetSharedRest();
    getSpy = jest
      .spyOn(REST.prototype, "get")
      .mockResolvedValue([echo("ping"), echo("quote")]);
    putSpy = jest.spyOn(REST.prototype, "put").mockResolvedValue([]);
    postSpy = jest.spyOn(REST.prototype, "post").mockResolvedValue([]);
    patchSpy = jest.spyOn(REST.prototype, "patch").mockResolvedValue([]);
    deleteSpy = jest.spyOn(REST.prototype, "delete").mockResolvedValue([]);
    manager = CommandManager.getInstance({ user: { id: "1" } } as never);
    values = {
      GUILD_ID: "guild-1",
      CLIENT_ID: "client-1",
      DISCORD_TOKEN: "secret-token-value",
    };
    (manager as unknown as { configService: unknown }).configService = {
      getString: async (key: string) => values[key] ?? "",
      getBoolean: async () => false,
    };
    desired = [
      { name: "ping", description: "d" },
      { name: "quote", description: "d" },
    ];
    (manager as unknown as { getEnabledCommands: unknown }).getEnabledCommands =
      async () => desired;
    populate = jest.fn();
    (
      manager as unknown as { populateClientCommands: unknown }
    ).populateClientCommands = populate;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const expectNoWrite = (): void => {
    expect(putSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
    expect(patchSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(populate).not.toHaveBeenCalled();
  };

  it("is in sync when Discord has the desired list, and writes nothing", async () => {
    const report = await manager.checkCommandSync();
    expect(report.state).toBe("in-sync");
    expect(getSpy).toHaveBeenCalledTimes(1);
    expectNoWrite();
  });

  it("names a command to add", async () => {
    desired.push({ name: "poll", description: "d" });
    const report = await manager.checkCommandSync();
    expect(report).toMatchObject({
      state: "out-of-sync",
      added: ["poll"],
      removed: [],
      changed: [],
    });
    expectNoWrite();
  });

  it("names a command to remove", async () => {
    desired.pop();
    const report = await manager.checkCommandSync();
    expect(report).toMatchObject({
      state: "out-of-sync",
      added: [],
      removed: ["quote"],
      changed: [],
    });
    expectNoWrite();
  });

  it("names a changed command", async () => {
    desired[0] = { name: "ping", description: "new words" };
    const report = await manager.checkCommandSync();
    expect(report).toMatchObject({
      state: "out-of-sync",
      added: [],
      removed: [],
      changed: ["ping"],
    });
    expectNoWrite();
  });

  it("is unknown, never in sync, when the GET fails", async () => {
    getSpy.mockRejectedValue(
      new Error("DiscordAPIError[50001]: Missing Access"),
    );
    const report = await manager.checkCommandSync();
    expect(report).toMatchObject({
      state: "unknown",
      reason: "Discord did not answer",
    });
    expectNoWrite();
  });

  it("is unknown when Discord's list has an unexpected shape", async () => {
    getSpy.mockResolvedValue({ message: "not a list" });
    expect((await manager.checkCommandSync()).state).toBe("unknown");
    expectNoWrite();
  });

  it("is unknown when the lists differ but no command can be named", async () => {
    getSpy.mockResolvedValue([echo("ping"), echo("ping")]);
    desired = [
      { name: "ping", description: "d" },
      { name: "x", description: "d" },
    ];
    expect((await manager.checkCommandSync()).state).toBe("unknown");
  });

  it("is unknown when the desired list cannot be loaded", async () => {
    (manager as unknown as { getEnabledCommands: unknown }).getEnabledCommands =
      async () => {
        throw new Error("boom");
      };
    const report = await manager.checkCommandSync();
    expect(report.state).toBe("unknown");
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("is unknown, with a reason, when the application is not configured", async () => {
    values.CLIENT_ID = "";
    const report = await manager.checkCommandSync();
    expect(report).toMatchObject({ state: "unknown" });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("never rejects, even when reading config throws", async () => {
    (manager as unknown as { configService: unknown }).configService = {
      getString: async () => {
        throw new Error("db down");
      },
    };
    await expect(manager.checkCommandSync()).resolves.toMatchObject({
      state: "unknown",
    });
  });

  it("a slow GET stays pending without writing, and callers share one read", async () => {
    let finish: (v: unknown) => void = () => undefined;
    getSpy.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)) as never,
    );
    const a = manager.checkCommandSync();
    const b = manager.checkCommandSync();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expectNoWrite();
    finish([echo("ping"), echo("quote")]);
    expect((await a).state).toBe("in-sync");
    expect(await b).toBe(await a);
  });

  it("a GET that never answers becomes unknown at the API timeout", async () => {
    getSpy.mockImplementation(() => new Promise(() => undefined) as never);
    const pending = manager.checkCommandSync();
    await jest.advanceTimersByTimeAsync(15_001);
    expect(await pending).toMatchObject({ state: "unknown" });
    expectNoWrite();
  });

  it("caches a result for 60 seconds and then reads again", async () => {
    await manager.checkCommandSync();
    await manager.checkCommandSync();
    expect(getSpy).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + COMMAND_SYNC_TTL_MS + 1);
    await manager.checkCommandSync();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("retries an unknown result sooner than a known one", async () => {
    getSpy.mockRejectedValueOnce(new Error("x"));
    expect((await manager.checkCommandSync()).state).toBe("unknown");
    await manager.checkCommandSync();
    expect(getSpy).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + COMMAND_SYNC_UNKNOWN_TTL_MS + 1);
    expect((await manager.checkCommandSync()).state).toBe("in-sync");
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it("invalidateCommandSync makes the next check read Discord again", async () => {
    expect((await manager.checkCommandSync()).state).toBe("in-sync");
    desired.push({ name: "poll", description: "d" });
    expect((await manager.checkCommandSync()).state).toBe("in-sync");
    manager.invalidateCommandSync();
    expect((await manager.checkCommandSync()).state).toBe("out-of-sync");
    expect(getSpy).toHaveBeenCalledTimes(2);
    expectNoWrite();
  });

  it("a read that started before an invalidation cannot refill the cache", async () => {
    let finish: (v: unknown) => void = () => undefined;
    getSpy.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)) as never,
    );
    const stale = manager.checkCommandSync();
    await jest.advanceTimersByTimeAsync(0);
    manager.invalidateCommandSync();
    finish([echo("ping")]);
    expect((await stale).state).toBe("out-of-sync");
    // The stale result was not cached: this reads Discord again.
    expect((await manager.checkCommandSync()).state).toBe("in-sync");
    expect(getSpy).toHaveBeenCalledTimes(2);
  });
});
