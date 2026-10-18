import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  RateLimitError,
} from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

type Group = {
  key: string;
  name: string;
  kind: string;
  size: number | null;
  channelId: string | null;
  memberIds: string[];
};
type Row = {
  _id: string;
  guildId: string;
  state: string;
  groupsEnabled: boolean;
  channelId: string | null;
  createdBy: string;
  groups: Group[];
};
const store = new Map<string, Row>();
let findFails = false;
const findById = jest.fn((id: string) => ({
  lean: async () => {
    if (findFails) throw new Error("db down");
    const row = store.get(id);
    return row ? JSON.parse(JSON.stringify(row)) : null;
  },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: { findById },
}));

let eventsEnabled: boolean | "throw" = true;
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({
      getBoolean: async () => {
        if (eventsEnabled === "throw") throw new Error("config unreadable");
        return eventsEnabled;
      },
    }),
  },
}));

const {
  moveEventMembers,
  planSendToGroups,
  planReturnToMain,
  planMoveOne,
  describeMoveReport,
  moveMembersBlocker,
  MAX_MOVES_PER_RUN,
} = await import("../../src/services/event-member-moves.js");
const { consumeHostMove, withEventMoveLock, resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const GUILD = "guild-1";
const EV = "evt1";
const HOST = "host-1";
const MAIN = "ch-main";
const CH_A = "ch-a";
const CH_B = "ch-b";
const CH_OPEN = "ch-open";
const CH_LEADS = "ch-leads";
const ELSEWHERE = "ch-elsewhere";

function apiError(code: number, method = "PATCH"): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "x" },
    code,
    400,
    method,
    "/",
    {},
  );
}
function rateLimit(): RateLimitError {
  return new RateLimitError({
    timeToReset: 60_000,
    limit: 1,
    method: "PATCH",
    hash: "h",
    url: "/",
    route: "/",
    majorParameter: "",
    global: false,
    retryAfter: 60_000,
    sublimitTimeout: 0,
  } as never);
}

function makeRow(over: Partial<Row> = {}): Row {
  return {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    channelId: MAIN,
    createdBy: HOST,
    groups: [
      {
        key: "a",
        name: "Alpha",
        kind: "team",
        size: 2,
        channelId: CH_A,
        memberIds: ["u1", "u2"],
      },
      {
        key: "b",
        name: "Bravo",
        kind: "team",
        size: null,
        channelId: CH_B,
        memberIds: ["u3"],
      },
      {
        key: "o",
        name: "Open",
        kind: "open",
        size: null,
        channelId: CH_OPEN,
        memberIds: [],
      },
      {
        key: "l",
        name: "Leads",
        kind: "leads",
        size: null,
        channelId: CH_LEADS,
        memberIds: [],
      },
    ],
    ...over,
  };
}

