import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { DiscordAPIError, RateLimitError } from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  store,
  writes,
  fake,
  EventMock,
  type Json,
} from "./event-live-edit-groups-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));

const { EventGroupChannels, UNCONFIRMED_RENAME_HOLD_MS } =
  await import("../../src/services/event-group-channels.js");
const { getRenameQueue } =
  await import("../../src/services/event-rename-queue.js");

/**
 * `syncUserLimits` (#1241): after the host changes a group's size, the stored
 * size is the truth and the channel's user limit follows, in the channel pass,
 * one attempt, never sleeping on a rate limit, never moving anybody. Same
 * discipline as `syncNames` (see `event-group-channels-customise.test.ts`).
 */

const GUILD = "111111111111111111";
const EV = "65a000000000000000000001";
const BOT = "999999999999999999";
const RED = "g_00000001";
const BLUE = "g_00000002";
const RED_CH = "200000000000000001";
const BLUE_CH = "200000000000000002";

function apiError(code: number, status = 400): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "x" },
    code,
    status,
    "PATCH",
    "/",
    {},
  );
}
function rateLimited(ms = 30_000): RateLimitError {
  return new RateLimitError({
    timeToReset: ms,
    limit: 2,
    method: "PATCH",
    hash: "h",
    url: "u",
    route: "/channels/:id",
    majorParameter: RED_CH,
    global: false,
    retryAfter: ms,
    sublimitTimeout: 0,
    scope: "user",
  } as never);
}

function seed(over: Json = {}): void {
  store.set(EV, {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    channelId: "main-1",
    groups: [
      {
        key: RED,
        name: "Red",
        kind: "team",
        size: 2,
        channelId: RED_CH,
        memberIds: ["u1", "u2", "u3"],
        sizeSyncPending: true,
      },
      {
        key: BLUE,
        name: "Blue",
        kind: "team",
        size: null,
        channelId: BLUE_CH,
        memberIds: [],
      },
    ],
    ...over,
  });
}
const stored = (key = RED): Json =>
  (store.get(EV)?.groups as Json[]).find((g) => g.key === key) as Json;

