import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { DiscordAPIError, RateLimitError } from "discord.js";

/**
 * `EventGroupChannels.removeGroup` (#1242): the channel of a removed group is
 * deleted and the group's record goes with it in one step under the per-event
 * channel lock. Driven with a fake Discord REST client and the in-memory Event
 * stand-in (which throws on a filter or update shape it does not know); the real
 * `$pull` shape is proven against MongoDB in
 * `__tests__/integration/event-live-edit-group-set.integration.test.ts`.
 */

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

const { EventGroupChannels } =
  await import("../../src/services/event-group-channels.js");
const { getRenameQueue } =
  await import("../../src/services/event-rename-queue.js");

const GUILD = "111111111111111111";
const EV = "65a000000000000000000001";
const BOT = "999999999999999999";
const A = "g_00000001";
const B = "g_00000002";
const A_CH = "200000000000000001";
const B_CH = "200000000000000002";
const MAIN = "200000000000000009";

function apiError(code: number, status = 400): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "x" },
    code,
    status,
    "DELETE",
    "/",
    {},
  );
}

function seed(over: Json = {}): void {
  store.set(EV, {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    channelId: MAIN,
    groups: [
      {
        key: A,
        name: "Alpha",
        kind: "team",
        size: null,
        tag: "",
        marker: "",
        channelId: A_CH,
        captainId: null,
        memberIds: [],
      },
      {
        key: B,
        name: "Bravo",
        kind: "leads",
        size: null,
        tag: "",
        marker: "",
        channelId: B_CH,
        captainId: null,
        memberIds: [],
      },
    ],
    ...over,
  });
}
const groupKeys = (): string[] =>
  (store.get(EV)?.groups as Json[]).map((g) => g.key as string);

function makeEnv(
  opts: {
    eventsEnabled?: boolean | (() => Promise<boolean>);
    members?: Record<string, string[]>;
    channelType?: number;
  } = {},
) {
  const members = new Map<string, Set<string>>(
    Object.entries(opts.members ?? {}).map(([c, ids]) => [c, new Set(ids)]),
  );
  const gone = new Set<string>();
  const calls: string[] = [];
  const failures: { delete?: unknown; fetch?: unknown } = {};
  /** Runs right before a REST request is made (an interleaving). */
  const hooks: { beforeCall: (() => void) | null } = { beforeCall: null };
  const voice = (id: string) => ({
    id,
    guildId: GUILD,
    type: opts.channelType ?? 2,
    get members() {
      return new Map([...(members.get(id) ?? [])].map((u) => [u, { id: u }]));
    },
  });
  const cache = new Map<string, unknown>(
    [A_CH, B_CH].map((id) => [id, voice(id)]),
  );
  const rest = {
    delete: jest.fn(async (route: string) => {
      calls.push(`delete ${route}`);
      if (failures.delete) throw failures.delete;
      const id = /channels\/(\d+)$/.exec(route)?.[1] ?? "";
      if (gone.has(id)) throw apiError(10003, 404);
      gone.add(id);
      cache.delete(id);
      return {};
    }),
  };
  const guild = {
    id: GUILD,
    channels: {
      cache,
      fetch: jest.fn(async (id: string) => {
        calls.push(`fetch ${id}`);
        if (failures.fetch) throw failures.fetch;
        if (gone.has(id)) throw apiError(10003, 404);
        return voice(id);
      }),
    },
  };
  const enabled = opts.eventsEnabled ?? true;
  const channels = new EventGroupChannels(
    { user: { id: BOT }, token: "t" } as never,
    {
      getPrefix: async () => "📅",
      getGraceMs: async () => 0,
      isEnabled: typeof enabled === "function" ? enabled : async () => enabled,
    },
    {
      rest: rest as never,
      call: ((fn: (s: AbortSignal) => Promise<unknown>) => {
        hooks.beforeCall?.();
        return fn(new AbortController().signal);
      }) as never,
      paceMs: 0,
    },
  );
  return {
    channels,
    guild: guild as never,
    rest,
    members,
    gone,
    calls,
    failures,
    cache,
    hooks,
  };
}