/** A fake server: voice channels, who is in them, and what Discord answers. */
function makeWorld(
  opts: { limits?: Record<string, number>; mePerms?: bigint[] | null } = {},
) {
  const limits: Record<string, number> = {
    [CH_A]: 2,
    ...(opts.limits ?? {}),
  };
  const inChannel = new Map<string, string | null>(); // user -> channel
  const channelIds = [MAIN, CH_A, CH_B, CH_OPEN, CH_LEADS, ELSEWHERE];
  const voiceReadFail = new Map<string, unknown>();
  const patchBehaviour = new Map<string, unknown>(); // user -> error to throw
  const channelFetchFail = new Map<string, unknown>();
  const held = opts.mePerms === undefined ? null : opts.mePerms;
  const allowed = (bit: bigint): boolean => held === null || held.includes(bit);

  const membersOf = (channelId: string) =>
    new Map(
      [...inChannel.entries()]
        .filter(([, c]) => c === channelId)
        .map(([id]) => [
          id,
          {
            id,
            displayName: `Name ${id}`,
            user: { bot: id.startsWith("bot") },
          },
        ]),
    );
  const channelObj = (id: string) => ({
    id,
    type: ChannelType.GuildVoice,
    guildId: GUILD,
    userLimit: limits[id] ?? 0,
    isVoiceBased: () => true,
    get members() {
      return membersOf(id);
    },
  });
  const cache = new Map(channelIds.map((id) => [id, channelObj(id)]));
  const guild = {
    id: GUILD,
    members: {
      me:
        opts.mePerms === null
          ? null
          : {
              permissions: { has: (bit: bigint) => allowed(bit) },
              permissionsIn: () => ({ has: (bit: bigint) => allowed(bit) }),
            },
    },
    channels: {
      cache,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      fetch: jest.fn(async (id: string, _o?: unknown) => {
        if (channelFetchFail.has(id)) throw channelFetchFail.get(id);
        const c = cache.get(id);
        if (!c) throw apiError(10003, "GET");
        return c;
      }),
    },
    voiceStates: {
      cache: {
        get: (id: string) => {
          const c = inChannel.get(id);
          return c ? { channelId: c } : undefined;
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      fetch: jest.fn(async (id: string, _o?: unknown) => {
        if (voiceReadFail.has(id)) throw voiceReadFail.get(id);
        const c = inChannel.get(id);
        if (!c) throw apiError(10065, "GET");
        return { channelId: c };
      }),
    },
  };
  const voiceListeners = new Set<(o: unknown, n: unknown) => void>();
  const client = {
    guilds: {
      cache: { get: (id: string) => (id === GUILD ? guild : undefined) },
    },
    token: "t",
    on: (_event: string, fn: (o: unknown, n: unknown) => void) => {
      voiceListeners.add(fn);
    },
    off: (_event: string, fn: (o: unknown, n: unknown) => void) => {
      voiceListeners.delete(fn);
    },
  } as { token: string; guilds: unknown; on?: unknown; off?: unknown };
  const patch = jest.fn(
    async (
      route: string,
      o: { body: { channel_id: string }; signal?: AbortSignal },
    ) => {
      const user = route.split("/").pop() as string;
      if (patchBehaviour.has(user)) throw patchBehaviour.get(user);
      inChannel.set(user, o.body.channel_id);
      return {};
    },
  );
  return {
    guild,
    client,
    patch,
    /** The gateway announces a voice change (the cache is set by `place`). */
    emitVoice: (user: string, channel: string | null) => {
      for (const fn of [...voiceListeners]) {
        fn({}, { id: user, channelId: channel, guild: { id: GUILD } });
      }
    },
    listenerCount: () => voiceListeners.size,
    place: (user: string, channel: string | null) =>
      inChannel.set(user, channel),
    where: (user: string) => inChannel.get(user) ?? null,
    voiceReadFail,
    patchBehaviour,
    channelFetchFail,
    deps: {
      rest: { patch } as never,
      call: (async (fn: (s: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal)) as never,
      paceMs: 0,
    },
  };
}

type World = ReturnType<typeof makeWorld>;

function run(
  world: World,
  plan: Parameters<typeof moveEventMembers>[0]["plan"],
  exclude: string[] = [HOST],
) {
  return moveEventMembers({
    client: world.client as never,
    guildId: GUILD,
    eventId: EV,
    plan,
    excludeUserIds: exclude,
    deps: world.deps,
  });
}

const reasons = (r: { skipped: Array<{ userId: string; reason: string }> }) =>
  Object.fromEntries(r.skipped.map((s) => [s.userId, s.reason]));

beforeEach(() => {
  store.clear();
  store.set(EV, makeRow());
  findFails = false;
  eventsEnabled = true;
  findById.mockClear();
  resetMoveGuardForTests();
});

describe("send to groups", () => {
  it("moves each assigned member to their own group's channel and lists the rest", async () => {
    const w = makeWorld();
    w.place("u1", MAIN);
    w.place("u2", MAIN);
    w.place("u3", CH_OPEN); // wrong room: still goes to Bravo
    w.place("u9", MAIN); // connected but unassigned: left alone
    w.place(HOST, MAIN);
    const out = await run(w, ({ event }) => planSendToGroups(event));
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(out.report.moved.sort()).toEqual(["u1", "u2", "u3"]);
    expect(w.where("u1")).toBe(CH_A);
    expect(w.where("u2")).toBe(CH_A);
    expect(w.where("u3")).toBe(CH_B);
    expect(w.where("u9")).toBe(MAIN);
    expect(w.where(HOST)).toBe(MAIN);
  });

  it("skips and reports people who are not connected, in an unrelated channel, or already there", async () => {
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "a"
            ? { ...g, size: null, memberIds: ["u1", "u2", "u4"] }
            : g,
        ),
      }),
    );
    const w = makeWorld({ limits: {} });
    w.place("u1", ELSEWHERE); // an unrelated channel
    w.place("u2", CH_A); // already in place
    // u3: not connected at all; u4: not connected
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual([]);
    expect(reasons(out.report)).toEqual({
      u1: "elsewhere",
      u2: "already-there",
      u3: "not-connected",
      u4: "not-connected",
    });
    // Nobody was pulled out of the unrelated channel.
    expect(w.where("u1")).toBe(ELSEWHERE);
    expect(w.patch).not.toHaveBeenCalled();
  });

  it("never moves the host or the acting user, even when assigned", async () => {
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "b" ? { ...g, memberIds: ["u3", HOST, "admin-1"] } : g,
        ),
      }),
    );
    const w = makeWorld();
    w.place("u3", MAIN);
    w.place(HOST, MAIN);
    w.place("admin-1", MAIN);
    const out = await run(w, ({ event }) => planSendToGroups(event), [
      HOST,
      "admin-1",
    ]);
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual(["u3"]);
    expect(reasons(out.report)).toMatchObject({
      [HOST]: "host",
      "admin-1": "host",
    });
    expect(w.where(HOST)).toBe(MAIN);
    expect(w.where("admin-1")).toBe(MAIN);
    expect(w.patch).toHaveBeenCalledTimes(1);
  });

  it("refuses a move into a full group and counts arrivals in the same run", async () => {
    // Alpha holds 2 and u7 is already in it: only one more fits.
    const w = makeWorld({ limits: { [CH_A]: 2 } });
    w.place("u7", CH_A);
    w.place("u1", MAIN);
    w.place("u2", MAIN);
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual(["u1"]);
    expect(reasons(out.report).u2).toBe("group-full");
    expect(w.where("u2")).toBe(MAIN);
  });

  it("a person leaving a full channel in the same run frees their place", async () => {
    // u1 (in Alpha, full) is assigned to Bravo; u2 (main) is assigned to Alpha.
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "a"
            ? { ...g, memberIds: ["u2"] }
            : g.key === "b"
              ? { ...g, memberIds: ["u1"] }
              : g,
        ),
      }),
    );
    const w = makeWorld({ limits: { [CH_A]: 1 } });
    w.place("u1", CH_A);
    w.place("u2", MAIN);
    // Bravo's turn comes first in plan order? No: Alpha first. u2 is refused
    // (full), then u1 leaves; the run does not retry u2.
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual(["u1"]);
    expect(reasons(out.report).u2).toBe("group-full");
  });

  it("reports a partial failure of every kind and keeps going", async () => {
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "b"
            ? { ...g, memberIds: ["u3", "u4", "u5", "u6", "u7"] }
            : { ...g, memberIds: [] },
        ),
      }),
    );
    const w = makeWorld();
    for (const u of ["u3", "u4", "u5", "u6", "u7"]) w.place(u, MAIN);
    w.patchBehaviour.set("u4", apiError(40032)); // left voice meanwhile
    w.patchBehaviour.set("u5", apiError(50013)); // missing permission
    w.patchBehaviour.set("u6", new Error("Discord API timeout after 30000ms"));
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved.sort()).toEqual(["u3", "u7"]);
    expect(reasons(out.report)).toEqual({
      u4: "not-connected",
      u5: "missing-permission",
    });
    expect(out.report.unconfirmed).toEqual(["u6"]);
    const text = describeMoveReport(out.report, (id) => `N-${id}`);
    expect(text).toContain("Moved 2.");
    expect(text).toContain("Skipped 2");
    expect(text).toContain("did not confirm 1, who may or may not have moved");
    expect(text).toContain("check Discord before trying again");
    expect(text).toContain("Not confirmed: N-u6.");
  });

  it("stops at a rate limit and lists the rest as not attempted", async () => {
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "b"
            ? { ...g, memberIds: ["u3", "u4", "u5"] }
            : { ...g, memberIds: [] },
        ),
      }),
    );
    const w = makeWorld();
    for (const u of ["u3", "u4", "u5"]) w.place(u, MAIN);
    w.patchBehaviour.set("u4", rateLimit());
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual(["u3"]);
    expect(reasons(out.report)).toEqual({
      u4: "rate-limited",
      u5: "rate-limited",
    });
    // u5 was never asked of Discord.
    expect(w.patch).toHaveBeenCalledTimes(2);
  });

  it("does not ask Discord to move more than the per-run cap", async () => {
    const ids = Array.from(
      { length: MAX_MOVES_PER_RUN + 3 },
      (_, i) => `m${i}`,
    );
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "b" ? { ...g, memberIds: ids } : { ...g, memberIds: [] },
        ),
      }),
    );
    const w = makeWorld();
    for (const id of ids) w.place(id, MAIN);
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toHaveLength(MAX_MOVES_PER_RUN);
    expect(
      out.report.skipped.filter((s) => s.reason === "over-limit"),
    ).toHaveLength(3);
  });

  it("a second run gets past the people the first run moved (the cap counts only real moves)", async () => {
    const ids = Array.from(
      { length: MAX_MOVES_PER_RUN + 3 },
      (_, i) => `m${i}`,
    );
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "b" ? { ...g, memberIds: ids } : { ...g, memberIds: [] },
        ),
      }),
    );
    const w = makeWorld();
    for (const id of ids) w.place(id, MAIN);
    const first = await run(w, ({ event }) => planSendToGroups(event));
    if (first.status !== "done") throw new Error("expected done");
    expect(first.report.moved).toHaveLength(MAX_MOVES_PER_RUN);
    w.patch.mockClear();
    w.guild.voiceStates.fetch.mockClear();
    const second = await run(w, ({ event }) => planSendToGroups(event));
    if (second.status !== "done") throw new Error("expected done");
    expect(second.report.moved).toEqual(ids.slice(MAX_MOVES_PER_RUN));
    expect(
      second.report.skipped.filter((s) => s.reason === "already-there"),
    ).toHaveLength(MAX_MOVES_PER_RUN);
    // People already in place cost no request at all.
    expect(w.guild.voiceStates.fetch).toHaveBeenCalledTimes(3);
    expect(w.patch).toHaveBeenCalledTimes(3);
    ids.forEach((id) => expect(w.where(id)).toBe(CH_B));
  });

  it("skips a person who left the event's channels between the read and the write", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    // Discord's read says MAIN; by the time of the write the gateway has them elsewhere.
    w.guild.voiceStates.fetch.mockImplementationOnce(async () => {
      w.place("u3", ELSEWHERE);
      return { channelId: MAIN };
    });
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u3).toBe("elsewhere");
    expect(w.patch).not.toHaveBeenCalled();
    expect(w.where("u3")).toBe(ELSEWHERE);
  });

  it("skips someone whose voice state cannot be read (fails closed)", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    w.voiceReadFail.set("u3", new Error("socket hang up"));
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u3).toBe("error");
    expect(w.patch).not.toHaveBeenCalled();
  });

  it("skips people whose destination cannot be read from Discord", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    w.channelFetchFail.set(CH_B, new Error("boom"));
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u3).toBe("error");
    expect(w.patch).not.toHaveBeenCalled();
  });

  it("force-reads every destination from Discord", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    await run(w, ({ event }) => planSendToGroups(event));
    expect(w.guild.channels.fetch).toHaveBeenCalledWith(CH_B, { force: true });
    expect(w.guild.voiceStates.fetch).toHaveBeenCalledWith("u3", {
      force: true,
    });
  });

  it("does not replay a move after a timeout", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    const retries: boolean[] = [];
    w.deps.call = (async (
      fn: (s: AbortSignal) => Promise<unknown>,
      name: string,
      retryOnTimeout: boolean,
    ) => {
      if (name === "move event member") retries.push(retryOnTimeout);
      return fn(new AbortController().signal);
    }) as never;
    await run(w, ({ event }) => planSendToGroups(event));
    expect(retries).toEqual([false]);
  });

  it("skips a move the bot has no permission for, without asking Discord", async () => {
    const w = makeWorld({ mePerms: [PermissionFlagsBits.MoveMembers] }); // no Connect
    w.place("u3", MAIN);
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u3).toBe("missing-permission");
    expect(w.patch).not.toHaveBeenCalled();
  });
});

