import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
} from "discord.js";

/**
 * The PRODUCTION logging path of the voice-room link (#1421): the sync's
 * default API caller goes through the real CommandManager.makeDiscordApiCall,
 * which used to log every non-timeout rejection with logger.error. A persistent
 * rejection must now log once per event and room (a warn), never an error each
 * minute scan. Only the CommandManager singleton lookup is replaced; the real
 * wrapper method runs.
 */

const config = {
  getBoolean: jest.fn<(k: string, d?: boolean) => Promise<boolean>>(),
  getString: jest.fn<(k: string, d?: string) => Promise<string>>(),
};
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: jest.fn(() => config) },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    exists: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

const logger = (await import("../../src/utils/logger.js"))
  .default as unknown as {
  warn: jest.Mock;
  error: jest.Mock;
};
const { CommandManager } =
  await import("../../src/services/command-manager.js");
const { NativeEventSync, buildNativeFields } =
  await import("../../src/services/event-native-sync.js");

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

function makeEvent() {
  return {
    _id: "ev1",
    guildId: "g1",
    title: "Game night",
    description: "Bring snacks",
    startTime: FUTURE,
    durationMinutes: 120,
    state: "scheduled",
    nativeEventId: "n1",
    nativeDetached: false,
    channelId: "room1",
  } as never;
}

function makeGuild(patch: jest.Mock<(...a: unknown[]) => Promise<unknown>>) {
  const want = buildNativeFields(makeEvent() as never, "Somewhere");
  const native = {
    id: "n1",
    creatorId: "bot1",
    name: want.name,
    description: want.description,
    scheduledStartTimestamp: want.start.getTime(),
    scheduledEndTimestamp: want.end.getTime(),
    entityType: GuildScheduledEventEntityType.External,
    entityMetadata: { location: "Somewhere" },
    channelId: null,
    status: GuildScheduledEventStatus.Scheduled,
  };
  return {
    id: "g1",
    client: { rest: { patch } },
    members: {
      me: {
        permissions: {
          has: (p: bigint) => p === PermissionFlagsBits.CreateEvents,
        },
      },
    },
    channels: { cache: new Map([["room1", {}]]), fetch: jest.fn() },
    scheduledEvents: {
      fetch: jest.fn(async () => native),
      edit: jest.fn(async () => ({})),
    },
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  config.getBoolean.mockResolvedValue(true);
  config.getString.mockResolvedValue("Somewhere");
});

describe("link rejection, production API wrapper", () => {
  it("logs once per event and room, never as an error, across scans", async () => {
    const real = CommandManager.prototype.makeDiscordApiCall;
    jest.spyOn(CommandManager, "getInstance").mockReturnValue({
      makeDiscordApiCall: real,
    } as never);
    const patch = jest
      .fn<(...a: unknown[]) => Promise<unknown>>()
      .mockRejectedValue(new Error("Missing Permissions"));
    const guild = makeGuild(patch);
    const sync = new NativeEventSync({ user: { id: "bot1" } } as never);
    const event = makeEvent();

    for (let i = 0; i < 3; i++) {
      await expect(sync.syncEvent(event, guild)).resolves.toBeUndefined();
    }

    expect(patch).toHaveBeenCalledTimes(3);
    expect(logger.error).not.toHaveBeenCalled();
    expect(
      logger.warn.mock.calls.filter((c) => String(c[0]).includes("link")),
    ).toHaveLength(1);
  });

  it("other callers of makeDiscordApiCall still log errors", async () => {
    await expect(
      CommandManager.prototype.makeDiscordApiCall.call(
        {},
        async () => {
          throw new Error("boom");
        },
        "other op",
      ),
    ).rejects.toThrow("boom");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