beforeEach(() => {
  store.clear();
  writes.length = 0;
  fake.beforeWrite = null;
  fake.failReads = false;
  fake.afterFind = null;
  getRenameQueue().forget(A_CH);
  getRenameQueue().forget(B_CH);
  seed();
});

describe("removeGroup deletes the channel and the record together", () => {
  it("deletes the channel on the fail-fast client, then pulls the group under the id it was deleted under", async () => {
    const env = makeEnv();
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out).toEqual({ status: "removed" });
    expect(env.rest.delete).toHaveBeenCalledTimes(1);
    expect(env.rest.delete.mock.calls[0][0]).toBe(`/channels/${A_CH}`);
    expect(groupKeys()).toEqual([B]);
    // The other group, its channel and the event's other fields are untouched.
    expect(writes).toHaveLength(1);
    expect(writes[0].filter).toMatchObject({
      _id: EV,
      state: { $in: ["scheduled", "active"] },
      groups: { $elemMatch: { key: A, channelId: A_CH } },
    });
    expect(writes[0].update).toEqual({
      $pull: { groups: { key: A, channelId: A_CH } },
    });
  });

  it("reads the channel from Discord first, and the delete comes after that read", async () => {
    const env = makeEnv();
    await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(env.calls[0]).toBe(`fetch ${A_CH}`);
    expect(env.calls[1]).toBe(`delete /channels/${A_CH}`);
  });

  it("keeps the channel and the record while somebody is connected", async () => {
    const env = makeEnv({ members: { [A_CH]: ["u1", "u2"] } });
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out).toEqual({ status: "occupied", remaining: 2 });
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(groupKeys()).toEqual([A, B]);
    expect(writes).toEqual([]);
  });

  it("does not count people just moved out whom the cache still shows, but counts anybody else", async () => {
    const env = makeEnv({ members: { [A_CH]: ["moved", "stays"] } });
    const kept = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
      ignore: new Set(["moved"]),
    });
    expect(kept).toEqual({ status: "occupied", remaining: 1 });
    env.members.get(A_CH)?.delete("stays");
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
      ignore: new Set(["moved"]),
    });
    expect(out).toEqual({ status: "removed" });
  });

  it("somebody who joins between the read and the request keeps it (checked in the same tick as the request)", async () => {
    const env = makeEnv();
    // The read sees nobody; a member joins before the request is sent.
    env.hooks.beforeCall = (): void => {
      env.members.set(A_CH, new Set(["late"]));
    };
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out).toEqual({ status: "occupied", remaining: 1 });
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(groupKeys()).toEqual([A, B]);
  });

  it("an end or cancel holding the event stops it in the same tick as the request", async () => {
    const env = makeEnv();
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
      ending: () => true,
    });
    expect(out).toEqual({
      status: "failed",
      reason: "the event is being ended",
    });
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(groupKeys()).toEqual([A, B]);
  });

  it("a channel that is already gone (10003) counts as deleted and the record goes", async () => {
    const env = makeEnv();
    env.gone.add(A_CH);
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out).toEqual({ status: "removed" });
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(groupKeys()).toEqual([B]);
  });

  it("a delete answered 10003 counts as deleted too", async () => {
    const env = makeEnv();
    env.failures.delete = apiError(10003, 404);
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out).toEqual({ status: "removed" });
    expect(groupKeys()).toEqual([B]);
  });

  it("a refusal keeps the channel and the record, and says why", async () => {
    const env = makeEnv();
    env.failures.delete = apiError(50013, 403);
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out.status).toBe("failed");
    expect(groupKeys()).toEqual([A, B]);
    expect(writes).toEqual([]);
  });

  it("a rate limit is reported at once, never slept on, and nothing is removed", async () => {
    const env = makeEnv();
    env.failures.delete = new RateLimitError({
      timeToReset: 120_000,
      limit: 1,
      method: "DELETE",
      hash: "h",
      url: "u",
      route: "/channels/:id",
      majorParameter: A_CH,
      global: false,
      retryAfter: 120_000,
      sublimitTimeout: 0,
      scope: "user",
    } as never);
    const started = Date.now();
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.status).toBe("failed");
    expect(groupKeys()).toEqual([A, B]);
  });

  it("a channel that could not be read is not deleted and not forgotten", async () => {
    const env = makeEnv();
    env.failures.fetch = new Error("gateway down");
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out.status).toBe("failed");
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(groupKeys()).toEqual([A, B]);
  });

  it("a recorded id that is no longer a voice channel here is not ours to delete: only the record goes", async () => {
    const env = makeEnv({ channelType: 4 });
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out).toEqual({ status: "removed" });
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(groupKeys()).toEqual([B]);
  });

  it("a replacement channel recorded meanwhile is not orphaned: the record stays and the result is lost", async () => {
    const env = makeEnv();
    // The scan's pass saw the deleted channel and recorded a new one on the
    // group between the delete and the pull.
    fake.beforeWrite = (): void => {
      const g = (store.get(EV)?.groups as Json[]).find(
        (x) => x.key === A,
      ) as Json;
      g.channelId = "300000000000000001";
    };
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out).toEqual({ status: "lost" });
    expect(groupKeys()).toEqual([A, B]);
    const g = (store.get(EV)?.groups as Json[])[0];
    expect(g.channelId).toBe("300000000000000001");
  });

  it("nothing is done for a group whose channel id is not the one given, a missing group, or an event that is not open", async () => {
    const env = makeEnv();
    expect(
      await env.channels.removeGroup(EV, env.guild, {
        groupKey: A,
        channelId: B_CH,
      }),
    ).toEqual({ status: "lost" });
    expect(
      await env.channels.removeGroup(EV, env.guild, {
        groupKey: "g_deadbeef",
        channelId: A_CH,
      }),
    ).toEqual({ status: "lost" });
    seed({ state: "ended" });
    expect(
      await env.channels.removeGroup(EV, env.guild, {
        groupKey: A,
        channelId: A_CH,
      }),
    ).toEqual({ status: "lost" });
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("fails closed when events.enabled is off or unreadable", async () => {
    const off = makeEnv({ eventsEnabled: false });
    expect(
      await off.channels.removeGroup(EV, off.guild, {
        groupKey: A,
        channelId: A_CH,
      }),
    ).toEqual({ status: "lost" });
    const broken = makeEnv({
      eventsEnabled: async () => {
        throw new Error("config down");
      },
    });
    expect(
      await broken.channels.removeGroup(EV, broken.guild, {
        groupKey: A,
        channelId: A_CH,
      }),
    ).toEqual({ status: "lost" });
    expect(off.rest.delete).not.toHaveBeenCalled();
    expect(broken.rest.delete).not.toHaveBeenCalled();
    expect(groupKeys()).toEqual([A, B]);
  });

  it("an unreadable event is a failure, not a missing one", async () => {
    const env = makeEnv();
    fake.failReads = true;
    const out = await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(out.status).toBe("failed");
    expect(env.rest.delete).not.toHaveBeenCalled();
  });

  it("forgets the rename budget of the deleted channel", async () => {
    const env = makeEnv();
    getRenameQueue().reserve(A_CH);
    getRenameQueue().reserve(A_CH);
    expect(getRenameQueue().check(A_CH).ok).toBe(false);
    await env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    expect(getRenameQueue().check(A_CH).ok).toBe(true);
  });

  it("the pass of the scan (same channel lock) cannot run between the delete and the pull", async () => {
    const env = makeEnv();
    const order: string[] = [];
    fake.beforeWrite = async (): Promise<void> => {
      order.push("pull");
    };
    env.rest.delete.mockImplementationOnce(async (route: string) => {
      order.push("delete");
      const id = /channels\/(\d+)$/.exec(route)?.[1] ?? "";
      env.cache.delete(id);
      env.gone.add(id);
      return {};
    });
    // A scan pass that starts while the removal runs queues behind it.
    const removal = env.channels.removeGroup(EV, env.guild, {
      groupKey: A,
      channelId: A_CH,
    });
    const scan = env.channels
      .reconcile({ _id: EV }, env.guild)
      .then(() => order.push("scan"));
    await Promise.all([removal, scan]);
    expect(order.slice(0, 3)).toEqual(["delete", "pull", "scan"]);
    // The scan found the group already gone: no replacement channel.
    expect(groupKeys()).toEqual([B]);
  });
});