describe("capacity is read live (review of #1221)", () => {
  const bravoFirst = (a: string[], b: string[], size = 1): void => {
    const base = makeRow();
    store.set(
      EV,
      makeRow({
        groups: [
          { ...base.groups[1], memberIds: b },
          { ...base.groups[0], size, memberIds: a },
          base.groups[2],
          base.groups[3],
        ],
      }),
    );
  };

  it("a join during the voice-state read fills the destination: nobody is moved into a full group", async () => {
    const w = makeWorld({ limits: { [CH_A]: 2 } });
    w.place("u7", CH_A);
    w.place("u1", MAIN);
    w.place("u2", MAIN);
    w.guild.voiceStates.fetch.mockImplementationOnce(async () => {
      w.place("stranger", CH_A); // a normal join, not a move
      return { channelId: MAIN };
    });
    const calls: string[] = [];
    w.deps.call = (async (
      fn: (s: AbortSignal) => Promise<unknown>,
      name: string,
    ) => {
      calls.push(name);
      return fn(new AbortController().signal);
    }) as never;
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual([]);
    expect(reasons(out.report)).toMatchObject({
      u1: "group-full",
      u2: "group-full",
    });
    expect(w.patch).not.toHaveBeenCalled();
    // Refused before any move was asked of Discord (and so before a mark).
    expect(calls).not.toContain("move event member");
  });

  it("a join between the last check and the write is caught in the same tick as the write", async () => {
    const w = makeWorld({ limits: { [CH_A]: 2 } });
    w.place("u7", CH_A);
    w.place("u1", MAIN);
    w.deps.call = (async (
      fn: (s: AbortSignal) => Promise<unknown>,
      name: string,
    ) => {
      if (name === "move event member") w.place("stranger", CH_A);
      return fn(new AbortController().signal);
    }) as never;
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u1).toBe("group-full");
    expect(w.patch).not.toHaveBeenCalled();
    // The refused move left no mark behind.
    expect(consumeHostMove(GUILD, "u1", CH_A)).toBe(false);
  });

  it("a departure during the run frees a place that was full at the start", async () => {
    bravoFirst(["u1"], ["p"]);
    const w = makeWorld({ limits: { [CH_A]: 1 } });
    w.place("u7", CH_A);
    w.place("p", MAIN);
    w.place("u1", MAIN);
    w.guild.voiceStates.fetch.mockImplementationOnce(async () => {
      w.place("u7", MAIN); // leaves Alpha on their own
      return { channelId: MAIN };
    });
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved.sort()).toEqual(["p", "u1"]);
    expect(w.where("u1")).toBe(CH_A);
  });

  it("an unconfirmed move out of a full group does not free its place", async () => {
    bravoFirst(["u2"], ["p"]);
    const w = makeWorld({ limits: { [CH_A]: 1 } });
    w.place("p", CH_A);
    w.place("u2", MAIN);
    w.patchBehaviour.set("p", new Error("Discord API timeout after 30000ms"));
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.unconfirmed).toEqual(["p"]);
    expect(reasons(out.report).u2).toBe("group-full");
    expect(w.where("u2")).toBe(MAIN);
  });

  it("a confirmed move frees the source even before the gateway shows it", async () => {
    bravoFirst(["u2"], ["p"]);
    const w = makeWorld({ limits: { [CH_A]: 1 } });
    w.place("p", CH_A);
    w.place("u2", MAIN);
    // Discord says yes; the gateway has not caught up (p still shows in Alpha).
    w.patch.mockImplementationOnce(async () => ({}));
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved.sort()).toEqual(["p", "u2"]);
  });

  it("an unconfirmed move into a group keeps a place for the person", async () => {
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "a"
            ? { ...g, size: 1, memberIds: ["u1", "u2"] }
            : { ...g, memberIds: [] },
        ),
      }),
    );
    const w = makeWorld({ limits: { [CH_A]: 1 } });
    w.place("u1", MAIN);
    w.place("u2", MAIN);
    w.patchBehaviour.set("u1", new Error("Discord API timeout after 30000ms"));
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.unconfirmed).toEqual(["u1"]);
    expect(reasons(out.report).u2).toBe("group-full");
  });

  it("people aimed at a full group do not use up the per-run budget of the rest", async () => {
    const stuck = Array.from(
      { length: MAX_MOVES_PER_RUN + 1 },
      (_, i) => `f${i}`,
    );
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "a"
            ? { ...g, size: 1, memberIds: stuck }
            : g.key === "b"
              ? { ...g, memberIds: ["z1"] }
              : { ...g, memberIds: [] },
        ),
      }),
    );
    const w = makeWorld({ limits: { [CH_A]: 1 } });
    w.place("u7", CH_A);
    for (const id of [...stuck, "z1"]) w.place(id, MAIN);
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual(["z1"]);
    expect(
      out.report.skipped.filter((x) => x.reason === "group-full"),
    ).toHaveLength(stuck.length);
    expect(out.report.skipped.some((x) => x.reason === "over-limit")).toBe(
      false,
    );
    // Nobody aimed at the full group cost a voice-state read.
    expect(w.guild.voiceStates.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("marks of two moves of one member (review of #1221)", () => {
  it("a later move of the member to another channel does not drop the mark of an unconfirmed earlier one", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    w.patchBehaviour.set("u3", new Error("Discord API timeout after 30000ms"));
    const first = await run(
      w,
      ({ event }) => planMoveOne(event, "u3", "b"),
      [],
    );
    if (first.status !== "done") throw new Error("expected done");
    expect(first.report.unconfirmed).toEqual(["u3"]);
    // Another press moves the same member somewhere else; this one lands.
    w.patchBehaviour.delete("u3");
    const second = await run(
      w,
      ({ event }) => planMoveOne(event, "u3", "a"),
      [],
    );
    if (second.status !== "done") throw new Error("expected done");
    expect(second.report.moved).toEqual(["u3"]);
    // The delayed join of the first move still counts as the host's.
    expect(consumeHostMove(GUILD, "u3", CH_B)).toBe(true);
    expect(consumeHostMove(GUILD, "u3", CH_A)).toBe(true);
  });
});

