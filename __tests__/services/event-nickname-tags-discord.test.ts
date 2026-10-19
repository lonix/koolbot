import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Routes } from "discord.js";

/**
 * How the clan tags talk to Discord (#1194, review of #1228): the nickname
 * PATCH goes through the cancellable write client (no automatic retries; the
 * request is aborted when it times out), so a timed-out edit is not left
 * running behind a released lock. The decisions are in
 * event-nickname-tags.test.ts.
 */

jest.unstable_mockModule("../../src/models/event.js", () => ({ Event: {} }));
jest.unstable_mockModule("../../src/models/event-nickname-backup.js", () => ({
  EventNicknameBackup: {},
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({}) },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({ TrackingOptOutService: { getInstance: () => ({}) } }),
);
jest.unstable_mockModule(
  "../../src/services/event-group-assignment.js",
  () => ({
    onGroupAssignmentChange: () => () => undefined,
  }),
);

const patch = jest.fn<(route: string, options: unknown) => Promise<unknown>>();
const createFailFastRest = jest.fn((...args: [string]) => ({
  patch,
  token: args[0],
}));
const cancellableCall = jest.fn(
  async (
    ...args: [
      unknown,
      (signal: AbortSignal) => Promise<unknown>,
      string,
      boolean,
      number,
    ]
  ) => args[1](new AbortController().signal),
);
jest.unstable_mockModule("../../src/web/channel-write-rest.js", () => ({
  createFailFastRest,
  cancellableCall,
}));
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: { getInstance: () => ({ makeDiscordApiCall: jest.fn() }) },
}));

const { createClientDiscord } =
  await import("../../src/services/event-nickname-tags.js");

beforeEach(() => {
  patch.mockReset();
  createFailFastRest.mockClear();
  cancellableCall.mockClear();
});

describe("setNickname", () => {
  const client = {
    token: "t0ken",
    guilds: { cache: new Map() },
  } as never;

  it("is one PATCH through the cancellable write client, never retried on a timeout", async () => {
    patch.mockResolvedValue({ nick: "[RED]  Alice" });
    const discord = createClientDiscord(client);

    const shown = await discord.setNickname("g1", "u1", "[RED] Alice");

    expect(shown).toBe("[RED]  Alice");
    expect(createFailFastRest).toHaveBeenCalledWith("t0ken");
    const [route, options] = patch.mock.calls[0] as [
      string,
      { body: { nick: string }; reason: string; signal: AbortSignal },
    ];
    expect(route).toBe(Routes.guildMember("g1", "u1"));
    expect(options.body).toEqual({ nick: "[RED] Alice" });
    expect(options.reason).toBe("KoolBot event tag");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // retryOnTimeout is false: a second request must not start behind the first.
    expect(cancellableCall.mock.calls[0]?.[3]).toBe(false);
    // ...and makes ONE attempt: makeDiscordApiCall's rate-limit retries ignore the flag above.
    expect(cancellableCall.mock.calls[0]?.[4]).toBe(1);
  });

  it("clears the nickname with null (the restore of 'no nickname')", async () => {
    patch.mockResolvedValue({ nick: null });
    const discord = createClientDiscord(client);
    expect(await discord.setNickname("g1", "u1", null)).toBeNull();
    expect((patch.mock.calls[0]?.[1] as { body: { nick: null } }).body).toEqual(
      { nick: null },
    );
  });

  it("lets a failure through so the row stays", async () => {
    patch.mockRejectedValue(new Error("Discord API timeout"));
    const discord = createClientDiscord(client);
    await expect(discord.setNickname("g1", "u1", "x")).rejects.toThrow(
      /timeout/,
    );
  });
});

describe("fetchMember", () => {
  it("is ONE attempt: the read has no retry budget of its own that could use up the settle window", async () => {
    const makeDiscordApiCall = jest.fn(
      async (...args: [() => Promise<unknown>, string, number, number]) =>
        args[0](),
    );
    const calls: Array<[string, number]> = [];
    const member = {
      id: "u1",
      nickname: "Alice",
      displayName: "Alice",
      manageable: true,
    };
    const guild = {
      ownerId: "owner",
      members: {
        me: { permissions: { has: () => true } },
        fetch: async () => member,
      },
    };
    const client = {
      token: "t",
      guilds: { cache: new Map([["g1", guild]]) },
    } as never;
    // The mocked CommandManager of this file records what it is asked for.
    const { CommandManager } =
      await import("../../src/services/command-manager.js");
    (CommandManager as unknown as { getInstance: () => unknown }).getInstance =
      () => ({
        makeDiscordApiCall: async (
          fn: () => Promise<unknown>,
          name: string,
          _timeout: number,
          attempts: number,
        ) => {
          calls.push([name, attempts]);
          return makeDiscordApiCall(fn, name, _timeout, attempts);
        },
      });
    const discord = createClientDiscord(client);
    const view = await discord.fetchMember("g1", "u1");
    expect(view).toMatchObject({ nickname: "Alice" });
    expect(calls.find(([n]) => n === "fetch member for tags")?.[1]).toBe(1);
  });
});
