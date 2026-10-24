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
  cstore,
  cupdates,
  cfake,
  CEventMock,
  type CDoc,
  type CGroup,
} from "./event-customise-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: CEventMock,
}));

const { EventGroupChannels, groupChannelName, UNCONFIRMED_RENAME_HOLD_MS } =
  await import("../../src/services/event-group-channels.js");
const { getRenameQueue } =
  await import("../../src/services/event-rename-queue.js");

const GUILD = "111111111111111111";
const EV = "65a000000000000000000001";
const BOT = "999999999999999999";
const RED = "g_00000001";
const BLUE = "g_00000002";
const RED_CH = "200000000000000001";
const BLUE_CH = "200000000000000002";
const LEADER = "100000000000000001";

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
function rateLimited(ms = 120_000): RateLimitError {
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

function group(key: string, over: Partial<CGroup> = {}): CGroup {
  const red = key === RED;
  return {
    key,
    name: red ? "Crimson" : "Blue",
    tag: "",
    kind: "team",
    channelId: red ? RED_CH : BLUE_CH,
    captainId: LEADER,
    memberIds: [LEADER],
    ...over,
  };
}
function seed(over: Partial<CDoc> = {}): CDoc {
  const doc: CDoc = {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    captainsEnabled: true,
    captainCustomisationEnabled: true,
    channelId: "main-1",
    groups: [group(RED, { nameSyncPending: true }), group(BLUE)],
    ...over,
  };
  cstore.set(EV, doc);
  return doc;
}
const stored = (key = RED): CGroup =>
  cstore.get(EV)!.groups.find((g) => g.key === key)!;

interface Msg {
  id: string;
  author: { id: string };
  components: Array<{ components: Array<{ custom_id: string }> }>;
}

function makeEnv(
  opts: { eventsEnabled?: boolean | (() => Promise<boolean>) } = {},
) {
  const channelNames = new Map<string, string>([
    [RED_CH, "📅 Red"],
    [BLUE_CH, "📅 Blue"],
  ]);
  const goneChannels = new Set<string>();
  const messages = new Map<string, Msg[]>(); // channel -> messages
  const calls: Array<{ op: string; route: string; body?: unknown }> = [];
  let nextMsg = 1;
  const fail: {
    patch?: unknown;
    post?: unknown;
    get?: unknown;
    delete?: unknown;
    channelFetch?: unknown;
  } = {};
  const routeChannel = (route: string): string =>
    /channels\/(\d+)/.exec(route)?.[1] ?? "";
  const rest = {
    patch: jest.fn(async (route: string, o: { body: { name: string } }) => {
      calls.push({ op: "patch", route, body: o.body });
      if (fail.patch) throw fail.patch;
      channelNames.set(routeChannel(route), o.body.name);
      return {};
    }),
    post: jest.fn(
      async (
        route: string,
        o: {
          body: { components: Msg["components"]; allowed_mentions: unknown };
        },
      ) => {
        calls.push({ op: "post", route, body: o.body });
        if (fail.post) {
          const f = fail.post;
          if ((f as { once?: boolean }).once) fail.post = undefined;
          throw (f as { err?: unknown }).err ?? f;
        }
        const ch = routeChannel(route);
        const m: Msg = {
          id: `30000000000000000${nextMsg++}`,
          author: { id: BOT },
          components: o.body.components,
        };
        messages.set(ch, [m, ...(messages.get(ch) ?? [])]);
        return { id: m.id };
      },
    ),
    get: jest.fn(
      async (route: string, o?: { query?: globalThis.URLSearchParams }) => {
        calls.push({ op: "get", route });
        if (fail.get) throw fail.get;
        const ch = routeChannel(route);
        const single = /messages\/(\d+)$/.exec(route);
        if (single) {
          const m = (messages.get(ch) ?? []).find((x) => x.id === single[1]);
          if (!m) throw apiError(10008, 404);
          return m;
        }
        // The channel history, newest first, honouring `before` and `limit`.
        const all = (messages.get(ch) ?? [])
          .slice()
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
        const before = o?.query?.get("before");
        const limit = Number(o?.query?.get("limit") ?? "50");
        return all
          .filter((m) => !before || BigInt(m.id) < BigInt(before))
          .slice(0, limit);
      },
    ),
    delete: jest.fn(async (route: string) => {
      calls.push({ op: "delete", route });
      if (fail.delete) throw fail.delete;
      const ch = routeChannel(route);
      const single = /messages\/(\d+)$/.exec(route);
      if (single) {
        const list = messages.get(ch) ?? [];
        if (!list.some((x) => x.id === single[1])) throw apiError(10008, 404);
        messages.set(
          ch,
          list.filter((x) => x.id !== single[1]),
        );
      }
      return {};
    }),
  };
  const guild = {
    id: GUILD,
    channels: {
      cache: new Map(),
      fetch: jest.fn(async (id: string) => {
        if (fail.channelFetch) throw fail.channelFetch;
        if (goneChannels.has(id)) throw apiError(10003, 404);
        return { id, name: channelNames.get(id), guildId: GUILD, type: 2 };
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
      call: ((fn: (s: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal)) as never,
      paceMs: 0,
    },
  );
  return {
    channels,
    guild: guild as never,
    rest,
    calls,
    channelNames,
    goneChannels,
    messages,
    fail,
  };
}

const customId = (key: string): string => `evcust:btn:${EV}:${key}`;

beforeEach(() => {
  cstore.clear();
  cupdates.length = 0;
  cfake.beforeNextUpdate = null;
  cfake.failFind = false;
  getRenameQueue().forget(RED_CH);
  getRenameQueue().forget(BLUE_CH);
  seed();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("syncNames: the stored name is the truth, the channel follows (#1196)", () => {
  it("renames the channel to the stored name and clears the flag after a confirmed rename", async () => {
    const env = makeEnv();
    const out = await env.channels.syncNames(EV, env.guild);
    expect(out).toEqual([{ groupKey: RED, status: "applied" }]);
    expect(env.rest.patch).toHaveBeenCalledTimes(1);
    expect(env.channelNames.get(RED_CH)).toBe(
      groupChannelName("📅", { name: "Crimson" }),
    );
    expect(stored().nameSyncPending).toBe(false);
    // The other group was not pending and was not touched.
    expect(stored(BLUE).nameSyncPending).toBeUndefined();
  });

  it("a channel that already carries the stored name is settled without spending the rename budget", async () => {
    const env = makeEnv();
    env.channelNames.set(RED_CH, "📅 Crimson");
    const out = await env.channels.syncNames(EV, env.guild);
    expect(out[0].status).toBe("applied");
    expect(env.rest.patch).not.toHaveBeenCalled();
    expect(stored().nameSyncPending).toBe(false);
    expect(getRenameQueue().check(RED_CH).ok).toBe(true);
    getRenameQueue().reserve(RED_CH);
    expect(getRenameQueue().check(RED_CH).ok).toBe(true); // still room for the second
  });

  it("does nothing for groups that are not pending and for events that are not open", async () => {
    const env = makeEnv();
    stored().nameSyncPending = false;
    expect(await env.channels.syncNames(EV, env.guild)).toEqual([]);
    seed({ state: "ended" });
    expect(await env.channels.syncNames(EV, env.guild)).toEqual([]);
    expect(env.rest.patch).not.toHaveBeenCalled();
  });

  it("fails closed when events.enabled is off or unreadable", async () => {
    const off = makeEnv({ eventsEnabled: false });
    expect(await off.channels.syncNames(EV, off.guild)).toEqual([]);
    const unreadable = makeEnv({
      eventsEnabled: async () => {
        throw new Error("config down");
      },
    });
    expect(await unreadable.channels.syncNames(EV, unreadable.guild)).toEqual(
      [],
    );
    expect(off.rest.patch).not.toHaveBeenCalled();
    expect(unreadable.rest.patch).not.toHaveBeenCalled();
    expect(stored().nameSyncPending).toBe(true);
  });

  it("reports an unreadable event instead of pretending", async () => {
    const env = makeEnv();
    cfake.failFind = true;
    const out = await env.channels.syncNames(EV, env.guild, RED);
    expect(out[0].status).toBe("failed");
    expect(env.rest.patch).not.toHaveBeenCalled();
  });

  it("only the asked group is finished when a key is given", async () => {
    const env = makeEnv();
    stored(BLUE).nameSyncPending = true;
    const out = await env.channels.syncNames(EV, env.guild, BLUE);
    expect(out.map((o) => o.groupKey)).toEqual([BLUE]);
    expect(stored().nameSyncPending).toBe(true);
    expect(stored(BLUE).nameSyncPending).toBe(false);
  });

  it("a channel that is gone is skipped (the channel pass re-creates it with the stored name)", async () => {
    const env = makeEnv();
    env.goneChannels.add(RED_CH);
    const out = await env.channels.syncNames(EV, env.guild);
    expect(out[0].status).toBe("skipped");
    expect(env.rest.patch).not.toHaveBeenCalled();
    expect(stored().nameSyncPending).toBe(true);
  });

  it("an unreadable channel is a failure, never a rename", async () => {
    const env = makeEnv();
    env.fail.channelFetch = new Error("network");
    const out = await env.channels.syncNames(EV, env.guild);
    expect(out[0].status).toBe("failed");
    expect(env.rest.patch).not.toHaveBeenCalled();
  });

  it("goes out once, with no retry, on the one-attempt path", async () => {
    const seen: boolean[] = [];
    const env = makeEnv();
    const channels = new EventGroupChannels(
      { user: { id: BOT }, token: "t" } as never,
      { getPrefix: async () => "📅", getGraceMs: async () => 0 },
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
    await channels.syncNames(EV, env.guild);
    expect(seen).toEqual([false]);
  });

  describe("rate limits are reported, never slept on", () => {
    it("Discord's budget is used up: limited with the time left, no request sent, flag kept", async () => {
      const env = makeEnv();
      getRenameQueue().reserve(RED_CH);
      getRenameQueue().reserve(RED_CH);
      const out = await env.channels.syncNames(EV, env.guild);
      expect(out[0].status).toBe("limited");
      expect(out[0].retryAfterMs).toBeGreaterThan(0);
      expect(env.rest.patch).not.toHaveBeenCalled();
      expect(stored().nameSyncPending).toBe(true);
    });

    it("a 429 from Discord is limited and blocks the channel", async () => {
      const env = makeEnv();
      env.fail.patch = rateLimited(120_000);
      const out = await env.channels.syncNames(EV, env.guild);
      expect(out[0]).toMatchObject({
        status: "limited",
        retryAfterMs: 120_000,
      });
      expect(stored().nameSyncPending).toBe(true);
      env.fail.patch = undefined;
      const again = await env.channels.syncNames(EV, env.guild);
      expect(again[0].status).toBe("limited");
      expect(env.rest.patch).toHaveBeenCalledTimes(1); // the second never went out
    });
  });

  describe("failures leave a visible, retried mismatch, never a silent one", () => {
    it("a refusal is held back and reported; the flag stays", async () => {
      const env = makeEnv();
      env.fail.patch = apiError(50013, 403);
      const out = await env.channels.syncNames(EV, env.guild);
      expect(out[0].status).toBe("failed");
      expect(out[0].reason).toContain("Discord refused");
      expect(stored().nameSyncPending).toBe(true);
      // The standing refusal is not hammered: the next pass waits for the hold.
      const again = await env.channels.syncNames(EV, env.guild);
      expect(again[0].status).toBe("failed");
      expect(env.rest.patch).toHaveBeenCalledTimes(1);
      expect(env.channels.namesNeedAttention(cstore.get(EV)!)).toBe(false);
    });

    it("an unknown outcome (timeout) is settled by reading the channel on the next pass", async () => {
      const env = makeEnv();
      env.fail.patch = new Error("Discord API timeout after 30000ms");
      const out = await env.channels.syncNames(EV, env.guild);
      expect(out[0].status).toBe("unconfirmed");
      expect(stored().nameSyncPending).toBe(true);
      // The rename did land at Discord after all.
      env.channelNames.set(RED_CH, "📅 Crimson");
      const now = Date.now();
      jest
        .spyOn(Date, "now")
        .mockReturnValue(now + UNCONFIRMED_RENAME_HOLD_MS + 1);
      const again = await env.channels.syncNames(EV, env.guild);
      expect(again[0].status).toBe("applied");
      expect(env.rest.patch).toHaveBeenCalledTimes(1); // settled by the read
      expect(stored().nameSyncPending).toBe(false);
    });
  });

  it("the flag is cleared only for the name that was renamed (a newer name keeps it pending)", async () => {
    const env = makeEnv();
    // While the rename request is in flight the leader chooses another name.
    env.rest.patch.mockImplementationOnce(
      async (route: string, o: { body: { name: string } }) => {
        env.channelNames.set(routeChannel(route), o.body.name);
        stored().name = "Scarlet";
        return {};
      },
    );
    function routeChannel(route: string): string {
      return /channels\/(\d+)/.exec(route)?.[1] ?? "";
    }
    const out = await env.channels.syncNames(EV, env.guild);
    expect(out[0].status).toBe("applied");
    expect(stored().name).toBe("Scarlet");
    expect(stored().nameSyncPending).toBe(true); // the next pass renames to Scarlet
    expect(env.channels.namesNeedAttention(cstore.get(EV)!)).toBe(true);
  });

  it("the flag is cleared only for the name AND marker that were renamed (a marker the host set meanwhile keeps it pending, #1406)", async () => {
    stored().marker = "R";
    const env = makeEnv();
    function routeChannel(route: string): string {
      return /channels\/(\d+)/.exec(route)?.[1] ?? "";
    }
    // The channel is renamed with the old marker; while the request is in
    // flight the host's live edit stores a new marker and a new pending flag.
    env.rest.patch.mockImplementationOnce(
      async (route: string, o: { body: { name: string } }) => {
        env.channelNames.set(routeChannel(route), o.body.name);
        stored().marker = "B";
        stored().nameSyncPending = true;
        return {};
      },
    );
    const out = await env.channels.syncNames(EV, env.guild);
    expect(out[0].status).toBe("applied");
    expect(env.channelNames.get(RED_CH)).toBe(
      groupChannelName("\u{1F4C5}", { name: "Crimson", marker: "R" }),
    );
    expect(stored().marker).toBe("B");
    expect(stored().nameSyncPending).toBe(true); // the next pass renames to B
    expect(env.channels.namesNeedAttention(cstore.get(EV)!)).toBe(true);
    // The next pass renames with the new marker and then clears the flag.
    const again = await env.channels.syncNames(EV, env.guild);
    expect(again[0].status).toBe("applied");
    expect(env.channelNames.get(RED_CH)).toBe(
      groupChannelName("\u{1F4C5}", { name: "Crimson", marker: "B" }),
    );
    expect(stored().nameSyncPending).toBe(false);
  });

  it("a group with no stored marker is still settled by a rename (the marker is empty, not different)", async () => {
    const env = makeEnv();
    expect(stored().marker).toBeUndefined();
    await env.channels.syncNames(EV, env.guild);
    expect(stored().nameSyncPending).toBe(false);
  });

  it("namesNeedAttention: pending only, open events only, with a channel", () => {
    const env = makeEnv();
    const doc = cstore.get(EV)!;
    expect(env.channels.namesNeedAttention({ ...doc, _id: EV })).toBe(true);
    expect(env.channels.namesNeedAttention({ ...doc, state: "ended" })).toBe(
      false,
    );
    expect(
      env.channels.namesNeedAttention({ ...doc, groupsEnabled: false }),
    ).toBe(false);
    stored().channelId = null;
    expect(env.channels.namesNeedAttention(cstore.get(EV)!)).toBe(false);
    stored().channelId = RED_CH;
    stored().nameSyncPending = false;
    expect(env.channels.namesNeedAttention(cstore.get(EV)!)).toBe(false);
  });
});

describe("syncControls: the Customise team message (#1196)", () => {
  beforeEach(() => {
    seed({ groups: [group(RED), group(BLUE)] });
  });

  it("posts one message per team channel, recorded with the channel it is in", async () => {
    const env = makeEnv();
    await env.channels.syncControls(EV);
    const posts = env.calls.filter((c) => c.op === "post");
    expect(posts).toHaveLength(2);
    const body = posts[0].body as {
      content: string;
      allowed_mentions: unknown;
      components: Msg["components"];
    };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.components[0].components[0].custom_id).toBe(customId(RED));
    // Static text: no names, no mentions.
    expect(body.content).not.toMatch(/<@|@everyone|Crimson/);
    expect(stored().controlMessageId).toBeTruthy();
    expect(stored().controlChannelId).toBe(RED_CH);
    expect(stored(BLUE).controlChannelId).toBe(BLUE_CH);
  });

  it("is idempotent: a second pass makes no Discord call at all", async () => {
    const env = makeEnv();
    await env.channels.syncControls(EV);
    env.calls.length = 0;
    await env.channels.syncControls(EV);
    expect(env.calls).toHaveLength(0);
    expect(env.channels.controlsNeedAttention(cstore.get(EV)!)).toBe(false);
  });

  it("adopts the bot's own existing message instead of posting a duplicate (a crash between post and record)", async () => {
    const env = makeEnv();
    env.messages.set(RED_CH, [
      {
        id: "300000000000000099",
        author: { id: BOT },
        components: [{ components: [{ custom_id: customId(RED) }] }],
      },
    ]);
    await env.channels.syncControls(EV);
    expect(
      env.calls.filter((c) => c.op === "post" && c.route.includes(RED_CH)),
    ).toHaveLength(0);
    expect(stored().controlMessageId).toBe("300000000000000099");
  });

  it("does not adopt someone else's message that copies the button", async () => {
    const env = makeEnv();
    env.messages.set(RED_CH, [
      {
        id: "300000000000000098",
        author: { id: "123" },
        components: [{ components: [{ custom_id: customId(RED) }] }],
      },
    ]);
    await env.channels.syncControls(EV);
    expect(
      env.calls.filter((c) => c.op === "post" && c.route.includes(RED_CH)),
    ).toHaveLength(1);
    expect(stored().controlMessageId).not.toBe("300000000000000098");
  });

  it("re-posts a recorded message that was deleted", async () => {
    const env = makeEnv();
    await env.channels.syncControls(EV);
    const first = stored().controlMessageId;
    env.messages.set(RED_CH, []);
    // A new process has not seen it exist yet.
    const fresh = makeEnv();
    fresh.messages.set(BLUE_CH, env.messages.get(BLUE_CH) ?? []);
    await fresh.channels.syncControls(EV);
    expect(first).toBeTruthy();
    expect(stored().controlMessageId).toBeTruthy();
    // It looked (the record was unseen in this process), found nothing, posted.
    expect(
      fresh.calls.some((c) => c.op === "get" && /messages\/\d+$/.test(c.route)),
    ).toBe(true);
    expect(
      fresh.calls.filter((c) => c.op === "post" && c.route.includes(RED_CH)),
    ).toHaveLength(1);
  });

  it("removes the message and the record when customisation is switched off", async () => {
    const env = makeEnv();
    await env.channels.syncControls(EV);
    expect(env.channels.controlsNeedAttention(cstore.get(EV)!)).toBe(false);
    cstore.get(EV)!.captainCustomisationEnabled = false;
    expect(env.channels.controlsNeedAttention(cstore.get(EV)!)).toBe(true);
    await env.channels.syncControls(EV);
    expect(env.messages.get(RED_CH)).toEqual([]);
    expect(stored().controlMessageId).toBeNull();
    expect(stored().controlChannelId).toBeNull();
    expect(env.channels.controlsNeedAttention(cstore.get(EV)!)).toBe(false);
  });

  it.each([
    ["leaders are switched off", (d: CDoc) => void (d.captainsEnabled = false)],
    ["groups are switched off", (d: CDoc) => void (d.groupsEnabled = false)],
  ])("removes it when %s", async (_n, change) => {
    const env = makeEnv();
    await env.channels.syncControls(EV);
    change(cstore.get(EV)!);
    await env.channels.syncControls(EV);
    if (cstore.get(EV)!.groupsEnabled === false) {
      // A pass does not touch a group-less event; the end teardown owns that.
      return;
    }
    expect(env.messages.get(RED_CH)).toEqual([]);
  });

  it("removes it when events.enabled turns off (fails closed)", async () => {
    let enabled = true;
    const env = makeEnv({ eventsEnabled: async () => enabled });
    await env.channels.syncControls(EV);
    enabled = false;
    await env.channels.syncControls(EV);
    expect(env.messages.get(RED_CH)).toEqual([]);
  });

  it("tolerates a message that is already gone when removing", async () => {
    const env = makeEnv();
    await env.channels.syncControls(EV);
    env.messages.set(RED_CH, []);
    cstore.get(EV)!.captainCustomisationEnabled = false;
    await env.channels.syncControls(EV);
    expect(stored().controlMessageId).toBeNull();
  });

  it("a record from another channel is stale: cleared, never deleted from the new channel", async () => {
    const env = makeEnv();
    stored().controlMessageId = "300000000000000050";
    stored().controlChannelId = "299999999999999999";
    await env.channels.syncControls(EV);
    // The old channel's id is never looked up or deleted in the new channel.
    expect(
      env.calls.filter((c) => c.route.includes("300000000000000050")),
    ).toHaveLength(0);
    expect(stored().controlChannelId).toBe(RED_CH);
    expect(stored().controlMessageId).not.toBe("300000000000000050");
  });

  it("an event that is not open is left alone", async () => {
    const env = makeEnv();
    cstore.get(EV)!.state = "ended";
    await env.channels.syncControls(EV);
    expect(env.calls).toHaveLength(0);
  });

  it("ignores groups that are not teams or have no channel", async () => {
    const env = makeEnv();
    stored(BLUE).kind = "open";
    stored().channelId = null;
    await env.channels.syncControls(EV);
    expect(env.calls.filter((c) => c.op === "post")).toHaveLength(0);
  });

  it("a refused post is held back, shown on the panel and does not stop the other group", async () => {
    const env = makeEnv();
    env.fail.post = { once: true, err: apiError(50013, 403) };
    await env.channels.syncControls(EV);
    expect(stored().controlMessageId).toBeFalsy();
    expect(stored(BLUE).controlMessageId).toBeTruthy();
    const report = env.channels.getReport(EV);
    expect(
      report?.failures.some((f) => f.name.includes("customise button")),
    ).toBe(true);
    // Not retried while the hold lasts.
    env.calls.length = 0;
    await env.channels.syncControls(EV);
    expect(env.calls.filter((c) => c.op === "post")).toHaveLength(0);
    // A later success clears the problem.
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    await env.channels.syncControls(EV);
    expect(stored().controlMessageId).toBeTruthy();
    expect(env.channels.getReport(EV)?.failures ?? []).toHaveLength(0);
  });

  it("a transient failure checking a recorded message is reported, and the report ends when it is seen to exist", async () => {
    const env = makeEnv();
    stored().controlMessageId = "300000000000000061";
    stored().controlChannelId = RED_CH;
    env.messages.set(RED_CH, [
      {
        id: "300000000000000061",
        author: { id: BOT },
        components: [{ components: [{ custom_id: customId(RED) }] }],
      },
    ]);
    stored(BLUE).controlMessageId = "300000000000000062";
    stored(BLUE).controlChannelId = BLUE_CH;
    env.messages.set(BLUE_CH, [
      {
        id: "300000000000000062",
        author: { id: BOT },
        components: [{ components: [{ custom_id: customId(BLUE) }] }],
      },
    ]);
    env.fail.get = new Error("network");
    await env.channels.syncControls(EV);
    expect(
      env.channels
        .getReport(EV)
        ?.failures.some((f) => f.name.includes("customise button")),
    ).toBe(true);
    // Recovered, after the hold: seen to exist, so the report is gone and the
    // scan has nothing left to look at.
    env.fail.get = undefined;
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    await env.channels.syncControls(EV);
    expect(env.channels.getReport(EV)?.failures ?? []).toHaveLength(0);
    expect(env.channels.controlsNeedAttention(cstore.get(EV)!)).toBe(false);
  });

  describe("finding an existing button (a post whose record was lost)", () => {
    const own = (n: number): Msg => ({
      id: String(300000000000000000n + BigInt(n)),
      author: { id: BOT },
      components: [{ components: [{ custom_id: customId(RED) }] }],
    });
    const chatter = (from: number, count: number): Msg[] =>
      Array.from({ length: count }, (_v, i) => ({
        id: String(300000000000000000n + BigInt(from + i)),
        author: { id: "555" },
        components: [],
      }));

    it("looks past the newest 100 messages and adopts the button instead of posting a second", async () => {
      const env = makeEnv();
      // The button is the oldest of 250 messages.
      env.messages.set(RED_CH, [own(1), ...chatter(2, 249)]);
      await env.channels.syncControls(EV);
      expect(
        env.calls.filter((c) => c.op === "post" && c.route.includes(RED_CH)),
      ).toHaveLength(0);
      expect(stored().controlMessageId).toBe(String(300000000000000001n));
    });

    it("a short history without it means there is none: post", async () => {
      const env = makeEnv();
      env.messages.set(RED_CH, chatter(1, 30));
      await env.channels.syncControls(EV);
      expect(
        env.calls.filter((c) => c.op === "post" && c.route.includes(RED_CH)),
      ).toHaveLength(1);
    });

    it("a history too long to rule it out does NOT permit a new post: held and reported", async () => {
      const env = makeEnv();
      env.messages.set(RED_CH, chatter(1, 600));
      await env.channels.syncControls(EV);
      expect(
        env.calls.filter((c) => c.op === "post" && c.route.includes(RED_CH)),
      ).toHaveLength(0);
      expect(stored().controlMessageId).toBeFalsy();
      expect(
        env.channels
          .getReport(EV)
          ?.failures.some((f) => f.name.includes("customise button")),
      ).toBe(true);
    });

    it("a failed look does not permit a new post either", async () => {
      const env = makeEnv();
      env.fail.get = new Error("network");
      await env.channels.syncControls(EV);
      expect(env.calls.filter((c) => c.op === "post")).toHaveLength(0);
    });

    it("the bot's own id being unknown does not permit a post", async () => {
      const env = makeEnv();
      (env.channels as unknown as { client: { user: unknown } }).client.user =
        null;
      await env.channels.syncControls(EV);
      expect(env.calls.filter((c) => c.op === "post")).toHaveLength(0);
    });
  });

  it("a message posted while the record was taken by another pass is removed again", async () => {
    const env = makeEnv();
    cfake.beforeNextUpdate = () => {
      stored().controlMessageId = "300000000000000077";
      stored().controlChannelId = RED_CH;
    };
    await env.channels.syncControls(EV);
    const posted = env.calls.filter(
      (c) => c.op === "post" && c.route.includes(RED_CH),
    );
    expect(posted).toHaveLength(1);
    expect(
      env.calls.filter((c) => c.op === "delete" && c.route.includes(RED_CH)),
    ).toHaveLength(1);
    expect(stored().controlMessageId).toBe("300000000000000077");
  });

  it("controlsNeedAttention: wanted vs recorded", () => {
    const env = makeEnv();
    const doc = cstore.get(EV)!;
    expect(env.channels.controlsNeedAttention(doc)).toBe(true); // wanted, none recorded
    doc.captainCustomisationEnabled = false;
    expect(env.channels.controlsNeedAttention(doc)).toBe(false); // off, none recorded
    stored().controlMessageId = "300000000000000001";
    stored().controlChannelId = RED_CH;
    expect(env.channels.controlsNeedAttention(doc)).toBe(true); // off, one recorded
  });
});