describe("the flash keeps what matters inside its limit (review of #1221)", () => {
  it("puts the counts and the unconfirmed warning before the names and stays within the budget", () => {
    const reasonsAll = [
      "not-connected",
      "elsewhere",
      "group-full",
      "missing-permission",
      "error",
      "over-limit",
      "rate-limited",
      "host",
    ] as const;
    const skipped = reasonsAll.flatMap((reason, r) =>
      Array.from({ length: 12 }, (_, i) => ({
        userId: `${reason}-${r}-${i}`,
        reason,
      })),
    );
    const text = describeMoveReport(
      {
        moved: ["a", "b", "c", "d", "e"],
        skipped,
        unconfirmed: ["slow-1", "slow-2", "slow-3"],
      },
      (id) => `Very Long Display Name ${id}`,
      [
        "2 assigned people are in a group without a channel yet and were not moved.",
      ],
    );
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.startsWith("Moved 5. Discord did not confirm 3")).toBe(true);
    expect(text).toContain("check Discord before trying again");
    for (const label of [
      "not connected to voice",
      "group full",
      "missing permission",
    ]) {
      expect(text).toContain(`12 ${label}`);
    }
    expect(text).toContain(
      "2 assigned people are in a group without a channel yet",
    );
  });

  it("keeps long diagnostic details out of the always-whole part", () => {
    const longDetail = (n: number): string =>
      `Discord didn't answer within 30 seconds (case ${n}), so it is unknown whether the change was applied: the request was cancelled here, but Discord may already have accepted it. Check Discord before trying again.`;
    const skipped = [
      ...[1, 2, 3].map((n) => ({
        userId: `e${n}`,
        reason: "error" as const,
        detail: longDetail(n),
      })),
      ...(
        [
          "not-connected",
          "elsewhere",
          "group-full",
          "missing-permission",
        ] as const
      ).map((reason) => ({ userId: `x-${reason}`, reason })),
    ];
    const extra = [
      "2 assigned people are in a group without a channel yet and were not moved.",
    ];
    const text = describeMoveReport(
      { moved: ["a"], skipped, unconfirmed: ["slow"] },
      (id) => `Name ${id}`,
      extra,
    );
    expect(text.length).toBeLessThanOrEqual(500);
    // The counts, the warning and the note are whole even though the
    // details would not fit.
    expect(text).toContain("did not confirm 1");
    expect(text).toContain("check Discord before trying again");
    expect(text).toContain("3 error");
    expect(text).toContain("1 not connected to voice");
    expect(text).toContain("1 group full");
    expect(text).toContain(extra[0]);
    // And with nothing else to say the detail is added, clipped.
    const alone = describeMoveReport(
      {
        moved: [],
        skipped: [{ userId: "e1", reason: "error", detail: longDetail(1) }],
        unconfirmed: [],
      },
      (id) => id,
    );
    expect(alone).toContain("Error: Discord didn't answer");
    expect(alone.length).toBeLessThanOrEqual(500);
  });

  it("adds names while they fit, unconfirmed people first", () => {
    const text = describeMoveReport(
      {
        moved: [],
        skipped: [{ userId: "x1", reason: "not-connected" }],
        unconfirmed: ["slow-1"],
      },
      (id) => id,
    );
    expect(text).toContain("Not confirmed: slow-1.");
    expect(text).toContain("Not connected to voice: x1.");
    expect(text.indexOf("Not confirmed")).toBeLessThan(
      text.indexOf("Not connected to voice:"),
    );
  });
});

