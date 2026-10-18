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
  const client = {
    guilds: {
      cache: { get: (id: string) => (id === GUILD ? guild : undefined) },
    },
    token: "t",
  };
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
    expect(text).toContain("may or may not have moved: N-u6");
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
