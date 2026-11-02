/**
 * The Setup wizard's Administrator check (#1617): a read-only answer that is
 * "unknown" whenever Discord cannot be read, never a guess.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { PermissionFlagsBits, type Client } from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: (): boolean => false,
}));
jest.unstable_mockModule("../../src/services/bot-permission-check.js", () => ({
  defaultCall: async <T>(_c: unknown, fn: () => Promise<T>): Promise<T> => fn(),
}));

const { checkBotAdministrator, administratorInviteUrl } =
  await import("../../src/services/wizard-admin-check.js");

const ADMIN: bigint = PermissionFlagsBits.Administrator;
const member = (bits: bigint, roles = 2): unknown => ({
  permissions: { has: (b: bigint): boolean => (bits & b) === b },
  roles: { cache: { size: roles } },
});

function clientWith(opts: {
  cached?: unknown;
  me?: unknown;
  fetchMe?: () => Promise<unknown>;
  fetchGuild?: () => Promise<unknown>;
}): Client {
  const guild = {
    roles: { fetch: async (): Promise<unknown> => [] },
    members: { me: opts.me ?? null, fetchMe: opts.fetchMe ?? jest.fn() },
  };
  return {
    guilds: {
      cache: {
        get: (): unknown => (opts.cached === false ? undefined : guild),
      },
      fetch: opts.fetchGuild ?? (async (): Promise<unknown> => guild),
    },
  } as unknown as Client;
}

describe("checkBotAdministrator", () => {
  it("has: the bot's member holds Administrator (any role it carries)", async () => {
    const c = clientWith({ me: member(ADMIN) });
    expect(await checkBotAdministrator(c, "g")).toEqual({ state: "has" });
  });

  it("missing: it does not", async () => {
    const c = clientWith({ me: member(0x400n) });
    expect(await checkBotAdministrator(c, "g")).toEqual({ state: "missing" });
  });

  it("does not call Discord for the first view, and reads once on refresh", async () => {
    const fetchMe = jest.fn(async () => member(0n));
    const c = clientWith({ me: member(ADMIN), fetchMe });
    await checkBotAdministrator(c, "g");
    expect(fetchMe).not.toHaveBeenCalled();
    expect(await checkBotAdministrator(c, "g", { refresh: true })).toEqual({
      state: "missing",
    });
    expect(fetchMe).toHaveBeenCalledTimes(1);
  });

  it("unknown, not a guess, when the refresh fails even though the cache has an answer", async () => {
    const c = clientWith({
      me: member(ADMIN),
      fetchMe: async () => {
        throw new Error("down");
      },
    });
    expect(
      await checkBotAdministrator(c, "g", { refresh: true }),
    ).toMatchObject({ state: "unknown" });
  });

  it("reads the member when the cache has none", async () => {
    const c = clientWith({ me: null, fetchMe: async () => member(ADMIN) });
    expect(await checkBotAdministrator(c, "g")).toEqual({ state: "has" });
  });

  it.each([
    ["no roles in view", clientWith({ me: member(0n, 0) })],
    [
      "no members manager",
      { guilds: { cache: { get: () => ({}) } } } as unknown as Client,
    ],
    [
      "the server cannot be fetched",
      clientWith({
        cached: false,
        fetchGuild: async () => {
          throw new Error("down");
        },
      }),
    ],
  ])("unknown when %s", async (_name, c) => {
    expect(await checkBotAdministrator(c, "g")).toMatchObject({
      state: "unknown",
    });
  });
});

describe("administratorInviteUrl", () => {
  it("asks for Administrator and both scopes", () => {
    const c = { application: { id: "123" } } as unknown as Client;
    expect(administratorInviteUrl(c)).toBe(
      "https://discord.com/oauth2/authorize?client_id=123&permissions=8&scope=bot%20applications.commands",
    );
  });

  it("falls back to the user id and gives nothing for a missing or odd id", () => {
    expect(
      administratorInviteUrl({ user: { id: "456" } } as unknown as Client),
    ).toContain("client_id=456");
    expect(administratorInviteUrl({} as unknown as Client)).toBeNull();
    expect(
      administratorInviteUrl({ user: { id: "1&x=" } } as unknown as Client),
    ).toBeNull();
  });
});

describe("checkBotAdministrator reads the roles again on refresh", () => {
  /** A member whose permissions come from a role cache that is stale until the roles are fetched. */
  function staleRoles(opts: { rolesFetch: () => Promise<unknown> }): {
    client: Client;
    fetched: () => boolean;
  } {
    let fresh = false;
    const me = {
      permissions: {
        has: (bit: bigint): boolean => {
          if (!fresh) return false;
          return (ADMIN & bit) === bit;
        },
      },
      roles: { cache: { size: 2 } },
    };
    const guild = {
      roles: {
        fetch: async (): Promise<unknown> => {
          const out = await opts.rolesFetch();
          fresh = true;
          return out;
        },
      },
      members: { me, fetchMe: async (): Promise<unknown> => me },
    };
    return {
      client: {
        guilds: { cache: { get: (): unknown => guild } },
      } as unknown as Client,
      fetched: () => fresh,
    };
  }

  it("has: Check again after Administrator was switched on sees it once the roles are fetched", async () => {
    const { client, fetched } = staleRoles({ rolesFetch: async () => [] });
    expect(await checkBotAdministrator(client, "g", { refresh: true })).toEqual(
      {
        state: "has",
      },
    );
    expect(fetched()).toBe(true);
  });

  it("does not fetch the roles for the first view", async () => {
    const { client, fetched } = staleRoles({ rolesFetch: async () => [] });
    await checkBotAdministrator(client, "g");
    expect(fetched()).toBe(false);
  });

  it("unknown, not the stale answer, when the roles cannot be read", async () => {
    const { client } = staleRoles({
      rolesFetch: async () => {
        throw new Error("down");
      },
    });
    expect(
      await checkBotAdministrator(client, "g", { refresh: true }),
    ).toMatchObject({ state: "unknown" });
  });

  it("unknown when the guild has no roles manager to refresh", async () => {
    const c = {
      guilds: {
        cache: {
          get: (): unknown => ({
            members: { me: member(ADMIN), fetchMe: async () => member(ADMIN) },
          }),
        },
      },
    } as unknown as Client;
    expect(
      await checkBotAdministrator(c, "g", { refresh: true }),
    ).toMatchObject({
      state: "unknown",
    });
  });
});