describe("later voice changes win over the run's bookkeeping (second review of #1221)", () => {
  const swapSetup = (): ReturnType<typeof makeWorld> => {
    const base = makeRow();
    store.set(
      EV,
      makeRow({
        groups: [
          { ...base.groups[1], memberIds: ["p"] }, // Bravo first
          { ...base.groups[0], size: 1, memberIds: ["u2"] }, // Alpha, size 1
          base.groups[2],
          base.groups[3],
        ],
      }),
    );
    const w = makeWorld({ limits: { [CH_A]: 1 } });
    w.place("p", CH_A);
    w.place("u2", MAIN);
    return w;
  };

  it("a person who arrives and then goes straight back to the source counts at the source again (gateway events)", async () => {
    const w = swapSetup();
    w.patch.mockImplementationOnce(async (route, o) => {
      const user = route.split("/").pop() as string;
      w.place(user, o.body.channel_id);
      w.emitVoice(user, o.body.channel_id); // arrival observed
      w.place(user, CH_A); // and back to Alpha on their own
      return {};
    });
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual(["p"]);
    // Alpha (size 1) holds p again: u2 must not be moved into it.
    expect(reasons(out.report).u2).toBe("group-full");
    expect(w.where("u2")).toBe(MAIN);
    // The listener is gone when the run ends.
    expect(w.listenerCount()).toBe(0);
  });

  it("the same without gateway events: the cache showing the arrival retires the entry", async () => {
    const w = swapSetup();
    delete w.client.on;
    w.patch.mockImplementationOnce(async (route, o) => {
      w.place(route.split("/").pop() as string, o.body.channel_id);
      return {};
    });
    // The next person's voice read happens after their pre-check, which has
    // seen p in Bravo; p then goes back before the write.
    let reads = 0;
    const original = w.guild.voiceStates.fetch.getMockImplementation();
    w.guild.voiceStates.fetch.mockImplementation(async (id, o) => {
      reads += 1;
      if (reads === 2) w.place("p", CH_A);
      return (original as (i: string, x?: unknown) => Promise<unknown>)(
        id,
        o,
      ) as never;
    });
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u2).toBe("group-full");
  });

  it("an arrival the gateway shows AFTER the answer retires the entry, so a quick return counts (gateway events)", async () => {
    const w = swapSetup();
    w.patch.mockImplementationOnce(async () => ({})); // yes; the gateway lags
    let reads = 0;
    const original = w.guild.voiceStates.fetch.getMockImplementation();
    w.guild.voiceStates.fetch.mockImplementation(async (id, o) => {
      reads += 1;
      if (reads === 2) {
        // The lagging arrival finally comes, and p goes straight back.
        w.place("p", CH_B);
        w.emitVoice("p", CH_B);
        w.place("p", CH_A);
      }
      return (original as (i: string, x?: unknown) => Promise<unknown>)(
        id,
        o,
      ) as never;
    });
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u2).toBe("group-full");
  });

  it("the same without gateway events: seeing the arrival in the cache retires the entry", async () => {
    const w = swapSetup();
    // A third person (q) goes to Bravo between p and u2.
    store.get(EV)!.groups[0].memberIds = ["p", "q"];
    w.place("q", MAIN);
    delete w.client.on;
    w.patch.mockImplementationOnce(async () => ({})); // yes; the gateway lags
    let reads = 0;
    const original = w.guild.voiceStates.fetch.getMockImplementation();
    w.guild.voiceStates.fetch.mockImplementation(async (id, o) => {
      reads += 1;
      // The lagging arrival of p shows up in the cache during q's turn: u2's
      // check then sees it; p goes back during u2's read, before the write.
      if (reads === 2) w.place("p", CH_B);
      if (reads === 3) w.place("p", CH_A);
      return (original as (i: string, x?: unknown) => Promise<unknown>)(
        id,
        o,
      ) as never;
    });
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u2).toBe("group-full");
  });

  it("still protects a destination while the gateway lags behind a confirmed move", async () => {
    const w = swapSetup();
    w.patch.mockImplementationOnce(async () => ({})); // yes, but p still shows in Alpha
    const out = await run(w, ({ event }) => planSendToGroups(event));
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved.sort()).toEqual(["p", "u2"]);
  });
});