function makeEnv(
  opts: { eventsEnabled?: boolean | (() => Promise<boolean>) } = {},
) {
  const limits = new Map<string, number>([
    [RED_CH, 0],
    [BLUE_CH, 0],
  ]);
  const gone = new Set<string>();
  const calls: Array<{ route: string; body: Json }> = [];
  const fail: { patch?: unknown; fetch?: unknown } = {};
  const rest = {
    patch: jest.fn(async (route: string, o: { body: Json }) => {
      calls.push({ route, body: o.body });
      if (fail.patch) throw fail.patch;
      limits.set(
        /channels\/(\d+)/.exec(route)?.[1] ?? "",
        o.body.user_limit as number,
      );
      return {};
    }),
  };
  const guild = {
    id: GUILD,
    channels: {
      cache: new Map(),
      fetch: jest.fn(async (id: string) => {
        if (fail.fetch) throw fail.fetch;
        if (gone.has(id)) throw apiError(10003, 404);
        return {
          id,
          name: "x",
          guildId: GUILD,
          type: 2,
          userLimit: limits.get(id),
        };
      }),
    },
  };
  const enabled = opts.eventsEnabled ?? true;
  const channels = new EventGroupChannels(
    { user: { id: BOT }, token: "t" } as never,
    {
      getPrefix: async () => "",
      getGraceMs: async () => 0,
      isEnabled: typeof enabled === "function" ? enabled : async () => enabled,
    },
    {
      rest: rest as never,
      call: ((fn: (s: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal)) as never,
      paceMs: 0,
    },
  );
  return { channels, guild: guild as never, rest, calls, limits, gone, fail };
}

beforeEach(() => {
  store.clear();
  writes.length = 0;
  fake.beforeWrite = null;
  fake.failReads = false;
  getRenameQueue().forget(RED_CH);
  seed();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("syncUserLimits: the stored size is the truth, the channel follows (#1241)", () => {
  it("sets the user limit to the stored size, with only user_limit in the body, and clears the marker", async () => {
    const env = makeEnv();
    const out = await env.channels.syncUserLimits(EV, env.guild);
    expect(out).toEqual([{ groupKey: RED, status: "applied" }]);
    expect(env.calls).toEqual([
      { route: `/channels/${RED_CH}`, body: { user_limit: 2 } },
    ]);
    expect(env.limits.get(RED_CH)).toBe(2);
    expect(stored().sizeSyncPending).toBe(false);
    // The other group was not pending and was not touched.
    expect(env.limits.get(BLUE_CH)).toBe(0);
  });

  it("no size means no limit (0)", async () => {
    stored().size = null;
    const env = makeEnv();
    env.limits.set(RED_CH, 5);
    await env.channels.syncUserLimits(EV, env.guild);
    expect(env.calls[0].body).toEqual({ user_limit: 0 });
  });

  it("never spends the rename budget (it is not a rename)", async () => {
    const env = makeEnv();
    await env.channels.syncUserLimits(EV, env.guild);
    expect(getRenameQueue().check(RED_CH).ok).toBe(true);
    getRenameQueue().reserve(RED_CH);
    getRenameQueue().reserve(RED_CH);
    stored().sizeSyncPending = true;
    stored().size = 7;
    const again = await env.channels.syncUserLimits(EV, env.guild);
    expect(again[0].status).toBe("applied");
  });

  it("a channel that already carries the limit is settled without a write", async () => {
    const env = makeEnv();
    env.limits.set(RED_CH, 2);
    const out = await env.channels.syncUserLimits(EV, env.guild);
    expect(out[0].status).toBe("applied");
    expect(env.rest.patch).not.toHaveBeenCalled();
    expect(stored().sizeSyncPending).toBe(false);
  });

  it("moves nobody: no member list is touched and nothing but the marker is written", async () => {
    const env = makeEnv();
    await env.channels.syncUserLimits(EV, env.guild);
    expect(stored().memberIds).toEqual(["u1", "u2", "u3"]);
    expect(writes.map((w) => w.update)).toEqual([
      { $set: { "groups.$[g].sizeSyncPending": false } },
    ]);
  });

  it("does nothing for groups that are not pending, for events that are not open, and without a channel", async () => {
    const env = makeEnv();
    delete stored().sizeSyncPending;
    expect(await env.channels.syncUserLimits(EV, env.guild)).toEqual([]);
    seed({ state: "ended" });
    expect(await env.channels.syncUserLimits(EV, env.guild)).toEqual([]);
    seed();
    stored().channelId = null;
    expect(await env.channels.syncUserLimits(EV, env.guild)).toEqual([]);
    expect(env.rest.patch).not.toHaveBeenCalled();
  });

  it("fails closed when events.enabled is off or unreadable", async () => {
    const off = makeEnv({ eventsEnabled: false });
    expect(await off.channels.syncUserLimits(EV, off.guild)).toEqual([]);
    const unreadable = makeEnv({
      eventsEnabled: async () => {
        throw new Error("config down");
      },
    });
    expect(
      await unreadable.channels.syncUserLimits(EV, unreadable.guild),
    ).toEqual([]);
    expect(off.rest.patch).not.toHaveBeenCalled();
    expect(unreadable.rest.patch).not.toHaveBeenCalled();
    expect(stored().sizeSyncPending).toBe(true);
  });

  it("reports an unreadable event instead of pretending", async () => {
    const env = makeEnv();
    fake.failReads = true;
    const out = await env.channels.syncUserLimits(EV, env.guild, RED);
    expect(out[0].status).toBe("failed");
    expect(env.rest.patch).not.toHaveBeenCalled();
  });

  it("only the asked group is finished when a key is given", async () => {
    const env = makeEnv();
    stored(BLUE).sizeSyncPending = true;
    stored(BLUE).size = 4;
    const out = await env.channels.syncUserLimits(EV, env.guild, BLUE);
    expect(out.map((o) => o.groupKey)).toEqual([BLUE]);
    expect(stored().sizeSyncPending).toBe(true);
    expect(stored(BLUE).sizeSyncPending).toBe(false);
  });

  it("a channel that is gone is skipped (the channel pass re-creates it with the stored size); an unreadable one is a failure", async () => {
    const env = makeEnv();
    env.gone.add(RED_CH);
    expect((await env.channels.syncUserLimits(EV, env.guild))[0].status).toBe(
      "skipped",
    );
    env.gone.clear();
    env.fail.fetch = new Error("network");
    expect((await env.channels.syncUserLimits(EV, env.guild))[0].status).toBe(
      "failed",
    );
    expect(env.rest.patch).not.toHaveBeenCalled();
    expect(stored().sizeSyncPending).toBe(true);
  });

  it("goes out once, with no retry, on the one-attempt path", async () => {
    const seen: boolean[] = [];
    const env = makeEnv();
    const channels = new EventGroupChannels(
      { user: { id: BOT }, token: "t" } as never,
      { getPrefix: async () => "", getGraceMs: async () => 0 },
      {
        rest: env.rest as never,
        call: ((
          fn: (s: AbortSignal) => Promise<unknown>,
          _n: string,
          retry: boolean,
        ) => {
          seen.push(retry);
          return fn(new AbortController().signal);
        }) as never,
        paceMs: 0,
      },
    );
    await channels.syncUserLimits(EV, env.guild);
    expect(seen).toEqual([false]);
  });

  it("the marker is cleared only for the size that was set (a newer size keeps it pending)", async () => {
    const env = makeEnv();
    env.rest.patch.mockImplementationOnce(async () => {
      // The host changes the size while the request is in flight.
      stored().size = 9;
      return {};
    });
    await env.channels.syncUserLimits(EV, env.guild);
    expect(stored()).toMatchObject({ size: 9, sizeSyncPending: true });
  });

  describe("failures are reported and finished by a later pass", () => {
    it("a 429 is limited with Discord's time, not slept on, and the marker stays", async () => {
      const env = makeEnv();
      env.fail.patch = rateLimited(30_000);
      const out = await env.channels.syncUserLimits(EV, env.guild);
      expect(out[0]).toMatchObject({ status: "limited", retryAfterMs: 30_000 });
      expect(stored().sizeSyncPending).toBe(true);
    });

    it("a refusal (missing permission) is held back and reported, not hammered", async () => {
      const env = makeEnv();
      env.fail.patch = apiError(50013, 403);
      const out = await env.channels.syncUserLimits(EV, env.guild);
      expect(out[0].status).toBe("failed");
      expect(out[0].reason).toContain("Discord refused");
      expect(stored().sizeSyncPending).toBe(true);
      const again = await env.channels.syncUserLimits(EV, env.guild);
      expect(again[0].status).toBe("failed");
      expect(env.rest.patch).toHaveBeenCalledTimes(1);
      expect(env.channels.sizesNeedAttention(store.get(EV) as never)).toBe(
        false,
      );
    });

    it("an unknown outcome is settled by reading the channel on the next pass", async () => {
      const env = makeEnv();
      env.fail.patch = new Error("Discord API timeout after 30000ms");
      const out = await env.channels.syncUserLimits(EV, env.guild);
      expect(out[0].status).toBe("unconfirmed");
      expect(stored().sizeSyncPending).toBe(true);
      env.limits.set(RED_CH, 2);
      const now = Date.now();
      jest
        .spyOn(Date, "now")
        .mockReturnValue(now + UNCONFIRMED_RENAME_HOLD_MS + 1);
      const again = await env.channels.syncUserLimits(EV, env.guild);
      expect(again[0].status).toBe("applied");
      expect(env.rest.patch).toHaveBeenCalledTimes(1);
      expect(stored().sizeSyncPending).toBe(false);
    });
  });

  it("sizesNeedAttention: pending only, open events only, with a channel", () => {
    const env = makeEnv();
    const doc = store.get(EV) as never as {
      _id: string;
      state: string;
      groupsEnabled: boolean;
      groups: Array<Record<string, unknown>>;
    };
    expect(env.channels.sizesNeedAttention(doc as never)).toBe(true);
    expect(
      env.channels.sizesNeedAttention({ ...doc, state: "ended" } as never),
    ).toBe(false);
    expect(
      env.channels.sizesNeedAttention({
        ...doc,
        groupsEnabled: false,
      } as never),
    ).toBe(false);
    expect(
      env.channels.sizesNeedAttention({
        ...doc,
        groups: [{ ...doc.groups[0], channelId: null }],
      } as never),
    ).toBe(false);
    expect(
      env.channels.sizesNeedAttention({
        ...doc,
        groups: [{ ...doc.groups[0], sizeSyncPending: false }],
      } as never),
    ).toBe(false);
  });
});