describe("two attempts to the same channel (second review of #1221)", () => {
  it("an unconfirmed attempt followed by a refused one to the same channel keeps the first mark", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    w.patchBehaviour.set("u3", new Error("Discord API timeout after 30000ms"));
    const first = await run(
      w,
      ({ event }) => planMoveOne(event, "u3", "b"),
      [],
    );
    if (first.status !== "done") throw new Error("expected done");
    expect(first.report.unconfirmed).toEqual(["u3"]);
    w.patchBehaviour.set("u3", apiError(50013));
    const second = await run(
      w,
      ({ event }) => planMoveOne(event, "u3", "b"),
      [],
    );
    if (second.status !== "done") throw new Error("expected done");
    expect(reasons(second.report).u3).toBe("missing-permission");
    // The delayed join of the first attempt is still the host's.
    expect(consumeHostMove(GUILD, "u3", CH_B)).toBe(true);
    // The refused attempt left nothing behind.
    expect(consumeHostMove(GUILD, "u3", CH_B)).toBe(false);
  });
});

describe("return to main", () => {
  function groupWorld() {
    const w = makeWorld();
    w.place("u1", CH_A);
    w.place("u3", CH_B);
    w.place("o1", CH_OPEN);
    w.place("l1", CH_LEADS);
    w.place("m1", MAIN);
    w.place("bot1", CH_A);
    w.place(HOST, CH_A);
    return w;
  }

  it("brings back everyone in a group channel, open and leads included by default, never the host", async () => {
    const w = groupWorld();
    const out = await run(w, ({ event, presence }) =>
      planReturnToMain(event, presence, false),
    );
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved.sort()).toEqual(["l1", "o1", "u1", "u3"]);
    for (const u of ["u1", "u3", "o1", "l1", "m1"])
      expect(w.where(u)).toBe(MAIN);
    expect(w.where(HOST)).toBe(CH_A);
    expect(w.where("bot1")).toBe(CH_A);
  });

  it("leaves open and leads channels alone when asked", async () => {
    const w = groupWorld();
    const out = await run(w, ({ event, presence }) =>
      planReturnToMain(event, presence, true),
    );
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved.sort()).toEqual(["u1", "u3"]);
    expect(w.where("o1")).toBe(CH_OPEN);
    expect(w.where("l1")).toBe(CH_LEADS);
  });

  it("refuses when the main channel does not exist", async () => {
    store.set(EV, makeRow({ channelId: null }));
    const w = groupWorld();
    const out = await run(w, ({ event, presence }) =>
      planReturnToMain(event, presence, false),
    );
    expect(out.status).toBe("refused");
    expect(w.patch).not.toHaveBeenCalled();
  });
});

describe("move one person", () => {
  it("moves to main or a group by key and refuses an unknown destination", async () => {
    const w = makeWorld();
    w.place("u1", CH_B);
    let out = await run(w, ({ event }) => planMoveOne(event, "u1", "main"), []);
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual(["u1"]);
    expect(w.where("u1")).toBe(MAIN);
    out = await run(w, ({ event }) => planMoveOne(event, "u1", "nope"), []);
    expect(out.status).toBe("refused");
    // A raw channel id is not a destination.
    out = await run(w, ({ event }) => planMoveOne(event, "u1", ELSEWHERE), []);
    expect(out.status).toBe("refused");
    expect(w.where("u1")).toBe(MAIN);
  });

  it("refuses a full group", async () => {
    const w = makeWorld({ limits: { [CH_A]: 1 } });
    w.place("u7", CH_A);
    w.place("u1", MAIN);
    const out = await run(w, ({ event }) => planMoveOne(event, "u1", "a"), []);
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u1).toBe("group-full");
    expect(w.where("u1")).toBe(MAIN);
  });

  it("can move the host when the host asks for it", async () => {
    const w = makeWorld();
    w.place(HOST, MAIN);
    const out = await run(w, ({ event }) => planMoveOne(event, HOST, "b"), []);
    if (out.status !== "done") throw new Error("expected done");
    expect(out.report.moved).toEqual([HOST]);
  });
});

describe("gates", () => {
  const plan = ({ event }: { event: Parameters<typeof planSendToGroups>[0] }) =>
    planSendToGroups(event);

  it("answers busy while another run of the same event is going, and frees the lock afterwards", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    let release: () => void = () => undefined;
    const held = withEventMoveLock(
      EV,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    expect((await run(w, plan)).status).toBe("busy");
    expect(w.patch).not.toHaveBeenCalled();
    release();
    await held;
    expect((await run(w, plan)).status).toBe("done");
    // A different event is not blocked.
    const other = withEventMoveLock("evt2", async () => 1);
    expect(await other).toEqual({ busy: false, value: 1 });
  });

  it("two simultaneous calls: exactly one runs", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    const [a, b] = await Promise.all([run(w, plan), run(w, plan)]);
    expect([a.status, b.status].sort()).toEqual(["busy", "done"]);
  });

  it("refuses when events are off or the switch is unreadable", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    eventsEnabled = false;
    expect((await run(w, plan)).status).toBe("refused");
    eventsEnabled = "throw";
    expect((await run(w, plan)).status).toBe("refused");
    expect(w.patch).not.toHaveBeenCalled();
  });

  it("decides from a fresh read, not an earlier copy", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    const seen: string[][] = [];
    // The stored assignment changes after the caller loaded its copy.
    store.get(EV)!.groups[1].memberIds = ["u3", "u8"];
    w.place("u8", MAIN);
    await run(w, ({ event }) => {
      seen.push((event.groups ?? []).flatMap((g) => g.memberIds ?? []));
      return planSendToGroups(event);
    });
    expect(seen[0]).toContain("u8");
    expect(w.where("u8")).toBe(CH_B);
  });

  it("refuses an event that is no longer running, has no groups, or cannot be read", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    store.get(EV)!.state = "ended";
    expect((await run(w, plan)).status).toBe("refused");
    store.get(EV)!.state = "active";
    store.get(EV)!.groupsEnabled = false;
    expect((await run(w, plan)).status).toBe("refused");
    store.get(EV)!.groupsEnabled = true;
    findFails = true;
    expect((await run(w, plan)).status).toBe("refused");
    findFails = false;
    store.set(EV, makeRow({ guildId: "other-guild" }));
    expect((await run(w, plan)).status).toBe("refused");
    expect(w.patch).not.toHaveBeenCalled();
  });

  it("moves for an ended event only when the caller opts in (#1193)", async () => {
    const w = makeWorld();
    w.place("u3", CH_B);
    store.get(EV)!.state = "ended";
    const base = {
      client: w.client as never,
      guildId: GUILD,
      eventId: EV,
      plan: ({ event }: { event: Parameters<typeof planMoveOne>[0] }) =>
        planMoveOne(event, "u3", "main"),
      deps: w.deps,
    };
    expect((await moveEventMembers(base)).status).toBe("refused");
    expect(w.patch).not.toHaveBeenCalled();
    expect(
      (await moveEventMembers({ ...base, allowFinished: true })).status,
    ).toBe("done");
    expect(w.where("u3")).toBe(MAIN);
    store.get(EV)!.state = "scheduled";
    store.get(EV)!.groupsEnabled = false;
    expect(
      (await moveEventMembers({ ...base, allowFinished: true })).status,
    ).toBe("refused");
  });

  it("refuses without Move Members, and when the bot's own membership is unknown", async () => {
    let w = makeWorld({ mePerms: [PermissionFlagsBits.Connect] });
    w.place("u3", MAIN);
    expect((await run(w, plan)).status).toBe("refused");
    w = makeWorld({ mePerms: null });
    w.place("u3", MAIN);
    expect((await run(w, plan)).status).toBe("refused");
    expect(w.patch).not.toHaveBeenCalled();
    expect(moveMembersBlocker(undefined)).not.toBeNull();
    expect(moveMembersBlocker(w.guild as never)).not.toBeNull();
    expect(moveMembersBlocker(makeWorld().guild as never)).toBeNull();
  });

  it("a destination outside the event is refused for that person", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    const out = await run(w, () => [{ userId: "u3", toChannelId: ELSEWHERE }]);
    if (out.status !== "done") throw new Error("expected done");
    expect(reasons(out.report).u3).toBe("error");
    expect(w.patch).not.toHaveBeenCalled();
  });
});

describe("host-move marks", () => {
  it("marks each move before sending it, for its own target channel", async () => {
    const w = makeWorld();
    w.place("u3", MAIN);
    let markedWhenSent = false;
    w.patch.mockImplementationOnce(async (route, o) => {
      // The join event could arrive right now: the mark must already exist.
      markedWhenSent = consumeHostMove(GUILD, "u3", o.body.channel_id);
      throw apiError(50013);
    });
    await run(w, ({ event }) => planSendToGroups(event));
    expect(markedWhenSent).toBe(true);
  });

  it("keeps the mark for a move whose outcome is unknown, drops it for a refusal", async () => {
    store.set(
      EV,
      makeRow({
        groups: makeRow().groups.map((g) =>
          g.key === "b"
            ? { ...g, memberIds: ["u3", "u4"] }
            : { ...g, memberIds: [] },
        ),
      }),
    );
    const w = makeWorld();
    w.place("u3", MAIN);
    w.place("u4", MAIN);
    w.patchBehaviour.set("u3", new Error("Discord API timeout after 30000ms"));
    w.patchBehaviour.set("u4", apiError(50013));
    await run(w, ({ event }) => planSendToGroups(event));
    expect(consumeHostMove(GUILD, "u4", CH_B)).toBe(false);
    expect(consumeHostMove(GUILD, "u3", CH_B)).toBe(true);
  });
});

describe("describeMoveReport", () => {
  it("lists names, groups reasons and caps the list", () => {
    const skipped = Array.from({ length: 12 }, (_, i) => ({
      userId: `x${i}`,
      reason: "not-connected" as const,
    }));
    const text = describeMoveReport(
      { moved: ["a"], skipped, unconfirmed: [] },
      (id) => id,
    );
    expect(text).toContain("Moved 1.");
    expect(text).toContain("12 not connected to voice");
    expect(text).toContain("and 2 more");
  });
});
